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
  const state = { busy: new Set<string>(), rooms: new Set<string>(), wake: true, spend: false, fail: false, noTools: new Set<string>() };
  const coordinator = new JobWakeCoordinator({
    wakeEnabled: () => state.wake,
    isRoom: (threadId) => state.rooms.has(threadId),
    botBusy: (botId) => state.busy.has(botId),
    botHasJobTools: (botId) => !state.noTools.has(botId),
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

  it("does not wake a bot whose engine has no job tools, and keeps its notice for the next turn", async () => {
    const t = setup();
    // switched to a CLI engine while its job ran
    t.state.noTools.add("bot-a");
    t.finish(job("job_switched", "thread-e", "bot-a"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    expect(t.queue.get("thread-e")).toHaveLength(1);
    expect(t.coordinator.wakesLeft("thread-e")).toBe(3);
    // another bot, on an engine that has them, is woken as ever
    t.finish(job("job_other", "thread-f", "bot-b"));
    await t.fireTimers();
    expect(t.wakes.map((wake) => wake.threadId)).toEqual(["thread-f"]);
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

describe("a busy command-line bot is steered, not woken (jobs P2)", () => {
  function steerSetup(options: { steer?: boolean } = {}) {
    const steers: Array<{ botId: string; threadId: string; prompt: string }> = [];
    const t = setup({
      steerBusyNotice: (botId, threadId, prompt) => {
        if (options.steer === false) return false;
        steers.push({ botId, threadId, prompt });
        return true;
      },
    });
    t.state.busy.add("bot-a");
    return { ...t, steers };
  }

  it("steers the notice onto the running turn and spends no wake", async () => {
    const t = steerSetup();
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.steers).toHaveLength(1);
    expect(t.steers[0]).toMatchObject({ botId: "bot-a", threadId: "thread-a" });
    // The whole point: no new turn, so nothing for the bot to be woken into.
    expect(t.wakes).toHaveLength(0);
    // And the notice left the queue, because the running turn took it.
    expect(t.queue.get("thread-a") ?? []).toHaveLength(0);
  });

  it("says the job ended while the bot was working, not while it was idle", async () => {
    const t = steerSetup();
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.steers[0]!.prompt).toMatch(/ended while you were working/);
    expect(t.steers[0]!.prompt).not.toMatch(/while you were idle/);
  });

  it("does not schedule a retry, so a busy bot cannot be woken in a loop", async () => {
    const t = steerSetup();
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.wakes).toHaveLength(0);
    // The parking timer is the loop: none was armed, so there is nothing to
    // re-fire and no wake to spend on the next settle either.
    expect(t.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
    t.coordinator.botSettled("bot-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.wakes).toHaveLength(0);
    expect(t.steers).toHaveLength(1);
  });

  it("puts the notice back and parks when the engine cannot steer", async () => {
    // An engine with no steer (every ACP engine but Claude) leaves the notice
    // queued for its next turn's opening reminder — which is the same channel
    // it already used, so nothing is lost.
    const t = steerSetup({ steer: false });
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.steers).toHaveLength(0);
    expect(t.wakes).toHaveLength(0);
    expect(t.queue.get("thread-a") ?? []).toHaveLength(1);
    // Parked, so the settle that ends the turn still finds it waiting.
    expect(t.timers.some((timer) => timer.ms === 30_000 && !timer.cleared)).toBe(true);
    t.state.busy.delete("bot-a");
    t.coordinator.botSettled("bot-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.wakes).toHaveLength(1);
  });

  it("wakes an IDLE command-line bot as before, rather than steering into nothing", async () => {
    const t = steerSetup();
    t.state.busy.delete("bot-a");
    t.finish(job("job_a"));
    await t.fireTimers();
    expect(t.steers).toHaveLength(0);
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt).toMatch(/while you were idle/);
  });
});
