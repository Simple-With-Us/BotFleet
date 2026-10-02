// Waking a bot when its job ends (jobs P1): merging, the per-thread budget
// and its refill, busy bots, rooms, the kill switch, the spend ceiling, and
// a dispatch that fails.  Timers are captured, so no test sleeps through the
// 5-second merge window.
import { describe, expect, it } from "vitest";

import type { JobSnapshot } from "../../shared/jobs.ts";
import type { JobNoticeItem } from "../steer-queue.ts";
import { JobWakeCoordinator, wakePrompt, type JobWakeDeps } from "./wake.ts";

function job(id: string, threadId = "thread-a", botId = "bot-a", onComplete: JobSnapshot["onComplete"] = "wake"): JobSnapshot {
  return {
    id,
    botId,
    threadId,
    origin: "botfleet",
    kind: "shell",
    label: `run ${id}`,
    cwd: "/tmp",
    status: "completed",
    exitCode: 0,
    signal: null,
    startedAt: 0,
    endedAt: 1000,
    timeoutMs: 60_000,
    onComplete,
    notice: "pending",
  };
}

function setup(overrides: Partial<JobWakeDeps> = {}) {
  const queue = new Map<string, JobNoticeItem[]>();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const wakes: Array<{ botId: string; threadId: string; prompt: string; jobIds: string[] }> = [];
  const state = { busy: new Set<string>(), rooms: new Set<string>(), wake: true, spend: false, fail: false };
  const coordinator = new JobWakeCoordinator({
    wakeEnabled: () => state.wake,
    isRoom: (threadId) => state.rooms.has(threadId),
    botBusy: (botId) => state.busy.has(botId),
    spendBlocked: () => state.spend,
    drainNotices: (threadId) => {
      const items = queue.get(threadId) ?? [];
      queue.delete(threadId);
      return items;
    },
    restoreNotices: (threadId, items) => queue.set(threadId, [...items, ...(queue.get(threadId) ?? [])]),
    pendingNotices: (threadId) => queue.get(threadId) ?? [],
    startWake: async (botId, threadId, prompt, jobIds) => {
      if (state.fail) throw Object.assign(new Error("the bot is already working"), { status: 409 });
      wakes.push({ botId, threadId, prompt, jobIds });
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cleared = true;
        },
      };
    },
    ...overrides,
  });
  /** A job ended: queue its notice the way server/index.ts does, and tell
   *  the coordinator. */
  const finish = (snapshot: JobSnapshot) => {
    const items = queue.get(snapshot.threadId) ?? [];
    items.push({ jobId: snapshot.id, botId: snapshot.botId, text: `ended ${snapshot.id}`, wake: snapshot.onComplete === "wake" });
    queue.set(snapshot.threadId, items);
    coordinator.noteFinished(snapshot);
  };
  const fireTimers = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { coordinator, queue, timers, wakes, state, finish, fireTimers };
}

describe("job wakes", () => {
  it("merges completions within the 5-second window into one wake", async () => {
    const t = setup();
    t.finish(job("job_a"));
    t.finish(job("job_b"));
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(5_000);
    await t.fireTimers();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.jobIds).toEqual(["job_a", "job_b"]);
    expect(t.wakes[0]!.prompt).toContain("ended job_a");
    expect(t.wakes[0]!.prompt).toContain("ended job_b");
    expect(t.queue.get("thread-a")).toBeUndefined();
  });

  it("gives each thread 3 wakes in a row, refilled by any owner message", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      t.finish(job(`job_${i}`));
      await t.fireTimers();
    }
    expect(t.wakes).toHaveLength(3);
    t.finish(job("job_4"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(3);
    // the notice waits for the owner rather than vanishing
    expect(t.queue.get("thread-a")?.map((item) => item.jobId)).toEqual(["job_4"]);
    t.coordinator.ownerMessage("thread-a");
    expect(t.coordinator.wakesLeft("thread-a")).toBe(3);
    t.finish(job("job_5"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(4);
    expect(t.wakes[3]!.jobIds).toEqual(["job_4", "job_5"]);
  });

  it("waits for a busy bot to settle, then wakes it", async () => {
    const t = setup();
    t.state.busy.add("bot-a");
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    t.state.busy.delete("bot-a");
    t.coordinator.botSettled("bot-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.wakes).toHaveLength(1);
  });

  it("does nothing once a round or a turn already delivered the notice", async () => {
    const t = setup();
    t.finish(job("job_a"));
    t.queue.delete("thread-a");
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
  });

  it("never wakes for a room, a notice-only job, the kill switch or a tripped spend ceiling", async () => {
    const t = setup();
    t.state.rooms.add("room-1");
    t.finish(job("job_room", "room-1"));
    t.finish(job("job_owner_stop", "thread-b", "bot-a", "notice"));
    expect(t.timers).toHaveLength(0);

    t.state.wake = false;
    t.finish(job("job_off", "thread-c"));
    await t.fireTimers();
    t.state.wake = true;
    t.state.spend = true;
    t.finish(job("job_spend", "thread-d"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    // and none of their notices were dropped
    expect(t.queue.get("thread-c")).toHaveLength(1);
    expect(t.queue.get("thread-d")).toHaveLength(1);
  });

  it("puts the notices back, unspent, when the wake cannot dispatch", async () => {
    const t = setup();
    t.state.fail = true;
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    expect(t.queue.get("thread-a")?.map((item) => item.jobId)).toEqual(["job_a"]);
    expect(t.coordinator.wakesLeft("thread-a")).toBe(3);
    t.state.fail = false;
    t.coordinator.botSettled("bot-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.wakes).toHaveLength(1);
  });

  it("tries a wake that could not start again on a timer, with no turn settling", async () => {
    // a provider reload ended, or a stalled turn was released: the bot is
    // idle again, and no turn.completed will say so
    const t = setup();
    t.state.fail = true;
    t.finish(job("job_a"));
    await t.fireTimers(); // the merge window: the dispatch fails
    expect(t.wakes).toHaveLength(0);
    const retry = t.timers.find((timer) => !timer.cleared && timer.ms === 30_000);
    expect(retry).toBeDefined();
    t.state.fail = false;
    await t.fireTimers();
    expect(t.wakes.map((wake) => wake.jobIds)).toEqual([["job_a"]]);
  });

  it("retries a wake parked behind a busy bot that went idle without settling", async () => {
    const t = setup();
    t.state.busy.add("bot-a");
    t.finish(job("job_a"));
    await t.fireTimers(); // parked: busy
    expect(t.wakes).toHaveLength(0);
    // still busy at the first retry: parked again, one timer, not two
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    expect(t.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    t.state.busy.delete("bot-a");
    await t.fireTimers();
    expect(t.wakes).toHaveLength(1);
  });

  it("calls the retry off when the bot settles first, or the thread is deleted", async () => {
    const t = setup();
    t.state.busy.add("bot-a");
    t.finish(job("job_a"));
    await t.fireTimers();
    const retry = t.timers.find((timer) => timer.ms === 30_000)!;
    t.state.busy.delete("bot-a");
    t.coordinator.botSettled("bot-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.wakes).toHaveLength(1);
    expect(retry.cleared).toBe(true);

    t.state.busy.add("bot-b");
    t.finish(job("job_b", "thread-b", "bot-b"));
    await t.fireTimers();
    const second = t.timers.find((timer) => timer.ms === 30_000 && !timer.cleared)!;
    t.coordinator.forgetThread("thread-b");
    expect(second.cleared).toBe(true);
  });

  it("writes a prompt a person can read in the thread", () => {
    const prompt = wakePrompt([{ jobId: "j", botId: "b", text: "Background job j `x` finished.", wake: true }]);
    expect(prompt).toContain("Background job j `x` finished.");
    expect(prompt).toMatch(/idle\.  Read/);
  });
});
