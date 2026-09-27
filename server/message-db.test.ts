// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  closeMessageDb,
  deleteThread,
  insertMessage,
  pruneDeadThreads,
  readThread,
  readThreadTail,
  searchMessages,
  setActiveLeaf,
  updateMessage,
} from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    // bots.json writes are debounced; a relaunch goes through the shutdown
    // flush, so the roster is on disk before the next Store reads it.
    initial.flushBotsNow();
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);

    // Current-chat find scopes in SQL before LIMIT, so busy transcripts in
    // other conversations cannot crowd out this thread's matches.
    expect(searchMessages("railway", 40, "t5").map((hit) => hit.threadId)).toEqual(["t5"]);
    expect(searchMessages("railway", 40, "missing")).toEqual([]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } } as Message);

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("readThreadTail returns only the newest rows and reports hasMore", () => {
    for (let i = 0; i < 5; i++) insertMessage("tail1", msg(`m${i}`, `text ${i}`));
    const page = readThreadTail("tail1", legacy("tail1"), 2);
    expect(page.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(page.hasMore).toBe(true);
    // the full read agrees on order — the tail is really the newest end
    expect(readThread("tail1", legacy("tail1")).messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("readThreadTail reports hasMore:false when the whole thread fits in the page", () => {
    insertMessage("tail2", msg("a", "one"));
    insertMessage("tail2", msg("b", "two"));
    setActiveLeaf("tail2", "b");
    const page = readThreadTail("tail2", legacy("tail2"), 5);
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(false);
    expect(page.activeLeafId).toBe("b");
  });

  it("readThreadTail falls back to a full legacy import on first touch", () => {
    writeFileSync(legacy("tail3"), JSON.stringify([msg("a", "one"), msg("b", "two"), msg("c", "three")]));
    // a never-before-touched thread has no sqlite rows to bound a SQL LIMIT
    // read over, so the one-time legacy import returns the whole thread —
    // the caller (Store.messagesTail) decides whether to slice further.
    const page = readThreadTail("tail3", legacy("tail3"), 2);
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(page.hasMore).toBeUndefined();
    expect(existsSync(`${legacy("tail3")}.imported`)).toBe(true);
  });

  // Most of these fixtures are 2-3 threads total, so a genuinely dead one is
  // often "most of the database" by share alone, and every message here is
  // inserted at Date.now() (fresh).  Tests that are not specifically about
  // the age gate or the dead-share refusal disable both with NO_GATES; the
  // dedicated tests below exercise them directly.  UNRELATED_LIVE pads the
  // live set so it is never empty (the OTHER refusal) without being the
  // thread under test.
  const UNRELATED_LIVE = new Set(["unrelated-live-thread"]);
  const NO_GATES = { maxAgeMs: 0, maxDeadShare: 1 };

  it("pruneDeadThreads removes messages and thread_state for dead threads, keeps live ones", () => {
    insertMessage("dead1", msg("m1", "gone"));
    setActiveLeaf("dead1", "m1");
    insertMessage("dead2", msg("m2", "also gone"));
    insertMessage("live1", msg("m3", "keep"));
    setActiveLeaf("live1", "m3");

    const result = pruneDeadThreads(new Set(["live1"]), NO_GATES);
    expect(result.refused).toBeUndefined();
    expect(result.messagesDeleted).toBe(2);
    expect(result.threadStateDeleted).toBe(1); // only dead1 had a thread_state row
    expect(result.dryRun).toBe(false);
    expect(readThread("dead1", legacy("dead1")).messages).toEqual([]);
    expect(readThread("dead2", legacy("dead2")).messages).toEqual([]);
    expect(readThread("live1", legacy("live1")).messages).toHaveLength(1);
    expect(readThread("live1", legacy("live1")).activeLeafId).toBe("m3");
  });

  it("pruneDeadThreads removes an orphaned thread_state row with no messages rows too", () => {
    setActiveLeaf("orphan-state", "some-id");
    // No messages behind it, so there is nothing to date — the age gate
    // does not apply to a thread_state-only row regardless of maxAgeMs.
    const result = pruneDeadThreads(UNRELATED_LIVE, { maxDeadShare: 1 });
    expect(result.refused).toBeUndefined();
    expect(result.threadStateDeleted).toBeGreaterThanOrEqual(1);
    expect(readThread("orphan-state", legacy("orphan-state")).activeLeafId).toBeNull();
  });

  it("pruneDeadThreads accepts a plain iterable, not just a Set", () => {
    insertMessage("dead3", msg("m1", "gone"));
    insertMessage("live2", msg("m2", "keep"));
    pruneDeadThreads(["live2"], NO_GATES); // array, not a Set
    expect(readThread("dead3", legacy("dead3")).messages).toEqual([]);
    expect(readThread("live2", legacy("live2")).messages).toHaveLength(1);
  });

  it("pruneDeadThreads does not VACUUM when the freed freelist is small", () => {
    insertMessage("dead4", msg("m1", "x"));
    const result = pruneDeadThreads(UNRELATED_LIVE, NO_GATES);
    expect(result.vacuumed).toBe(false);
  });

  it("pruneDeadThreads VACUUMs once the freed freelist crosses the threshold", () => {
    // A large text value forces real page allocation, so deleting it frees
    // at least one whole page — real production uses a 32 MB threshold
    // (DEFAULT_VACUUM_THRESHOLD_BYTES), which a unit test should not have to
    // allocate tens of megabytes to exercise.
    insertMessage("dead5", msg("m1", "x".repeat(50_000)));
    const result = pruneDeadThreads(UNRELATED_LIVE, { ...NO_GATES, vacuumThresholdBytes: 1 });
    expect(result.vacuumed).toBe(true);
  });

  it("pruneDeadThreads leaves a dead thread alone until its newest message is old enough", () => {
    insertMessage("dead-fresh", msg("m1", "just now"));
    const fresh = pruneDeadThreads(UNRELATED_LIVE, { maxDeadShare: 1 }); // default maxAgeMs (7 days)
    expect(fresh.refused).toBeUndefined();
    expect(fresh.messagesDeleted).toBe(0);
    expect(readThread("dead-fresh", legacy("dead-fresh")).messages).toHaveLength(1);

    // an explicit old `at`, well past the default 7-day bar
    insertMessage("dead-old", msg("m1", "long ago", { at: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    const old = pruneDeadThreads(UNRELATED_LIVE, { maxDeadShare: 1 });
    expect(old.messagesDeleted).toBe(1);
    expect(readThread("dead-old", legacy("dead-old")).messages).toEqual([]);
    // the still-fresh thread from above must not have been swept as a side effect
    expect(readThread("dead-fresh", legacy("dead-fresh")).messages).toHaveLength(1);
  });

  it("pruneDeadThreads refuses an empty live set against a nonempty database, dry run or not", () => {
    insertMessage("real-history", msg("m1", "do not lose this", { at: Date.now() - 30 * 24 * 60 * 60 * 1000 }));

    const real = pruneDeadThreads(new Set());
    expect(real.refused).toBe("empty-live-set");
    expect(real.messagesDeleted).toBe(0);
    expect(readThread("real-history", legacy("real-history")).messages).toHaveLength(1);

    const preview = pruneDeadThreads(new Set(), { dryRun: true });
    expect(preview.refused).toBe("empty-live-set");
    expect(preview.messagesDeleted).toBe(0);
  });

  it("pruneDeadThreads refuses when dead threads are too large a share of the database", () => {
    // one live thread, four dead ones — 80% dead, past the 50% default
    insertMessage("keep-me", msg("m1", "keep"));
    for (const id of ["d1", "d2", "d3", "d4"]) {
      insertMessage(id, msg("m1", "old", { at: Date.now() - 30 * 24 * 60 * 60 * 1000 }));
    }
    const result = pruneDeadThreads(new Set(["keep-me"]));
    expect(result.refused).toBe("dead-share-too-large");
    expect(result.messagesDeleted).toBe(0);
    for (const id of ["d1", "d2", "d3", "d4"]) {
      expect(readThread(id, legacy(id)).messages).toHaveLength(1);
    }
  });

  it("pruneDeadThreads dry run reports what a real run would delete, without deleting", () => {
    insertMessage("dead-preview", msg("m1", "old enough", { at: Date.now() - 10 * 24 * 60 * 60 * 1000 }));
    setActiveLeaf("dead-preview", "m1");

    const preview = pruneDeadThreads(UNRELATED_LIVE, { maxDeadShare: 1, dryRun: true });
    expect(preview).toMatchObject({ messagesDeleted: 1, threadStateDeleted: 1, vacuumed: false, dryRun: true });
    expect(preview.refused).toBeUndefined();
    // nothing actually removed
    expect(readThread("dead-preview", legacy("dead-preview")).messages).toHaveLength(1);

    const real = pruneDeadThreads(UNRELATED_LIVE, { maxDeadShare: 1 });
    expect(real).toMatchObject({ messagesDeleted: 1, threadStateDeleted: 1, dryRun: false });
    expect(readThread("dead-preview", legacy("dead-preview")).messages).toEqual([]);
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });
});
