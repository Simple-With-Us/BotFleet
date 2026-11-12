// The registry bridge (native server mode plan, slice T4):  a job start in a
// server mode becomes an admission into the controller's own queue, a host
// that does not hold the controller refuses with a reason and keeps no local
// waiting list, and This Mac Only behaves exactly as it always has.
//
// The bridge is exercised against a real lease service over its durable epoch
// store, so the fence the messages carry is the fence the authority holds and
// not a number the test made up.  The registry half uses a fake spawn
// (bookkeeping, not processes) and an injected clock.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { PLACEMENT_WIRE_VERSION, type CapacitySample, type EnqueueMessage, type HostId } from "../shared/placement.ts";
import { JOB_CAP_PER_BOT, JOB_CAP_PER_HOST, JOB_CAP_PER_THREAD, JOB_RECORD_MAX } from "../shared/jobs.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openControllerEpochStore } from "./placement-identity.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import { PlacementModeStore } from "./placement-mode-store.ts";
import { PlacementControllerBridge, type PlacementBridgeView } from "./placement-controller-bridge.ts";
import { DEFAULT_JOBS_SETTINGS, JobRegistry, type JobRegistryDeps } from "./jobs/registry.ts";
import type { JobSpawnResult, JobSpawnSpec } from "./jobs/runner.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const otherHost: HostId = "server:22222222-2222-4222-8222-222222222222";

// A complete capacity sample:  the register route parses it strictly, so the
// helper carries every field the wire shape requires.
const sample: CapacitySample = {
  at: 1,
  cores: null,
  loadPerCore: null,
  ramTotalBytes: null,
  ramAvailableBytes: null,
  memoryPressure: null,
  memoryAvailablePercent: null,
  swapTotalBytes: null,
  swapUsedBytes: null,
  diskTotalBytes: null,
  diskFreeBytes: null,
  inodesTotal: null,
  inodesFree: null,
  dataVolume: null,
  rootDiskFreeBytes: null,
};

const made: string[] = [];
const registries: JobRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const dir of made.splice(0)) await removeTempDir(dir);
});

/** The bridge over a real lease service, with the mode record written the
 *  way the owner writes it. */
function fixture(options: { mode?: "localOnly" | "serverFirst"; acknowledge?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-"));
  made.push(dir);
  const epochStore = openControllerEpochStore(dir, controllerId);
  const leases = new PlacementLeaseService({
    hostId: controllerId,
    controller: epochStore.read(),
    controllerStore: epochStore,
  });
  const store = new PlacementModeStore(join(dir, "jobs"), {
    controller: () => leases.controller(),
    hostId: controllerId,
    now: () => 1_700_000_000_000,
  });
  const mode = options.mode ?? "serverFirst";
  if (options.acknowledge !== false) {
    store.apply({
      mode,
      controllerId: leases.controller().controllerId,
      epoch: leases.controller().epoch,
      // This Mac Only names no server;  a server mode names this host.
      serverId: mode === "localOnly" ? null : controllerId,
      allowOverflowToThisMac: false,
    });
  }
  const enqueued: EnqueueMessage[] = [];
  const bridge = new PlacementControllerBridge({
    hostId: controllerId,
    view: () => {
      const view = store.read();
      return {
        mode: view.record.mode,
        controllerId: view.controller.controllerId,
        epoch: view.controller.epoch,
        acknowledged: view.acknowledged,
      } satisfies PlacementBridgeView;
    },
    enqueue: (message) => {
      enqueued.push(message);
      return leases.enqueue(message);
    },
    queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
    sweepUnreachable: () => leases.sweepUnreachable(),
  });
  return { dir, leases, store, bridge, enqueued };
}

const request = {
  jobId: "job_1700000000000_abcdef",
  botId: "bot_1",
  threadId: "thread_1",
  command: "sleep 1",
  cwd: "/tmp",
  timeoutMs: 60_000,
};

describe("the registry bridge in This Mac Only", () => {
  it("runs the job here and never touches the queue", () => {
    const { bridge, enqueued } = fixture({ mode: "localOnly" });
    expect(bridge.admit(request)).toEqual({ kind: "local" });
    expect(enqueued).toEqual([]);
  });

  it("treats an unwritten record as This Mac Only", () => {
    const { bridge, enqueued } = fixture({ acknowledge: false });
    expect(bridge.admit(request)).toEqual({ kind: "local" });
    expect(enqueued).toEqual([]);
  });
});

describe("the registry bridge in a server mode on the controller", () => {
  it("admits the job into the controller's own queue", () => {
    const { bridge, enqueued, leases } = fixture();
    const admission = bridge.admit(request);
    expect(admission.kind).toBe("queued");
    if (admission.kind !== "queued") return;
    expect(admission.jobId).toBe(request.jobId);
    expect(admission.queuedReason).toBe("waiting for an eligible host");
    expect(admission.duplicate).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      version: PLACEMENT_WIRE_VERSION,
      jobId: request.jobId,
      botId: request.botId,
      threadId: request.threadId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    });
    expect(enqueued[0]?.controllerId).toBe(controllerId);
    expect(enqueued[0]?.epoch).toBe(leases.controller().epoch);
  });

  it("reports a replay of the same job as a duplicate, and enqueues nothing twice", () => {
    const { bridge, enqueued } = fixture();
    bridge.admit(request);
    const second = bridge.admit(request);
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") return;
    expect(second.duplicate).toBe(true);
    expect(enqueued).toHaveLength(2);
  });

  it("refuses a job the queue itself refuses, with the queue's reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-refuse-"));
    made.push(dir);
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const store = new PlacementModeStore(join(dir, "jobs"), {
      controller: () => leases.controller(),
      hostId: controllerId,
    });
    const view = store.read();
    const bridge = new PlacementControllerBridge({
      hostId: controllerId,
      view: () => ({
        mode: "serverFirst",
        controllerId: view.controller.controllerId,
        epoch: view.controller.epoch,
        acknowledged: true,
      }),
      enqueue: () => ({ ok: false, reason: "the queue is full" }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
    });
    const admission = bridge.admit(request);
    expect(admission).toEqual({ kind: "refused", reason: "the queue is full" });
  });
});

describe("the registry bridge on a host that does not hold the controller", () => {
  it("refuses the start with a reason and enqueues nothing when forwarding is not configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-other-"));
    made.push(dir);
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const enqueued: EnqueueMessage[] = [];
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId: leases.controller().controllerId,
        epoch: leases.controller().epoch,
        acknowledged: true,
      }),
      enqueue: (message) => {
        enqueued.push(message);
        return leases.enqueue(message);
      },
      queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
      sweepUnreachable: () => leases.sweepUnreachable(),
    });
    const admission = bridge.admit(request);
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.reason).toContain("does not admit jobs of its own");
    expect(admission.reason).toContain("Run the command with bash if it is short");
    expect(enqueued).toEqual([]);
  });

  it("forwards the job start to the controller when a forwarder is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-fwd-"));
    made.push(dir);
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const forwarded: EnqueueMessage[] = [];
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId: leases.controller().controllerId,
        epoch: leases.controller().epoch,
        acknowledged: true,
      }),
      enqueue: () => ({ ok: false, reason: "local enqueue should not be called on non-controller" }),
      queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
      sweepUnreachable: () => leases.sweepUnreachable(),
      forward: (message) => {
        forwarded.push(message);
        return leases.enqueue(message);
      },
    });
    const admission = bridge.admit(request);
    expect(admission.kind).toBe("queued");
    if (admission.kind !== "queued") return;
    expect(admission.jobId).toBe(request.jobId);
    expect(admission.queuedReason).toBe("waiting for an eligible host");
    expect(admission.controllerId).toBe(controllerId);
    expect(admission.epoch).toBe(leases.controller().epoch);
    expect(admission.duplicate).toBe(false);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      version: PLACEMENT_WIRE_VERSION,
      controllerId,
      epoch: leases.controller().epoch,
      jobId: request.jobId,
      botId: request.botId,
      threadId: request.threadId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    });
  });

  it("reports a forwarded duplicate job correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-fwd-dup-"));
    made.push(dir);
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId: leases.controller().controllerId,
        epoch: leases.controller().epoch,
        acknowledged: true,
      }),
      enqueue: () => ({ ok: false, reason: "local enqueue should not be called" }),
      queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
      sweepUnreachable: () => leases.sweepUnreachable(),
      forward: (message) => leases.enqueue(message),
    });
    bridge.admit(request);
    const second = bridge.admit(request);
    expect(second.kind).toBe("queued");
    if (second.kind !== "queued") return;
    expect(second.duplicate).toBe(true);
  });

  it("refuses when the forwarded controller admission is refused", () => {
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId,
        epoch: 5,
        acknowledged: true,
      }),
      enqueue: () => ({ ok: false, reason: "local enqueue should not be called" }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
      forward: () => ({
        ok: true,
        reply: {
          accepted: false,
          jobId: request.jobId,
          status: "refused",
          controllerId,
          epoch: 5,
          reason: "controller rejected queue admission",
        },
      }),
    });
    const admission = bridge.admit(request);
    expect(admission).toEqual({ kind: "refused", reason: "controller rejected queue admission" });
  });

  it("refuses when the forwarder reports a transport failure", () => {
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId,
        epoch: 5,
        acknowledged: true,
      }),
      enqueue: () => ({ ok: false, reason: "local enqueue should not be called" }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
      forward: () => ({ ok: false, reason: "connection to controller timed out" }),
    });
    const admission = bridge.admit(request);
    expect(admission).toEqual({ kind: "refused", reason: "connection to controller timed out" });
  });

  it("refuses when placement mode is not acknowledged even if forwarder is present", () => {
    const forwarded: EnqueueMessage[] = [];
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId,
        epoch: 5,
        acknowledged: false,
      }),
      enqueue: () => ({ ok: false, reason: "local enqueue should not be called" }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
      forward: (msg) => {
        forwarded.push(msg);
        return { ok: true, reply: { accepted: true, jobId: request.jobId, status: "queued", controllerId, epoch: 5 } };
      },
    });
    const admission = bridge.admit(request);
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.reason).toContain("not held at the current fence");
    expect(forwarded).toEqual([]);
  });

  it("refuses a record that is not held at the current fence", () => {
    const { bridge, enqueued } = fixture({ acknowledge: false });
    const admission = bridge.admit(request);
    // An unwritten record is This Mac Only; a written one at a stale fence
    // is the case this refusal is about, so the view says the fence moved.
    expect(admission.kind).toBe("local");
    expect(enqueued).toEqual([]);

    const stale = new PlacementControllerBridge({
      hostId: controllerId,
      view: () => ({ mode: "serverFirst", controllerId, epoch: 9, acknowledged: false }),
      enqueue: () => ({ ok: true, reply: { accepted: true, jobId: request.jobId, status: "queued", controllerId, epoch: 9 } }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
    });
    const refused = stale.admit(request);
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.reason).toContain("not held at the current fence");
  });

  it("refuses a record it cannot read, rather than running the job here", () => {
    const bridge = new PlacementControllerBridge({
      hostId: controllerId,
      view: () => {
        throw new Error("the record is invalid");
      },
      enqueue: () => ({ ok: true, reply: { accepted: true, jobId: request.jobId, status: "queued", controllerId, epoch: 1 } }),
      queuedReason: () => undefined,
      sweepUnreachable: () => [],
    });
    const admission = bridge.admit(request);
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.reason).toContain("could not be read");
  });
});

describe("the unreachable sweep", () => {
  it("runs on the timer and stops when it is stopped", () => {
    vi.useFakeTimers();
    try {
      let sweeps = 0;
      const bridge = new PlacementControllerBridge({
        hostId: controllerId,
        view: () => ({ mode: "serverFirst", controllerId, epoch: 1, acknowledged: true }),
        enqueue: () => ({ ok: false, reason: "unused" }),
        queuedReason: () => undefined,
        sweepUnreachable: () => {
          sweeps += 1;
          return [];
        },
      });
      bridge.startUnreachableSweep(() => 1_000);
      vi.advanceTimersByTime(3_500);
      expect(sweeps).toBe(3);
      bridge.stopUnreachableSweep();
      vi.advanceTimersByTime(5_000);
      expect(sweeps).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps sweeping after one sweep throws", () => {
    vi.useFakeTimers();
    try {
      let sweeps = 0;
      const bridge = new PlacementControllerBridge({
        hostId: controllerId,
        view: () => ({ mode: "serverFirst", controllerId, epoch: 1, acknowledged: true }),
        enqueue: () => ({ ok: false, reason: "unused" }),
        queuedReason: () => undefined,
        sweepUnreachable: () => {
          sweeps += 1;
          throw new Error("the sweep failed");
        },
      });
      bridge.startUnreachableSweep(() => 1_000);
      vi.advanceTimersByTime(3_500);
      expect(sweeps).toBe(3);
      bridge.stopUnreachableSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches the authority's jobs, so a quiet worker is noticed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-sweep-"));
    made.push(dir);
    const now = { value: 1_700_000_000_000 };
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
      now: () => now.value,
      unreachableAfterMs: () => 1_000,
    });
    const bridge = new PlacementControllerBridge({
      hostId: controllerId,
      view: () => ({
        mode: "serverFirst",
        controllerId: leases.controller().controllerId,
        epoch: leases.controller().epoch,
        acknowledged: true,
      }),
      enqueue: (message) => leases.enqueue(message),
      queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
      sweepUnreachable: () => leases.sweepUnreachable(),
    });
    const fence = { ...leases.controller(), version: PLACEMENT_WIRE_VERSION };
    const workerId: HostId = "server:33333333-3333-4333-8333-333333333333";
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-1" });
    expect(claim.ok && claim.reply.accepted).toBe(true);
    // The worker goes quiet, and the sweep the bridge runs is what notices.
    now.value += 60_000;
    expect(bridge.sweepNow()).toEqual(["job-1"]);
    expect(leases.job("job-1")?.status).toBe("worker-unreachable");
  });
});

// ── the registry half ─────────────────────────────────────────────────────

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

function registryHarness(overrides: Partial<JobRegistryDeps> = {}) {
  const { spawnFn, children } = fakeSpawn();
  const root = mkdtempSync(join(tmpdir(), "bf-placement-bridge-registry-"));
  made.push(root);
  const clock = { now: 1_700_000_000_000 };
  const settings = { value: { ...DEFAULT_JOBS_SETTINGS } };
  const registry = new JobRegistry({
    dir: join(root, "jobs"),
    dataDir: root,
    settings: () => settings.value,
    spendBlocked: () => false,
    broadcast: () => undefined,
    probe: { swapUsedPercent: () => 50, freeDiskBytes: () => 100 * 1024 ** 3 },
    now: () => clock.now,
    spawn: spawnFn,
    listProcesses: async () => [],
    platform: "linux",
    ...overrides,
  });
  registries.push(registry);
  return { registry, root, children, clock, settings };
}

const startJob = (registry: JobRegistry, root: string, botId = "bot_1", threadId = "thread_1") =>
  registry.start({ botId, threadId, command: "sleep 1", cwd: root, onComplete: "wake" });

describe("the registry under the bridge", () => {
  it("runs the job here in This Mac Only, exactly as before", () => {
    const { registry, root, children } = registryHarness();
    const result = startJob(registry, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("running");
    expect(children).toHaveLength(1);
  });

  it("queues the job in a server mode and keeps no copy of it here", () => {
    const { bridge, enqueued } = fixture();
    const { registry, root, children } = registryHarness({ placementBridge: bridge });
    const result = startJob(registry, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const job = result.job;
    expect(job.status).toBe("queued");
    expect(job.queuedReason).toBe("waiting for an eligible host");
    expect(job.controllerHostId).toBe(controllerId);
    expect(result.note).toContain("use bash instead if the command is short");
    expect(enqueued).toHaveLength(1);
    // The controller owns the record:  this registry keeps no copy, so no
    // process runs here and the local job file never names the job.
    expect(children).toHaveLength(0);
    let stored = "";
    try {
      stored = readFileSync(join(root, "jobs", "jobs.json"), "utf8");
    } catch {
      stored = "";
    }
    expect(stored).not.toContain(enqueued[0]?.jobId ?? "job_");
  });

  it("refuses the start on a host that does not hold the controller", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-registry-other-"));
    made.push(dir);
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const bridge = new PlacementControllerBridge({
      hostId: otherHost,
      view: () => ({
        mode: "serverFirst",
        controllerId: leases.controller().controllerId,
        epoch: leases.controller().epoch,
        acknowledged: true,
      }),
      enqueue: (message) => leases.enqueue(message),
      queuedReason: (jobId) => leases.job(jobId)?.queuedReason,
      sweepUnreachable: () => leases.sweepUnreachable(),
    });
    const { registry, root, children } = registryHarness({ placementBridge: bridge });
    const result = startJob(registry, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("does not admit jobs of its own");
    expect(children).toHaveLength(0);
  });

  it("still refuses a spend-ceiling job before the bridge is asked", () => {
    const { bridge } = fixture();
    const { registry, root, children } = registryHarness({ placementBridge: bridge, spendBlocked: () => true });
    const result = startJob(registry, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("spend ceiling");
    expect(children).toHaveLength(0);
  });

  it("queues a job past the local cap in a server mode instead of refusing it", () => {
    const { bridge, store, leases } = fixture({ mode: "localOnly" });
    const { registry, root, children } = registryHarness({
      placementBridge: bridge,
      // The mode the registry reads is the record's own, exactly as it is in
      // production.
      placementMode: () => bridge.mode(),
    });
    // Fill the local cap with jobs this host is actually running.
    for (let index = 0; index < JOB_CAP_PER_HOST; index += 1) {
      const started = startJob(registry, root, `bot_${index}`, `thread_${index}`);
      expect(started.ok).toBe(true);
    }
    expect(children).toHaveLength(JOB_CAP_PER_HOST);
    // This Mac Only refuses the next one:  the cap is a refusal here.
    const refused = startJob(registry, root, "bot_cap", "thread_cap");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("the most BotFleet allows");
    // A server mode makes the cap an eligibility input, so the job queues.
    store.apply({
      mode: "serverFirst",
      controllerId: leases.controller().controllerId,
      epoch: leases.controller().epoch,
      serverId: controllerId,
      allowOverflowToThisMac: false,
    });
    const queued = startJob(registry, root, "bot_cap", "thread_cap");
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.job.status).toBe("queued");
    expect(children).toHaveLength(JOB_CAP_PER_HOST);
  });

  it("refuses a start when the controller's queue is full", () => {
    const { bridge, leases } = fixture();
    // The controller's queue is the authority's own bound:  the registry's
    // queue cap never sees a bridged job, because the job never reaches the
    // registry's records.
    const fence = { ...leases.controller(), version: PLACEMENT_WIRE_VERSION };
    for (let index = 0; index < JOB_RECORD_MAX; index += 1) {
      leases.enqueue({
        ...fence,
        jobId: `job-full-${index}`,
        botId: "bot_full",
        threadId: "thread_full",
        command: "true",
        cwd: "/tmp",
        timeoutMs: 60_000,
      });
    }
    expect(leases.activeJobs()).toHaveLength(JOB_RECORD_MAX);
    const { registry, root, children } = registryHarness({
      placementBridge: bridge,
      placementMode: () => bridge.mode(),
      placementActiveJobs: () => leases.activeJobs(),
    });
    const result = startJob(registry, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("placement queue is full");
    expect(children).toHaveLength(0);
  });

  it("counts the bot's and the conversation's caps from the controller's queue", () => {
    const { bridge, leases } = fixture();
    const { registry, root, children } = registryHarness({
      placementBridge: bridge,
      placementMode: () => bridge.mode(),
      placementActiveJobs: () => leases.activeJobs(),
    });
    // Fill the bot's cap in the controller's queue.  The registry holds no
    // copy of any of them, so the count has to come from the queue.
    for (let index = 0; index < JOB_CAP_PER_BOT; index += 1) {
      const started = startJob(registry, root, "bot_busy", `thread_${index}`);
      expect(started.ok).toBe(true);
    }
    expect(leases.activeJobs()).toHaveLength(JOB_CAP_PER_BOT);
    const refused = startJob(registry, root, "bot_busy", "thread_other");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("the most a bot may");
    // A different bot is not refused by another bot's jobs.
    const other = startJob(registry, root, "bot_free", "thread_other");
    expect(other.ok).toBe(true);
    // The conversation's own cap refuses the fourth job in one conversation.
    for (let index = 0; index < JOB_CAP_PER_THREAD; index += 1) {
      const started = startJob(registry, root, `bot_thread_${index}`, "thread_busy");
      expect(started.ok).toBe(true);
    }
    const threadRefused = startJob(registry, root, "bot_thread_other", "thread_busy");
    expect(threadRefused.ok).toBe(false);
    if (threadRefused.ok) return;
    expect(threadRefused.error).toContain("the most it may");
    expect(children).toHaveLength(0);
  });
});
