// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  const isNewFile = !existsSync(file);
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  // auto_vacuum only takes effect set on an EMPTY database (SQLite ignores
  // it once a table exists, short of a full VACUUM), so this only ever runs
  // for a file this call just created — before journal_mode or the first
  // CREATE TABLE below writes a page. It lets pruneDeadThreads's freed pages
  // be reclaimed incrementally instead of sitting dead in the file until the
  // next freelist-triggered VACUUM.
  if (isNewFile) {
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    } catch {
      // an older node:sqlite build without the pragma still works correctly;
      // it just leaves reclaiming freed pages to VACUUM alone
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
    CREATE TABLE IF NOT EXISTS running_helpers (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    );
  `);
  backfillRunningHelpers(db);
  return db;
}

/** One-time import for databases that predated the side table. */
function backfillRunningHelpers(database: DatabaseSync): void {
  // SAFETY: `COUNT(*)` on `running_helpers` always returns one numeric row.
  const count = database.prepare("SELECT COUNT(*) AS n FROM running_helpers").get() as { n: number };
  if (count.n > 0) return;
  // SAFETY: the query selects `thread_id`, `id`, and `json`, all TEXT columns on `messages`.
  const rows = database
    .prepare("SELECT thread_id, id, json FROM messages WHERE json LIKE ?")
    .all('%"status":"running"%') as Array<{ thread_id: string; id: string; json: string }>;
  const insert = database.prepare(
    "INSERT OR IGNORE INTO running_helpers (thread_id, message_id, started_at) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    let message: Message;
    try {
      // SAFETY: `json` is `JSON.stringify` of a `Message`, the same cast `rowToMessage` uses.
      message = JSON.parse(row.json) as Message;
    } catch {
      continue;
    }
    if (message.helper?.status !== "running") continue;
    insert.run(row.thread_id, row.id, message.helper.startedAt ?? message.at ?? 0);
  }
}

function syncRunningHelper(threadId: string, message: Message): void {
  const database = db();
  if (message.helper?.status === "running") {
    database
      .prepare(
        "INSERT OR REPLACE INTO running_helpers (thread_id, message_id, started_at) VALUES (?, ?, ?)",
      )
      .run(threadId, message.id, message.helper.startedAt ?? message.at ?? 0);
    return;
  }
  database
    .prepare("DELETE FROM running_helpers WHERE thread_id = ? AND message_id = ?")
    .run(threadId, message.id);
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

export interface ThreadTailRows extends ThreadRows {
  /** `true` means older rows exist beyond this page; `false` means the SQL
   * read returned the complete thread. Absent for a full legacy import.
   * Both false and absent results can be cached as a full load. */
  hasMore?: boolean;
}

/** The newest `limit` rows only, read at the SQL boundary — the fast path
 * for a display page (the GET /api/bots hydrate, a fresh scrollback view)
 * that never needs the rest of a long transcript. Reading every thread in
 * full through readThread() and caching it forever was the likely driver
 * of the harness's unbounded RSS (HS12/HS21). Falls back to a full legacy
 * import on first touch, same as readThread(); that read is a one-time
 * migration cost regardless of how much of the result the caller keeps. */
export function readThreadTail(threadId: string, legacyFile: string, limit: number): ThreadTailRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, limit + 1) as Array<{ json: string }>;
  if (rows.length) {
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    rows.reverse();
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null, hasMore };
  }
  return importLegacy(threadId, legacyFile);
}

/** Read the newest `limit` messages for multiple threads in one batched query.
 * Uses a window function to partition by thread_id and order by rowid so
 * only the tail rows are returned in chronological order. */
export function readThreadsTail(threadIds: readonly string[], limit: number): Map<string, Message[]> {
  const result = new Map<string, Message[]>();
  for (const id of threadIds) {
    result.set(id, []);
  }
  const uniqueIds = Array.from(new Set(threadIds));
  if (uniqueIds.length === 0 || limit <= 0) return result;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const statement = db().prepare(
    "SELECT thread_id, json FROM (" +
      "SELECT thread_id, rowid AS seq, json, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rowid DESC) AS rn " +
      `FROM messages WHERE thread_id IN (${placeholders})` +
    ") WHERE rn <= ? ORDER BY thread_id, seq ASC",
  );
  // SAFETY: query returns `thread_id` and `json`, both TEXT columns on `messages`.
  const rows = statement.all(...uniqueIds, limit) as Array<{ thread_id: string; json: string }>;
  for (const row of rows) {
    const list = result.get(row.thread_id);
    const msg = rowToMessage(row);
    if (list) {
      list.push(msg);
    } else {
      result.set(row.thread_id, [msg]);
    }
  }
  return result;
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

/** Cheap row count for one thread — used by automation rollover so we
 * do not load the whole transcript just to decide whether to mint a fresh
 * task.  Cached in-memory threads still prefer `messages.length`; callers
 * that already hold the cache should use that instead. */
export function countMessages(threadId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
    .get(threadId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  syncRunningHelper(threadId, message);
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Persist a WHOLE transcript in one transaction.
 *
 * Folding a long conversation into another copies every message it holds,
 * and one transaction per message turned that into thousands of commits
 * that each blocked the event loop.  The rows land together and the branch
 * head moves to the last one, so the transcript reads exactly as it would
 * have if the messages had arrived one at a time. */
export function appendMessages(threadId: string, messages: Message[]): void {
  if (messages.length === 0) return;
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const message of messages) insertMessage(threadId, message);
    setActiveLeaf(threadId, messages[messages.length - 1]!.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** When a thread first spoke, without hydrating the transcript.
 *
 * The first row by insertion order is the thread's start, which is what the
 * merge order reads; a comparator that asked for it through the full
 * transcript instead pulled every message — base64 captures included —
 * into memory, once per comparison.  A thread whose rows still live only in
 * its legacy JSON file is read from that file, not imported: this is a
 * question about a timestamp, not a reason to write. */
export function firstMessageAt(threadId: string, legacyFile: string): number | null {
  // SAFETY: the query selects the single column `at` from at most one row, so
  // the row is `{ at: number }` and `.get()` returns undefined when the thread
  // has no rows yet.
  const row = db()
    .prepare("SELECT at FROM messages WHERE thread_id = ? ORDER BY rowid LIMIT 1")
    .get(threadId) as { at: number } | undefined;
  if (row) return row.at;
  try {
    const raw = JSON.parse(readFileSync(legacyFile, "utf8"));
    // SAFETY: a legacy transcript file holds either the message array itself
    // or an object with a `messages` array.  Both shapes are read here, and
    // any other shape yields an empty list rather than a wrong answer.
    const messages = Array.isArray(raw)
      ? (raw as Message[])
      : (((raw as { messages?: Message[] }).messages ?? []) as Message[]);
    return messages[0]?.at ?? null;
  } catch {
    return null;
  }
}

/** Rows whose stored helper is still running.  The LIKE pass is a candidate
 * filter; the helper status is what decides.  A restart has no live tracker,
 * so these are the cards that would otherwise tick forever. */
export function runningHelperRows(): Array<{ threadId: string; message: Message }> {
  // SAFETY: the join selects `thread_id` and `json`, both TEXT columns on their tables.
  const rows = db()
    .prepare(
      "SELECT rh.thread_id, m.json FROM running_helpers rh " +
        "INNER JOIN messages m ON m.thread_id = rh.thread_id AND m.id = rh.message_id",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  const found: Array<{ threadId: string; message: Message }> = [];
  for (const { thread_id, json } of rows) {
    let message: Message;
    try {
      // SAFETY: `json` is `JSON.stringify` of a `Message`, the same cast `rowToMessage` uses.
      message = JSON.parse(json) as Message;
    } catch {
      continue;
    }
    if (message.helper?.status !== "running") {
      syncRunningHelper(thread_id, message);
      continue;
    }
    found.push({ threadId: thread_id, message });
  }
  return found;
}

export function updateMessage(threadId: string, message: Message): void {
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
  syncRunningHelper(threadId, message);
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM running_helpers WHERE thread_id = ?").run(threadId);
}

/** Freelist bytes above which `pruneDeadThreads` runs a full `VACUUM`
 * (HS2's 251 MB / 58,532-row database was almost entirely dead pages from
 * `pruneScreenFrames` rewriting rows in place rather than shrinking the
 * file). Exposed so a test can force the VACUUM branch without allocating
 * tens of megabytes to build a real freelist that size. */
export const DEFAULT_VACUUM_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** How long a thread must sit outside the live set before its rows are
 * eligible — the same 7-day bar `transcript-retention.ts`'s orphan sweep
 * uses, so a thread that stopped being used is not treated any less
 * carefully here than its logs are. */
export const DEFAULT_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Refuse to prune when dead threads would be this large a share of every
 * thread the database holds.  A normal trickle of bot/task/group deletions
 * is a small fraction of the database; anything near "most of it" reads as
 * a store that failed to load, not organic cleanup — the same shape of risk
 * `Store`'s own constructor already guards against for `bots.json` (a file
 * that exists but fails to parse must not be read as "no bots"). */
export const DEFAULT_MAX_DEAD_SHARE = 0.5;

export interface PruneResult {
  /** rows deleted for real, or that a dry run confirms it would delete */
  messagesDeleted: number;
  threadStateDeleted: number;
  vacuumed: boolean;
  dryRun: boolean;
  /** set when candidates existed but the sweep declined to touch anything —
   *  an empty live set against a nonempty database (the likeliest read is a
   *  store that failed to load, not one with zero bots and real history),
   *  or dead threads crossing `maxDeadShare`.  Set on a dry run too, so a
   *  preview never claims a delete that a real run would refuse. */
  refused?: "empty-live-set" | "dead-share-too-large";
}

/** Delete every `messages` and `thread_state` row whose thread id is BOTH
 * not in `liveThreadIds` AND has had no message for `maxAgeMs` (a
 * thread_state row with no messages behind it has nothing to date by, and
 * is low-risk enough — a few dozen bytes, no content — to treat as always
 * old enough), then VACUUM only when that freed enough pages to be worth the
 * exclusive lock a VACUUM holds.  `deleteThread` already does the same
 * per-thread delete on an explicit removal, but nothing before this ever
 * swept the threads a bot/task/group delete missed (harness down at the
 * time, a pre-this-fix build) or ran the file-shrinking VACUUM at all.
 *
 * Two refusals sit in front of the delete, both live under dry run too so a
 * preview is never rosier than reality: `liveThreadIds` empty against a
 * nonempty database, and the dead share crossing `maxDeadShare`.  Both exist
 * for the same reason — an empty or partial `liveThreadIds` from a store
 * that failed to load looks, from here, identical to "the user deleted
 * everything", and this delete has no undo once `VACUUM` runs.
 *
 * `liveThreadIds` is the caller's job to build: every bot's active and task
 * threads, every group's active and task threads — the same set the
 * transcript orphan sweep uses, so a thread the store still knows about is
 * never at risk here either. */
export function pruneDeadThreads(
  liveThreadIds: Iterable<string>,
  opts: { now?: number; maxAgeMs?: number; vacuumThresholdBytes?: number; maxDeadShare?: number; dryRun?: boolean } = {},
): PruneResult {
  const live = new Set(liveThreadIds);
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PRUNE_AGE_MS;
  const maxDeadShare = opts.maxDeadShare ?? DEFAULT_MAX_DEAD_SHARE;
  const dryRun = opts.dryRun ?? false;
  const database = db();
  const base = { messagesDeleted: 0, threadStateDeleted: 0, vacuumed: false, dryRun };

  const allIds = new Set<string>();
  for (const row of database.prepare("SELECT DISTINCT thread_id FROM messages").all() as Array<{ thread_id: string }>) {
    allIds.add(row.thread_id);
  }
  for (const row of database.prepare("SELECT thread_id FROM thread_state").all() as Array<{ thread_id: string }>) {
    allIds.add(row.thread_id);
  }

  if (live.size === 0 && allIds.size > 0) {
    return { ...base, refused: "empty-live-set" };
  }

  const newestByThread = new Map<string, number>();
  for (const row of database
    .prepare("SELECT thread_id, MAX(at) AS max_at FROM messages GROUP BY thread_id")
    .all() as Array<{ thread_id: string; max_at: number }>) {
    newestByThread.set(row.thread_id, row.max_at);
  }

  const dead: string[] = [];
  for (const id of allIds) {
    if (live.has(id)) continue;
    const newest = newestByThread.get(id);
    if (newest !== undefined && now - newest < maxAgeMs) continue; // too recent to touch
    dead.push(id);
  }

  if (allIds.size > 0 && dead.length / allIds.size > maxDeadShare) {
    return { ...base, refused: "dead-share-too-large" };
  }
  if (dead.length === 0) return base;

  if (dryRun) {
    const countMessages = database.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?");
    const countState = database.prepare("SELECT COUNT(*) AS n FROM thread_state WHERE thread_id = ?");
    let messagesDeleted = 0;
    let threadStateDeleted = 0;
    for (const id of dead) {
      messagesDeleted += (countMessages.get(id) as { n: number } | undefined)?.n ?? 0;
      threadStateDeleted += (countState.get(id) as { n: number } | undefined)?.n ?? 0;
    }
    return { ...base, messagesDeleted, threadStateDeleted };
  }

  let messagesDeleted = 0;
  let threadStateDeleted = 0;
  const deleteMessages = database.prepare("DELETE FROM messages WHERE thread_id = ?");
  const deleteState = database.prepare("DELETE FROM thread_state WHERE thread_id = ?");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const threadId of dead) {
      messagesDeleted += Number(deleteMessages.run(threadId).changes ?? 0);
      threadStateDeleted += Number(deleteState.run(threadId).changes ?? 0);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const threshold = opts.vacuumThresholdBytes ?? DEFAULT_VACUUM_THRESHOLD_BYTES;
  const freelistRow = database.prepare("PRAGMA freelist_count").get() as { freelist_count: number } | undefined;
  const pageSizeRow = database.prepare("PRAGMA page_size").get() as { page_size: number } | undefined;
  const freelist = freelistRow?.freelist_count ?? 0;
  const pageSize = pageSizeRow?.page_size ?? 0;
  let vacuumed = false;
  if (freelist * pageSize > threshold) {
    database.exec("VACUUM");
    vacuumed = true;
  }
  return { messagesDeleted, threadStateDeleted, vacuumed, dryRun };
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist. */
export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text/content; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = db().prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.content') AS content, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}json_extract(json, '$.role') IN ('user', 'bot') ` +
      "  AND ((lower(COALESCE(text, json_extract(json, '$.content'), '')) LIKE ? ESCAPE '\\') " +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  // SAFETY: query returns columns from `messages` and JSON1 extractions.
  const rows = (threadId
    ? statement.all(threadId, pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    content: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? row.content ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
