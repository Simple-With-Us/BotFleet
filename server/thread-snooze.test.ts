// Per-thread snooze on the harness side: what the store keeps, what wakes
// it, and what stays quiet while it sleeps.
//
// The contract this pins is the one three surfaces depend on — absent means
// awake, `0` sleeps until the thread does anything again, a timestamp sleeps
// until that moment, and JSON `null` is the only way to wake a thread, since
// an omitted field has always meant "leave it alone" on the task route.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { buildNotification } from "./notify.ts";
import { Store } from "./store.ts";
import { SNOOZE_UNTIL_ACTIVITY } from "../shared/thread-snooze.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("per-thread snooze in the store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("puts one thread to sleep and leaves its siblings working", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.taskByThread(bot.id, bot.threadId)!;
    const second = store.createTask(bot.id, "Second")!;

    store.patchTask(bot.id, second.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });

    expect(store.taskByThread(bot.id, second.threadId)?.snoozedUntil).toBe(SNOOZE_UNTIL_ACTIVITY);
    expect(store.taskByThread(bot.id, first.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("keeps a snooze across a relaunch — it is a decision, not a runtime flag like busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const deadline = Date.now() + 3_600_000;
    // `createTask` activates what it makes, so `bot.threadId` moves under us.
    const firstThread = bot.threadId;
    const timed = store.createTask(bot.id, "Timed")!;
    store.patchTask(bot.id, firstThread, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });
    store.patchTask(bot.id, timed.threadId, { snoozedUntil: deadline });
    // A relaunch goes through the shutdown flush of the debounced roster save.
    store.flushBotsNow();

    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, firstThread)?.snoozedUntil).toBe(SNOOZE_UNTIL_ACTIVITY);
    expect(reloaded.taskByThread(bot.id, timed.threadId)?.snoozedUntil).toBe(deadline);
  });

  it("wakes an until-activity thread on the next message, whoever caused it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, "Quiet")!;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });

    store.appendMessage(task.threadId, { role: "bot", kind: "text", text: "done" });

    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("rebuilds the until-activity index after a relaunch, so a reloaded thread still wakes", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, "Quiet")!;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });

    const reloaded = new Store(selection);
    reloaded.appendMessage(task.threadId, { role: "user", kind: "text", text: "back" });

    expect(reloaded.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("leaves a timed snooze alone when the thread talks — only its clock ends it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, "Timed")!;
    const deadline = Date.now() + 3_600_000;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: deadline });

    store.appendMessage(task.threadId, { role: "bot", kind: "text", text: "still working" });

    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBe(deadline);
  });

  it("sweeps expired deadlines, reports the bots that changed, and never touches the sentinel", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const past = store.createTask(bot.id, "Past")!;
    const future = store.createTask(bot.id, "Future")!;
    const sentinel = store.createTask(bot.id, "Sentinel")!;
    const now = Date.now();
    store.patchTask(bot.id, past.threadId, { snoozedUntil: now - 1 });
    store.patchTask(bot.id, future.threadId, { snoozedUntil: now + 3_600_000 });
    store.patchTask(bot.id, sentinel.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });

    expect(store.wakeExpiredThreadSnoozes(now)).toEqual([bot.id]);
    expect(store.taskByThread(bot.id, past.threadId)?.snoozedUntil).toBeUndefined();
    expect(store.taskByThread(bot.id, future.threadId)?.snoozedUntil).toBe(now + 3_600_000);
    expect(store.taskByThread(bot.id, sentinel.threadId)?.snoozedUntil).toBe(SNOOZE_UNTIL_ACTIVITY);

    // Nothing left to wake: a second sweep must not emit for anyone.
    expect(store.wakeExpiredThreadSnoozes(now)).toEqual([]);
  });

  it("wakes on an explicit null and leaves the snooze alone when the field is omitted", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, "Quiet")!;
    store.patchTask(bot.id, task.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });

    store.patchTask(bot.id, task.threadId, { title: "Renamed while asleep" });
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBe(SNOOZE_UNTIL_ACTIVITY);

    store.patchTask(bot.id, task.threadId, { snoozedUntil: null });
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
    // The index went with it: a later message must not try to wake it again.
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "hello" });
    expect(store.taskByThread(bot.id, task.threadId)?.snoozedUntil).toBeUndefined();
  });

  it("emits a bot change for the sidebar on every snooze transition", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id, "Quiet")!;
    const seen: string[] = [];
    store.onChange((change) => {
      if (change.type === "bot") seen.push(change.botId);
    });

    store.patchTask(bot.id, task.threadId, { snoozedUntil: SNOOZE_UNTIL_ACTIVITY });
    store.appendMessage(task.threadId, { role: "bot", kind: "text", text: "awake" });

    expect(seen.filter((id) => id === bot.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe("notification suppression while a thread sleeps", () => {
  const bot = { id: "scout", name: "Scout", threadId: "thread-1" };

  it("stays quiet for a snoozed thread and speaks for an awake one", () => {
    expect(buildNotification("done", bot, "thread-1", "finished", { snoozed: true })).toBeNull();
    expect(buildNotification("done", bot, "thread-1", "finished", { snoozed: false })).not.toBeNull();
    expect(buildNotification("done", bot, "thread-1", "finished")).not.toBeNull();
  });

  it("suppresses the blocking kinds too — a held question is still a banner the person deferred", () => {
    for (const kind of ["approval", "question", "routine-failed", "takeover"] as const) {
      expect(buildNotification(kind, bot, "thread-1", "waiting", { snoozed: true })).toBeNull();
    }
  });
});
