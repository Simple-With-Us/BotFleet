// The steer queue's crash journal: failure, ordering and logging rules.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { readQueueJournal, STEER_JOURNAL_FILE, writeQueueJournal, type HeldQueueEntry } from "./update-drain.ts";
import type { BotRecord, Message } from "./store.ts";

// These tests drive the queue with the few fields it reads, not whole store records.
function fake<T>(value: unknown): T {
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

  it("sets an unreadable journal aside and never logs its text", () => {
    const dir = tmp();
    writeFileSync(join(dir, STEER_JOURNAL_FILE), '{"version":1,"sends":[],"queued":[ SECRET-USER-WORDS');
    const log = vi.fn();
    expect(readQueueJournal(dir, log)).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-USER-WORDS");
    expect(existsSync(join(dir, STEER_JOURNAL_FILE))).toBe(false);
    expect(readFileSync(join(dir, `${STEER_JOURNAL_FILE}.unreadable`), "utf8")).toContain("SECRET-USER-WORDS");
  });

  it("journals a drain once, after the transcript lines are appended", () => {
    const bot = fake<BotRecord>({ id: "bot-order", threadId: "thread-order", busy: true, power: "on" });
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
