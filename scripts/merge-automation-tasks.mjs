// One-time cleanup: fold a bot's repeated automation tasks into one thread
// per trigger.
//
// Before the source-keyed thread change, every webhook delivery and every
// scheduled tick minted a task.  A real fleet reached 146 tasks on one bot
// and 116 on another, almost all of them a single message from an uptime
// monitor.  New runs now reuse one thread per trigger; this reunites the ones
// already on disk.
//
// It is deliberately a script and not a migration.  A migration runs on
// everyone's data at startup, and this rewrites a person's whole transcript
// history — it should be a decision, with a dry run and a backup, made by
// someone who looked at the plan first.
//
//   node scripts/merge-automation-tasks.mjs               # dry run
//   node scripts/merge-automation-tasks.mjs --apply       # do it
//   node scripts/merge-automation-tasks.mjs --apply --data-dir /path
//
// The harness must be stopped: it holds the same SQLite file and keeps bots
// in memory, so it would write the old roster back over this one.
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dirFlag = args.indexOf("--data-dir");
const DATA_DIR = dirFlag >= 0 ? args[dirFlag + 1] : (process.env.OMB_DATA_DIR ?? join(homedir(), ".botfleet"));
const BOTS_FILE = join(DATA_DIR, "bots.json");
const DB_FILE = join(DATA_DIR, "messages.db");

/** Titles a person types are theirs to keep.  These are the ones the
 * automation minted: a routine's name, repeated once per firing.  A group of
 * one is left alone, so a task that merely shares a name with nothing is
 * never touched. */
function automationGroups(tasks) {
  const byTitle = new Map();
  for (const task of tasks) {
    const title = (task.title ?? "").trim();
    if (!title || title === "New task") continue;
    const group = byTitle.get(title) ?? [];
    group.push(task);
    byTitle.set(title, group);
  }
  return [...byTitle.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([title, group]) => ({
      title,
      // oldest leads: it is the thread whose id anything else may already
      // reference, and merging forward keeps that reference valid
      tasks: [...group].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    }));
}

function loadBots() {
  const raw = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
  // two on-disk layouts have shipped: a bare array, and an object with a
  // `bots` key alongside other roster state
  return Array.isArray(raw) ? { bare: true, bots: raw } : { bare: false, raw, bots: raw.bots ?? [] };
}

// HS9: nothing pruned these — a real fleet accumulated 90 MB of them, most
// from repeated dry runs during development. Names are
// `<basename>.bak-merge-<ISO stamp, ":"/"." replaced with "-">`, and that
// replacement keeps the fixed-width structure a timestamp has, so a plain
// string sort still orders them oldest to newest.
export const BACKUP_KEEP = 3;

export function pruneBackups(path, keep = BACKUP_KEEP) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-merge-`;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  const stale = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of stale) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.bak-merge-${stamp}`;
  copyFileSync(path, target);
  pruneBackups(path);
  return target;
}

export function main() {
  if (!existsSync(BOTS_FILE)) throw new Error(`no bots.json under ${DATA_DIR}`);
  if (!existsSync(DB_FILE)) throw new Error(`no messages.db under ${DATA_DIR}`);

  const loaded = loadBots();
  const plan = [];
  for (const bot of loaded.bots) {
    for (const group of automationGroups(bot.tasks ?? [])) {
      plan.push({ botId: bot.id, botName: bot.name, ...group });
    }
  }

  if (!plan.length) {
    console.log("nothing to merge — no bot has two tasks sharing an automation title");
    return;
  }

  let folded = 0;
  for (const entry of plan) {
    folded += entry.tasks.length - 1;
    console.log(
      `${entry.botName}: "${entry.title}" — ${entry.tasks.length} tasks → 1 (${entry.tasks.length - 1} folded in)`,
    );
  }
  console.log(`\n${plan.length} trigger(s) across ${new Set(plan.map((p) => p.botId)).size} bot(s); ${folded} tasks folded`);

  if (!apply) {
    console.log("\ndry run — nothing written.  Re-run with --apply to do it.");
    return;
  }

  // The harness would write its in-memory roster back over ours.
  const lock = join(DATA_DIR, "merge-automation.lock");
  const handle = openSync(lock, "wx");
  try {
    console.log(`\nbacked up ${backup(BOTS_FILE)}`);
    console.log(`backed up ${backup(DB_FILE)}`);

    const db = new DatabaseSync(DB_FILE);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of plan) {
        const [target, ...rest] = entry.tasks;
        const ids = entry.tasks.map((task) => task.threadId);
        const placeholders = ids.map(() => "?").join(",");

        // Read every message of every thread in the group, order it by time,
        // then rewrite the whole set under the target id.  Delete-then-insert
        // rather than UPDATE because readThread orders by rowid, not by `at`:
        // an UPDATE would leave the rows interleaved in insertion order and a
        // year of an uptime monitor would read out of sequence.
        const rows = db
          .prepare(`SELECT id, at, role, kind, text, json FROM messages WHERE thread_id IN (${placeholders})`)
          .all(...ids);
        rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)));

        db.prepare(`DELETE FROM messages WHERE thread_id IN (${placeholders})`).run(...ids);
        const insert = db.prepare(
          "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of rows) {
          // parentId links a branch inside ONE thread.  Across a merge the
          // links no longer form a single chain, and visibleMessages would
          // walk one thread's chain and hide the rest — so the merged thread
          // becomes a flat transcript, which is its documented fallback.
          const message = JSON.parse(row.json);
          delete message.parentId;
          insert.run(target.threadId, row.id, row.at, row.role, row.kind, row.text, JSON.stringify(message));
        }

        // Same reason: an active leaf names a branch that no longer exists.
        db.prepare(`DELETE FROM thread_state WHERE thread_id IN (${placeholders})`).run(...ids);

        const keep = new Set(rest.map((task) => task.threadId));
        const bot = loaded.bots.find((candidate) => candidate.id === entry.botId);
        bot.tasks = (bot.tasks ?? []).filter((task) => !keep.has(task.threadId));
        // the roster's active thread cannot point at a task that is gone
        if (keep.has(bot.threadId)) bot.threadId = target.threadId;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }

    const out = loaded.bare ? loaded.bots : { ...loaded.raw, bots: loaded.bots };
    writeFileSync(BOTS_FILE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\nmerged.  ${folded} tasks folded into ${plan.length} threads.`);
    console.log("start the harness again when you are ready.");
  } finally {
    closeSync(handle);
    // best effort: the lock only guards this process's own run
    try {
      unlinkSync(lock);
    } catch {}
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
