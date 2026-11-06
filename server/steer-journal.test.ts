// The steer queue's crash journal: failure, ordering and logging rules.
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainSteeredMessages,
  dropSteeredMessages,
  queueSteeredMessage,
  setSteerQueueObserver,
  snapshotSteerQueue,
  type SteerStore,
} from "./steer-queue.ts";
import {
  appendHeldWork,
  carriedWorkIds,
  HELD_SENDS_FILE,
  journalItemStillOwed,
  readQueueJournal,
  seedQueuedFirstSeen,
  STEER_JOURNAL_FILE,
  takeHeldWork,
  writeQueueJournal,
  type HeldQueueEntry,
} from "./update-drain.ts";
import type { BotRecord, Message } from "./store.ts";

// These tests drive the queue with the few fields it reads, not whole store records.
function fake<T>(value: Partial<T>): T {
  // SAFETY: a partial stand-in for a store record, used only by these tests.
  return value as T;
}

const entry = (text: string): HeldQueueEntry => ({
  botId: "bot-1",
  threadId: "thread-1",
  heldAt: 1,
  items: [{ messageId: "q1", text, prompt: text, relayed: false }],
});

describe("steer queue crash journal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    setSteerQueueObserver(null);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-steer-journal-"));
    dirs.push(dir);
    return dir;
  };

  it("writes the queue, reads it back, and deletes the file when the queue is empty", () => {
    const dir = tmp();
    expect(writeQueueJournal(dir, [entry("hello")])).toBeNull();
    expect(readQueueJournal(dir)).toMatchObject([{ botId: "bot-1", threadId: "thread-1", items: [{ messageId: "q1", text: "hello" }] }]);
    expect(writeQueueJournal(dir, [])).toBeNull();
    expect(existsSync(join(dir, STEER_JOURNAL_FILE))).toBe(false);
  });

  it("reports a write failure and leaves the last good journal untouched", () => {
    const dir = tmp();
    expect(writeQueueJournal(dir, [entry("keep me")])).toBeNull();
    const good = readFileSync(join(dir, STEER_JOURNAL_FILE), "utf8");
    // A directory where the temporary file must go makes the write fail the way a full disk does.
    expect(writeQueueJournal(join(dir, "missing"), [entry("lost")])).toBeInstanceOf(Error);
    expect(readFileSync(join(dir, STEER_JOURNAL_FILE), "utf8")).toBe(good);
  });

  it("never writes through a symlink planted where the temporary file goes", () => {
    const dir = tmp();
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(dir, `${STEER_JOURNAL_FILE}.${process.pid}.tmp`));
    expect(writeQueueJournal(dir, [entry("private words")])).toBeNull();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readQueueJournal(dir)).toMatchObject([{ items: [{ text: "private words" }] }]);

    const carrier = tmp();
    const carrierVictim = join(carrier, "victim.txt");
    writeFileSync(carrierVictim, "untouched");
    symlinkSync(carrierVictim, join(carrier, `${HELD_SENDS_FILE}.${process.pid}.tmp`));
    appendHeldWork(carrier, { queued: [entry("carried words")] });
    expect(readFileSync(carrierVictim, "utf8")).toBe("untouched");
    expect(takeHeldWork(carrier).queued).toMatchObject([{ items: [{ text: "carried words" }] }]);
  });

  it("still restores an entry that carries a key this version does not know", () => {
    const dir = tmp();
    const future = { ...entry("from a newer build"), addedLater: true };
    writeFileSync(join(dir, STEER_JOURNAL_FILE), JSON.stringify({ version: 1, sends: [], queued: [future] }));
    expect(readQueueJournal(dir)).toMatchObject([{ items: [{ text: "from a newer build" }] }]);
  });

  it("knows a carried committed batch by its queue id and by its transcript line", () => {
    const committedItem = {
      messageId: "queue-1",
      text: "t",
      prompt: "t",
      relayed: false,
      committed: { userMessageId: "line-1", excludeIds: [], relayed: false, heldAt: 1 },
    };
    const carried = { sends: [], queued: [{ botId: "bot-1", threadId: "thread-1", heldAt: 1, items: [committedItem] }], rooms: [] };
    const ids = carriedWorkIds(carried);
    expect([...ids].sort()).toEqual(["line-1", "queue-1"]);
    const inThread = new Set<string>();
    // The same batch in the journal is already carried: it must not run twice, even
    // though its transcript line exists.
    expect(journalItemStillOwed(committedItem, ids, inThread, () => true)).toBe(false);
    // A committed batch nobody carries still runs while its transcript line exists.
    expect(journalItemStillOwed(committedItem, new Set(), inThread, () => true)).toBe(true);
    expect(journalItemStillOwed(committedItem, new Set(), inThread, () => false)).toBe(false);
    // A plain queued item already drained into its thread (its queue id is on a line) is not owed.
    const plain = { messageId: "queue-2", text: "p", prompt: "p", relayed: false };
    expect(journalItemStillOwed(plain, new Set(), new Set(["queue-2"]), () => true)).toBe(false);
    expect(journalItemStillOwed(plain, new Set(), inThread, () => true)).toBe(true);
  });

  it("seeds a restored send's first-held time from its journal entry, never from now", () => {
    const firstSeen = new Map<string, number>();
    const old = { ...entry("waited an hour"), heldAt: 1234 };
    const committed = {
      ...entry("already in the thread"),
      items: [{ messageId: "q9", text: "c", prompt: "c", relayed: false, committed: { userMessageId: "l9", excludeIds: [], relayed: false, heldAt: 77 } }],
    };
    seedQueuedFirstSeen(firstSeen, [old, committed]);
    expect(firstSeen.get("q1")).toBe(1234);
    // A committed item keeps its own heldAt and is not seeded here.
    expect(firstSeen.has("q9")).toBe(false);
  });

  it("sets an unreadable journal aside and never logs its text", () => {
    const dir = tmp();
    writeFileSync(join(dir, STEER_JOURNAL_FILE), '{"version":1,"sends":[],"queued":[ SECRET-USER-WORDS');
    const log = vi.fn();
    expect(readQueueJournal(dir, log)).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-USER-WORDS");
    expect(existsSync(join(dir, STEER_JOURNAL_FILE))).toBe(false);
    expect(readFileSync(join(dir, `${STEER_JOURNAL_FILE}.unreadable`), "utf8")).toContain("SECRET-USER-WORDS");
  });

  it("never logs the text of an unreadable held-sends file", () => {
    const dir = tmp();
    writeFileSync(join(dir, HELD_SENDS_FILE), '{"version":1,"sends":[ SECRET-USER-WORDS');
    const log = vi.fn();
    expect(takeHeldWork(dir, log)).toEqual({ sends: [], queued: [], rooms: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-USER-WORDS");
    expect(existsSync(join(dir, HELD_SENDS_FILE))).toBe(false);
  });

  it("journals a drain once, after the transcript lines are appended", () => {
    const bot = fake<BotRecord>({ id: "bot-order", threadId: "thread-order", busy: true });
    const messages: Message[] = [];
    const store = fake<SteerStore>({
      bot: () => bot,
      messagesFor: () => messages,
      patchMessage: () => null,
      appendMessage: (_thread: string, message: Omit<Message, "id" | "at">) => {
        const full: Message = { ...message, id: `m${messages.length}`, at: 1 };
        messages.push(full);
        return full;
      },
    });
    queueSteeredMessage(bot, "one");
    queueSteeredMessage(bot, "two");
    const seen: Array<{ appended: number; queued: number }> = [];
    setSteerQueueObserver(() => seen.push({ appended: messages.length, queued: snapshotSteerQueue().length }));
    bot.busy = false;
    drainSteeredMessages(store, () => {});
    // One write, and by then both words are in the thread and out of the queue.
    expect(seen).toEqual([{ appended: 2, queued: 0 }]);
  });

  it("journals every accept and every drop", () => {
    const bot = fake<BotRecord>({ id: "bot-accept", threadId: "thread-accept", busy: true });
    const sizes: number[] = [];
    setSteerQueueObserver(() => sizes.push(snapshotSteerQueue().flatMap((e) => e.items).length));
    queueSteeredMessage(bot, "a");
    queueSteeredMessage(bot, "b");
    dropSteeredMessages("thread-accept");
    expect(sizes).toEqual([1, 2, 0]);
  });
});
