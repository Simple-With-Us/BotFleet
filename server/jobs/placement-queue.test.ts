// The placement queue (native server mode plan, slice 8a, server half):
// per-host cap and pressure queue instead of refusing, and the drain starts
// queued jobs oldest-first with per-bot FIFO.  A fake spawn (bookkeeping,
// not processes) and an injected clock, one temp folder per test.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JobSnapshot } from "../../shared/jobs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DEFAULT_JOBS_SETTINGS, DEFAULT_QUEUE_WINDOW_MS, JobRegistry, type JobRegistryDeps, type JobsSettings } from "./registry.ts";
import type { JobSpawnResult, JobSpawnSpec } from "./runner.ts";
import type { ChildProcess } from "node:child_process";

interface Harness {
  registry: JobRegistry;
  dir: string;
  host: { swap: number | null; disk: number | null; spend: boolean };
  clock: { now: number };
  awake: { now: number };
  settings: { value: JobsSettings };
}

const made: string[] = [];
const registries: JobRegistry[] = [];

function fakeSpawn() {
  const children: Array<{ spec: JobSpawnSpec; child: EventEmitter & { pid: number } }> = [];
  let pid = 2_000_000_000;
  const spawnFn = (spec: JobSpawnSpec): JobSpawnResult => {
    const child = Object.assign(new EventEmitter(), { pid: pid++ });
    children.push({ spec, child });
    // SAFETY: the registry reads only `on("exit" | "error")` off the child,
    // which an EventEmitter provides; nothing else of ChildProcess is used.
    return { ok: true, child: child as ChildProcess, pid: child.pid };
  };
  return { spawnFn, children };
}

function harness(overrides: Partial<JobRegistryDeps> = {}) {
  const { spawnFn, children } = fakeSpawn();
  const root = mkdtempSync(join(tmpdir(), "omb-placement-queue-"));
  const clock = { now: 1_700_000_000_000 };
  const awake = { now: 1_000 };
  const host: Harness["host"] = { swap: 50, disk: 100 * 1024 ** 3, spend: false };
  const settings = { value: { ...DEFAULT_JOBS_SETTINGS } };
  const registry = new JobRegistry({
    dir: join(root, "jobs"),
    dataDir: root,
    settings: () => settings.value,
    spendBlocked: () => host.spend,
    broadcast: () => undefined,
    probe: { swapUsedPercent: () => host.swap, freeDiskBytes: () => host.disk },
    now: () => clock.now,
    awakeNow: () => awake.now,
    spawn: spawnFn,
    listProcesses: async () => [],
    platform: "darwin",
    ...overrides,
  });
  made.push(root);
  registries.push(registry);
  return { h: { registry, dir: root, host, clock, awake, settings }, children, spawnFn };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const dir of made.splice(0)) await removeTempDir(dir);
});

const start = (h: Harness, command: string, threadId: string, botId: string) => {
  h.clock.now += 1000;
  return h.registry.start({ botId, threadId, command, cwd: h.dir, onComplete: "wake" });
};

const runningIds = (h: Harness, n: number, botPrefix = "bot") => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const started = start(h, `host job ${i}`, `host-thread-${i}`, `${botPrefix}-${i % 4}`);
    if (!started.ok) throw new Error(started.error);
    if (started.job.status !== "running") throw new Error(`expected running, got ${started.job.status}`);
    ids.push(started.job.id);
  }
  return ids;
};

describe("placement queue", () => {
  it("queues past the host cap in a server mode and refuses in This Mac Only", () => {
    const server = harness({ placementMode: () => "serverFirst" });
    runningIds(server.h, 8);
    const queued = start(server.h, "ninth job", "queue-thread", "queue-bot");
    if (!queued.ok) throw new Error(queued.error);
    expect(queued.job.status).toBe("queued");
    expect(queued.job.queuedReason).toMatch(/8 background jobs/);
    expect(queued.note).toMatch(/Queued:/);

    const local = harness();
    runningIds(local.h, 8);
    const refused = start(local.h, "ninth job", "queue-thread", "queue-bot");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.error).toMatch(/8 background jobs/);
  });

  it("drains oldest-first and never lets one bot overtake its own earlier job", () => {
    const { h, children } = harness({ placementMode: () => "serverFirst" });
    runningIds(h, 8);
    const a1 = start(h, "cmd-a1", "ta", "bot-a");
    const b1 = start(h, "cmd-b1", "tb", "bot-b");
    const a2 = start(h, "cmd-a2", "ta", "bot-a");
    if (!a1.ok || !b1.ok || !a2.ok) throw new Error("expected three queued jobs");
    expect([a1.job.status, b1.job.status, a2.job.status]).toEqual(["queued", "queued", "queued"]);
    const before = children.length;
    children[0]!.child.emit("exit", 0, null);
    expect(h.registry.get(a1.job.id)?.status).toBe("running");
    children[1]!.child.emit("exit", 0, null);
    expect(h.registry.get(b1.job.id)?.status).toBe("running");
    children[2]!.child.emit("exit", 0, null);
    expect(h.registry.get(a2.job.id)?.status).toBe("running");
    expect(children.slice(before).map((child) => child.spec.command)).toEqual(["cmd-a1", "cmd-b1", "cmd-a2"]);
    const snapshot: JobSnapshot | null = h.registry.get(a1.job.id);
    expect(snapshot?.queuedReason).toBeUndefined();
  });

  it("queues on memory pressure in every mode and resumes when it clears", () => {
    const { h } = harness();
    h.host.disk = 1;
    const queued = start(h, "pressured job", "pt", "bot-p");
    if (!queued.ok) throw new Error(queued.error);
    expect(queued.job.status).toBe("queued");
    expect(queued.job.queuedReason).toMatch(/short on disk space/);
    // The drain refreshes the reason while pressure holds instead of starting.
    h.registry.drainQueue();
    expect(h.registry.get(queued.job.id)?.status).toBe("queued");
    h.host.disk = 100 * 1024 ** 3;
    h.registry.drainQueue();
    expect(h.registry.get(queued.job.id)?.status).toBe("running");
  });

  it("lets another bot's job pass one this process never accepted, without launching it", async () => {
    const first = harness({ placementMode: () => "serverFirst" });
    runningIds(first.h, 8);
    const aOld = start(first.h, "cmd-a-old", "ta", "bot-a");
    if (!aOld.ok) throw new Error("expected a queued job");
    // A restart: the new registry reads the queued records back but holds
    // no command for them, so the old job stays queued for its controller.
    const second = harness({ placementMode: () => "serverFirst" });
    second.h.clock.now = first.h.clock.now;
    const restarted = new JobRegistry({
      dir: join(first.h.dir, "jobs"),
      dataDir: first.h.dir,
      settings: () => second.h.settings.value,
      spendBlocked: () => false,
      broadcast: () => undefined,
      probe: { swapUsedPercent: () => 50, freeDiskBytes: () => 100 * 1024 ** 3 },
      now: () => second.h.clock.now,
      awakeNow: () => second.h.awake.now,
      spawn: second.spawnFn,
      listProcesses: async () => [],
      platform: "darwin",
      placementMode: () => "serverFirst" as const,
    });
    registries.push(restarted);
    await restarted.adopt();
    expect(restarted.get(aOld.job.id)?.status).toBe("queued");
    // Fill this process's host again, then queue a newer job for another bot.
    for (let i = 0; i < 8; i++) {
      second.h.clock.now += 1000;
      const started = restarted.start({ botId: `host-bot-${i % 4}`, threadId: `host-thread-${i}`, command: `host job ${i}`, cwd: first.h.dir, onComplete: "wake" });
      if (!started.ok) throw new Error("expected the filler to run");
      expect(started.job.status).toBe("running");
    }
    second.h.clock.now += 1000;
    const bNew = restarted.start({ botId: "bot-b", threadId: "tb", command: "cmd-b-new", cwd: first.h.dir, onComplete: "wake" });
    if (!bNew.ok) throw new Error("expected b-new to queue");
    expect(bNew.job.status).toBe("queued");
    // A slot frees: the job this process never accepted stays queued while
    // the newer job of another bot takes the slot.
    second.children[0]!.child.emit("exit", 0, null);
    expect(restarted.get(aOld.job.id)?.status).toBe("queued");
    expect(restarted.get(bNew.job.id)?.status).toBe("running");
    expect(second.children.at(-1)!.spec.command).toBe("cmd-b-new");
  });

  it("a restart-read queued job holds no thread or bot slot and never launches", async () => {
    const first = harness();
    first.h.host.disk = 1;
    const old = start(first.h, "old cmd", "t", "bot-a");
    if (!old.ok) throw new Error(old.error);
    expect(old.job.status).toBe("queued");
    // A restart with no queue window (production-like): the record stays
    // queued for its controller, but this process holds no command for it.
    const second = harness();
    second.h.clock.now = first.h.clock.now;
    const restarted = new JobRegistry({
      dir: join(first.h.dir, "jobs"),
      dataDir: first.h.dir,
      settings: () => second.h.settings.value,
      spendBlocked: () => false,
      broadcast: () => undefined,
      probe: { swapUsedPercent: () => 50, freeDiskBytes: () => 100 * 1024 ** 3 },
      now: () => second.h.clock.now,
      awakeNow: () => second.h.awake.now,
      spawn: second.spawnFn,
      listProcesses: async () => [],
      platform: "darwin",
    });
    registries.push(restarted);
    await restarted.adopt();
    expect(restarted.get(old.job.id)?.status).toBe("queued");
    // It holds no admission slot: the same thread and bot may still fill
    // their whole caps with new work.
    expect(restarted.refusal({ botId: "bot-a", threadId: "t" })).toBeNull();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      second.h.clock.now += 1000;
      const started = restarted.start({ botId: "bot-a", threadId: "t", command: `new cmd ${i}`, cwd: first.h.dir, onComplete: "wake" });
      if (!started.ok) throw new Error(started.error);
      expect(started.job.status).toBe("running");
      ids.push(started.job.id);
    }
    expect(ids).toHaveLength(3);
    expect(restarted.get(old.job.id)?.status).toBe("queued");
    // Nothing this process never accepted ever launched.
    expect(second.children.map((child) => child.spec.command).sort()).toEqual(["new cmd 0", "new cmd 1", "new cmd 2"]);
  });

  it("a newer queued job of the same bot passes one this process never accepted", async () => {
    const first = harness({ placementMode: () => "serverFirst" });
    runningIds(first.h, 8);
    const aOld = start(first.h, "cmd-a-old", "ta", "bot-a");
    if (!aOld.ok) throw new Error("expected a queued job");
    const second = harness({ placementMode: () => "serverFirst" });
    second.h.clock.now = first.h.clock.now;
    const restarted = new JobRegistry({
      dir: join(first.h.dir, "jobs"),
      dataDir: first.h.dir,
      settings: () => second.h.settings.value,
      spendBlocked: () => false,
      broadcast: () => undefined,
      probe: { swapUsedPercent: () => 50, freeDiskBytes: () => 100 * 1024 ** 3 },
      now: () => second.h.clock.now,
      awakeNow: () => second.h.awake.now,
      spawn: second.spawnFn,
      listProcesses: async () => [],
      platform: "darwin",
      placementMode: () => "serverFirst" as const,
    });
    registries.push(restarted);
    await restarted.adopt();
    for (let i = 0; i < 8; i++) {
      second.h.clock.now += 1000;
      const started = restarted.start({ botId: `host-bot-${i % 4}`, threadId: `host-thread-${i}`, command: `host job ${i}`, cwd: first.h.dir, onComplete: "wake" });
      if (!started.ok) throw new Error("expected the filler to run");
      expect(started.job.status).toBe("running");
    }
    second.h.clock.now += 1000;
    const aNew = restarted.start({ botId: "bot-a", threadId: "ta", command: "cmd-a-new", cwd: first.h.dir, onComplete: "wake" });
    if (!aNew.ok) throw new Error("expected a-new to queue");
    expect(aNew.job.status).toBe("queued");
    // A slot frees: the unlaunchable head of bot-a's line must not block its
    // newer queued job, which takes the slot without launching the old one.
    second.children[0]!.child.emit("exit", 0, null);
    expect(restarted.get(aOld.job.id)?.status).toBe("queued");
    expect(restarted.get(aNew.job.id)?.status).toBe("running");
    expect(second.children.at(-1)!.spec.command).toBe("cmd-a-new");
    expect(second.children.every((child) => child.spec.command !== "cmd-a-old")).toBe(true);
  });

  it("a restart-read queued job expires past its window without ever launching", async () => {
    const first = harness();
    first.h.host.disk = 1;
    const old = start(first.h, "old cmd", "t", "bot-a");
    if (!old.ok) throw new Error(old.error);
    const second = harness({ queueWindowMs: 60_000 });
    second.h.clock.now = first.h.clock.now;
    const restarted = new JobRegistry({
      dir: join(first.h.dir, "jobs"),
      dataDir: first.h.dir,
      settings: () => second.h.settings.value,
      spendBlocked: () => false,
      broadcast: () => undefined,
      probe: { swapUsedPercent: () => 50, freeDiskBytes: () => 100 * 1024 ** 3 },
      now: () => second.h.clock.now,
      awakeNow: () => second.h.awake.now,
      spawn: second.spawnFn,
      listProcesses: async () => [],
      platform: "darwin",
      queueWindowMs: 60_000,
    });
    registries.push(restarted);
    await restarted.adopt();
    expect(restarted.get(old.job.id)?.status).toBe("queued");
    second.h.clock.now += 61_000;
    second.h.awake.now += 5_000;
    restarted.tick();
    expect(restarted.get(old.job.id)?.status).toBe("lost");
    expect(restarted.get(old.job.id)?.reason).toMatch(/no host could take it/);
    expect(second.children).toHaveLength(0);
  });

  it("expires a queued job past its window and kills a queued job on demand", async () => {
    const { h } = harness({ placementMode: () => "serverFirst", queueWindowMs: 60_000 });
    runningIds(h, 8);
    const queued = start(h, "doomed queue", "tq", "bot-q");
    if (!queued.ok) throw new Error(queued.error);
    h.clock.now += 61_000;
    h.awake.now += 5_000;
    h.registry.tick();
    expect(h.registry.get(queued.job.id)?.status).toBe("lost");
    expect(h.registry.get(queued.job.id)?.reason).toMatch(/no host could take it/);

    const killable = start(h, "kill me queued", "tk", "bot-q");
    if (!killable.ok) throw new Error(killable.error);
    expect(killable.job.status).toBe("queued");
    const killed = await h.registry.kill(killable.job.id, "model");
    expect(killed.ok).toBe(true);
    expect(killed.job?.status).toBe("killed");
  });

  it("expires a queued job under the default window when no window is configured", () => {
    // The fail-safe default is the longest run any job is allowed, so this
    // test names the exported constant instead of a magic duration.
    expect(DEFAULT_QUEUE_WINDOW_MS).toBe(240 * 60_000);
    const { h } = harness({ placementMode: () => "serverFirst" });
    runningIds(h, 8);
    const queued = start(h, "doomed queue", "tq", "bot-q");
    if (!queued.ok) throw new Error(queued.error);
    expect(queued.job.status).toBe("queued");
    // Just inside the default window the job still waits for its slot.
    h.clock.now += DEFAULT_QUEUE_WINDOW_MS - 1_000;
    h.awake.now += 5_000;
    h.registry.tick();
    expect(h.registry.get(queued.job.id)?.status).toBe("queued");
    // Past it the job expires unrun instead of accumulating without limit.
    h.clock.now += 2_000;
    h.awake.now += 5_000;
    h.registry.tick();
    expect(h.registry.get(queued.job.id)?.status).toBe("lost");
    expect(h.registry.get(queued.job.id)?.reason).toMatch(/no host could take it within 240 minutes/);
  });
});
