import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextOccurrence, RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const threads = new Set<string>();
  const keys = new Map<string, string>();
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const taskActivations: boolean[] = [];
  const taskTitles: string[] = [];
  const emitted: any[] = [];
  const failed: any[] = [];
  const checkInStarts: Array<{ run: any; routine: any }> = [];
  const checkInFinishes: Array<{ run: any; checkInId: string; ok: boolean }> = [];
  let checkInIdSeq = 0;
  let live = true;
  let admitting = true;
  let canStart = true;
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    admit: () => admitting,
    canStart: () => canStart,
    turnLive: () => live,
    createTask: (_botId, title, activate = false, automationKey) => {
      taskActivations.push(activate);
      taskTitles.push(title);
      const threadId = `thread-${++task}`;
      threads.add(threadId);
      if (automationKey) keys.set(automationKey, threadId);
      return { threadId };
    },
    taskForKey: (_botId, automationKey) => keys.get(automationKey),
    stampKey: (_botId, threadId, automationKey) => {
      keys.set(automationKey, threadId);
    },
    taskExists: (_botId, threadId) => threads.has(threadId),
    startTurn: async (botId, threadId, prompt, runOn, triggerSource) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
    },
    onRunFailed: (run) => failed.push(run),
    checkInStart: (run, routine) => {
      checkInStarts.push({ run: { ...run }, routine: { ...routine } });
      return `check-in-${++checkInIdSeq}`;
    },
    checkInFinish: (run, checkInId, ok) => {
      checkInFinishes.push({ run: { ...run }, checkInId, ok });
    },
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    taskTitles,
    runOns,
    triggerSources,
    taskActivations,
    failed,
    checkInStarts,
    checkInFinishes,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
    setLive: (value: boolean) => (live = value),
    setAdmitting: (value: boolean) => (admitting = value),
    setCanStart: (value: boolean) => (canStart = value),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("persists queued receipts while pruning more than 2,000 terminal records", () => {
  const h = harness();
  h.setAdmitting(false);
  const input = { runOn: "bot" as const, webhookId: "retention-hook", webhookName: "Retention", prompt: "Fixture", botId: "bot", receivedAt: 1 };
  const queued = h.manager.enqueueWebhook({ ...input, deliveryId: "queued" });
  h.manager.flushNow();
  const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
  disk.runs = [queued, ...Array.from({ length: 2001 }, (_, i) => ({ ...queued, id: `history-${i}`, deliveryId: `history-${i}`, status: "completed", createdAt: i + 2, finishedAt: i + 3 }))];
  writeFileSync(h.options.file!, JSON.stringify(disk));
  const reloaded = new RoutineManager(h.options);
  const second = reloaded.enqueueWebhook({ ...input, deliveryId: "new-queued" });
  reloaded.flushNow();
  const persisted = JSON.parse(readFileSync(h.options.file!, "utf8"));
  expect(persisted.runs).toHaveLength(2002);
  expect(persisted.runs.filter((run: { status: string }) => run.status === "queued").map((run: { id: string }) => run.id)).toEqual([queued.id, second.id]);
  expect(persisted.runs.some((run: { id: string }) => run.id === "history-0")).toBe(false);
});

it("bounds the prompt snapshot of settled runs older than the newest 100 when it saves", () => {
  const h = harness();
  h.setAdmitting(false);
  const payload = "p".repeat(20_000);
  const prompt = ["Event: deploy.finished", "[UNTRUSTED WEBHOOK EVENT DATA]", payload, "[/UNTRUSTED WEBHOOK EVENT DATA]"].join("\n");
  const input = { runOn: "bot" as const, webhookId: "bound-hook", webhookName: "Bound", prompt, botId: "bot", receivedAt: 1 };
  const queued = h.manager.enqueueWebhook({ ...input, deliveryId: "queued" });
  h.manager.flushNow();
  const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
  disk.runs = [queued, ...Array.from({ length: 105 }, (_, i) => ({ ...queued, id: `history-${i}`, deliveryId: `history-${i}`, status: "completed", createdAt: i + 2, finishedAt: i + 3 }))];
  writeFileSync(h.options.file!, JSON.stringify(disk));
  const reloaded = new RoutineManager(h.options);
  reloaded.enqueueWebhook({ ...input, deliveryId: "new-queued" });
  reloaded.flushNow();
  const persisted = JSON.parse(readFileSync(h.options.file!, "utf8"));
  const byId = new Map(persisted.runs.map((run: { id: string; prompt?: string }) => [run.id, run.prompt]));
  expect(byId.get(queued.id)).toBe(prompt);
  expect(byId.get("history-104")).toBe(prompt);
  expect(byId.get("history-5")).toBe(prompt);
  for (const stale of ["history-0", "history-4"]) {
    const bounded = byId.get(stale) as string;
    expect(bounded.length).toBeLessThan(700);
    expect(bounded.startsWith("Event: deploy.finished\n[UNTRUSTED WEBHOOK EVENT DATA]\n" + "p".repeat(500))).toBe(true);
    expect(bounded.endsWith("\n[/UNTRUSTED WEBHOOK EVENT DATA]")).toBe(true);
  }
});

it("retains the exact result of an unsettled run-now confirmation until its card settles", () => {
  const h = harness();
  h.setAdmitting(false);
  const routine = h.manager.create({ name: "Fixture", prompt: "Check", botId: "bot", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
  const request = { requestId: "retained-request", messageId: "message", botId: "bot", threadId: "thread", action: "run_now" as const, fingerprintVersion: 1 as const, fingerprint: "a".repeat(64) };
  const committed = h.manager.runNow(routine.id, request)!;
  h.manager.flushNow();
  const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
  const terminal = { ...committed, status: "completed", finishedAt: 1 };
  disk.runs = [terminal, ...Array.from({ length: 2001 }, (_, i) => ({ ...terminal, id: `later-${i}`, createdAt: i + 2, finishedAt: i + 3 }))];
  writeFileSync(h.options.file!, JSON.stringify(disk));
  const reloaded = new RoutineManager(h.options);
  reloaded.update(routine.id, { name: "Prune history" });
  reloaded.flushNow();
  const afterPruning = new RoutineManager(h.options);
  expect(afterPruning.runNow(routine.id, request)).toMatchObject({ id: committed.id, status: "completed" });
  expect(afterPruning.listRuns()).toHaveLength(2001);
  afterPruning.forgetRoutineRequestReceipt(request);
  afterPruning.flushNow();
  const settled = new RoutineManager(h.options);
  expect(settled.listRuns()).toHaveLength(2000);
  expect(settled.listRuns().some((run) => run.id === committed.id)).toBe(false);
});

it("coalesces a burst of saves into one write, and stop() flushes a pending save", () => {
  const h = harness();
  // snoozeBot/clearBotSnooze go through the plain debounced save() path, not
  // commitMutation (create/update/etc. carry confirmation receipts and stay
  // synchronous — see the "rolls back an uncommitted confirmation" test).
  h.manager.snoozeBot("bot-a");
  // The debounced save has not landed yet — proves this burst does not each
  // write synchronously the way the pre-fix save() did.
  expect(existsSync(h.options.file!)).toBe(false);
  h.manager.snoozeBot("bot-b");
  h.manager.snoozeBot("bot-c");
  expect(existsSync(h.options.file!)).toBe(false);

  h.manager.stop();

  expect(existsSync(h.options.file!)).toBe(true);
  const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
  expect(disk.botSnoozes).toMatchObject({ "bot-a": null, "bot-b": null, "bot-c": null });
});

it("saves through the atomic writer: unindented JSON and no stray temp file left behind", () => {
  const h = harness();
  h.manager.create({ name: "Fixture", prompt: "Check", botId: "maus-1", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
  h.manager.flushNow();

  const raw = readFileSync(h.options.file!, "utf8");
  expect(raw).not.toContain("\n  ");
  expect(JSON.parse(raw).routines).toHaveLength(1);

  // atomic.test.ts covers writeFileAtomic's own fsync/unique-temp-name
  // guarantees directly; this just confirms routines.ts actually goes
  // through it rather than a raw writeFileSync/renameSync pair — the
  // observable difference is that no `.tmp` file is ever left behind, even
  // transiently, once a save lands.
  const leftovers = readdirSync(dirname(h.options.file!)).filter((name) => name.includes(".tmp"));
  expect(leftovers).toEqual([]);
});

describe("nextOccurrence", () => {
  it("finds the next selected weekday in local wall-clock time", () => {
    const monday = new Date(2026, 7, 17, 10, 0, 0).getTime();
    const next = nextOccurrence({ type: "daily", time: "09:30", weekdays: [1, 3] }, monday)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
  });

  it("returns a one-off only while it is still in the future", () => {
    expect(nextOccurrence({ type: "once", at: 200 }, 100)).toBe(200);
    expect(nextOccurrence({ type: "once", at: 100 }, 100)).toBeNull();
  });

  it("uses an explicit IANA zone through Central DST gaps and folds", () => {
    expect(nextOccurrence(
      { type: "daily", time: "02:30", weekdays: [0], timeZone: "America/Chicago" },
      Date.parse("2026-03-08T06:00:00.000Z"),
    )).toBe(Date.parse("2026-03-08T08:30:00.000Z"));
    expect(nextOccurrence(
      { type: "daily", time: "01:30", weekdays: [0], timeZone: "America/Chicago" },
      Date.parse("2026-11-01T05:00:00.000Z"),
    )).toBe(Date.parse("2026-11-01T06:30:00.000Z"));
  });
});

describe("RoutineManager", () => {
  it("enriches legacy client schedules with the host zone without rewriting their stored semantics", () => {
    const h = harness(Date.parse("2026-09-14T12:00:00.000Z"));
    h.options.timeZone = () => "Europe/Athens";
    const created = h.manager.create({
      name: "Legacy local",
      prompt: "Check",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });

    expect(created.schedule).toEqual({ type: "daily", time: "09:00", weekdays: [1] });
    expect(h.manager.listRoutines()[0].schedule).toEqual({
      type: "daily",
      time: "09:00",
      weekdays: [1],
      timeZone: "Europe/Athens",
    });
    expect(h.manager.listRoutines()[0].scheduleTimeZoneSource).toBe("host");
    expect(h.emitted.at(-1)?.routine.schedule.timeZone).toBe("Europe/Athens");
    expect(h.emitted.at(-1)?.routine.scheduleTimeZoneSource).toBe("host");
    h.manager.flushNow();
    const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
    expect(disk.routines[0].schedule.timeZone).toBeUndefined();

    const clientCopy = h.manager.listRoutines()[0];
    if (clientCopy.schedule.type !== "daily") throw new Error("Expected a daily routine");
    const echoed = h.manager.update(created.id, {
      ...clientCopy,
      schedule: { ...clientCopy.schedule, time: "10:15" },
    });
    expect(echoed?.schedule).toEqual({ type: "daily", time: "10:15", weekdays: [1] });
    expect(h.manager.storedRoutineTimeZone(created.id)).toBeUndefined();
  });

  it("persists an explicit schedule zone and rejects an invalid one", () => {
    const h = harness(Date.parse("2026-09-14T12:00:00.000Z"));
    const created = h.manager.create({
      name: "Central",
      prompt: "Check",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1], timeZone: "America/Chicago" },
    });
    expect(created.nextRunAt).toBe(Date.parse("2026-09-14T14:00:00.000Z"));
    h.manager.flushNow();
    const reloaded = new RoutineManager(h.options).listRoutines()[0];
    expect(reloaded.schedule).toMatchObject({ timeZone: "America/Chicago" });
    const recased = h.manager.create({
      name: "Recased",
      prompt: "Check",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1], timeZone: "america/chicago" },
    });
    expect(recased.schedule).toMatchObject({ timeZone: "America/Chicago" });
    expect(reloaded.scheduleTimeZoneSource).toBe("stored");
    const updated = h.manager.update(created.id, {
      schedule: { type: "daily", time: "10:30", weekdays: [2] },
    });
    expect(updated?.schedule).toEqual({
      type: "daily",
      time: "10:30",
      weekdays: [2],
      timeZone: "America/Chicago",
    });
    expect(() => h.manager.update(created.id, {
      schedule: { type: "daily", time: "09:00", weekdays: [1], timeZone: "Mars/Olympus" },
    })).toThrow("Choose a valid timezone");
  });

  it.each([true, false])("keeps combined receipts pending until their owning execution settles (ok=%s)", async (ok) => {
    const h = harness();
    h.setBot("busy");
    for (let i = 0; i < 3; i++) h.manager.enqueueWebhook({ webhookId: "combined-fixture", webhookName: "Combined fixture",
      prompt: `Synthetic delivery ${i}`, botId: "maus-1", runOn: "bot", deliveryId: `delivery-${i}`, receivedAt: 1000 + i });
    await h.manager.tick();
    h.setBot("ready");
    await h.manager.tick();
    h.setBot("busy");
    const pending = h.manager.listRuns();
    expect(pending.map((run) => run.status)).toEqual(["running", "running", "running"]);
    expect(pending.every((run) => run.finishedAt === undefined)).toBe(true);
    const owner = pending.find((run) => !run.coalescedInto)!;
    expect(pending.filter((run) => run.coalescedInto === owner.id)).toHaveLength(2);
    const base = { eventId: "event", provider: "claude" as const, providerInstanceId: "claude-fixture", threadId: owner.threadId!, createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, type: "session.started", sessionId: "fixture", model: "fixture-model" });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok, stopReason: ok ? "end_turn" : "prompt_timeout", cost: 0.02 });
    const finished = h.manager.listRuns();
    expect(finished.every((run) => run.status === (ok ? "completed" : "failed"))).toBe(true);
    expect(finished.every((run) => run.outcomeCode === (ok ? "completed" : "timeout"))).toBe(true);
    expect(finished.every((run) => run.engineId === "claude-fixture" && run.model === "fixture-model")).toBe(true);
    expect(finished.reduce((sum, run) => sum + (run.cost ?? 0), 0)).toBe(0.02);
    expect(h.failed).toHaveLength(ok ? 0 : 1);
    h.manager.flushNow();
    expect(new RoutineManager(h.options).listRuns()).toEqual(finished);
  });

  it("cancels the owning execution and all combined deliveries when any combined receipt is cancelled", async () => {
    const h = harness();
    h.setBot("busy");
    for (let i = 0; i < 2; i++) h.manager.enqueueWebhook({ webhookId: "combined-cancel", webhookName: "Cancel fixture",
      prompt: "Synthetic delivery", botId: "maus-1", runOn: "bot", deliveryId: `cancel-${i}`, receivedAt: i });
    await h.manager.tick();
    h.setBot("ready");
    await h.manager.tick();
    const child = h.manager.listRuns().find((run) => run.coalescedInto)!;
    await h.manager.cancelRun(child.id);
    expect(h.manager.listRuns().every((run) => run.status === "cancelled" && run.outcomeCode === "cancelled")).toBe(true);
    expect(h.failed).toHaveLength(0);
  });

  it("preserves due work while scheduler admission is fenced", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Deferred update-boundary run",
      prompt: "Run after admission resumes",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    h.setAdmitting(false);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(0);
    expect(h.started).toHaveLength(0);

    h.setAdmitting(true);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.started).toHaveLength(1);
  });

  it("keeps a due run queued until its selected engine prerequisite arrives", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Encrypted engine run",
      prompt: "Run after the key is restored",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    h.setCanStart(false);
    await h.manager.tick();
    expect(h.manager.listRuns()).toMatchObject([{ status: "queued" }]);
    expect(h.started).toHaveLength(0);
    expect(h.taskTitles).toHaveLength(0);

    h.setCanStart(true);
    await h.manager.tick();
    expect(h.manager.listRuns()).toMatchObject([{ status: "running" }]);
    expect(h.started).toHaveLength(1);
  });

  it("does not apply a local engine prerequisite to a cloud routine", async () => {
    const h = harness();
    const admittedTargets: string[] = [];
    h.options.canStart = (_botId, _threadId, runOn) => {
      admittedTargets.push(runOn);
      return runOn === "cloud";
    };
    const routine = h.manager.create({
      name: "Cloud run",
      prompt: "Run in the cloud",
      botId: "maus-1",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(admittedTargets).toContain("cloud");
    expect(h.manager.listRuns()).toMatchObject([{ status: "running", runOn: "cloud" }]);
    expect(h.started).toHaveLength(1);
  });

  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const routineFile = h.options.file;
    if (!routineFile) throw new Error("test harness did not configure routine persistence");
    let failureWasPersistedBeforeCallback = false;
    h.options.onRunFailed = (run) => {
      h.failed.push(run);
      // routines.json is no longer pretty-printed (HS4) — no space after the colon.
      failureWasPersistedBeforeCallback = readFileSync(routineFile, "utf8").includes('"status":"failed"');
    };
    h.manager.flushNow();
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      { routineId: routine.id, routineName: "Morning brief", status: "failed", threadId: "thread-1" },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
    expect(failureWasPersistedBeforeCallback).toBe(true);
    expect(h.failed).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "failed",
        threadId: "thread-1",
        error: "BotFleet restarted while this routine was running",
      },
    ]);
  });

  it("persists confirmation receipts with the scheduler mutation and removes them after settlement", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Before",
      prompt: "Review the queue",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-update-1",
      messageId: "message-1",
      botId: "maus-1",
      threadId: "thread-1",
      action: "update" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "a".repeat(64),
    };
    h.manager.update(routine.id, { name: "After" }, request);
    h.manager.flushNow();

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
    expect(reloaded.routineRequestReceiptOwners()).toEqual([{
      requestId: request.requestId,
      messageId: request.messageId,
      botId: request.botId,
      threadId: request.threadId,
    }]);
    expect(() => reloaded.update(routine.id, { name: "Never applied" }, {
      ...request,
      fingerprint: "b".repeat(64),
    })).toThrow(/does not match/);
    expect(reloaded.listRoutines()[0]!.name).toBe("After");

    expect(reloaded.reconcileRoutineRequestReceipts([request])).toBe(0);
    expect(reloaded.forgetRoutineRequestReceipt(request)).toBe(true);
    reloaded.flushNow();
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("removes unreachable recovery receipts when their conversation is deleted", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cleanup",
      prompt: "Clean unreachable confirmations",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-orphaned-thread",
      messageId: "message-orphaned-thread",
      botId: "maus-1",
      threadId: "thread-deleted",
      action: "pause" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "d".repeat(64),
    };
    h.manager.update(routine.id, { enabled: false }, request);

    expect(h.manager.forgetRoutineRequestReceiptsForThread("another-thread")).toBe(0);
    expect(h.manager.forgetRoutineRequestReceiptsForThread("thread-deleted")).toBe(1);
    h.manager.flushNow();
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("rolls back an uncommitted confirmation when the atomic file write fails", () => {
    const h = harness();
    const file = h.options.file!;
    // A directory at the destination makes the final atomic rename fail
    // after the temporary file has been written.
    mkdirSync(file);
    const request = {
      requestId: "request-create-write-failure",
      messageId: "message-write-failure",
      botId: "maus-1",
      threadId: "thread-1",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "c".repeat(64),
    };
    const input = {
      name: "Retry safely",
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };

    expect(() => h.manager.create(input, request)).toThrow();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.routineRequestReceipt(request.requestId)).toBeNull();
    expect(h.emitted).toEqual([]);

    rmSync(file, { recursive: true, force: true });
    rmSync(`${file}.tmp`, { force: true });
    const routine = h.manager.create(input, request);
    expect(h.manager.listRoutines()).toHaveLength(1);
    expect(h.manager.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
  });

  it("queues behind a busy bot, then dispatches into a detached task", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review queue",
      prompt: "Review the queue",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 45,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("queued");
    expect(h.started).toHaveLength(0);

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-2", threadId: "thread-1", prompt: "Review the queue" }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeRunForBot("maus-2")?.threadId).toBe("thread-1");
    expect(h.manager.isActiveThread("thread-1")).toBe(true);
    expect(h.taskActivations).toEqual([false]);
  });

  it("reuses the previous thread for a later scheduled run of the same routine", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize overnight",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-1",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    expect(h.started).toEqual([{ botId: "maus-1", threadId: "thread-1", prompt: "Summarize overnight" }]);

    const again = h.manager.listRoutines()[0]!;
    h.setNow(again.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toEqual([
      { botId: "maus-1", threadId: "thread-1", prompt: "Summarize overnight" },
      { botId: "maus-1", threadId: "thread-1", prompt: "Summarize overnight" },
    ]);
    expect(h.taskActivations).toEqual([false]);
    expect(h.manager.listRuns().map((run) => run.threadId)).toEqual(["thread-1", "thread-1"]);
  });

  it("cancels queued work when a routine is paused", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Pauseable check",
      prompt: "Check later",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.update(routine.id, { enabled: false });
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
    expect(h.started).toHaveLength(0);
  });

  it("snapshots queued instructions so later edits do not rewrite a receipt", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original brief",
      prompt: "Use the original instructions",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { name: "Edited brief", prompt: "Use the new instructions" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe("Use the original instructions");
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
  });

  it("snapshots and dispatches the selected execution machine", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "VM review",
      prompt: "Review the project on the virtual machine",
      botId: "maus-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { runOn: "bot" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.runOns).toEqual(["cloud"]);
    expect(h.manager.listRuns()[0]).toMatchObject({ runOn: "cloud" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "bot" });
  });

  it("opens webhook jobs in the assigned bot's live chat", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    const queued = h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "cloud",
      deliveryId: "delivery-42",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      routineId: "hook-1",
      webhookId: "hook-1",
      deliveryId: "delivery-42",
      triggerSource: "webhook",
      scheduledFor: receivedAt,
    });
    expect(queued).not.toHaveProperty("durationMinutes");
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "thread-1", prompt: "Handle ticket 42" }]);
    expect(h.runOns).toEqual(["cloud"]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
  });

  it("keeps every delivery of ONE webhook on that webhook's own thread", async () => {
    // it used to mint a task per delivery — a real fleet ended up with 146
    // one-message tasks on a single bot, most of them uptime pings
    const h = harness();
    for (const deliveryId of ["d1", "d2", "d3"]) {
      h.manager.enqueueWebhook({
        webhookId: "hook-1",
        webhookName: "UptimeRobot alerts",
        prompt: `Handle ${deliveryId}`,
        botId: "maus-webhook",
        runOn: "bot",
        deliveryId,
        receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
      });
      await h.manager.tick();
      // SAFETY: the manager reads only these fields off a completion frame.
      h.manager.handleRuntimeEvent({
        type: "turn.completed",
        threadId: "thread-1",
        ok: true,
        cost: 0,
        denials: [],
      } as any);
    }
    expect(h.started.map((row) => row.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
    // and only the first delivery had to mint a task
    expect(h.taskActivations).toEqual([true]);
  });

  it("gives two different webhooks two different threads", async () => {
    // an uptime alert and a Sentry incident are not the same conversation,
    // which a single shared "Triggers" lane could not express
    const h = harness();
    h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "UptimeRobot alerts",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d1",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-1",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    h.manager.enqueueWebhook({
      webhookId: "hook-2",
      webhookName: "Sentry incidents",
      prompt: "Handle page",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d2",
      receivedAt: new Date(2026, 7, 17, 8, 3).getTime(),
    });
    await h.manager.tick();
    const threads = h.started.map((row) => row.threadId);
    expect(threads).toHaveLength(2);
    expect(new Set(threads).size).toBe(2);
  });

  it("names the thread after the routine, not after the lane", async () => {
    const h = harness();
    h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "UptimeRobot alerts",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d1",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    // the person recognises "UptimeRobot alerts", not "Webhooks"
    expect(h.taskTitles).toContain("UptimeRobot alerts");
  });

  it("writes every event into the bot's one conversation in simple mode", async () => {
    const h = harness();
    h.options.conversationMode = () => "simple";
    h.options.defaultThread = () => "chat-thread";
    h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d-simple",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "chat-thread", prompt: "Handle ticket 42" }]);
    expect(h.taskActivations).toEqual([]);
  });

  it("keeps every tick of ONE routine on that routine's thread", async () => {
    // a daily routine used to leave a task behind on every run: five days of
    // "Fleet PR Health Sweep" was five separate one-message conversations
    const h = harness();
    const morning = h.manager.create({
      name: "Morning brief",
      prompt: "Morning",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    for (let day = 0; day < 3; day++) {
      h.setNow(h.manager.listRoutines().find((r) => r.id === morning.id)!.nextRunAt!);
      await h.manager.tick();
      // SAFETY: the manager reads only these fields off a completion frame.
      h.manager.handleRuntimeEvent({
        type: "turn.completed",
        threadId: "thread-1",
        ok: true,
        cost: 0,
        denials: [],
      } as any);
    }
    expect(h.started.map((row) => row.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(h.taskTitles).toEqual(["Morning brief"]);
  });

  it("reuses a stamped key when it is the Simple-mode designated conversation", async () => {
    const h = harness();
    h.options.conversationMode = () => "simple";
    h.options.defaultThread = () => "chat-thread";
    const morning = h.manager.create({
      name: "Morning brief",
      prompt: "Morning",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(morning.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "chat-thread",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    h.setNow(h.manager.listRoutines().find((r) => r.id === morning.id)!.nextRunAt!);
    await h.manager.tick();
    expect(h.started.map((row) => row.threadId)).toEqual(["chat-thread", "chat-thread"]);
    expect(h.taskTitles).toEqual([]);
  });

  it("keeps Simple-mode automation on the designated conversation instead of a hidden extra", async () => {
    const h = harness();
    h.options.conversationMode = () => "simple";
    h.options.defaultThread = () => "chat-thread";
    const hidden = new Set(["hidden-projects-thread"]);
    h.options.taskForKey = () => "hidden-projects-thread";
    h.options.taskExists = (_botId, threadId) => hidden.has(threadId);
    const activations: string[] = [];
    h.options.activateTask = (_botId, threadId) => {
      activations.push(threadId);
    };
    h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "Sentry incidents",
      prompt: "Handle page",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d-hidden",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "chat-thread", prompt: "Handle page" }]);
    expect(activations).toEqual(["chat-thread"]);
    expect(activations).not.toContain("hidden-projects-thread");
  });

  it("live server wiring: simple mode webhook wake reuses bot.threadId without minting", async () => {
    const h = harness();
    h.options.conversationMode = () => "simple";
    h.options.defaultThread = () => "primary-thread";
    h.manager.enqueueWebhook({
      webhookId: "hook-sentry",
      webhookName: "Sentry",
      prompt: "Handle issue",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d-live-1",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "primary-thread", prompt: "Handle issue" }]);
    expect(h.taskTitles).toEqual([]);
  });

  it("reuses the bot's existing thread instead of minting one when defaultThread is set", async () => {
    const h = harness();
    h.options.conversationMode = () => "projects";
    h.options.defaultThread = () => "primary-thread";
    h.manager.enqueueWebhook({
      webhookId: "hook-sentry",
      webhookName: "Sentry",
      prompt: "Handle issue",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d-primary",
      receivedAt: new Date(2026, 7, 17, 8, 2).getTime(),
    });
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "primary-thread", prompt: "Handle issue" }]);
    expect(h.taskTitles).toEqual([]);

    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "primary-thread",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    h.manager.enqueueWebhook({
      webhookId: "hook-pd",
      webhookName: "PagerDuty",
      prompt: "Handle page",
      botId: "maus-webhook",
      runOn: "bot",
      deliveryId: "d-primary-2",
      receivedAt: new Date(2026, 7, 17, 8, 3).getTime(),
    });
    await h.manager.tick();
    expect(h.started.map((row) => row.threadId)).toEqual(["primary-thread", "primary-thread"]);
    expect(h.taskTitles).toEqual([]);
  });

  it("reuses the same thread for a later scheduled run when defaultThread is the primary", async () => {
    const h = harness();
    h.options.conversationMode = () => "simple";
    h.options.defaultThread = () => "primary-thread";
    const morning = h.manager.create({
      name: "Morning brief",
      prompt: "Morning",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(morning.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "primary-thread",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    h.setNow(h.manager.listRoutines().find((r) => r.id === morning.id)!.nextRunAt!);
    await h.manager.tick();
    expect(h.started.map((row) => row.threadId)).toEqual(["primary-thread", "primary-thread"]);
    expect(h.taskTitles).toEqual([]);
  });

  it("gives two different routines two different threads", async () => {
    const h = harness();
    const morning = h.manager.create({
      name: "Morning brief",
      prompt: "Morning",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(morning.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-1",
      ok: true,
      cost: 0,
      denials: [],
    } as any);
    const evening = h.manager.create({
      name: "Evening sweep",
      prompt: "Evening",
      botId: "maus-1",
      schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(evening.nextRunAt!);
    await h.manager.tick();
    const threads = h.started.map((row) => row.threadId);
    expect(new Set(threads).size).toBe(2);
    expect(h.started.map((row) => row.prompt)).toEqual(["Morning", "Evening"]);
    expect(h.taskTitles).toEqual(["Morning brief", "Evening sweep"]);
  });

  it("folds provider lifecycle events into the calendar receipt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "maus-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    h.manager.handleRuntimeEvent({ ...base, type: "request.opened", requestType: "question", tool: "ask", summary: "Need a date" });
    expect(h.manager.listRuns()[0]!.status).toBe("waiting");
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" });
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 });

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
  });

  it("reports a failed run once with its detached thread", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Broken report",
      prompt: "Write the report",
      botId: "maus-failed",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.handleRuntimeEvent({
      eventId: "failed",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "provider crashed",
    });

    expect(h.failed).toMatchObject([
      {
        routineName: "Broken report",
        botId: "maus-failed",
        threadId: "thread-1",
        status: "failed",
        error: "provider crashed",
      },
    ]);
    expect(h.manager.listRuns()[0]).toMatchObject({ threadId: "thread-1", status: "failed" });

    h.manager.markSeen(h.failed[0].id);
    expect(h.failed).toHaveLength(1);
  });

  it("keeps a structured runtime failure when the terminal event has no reason", async () => {
    const h = harness();
    const routine = h.manager.create({ name: "Quota", prompt: "Fixture", botId: "bot", schedule: { type: "once", at: 1 } });
    await h.manager.runNow(routine.id);
    await h.manager.tick();
    const base = { provider: "fake", threadId: "thread-1", createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, eventId: "error", type: "runtime.error", message: "quota_exhausted" });
    h.manager.handleRuntimeEvent({ ...base, eventId: "done", type: "turn.completed", ok: false, stopReason: null });
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", outcomeCode: "quota_exhausted", failurePhase: "execution" });
  });

  it.each(["throw", "callback"])("records a %s dispatch failure without parsing upstream text", async (failure) => {
    const h = harness();
    h.options.startTurn = async (_bot, _thread, _prompt, _runOn, _source, reject) => {
      if (failure === "throw") throw new Error("opaque upstream failure");
      reject("opaque upstream failure");
    };
    const routine = h.manager.create({ name: "Dispatch", prompt: "Fixture", botId: "bot", schedule: { type: "once", at: 1 } });
    await h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", outcomeCode: "dispatch_failed", failurePhase: "dispatch" });
    expect(h.failed).toHaveLength(1);
  });

  it("settles a run the stall watchdog stopped, and a late turn.completed cannot reopen it", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Nightly sweep",
      prompt: "Sweep the workspace",
      botId: "maus-stall",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("running");

    // the harness stopped a wedged turn: the same settle path the dispatch
    // failure uses, called from the watchdog instead of a provider event
    h.manager.failThread("thread-1", "no activity for 20 minutes — the turn was stopped", "timeout");
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "failed",
      error: "no activity for 20 minutes — the turn was stopped",
      outcomeCode: "timeout", failurePhase: "execution",
    });
    // an interrupted provider usually answers with its own terminal event
    // afterwards; that must neither reopen the receipt nor report it twice
    h.manager.handleRuntimeEvent({
      eventId: "late",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "cancelled",
    });
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "failed",
      error: "no activity for 20 minutes — the turn was stopped",
      outcomeCode: "timeout", failurePhase: "execution",
    });
    expect(h.failed).toHaveLength(1);
  });

  it("fails a run whose turn is gone and frees the webhook's pending slot", async () => {
    const start = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const h = harness(start);
    h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "Deploy",
      prompt: "Deploy the build",
      botId: "maus-hook",
      runOn: "bot",
      deliveryId: "delivery-1",
      receivedAt: start,
    });
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeWebhookRunCount("hook-1")).toBe(1);

    // the bot settled without a turn.completed (a crash, a reload, a stall
    // the watchdog missed) — inside the grace the sweep leaves it alone
    h.setLive(false);
    h.setNow(start + 5_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("running");

    h.setNow(start + 31_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "failed",
      error: "The bot stopped before this run finished",
      finishedAt: start + 31_000,
    });
    expect(h.manager.activeWebhookRunCount("hook-1")).toBe(0);
    expect(h.failed).toHaveLength(1);
  });

  it("leaves a run waiting on a person alone while its turn is live", async () => {
    const start = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const h = harness(start);
    const routine = h.manager.create({
      name: "Ask first",
      prompt: "Check with the user",
      botId: "maus-wait",
      schedule: { type: "once", at: start },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "ask",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date(start).toISOString(),
      type: "request.opened",
      requestType: "permission",
      tool: "shell",
      summary: "rm -rf build",
    });
    expect(h.manager.listRuns()[0]!.status).toBe("waiting");

    // a person may take an hour to answer; a live turn is never an orphan
    h.setNow(start + 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("waiting");
    expect(h.failed).toHaveLength(0);
  });

  it("keeps recurring history while advancing the definition", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "maus-4",
      schedule: { type: "daily", time: "08:05", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "done",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeGreaterThan(routine.nextRunAt!);
  });

  it("records a missed receipt instead of launching very stale work", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Old check",
      prompt: "Do the old thing",
      botId: "maus-5",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt! + 13 * 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed" });
    expect(h.started).toHaveLength(0);
  });

  it("records a missed receipt for a once routine created with a long-past time", async () => {
    const h = harness();
    const staleAt = new Date(2026, 7, 16, 6, 0, 0).getTime();
    const routine = h.manager.create({
      name: "Stale check",
      prompt: "Do the stale thing",
      botId: "maus-6",
      schedule: { type: "once", at: staleAt },
    });
    expect(routine.nextRunAt).toBe(staleAt);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed", scheduledFor: staleAt });
    expect(h.started).toHaveLength(0);
  });

  it("runs a once routine created slightly late and records the original scheduled time", async () => {
    const h = harness();
    const lateAt = new Date(2026, 7, 17, 7, 55, 0).getTime();
    const routine = h.manager.create({
      name: "Late check",
      prompt: "Do the late thing",
      botId: "maus-7",
      schedule: { type: "once", at: lateAt },
    });
    expect(routine.nextRunAt).toBe(lateAt);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", scheduledFor: lateAt });
  });

  describe("bot snooze and cancellation", () => {
    it("snoozes a bot and prevents routine dispatch while snoozed", async () => {
      const h = harness();
      const routine = h.manager.create({
        name: "Compiler check",
        prompt: "Check compiler status",
        botId: "compiler-bot",
        schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      });
      h.manager.snoozeBot("compiler-bot");
      expect(h.manager.isBotSnoozed("compiler-bot")).toBe(true);

      h.setNow(routine.nextRunAt! + 1000);
      await h.manager.tick();
      expect(h.started).toHaveLength(0);
      expect(h.manager.listRuns()).toHaveLength(0);

      h.manager.clearBotSnooze("compiler-bot");
      expect(h.manager.isBotSnoozed("compiler-bot")).toBe(false);
      await h.manager.tick();
      expect(h.started).toHaveLength(1);
      expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", botId: "compiler-bot" });
    });

    it("cancels all queued, running, and waiting runs for a bot", async () => {
      const h = harness();
      const r1 = h.manager.enqueueWebhook({
        webhookId: "wh-1",
        webhookName: "Hook 1",
        prompt: "Run 1",
        botId: "compiler-bot",
        runOn: "bot",
        deliveryId: "del-1",
        receivedAt: Date.now(),
      });
      const r2 = h.manager.enqueueWebhook({
        webhookId: "wh-2",
        webhookName: "Hook 2",
        prompt: "Run 2",
        botId: "compiler-bot",
        runOn: "bot",
        deliveryId: "del-2",
        receivedAt: Date.now(),
      });
      const rOther = h.manager.enqueueWebhook({
        webhookId: "wh-3",
        webhookName: "Hook 3",
        prompt: "Run Other",
        botId: "other-bot",
        runOn: "bot",
        deliveryId: "del-3",
        receivedAt: Date.now(),
      });

      expect(h.manager.listRuns().filter((r) => r.botId === "compiler-bot" && ["queued", "running"].includes(r.status))).toHaveLength(2);

      const cancelled = await h.manager.cancelAllRunsForBot("compiler-bot");
      expect(cancelled).toHaveLength(2);
      expect(cancelled.map((r) => r.id)).toEqual([r1.id, r2.id]);
      expect(h.manager.listRuns().find((r) => r.id === r1.id)?.status).toBe("cancelled");
      expect(h.manager.listRuns().find((r) => r.id === r2.id)?.status).toBe("cancelled");
      expect(h.manager.listRuns().find((r) => r.id === rOther.id)?.status).not.toBe("cancelled");
    });

    it("marks newly incoming webhooks and resource triggers as cancelled if bot is snoozed", () => {
      const h = harness();
      h.manager.snoozeBot("compiler-bot");

      const webhookRun = h.manager.enqueueWebhook({
        webhookId: "wh-1",
        webhookName: "Hook 1",
        prompt: "Run while snoozed",
        botId: "compiler-bot",
        runOn: "bot",
        deliveryId: "del-1",
        receivedAt: Date.now(),
      });
      expect(webhookRun.status).toBe("cancelled");
      expect(webhookRun.outcomeCode).toBe("cancelled");

      const resourceRun = h.manager.enqueueResource({
        triggerId: "res-1",
        triggerName: "Res 1",
        prompt: "Resource alert",
        botId: "compiler-bot",
        runOn: "bot",
        deliveryId: "del-2",
        receivedAt: Date.now(),
      });
      expect(resourceRun.status).toBe("cancelled");
    });

    it("requeues cancelled runs and clears snooze on runNow", async () => {
      const h = harness();
      const routine = h.manager.create({
        name: "Build",
        prompt: "Build",
        botId: "compiler-bot",
        schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      });
      h.manager.snoozeBot("compiler-bot");

      const run = h.manager.runNow(routine.id);
      expect(run).not.toBeNull();
      expect(h.manager.isBotSnoozed("compiler-bot")).toBe(false);

      const cancelled = await h.manager.cancelAllRunsForBot("compiler-bot");
      expect(cancelled).toHaveLength(1);
      expect(h.manager.listRuns()[0]?.status).toBe("cancelled");

      const requeued = h.manager.requeueRun(run!.id);
      expect(requeued).toBe(true);
      expect(h.manager.listRuns()[0]?.status).toBe("queued");
    });

    it("persists bot snoozes across manager restarts", () => {
      const h = harness();
      h.manager.snoozeBot("compiler-bot");
      h.manager.snoozeBot("finite-bot", 60_000);
      h.manager.flushNow();
      const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
      expect(disk.botSnoozes).toMatchObject({ "compiler-bot": null, "finite-bot": expect.any(Number) });

      const restarted = new RoutineManager(h.options);
      expect(restarted.isBotSnoozed("compiler-bot")).toBe(true);
      expect(restarted.isBotSnoozed("finite-bot")).toBe(true);

      // An expired finite snooze does not revive after a restart.
      h.setNow(h.options.now!() + 61_000);
      const later = new RoutineManager(h.options);
      expect(later.isBotSnoozed("finite-bot")).toBe(false);
      expect(later.isBotSnoozed("compiler-bot")).toBe(true);
    });

    it("drops a persisted snooze once it is cleared", () => {
      const h = harness();
      h.manager.snoozeBot("compiler-bot");
      h.manager.clearBotSnooze("compiler-bot");
      h.manager.flushNow();
      const restarted = new RoutineManager(h.options);
      expect(restarted.isBotSnoozed("compiler-bot")).toBe(false);
      const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
      expect(disk.botSnoozes ?? {}).not.toHaveProperty("compiler-bot");
    });
  });
});

describe("Sentry Crons check-ins", () => {
  it("opens a check-in only for a genuine schedule-triggered dispatch, and closes it on success", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Housekeeper sweep",
      prompt: "check disk and RAM",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.checkInStarts).toHaveLength(1);
    expect(h.checkInStarts[0].run.routineId).toBe(routine.id);
    expect(h.checkInStarts[0].routine.id).toBe(routine.id);
    const run = h.manager.listRuns()[0]!;
    expect(run.sentryCheckInId).toBe("check-in-1");

    const base = { eventId: "e", provider: "claude" as const, threadId: run.threadId!, createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn" });

    expect(h.checkInFinishes).toHaveLength(1);
    expect(h.checkInFinishes[0]).toMatchObject({ checkInId: "check-in-1", ok: true });
  });

  it("closes the check-in with ok:false when the turn fails", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Monitor sweep",
      prompt: "check uptime",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;

    const base = { eventId: "e", provider: "claude" as const, threadId: run.threadId!, createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: false, stopReason: "prompt_timeout" });

    expect(h.checkInFinishes).toHaveLength(1);
    expect(h.checkInFinishes[0]).toMatchObject({ checkInId: "check-in-1", ok: false });
  });

  it("closes the check-in with ok:false for an orphaned run the stall sweep gives up on", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Deployer sweep",
      prompt: "ship it",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.setLive(false);
    h.setNow(h.options.now!() + 6 * 60_000);
    await h.manager.tick();

    expect(h.checkInFinishes).toHaveLength(1);
    expect(h.checkInFinishes[0]).toMatchObject({ checkInId: "check-in-1", ok: false });
  });

  it("closes the check-in with ok:false when a running scheduled run is cancelled", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cancel sweep",
      prompt: "check disk",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;

    await h.manager.cancelRun(run.id);
    const base = { eventId: "e", provider: "claude" as const, threadId: run.threadId!, createdAt: new Date().toISOString() };
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: false, stopReason: "interrupted" });

    expect(h.checkInFinishes).toHaveLength(1);
    expect(h.checkInFinishes[0]).toMatchObject({ checkInId: "check-in-1", ok: false });
  });

  it("closes the check-in with ok:false for a run recovered after a restart", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Restart sweep",
      prompt: "check uptime",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.sentryCheckInId).toBe("check-in-1");
    h.manager.flushNow();

    const reloaded = new RoutineManager(h.options);

    expect(reloaded.listRuns()[0]).toMatchObject({ status: "failed", outcomeCode: "runtime_restart" });
    expect(h.checkInFinishes).toHaveLength(1);
    expect(h.checkInFinishes[0]).toMatchObject({ checkInId: "check-in-1", ok: false });
  });

  it("never opens a check-in for a webhook, resource, or manual dispatch", async () => {
    const h = harness();
    h.manager.enqueueWebhook({
      webhookId: "wh-1",
      webhookName: "Fixture hook",
      prompt: "handle delivery",
      botId: "maus-1",
      runOn: "bot",
      deliveryId: "delivery-1",
      receivedAt: 1,
    });
    await h.manager.tick();
    expect(h.checkInStarts).toHaveLength(0);

    const routine = h.manager.create({
      name: "Manual-only routine",
      prompt: "run when asked",
      botId: "maus-1",
      schedule: { type: "once", at: h.options.now!() + 60_000 },
    });
    h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.checkInStarts).toHaveLength(0);
  });

  it("hands the live routine (including its schedule) to checkInStart — whether a schedule is recurring enough to watch is the callback's call, not routines.ts's", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "One-time reminder",
      prompt: "do the thing once",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.checkInStarts).toHaveLength(1);
    expect(h.checkInStarts[0].routine.schedule).toEqual({ type: "once", at: routine.nextRunAt });
  });
});
