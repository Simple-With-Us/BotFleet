import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  type CapacitySample,
  type ClaimReply,
  type HeartbeatReply,
  type HostId,
  type RegisterReply,
  type ReportReply,
} from "../shared/placement.ts";
import { PlacementReportSpool } from "./placement-report-spool.ts";
import {
  leaseStoreSchema,
  PlacementWorkerRuntime,
  type PlacementWorkerClientLike,
  type PlacementWorkerRuntimeDeps,
  type WorkerSpawnResult,
} from "./placement-worker-runtime.ts";
import type { PayloadReply, StopReceiptReply, WorkerCallOutcome } from "./placement-worker-client.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";

const sample: CapacitySample = {
  at: 1, cores: 8, loadPerCore: 0.1, ramTotalBytes: 16000, ramAvailableBytes: 8000,
  memoryPressure: "normal", memoryAvailablePercent: 50, swapTotalBytes: 0, swapUsedBytes: 0,
  diskTotalBytes: 100000, diskFreeBytes: 50000, inodesTotal: 10000, inodesFree: 5000,
  dataVolume: null, rootDiskFreeBytes: 50000,
};

/** The lease file as the runtime itself reads it: through its strict schema. */
function readLeases(leaseFile: string) {
  return leaseStoreSchema.parse(JSON.parse(readFileSync(leaseFile, "utf8")));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface MockWorkerClient extends PlacementWorkerClientLike {
  register: Mock<PlacementWorkerClientLike["register"]>;
  heartbeat: Mock<PlacementWorkerClientLike["heartbeat"]>;
  assignment: Mock<PlacementWorkerClientLike["assignment"]>;
  payload: Mock<PlacementWorkerClientLike["payload"]>;
  report: Mock<PlacementWorkerClientLike["report"]>;
  stopReceipt: Mock<PlacementWorkerClientLike["stopReceipt"]>;
}

function fixtureEnv() {
  const dir = mkdtempSync(join(tmpdir(), "bf-worker-runtime-"));
  dirs.push(dir);
  const spool = new PlacementReportSpool(dir);
  let now = 1000;

  const registerReply: WorkerCallOutcome<RegisterReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } };
  const heartbeatReply: WorkerCallOutcome<HeartbeatReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, pendingStops: [] } };
  const assignmentReply: WorkerCallOutcome<ClaimReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, accepted: false, reason: "no eligible jobs" } };
  const payloadReply: WorkerCallOutcome<PayloadReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true, command: "echo test", cwd: "/tmp", timeoutMs: 1000 } };
  const reportReply: WorkerCallOutcome<ReportReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } };
  const stopReceiptReply: WorkerCallOutcome<StopReceiptReply> = { outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } };

  const mockClient: MockWorkerClient = {
    register: vi.fn(async () => registerReply),
    heartbeat: vi.fn(async () => heartbeatReply),
    assignment: vi.fn(async () => assignmentReply),
    payload: vi.fn(async () => payloadReply),
    report: vi.fn(async () => reportReply),
    stopReceipt: vi.fn(async () => stopReceiptReply),
  };

  return { dir, spool, mockClient, now: () => now, setNow: (n: number) => { now = n; } };
}

describe("PlacementWorkerRuntime", () => {
  it("registers capabilities and capacity sample with controller", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(),
      stopJob: vi.fn(),
      now,
    });

    const result = await runtime.register();
    expect(result.outcome).toBe("accepted");
    expect(runtime.isRegistered()).toBe(true);
    expect(mockClient.register).toHaveBeenCalledWith({
      capabilities: ["shell"],
      sample,
    });
  });

  it("sends heartbeats and acknowledges pending stops from controller", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const stopped: string[] = [];

    let finishJob: ((res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const donePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishJob = resolve;
    });

    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(async () => ({
        pid: 12345,
        done: donePromise,
      })),
      stopJob: vi.fn(async (id) => { stopped.push(id); }),
      now,
    });

    // Mock an active job in runtime by mocking an assignment poll
    const assignmentSuccess: WorkerCallOutcome<ClaimReply> = {
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-101", jobId: "job-101", host: workerId },
      },
    };
    mockClient.assignment.mockResolvedValueOnce(assignmentSuccess);

    await runtime.pullAssignment();
    expect(runtime.getActiveJobs().has("job-101")).toBe(true);

    // Now mock heartbeat reply with a pending stop for the lease of job-101
    const heartbeatStop: WorkerCallOutcome<HeartbeatReply> = {
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["lease-101"] },
    };
    mockClient.heartbeat.mockResolvedValueOnce(heartbeatStop);

    await runtime.tickHeartbeat();

    // Verify stop receipt was sent and stopJob was called
    expect(mockClient.stopReceipt).toHaveBeenCalledWith({ jobId: "job-101", leaseId: "lease-101" });
    expect(stopped).toEqual(["job-101"]);

    // When the stopped process exits with signal SIGTERM
    finishJob?.({ exitCode: null, signal: "SIGTERM" });
    await donePromise;
    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(runtime.getActiveJobs().has("job-101")).toBe(false);
    expect(mockClient.report).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-101",
        leaseId: "lease-101",
        status: "killed",
        signal: "SIGTERM",
      }),
    );
  });

  it("persists lease record before spawn and cleans it up after completion", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const leaseFile = join(dir, "placement", "worker-leases.json");

    let finishJob: ((res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const donePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishJob = resolve;
    });

    let leaseFileExistedDuringSpawn = false;
    let leaseFileContentDuringSpawn = "";

    const spawnJobResult: WorkerSpawnResult = {
      pid: 9999,
      done: donePromise,
    };

    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(async () => {
        leaseFileExistedDuringSpawn = existsSync(leaseFile);
        leaseFileContentDuringSpawn = readFileSync(leaseFile, "utf8");
        return spawnJobResult;
      }),
      stopJob: vi.fn(),
      now,
    });

    const assignmentSuccess: WorkerCallOutcome<ClaimReply> = {
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-abc", jobId: "job-abc", host: workerId },
      },
    };
    mockClient.assignment.mockResolvedValueOnce(assignmentSuccess);

    await runtime.pullAssignment();

    // Proves lease record was written to disk BEFORE spawn completed
    expect(leaseFileExistedDuringSpawn).toBe(true);
    expect(leaseFileContentDuringSpawn).toContain("job-abc");
    expect(leaseFileContentDuringSpawn).toContain("lease-abc");

    // Complete the job cleanly
    finishJob?.({ exitCode: 0, signal: null });
    await donePromise;
    await new Promise((r) => setTimeout(r, 10));

    // Proves lease record was removed from disk after report settlement
    const remaining = JSON.parse(readFileSync(leaseFile, "utf8"));
    expect(remaining["job-abc"]).toBeUndefined();
    expect(mockClient.report).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-abc",
        status: "completed",
        exitCode: 0,
      }),
    );
  });

  it("reconciles orphan leases on restart when process is dead", async () => {
    const { dir, spool, mockClient, now, setNow } = fixtureEnv();
    const leaseFile = join(dir, "placement", "worker-leases.json");

    // Pre-populate an orphan lease in worker-leases.json from a simulated crashed run
    const orphanLease = {
      "job-orphan": {
        jobId: "job-orphan",
        leaseId: "lease-orphan",
        controllerId,
        epoch: 1,
        command: "run-something",
        spawnedAt: 500,
        pid: 88888,
      },
    };
    mkdirSync(join(dir, "placement"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify(orphanLease, null, 2), "utf8");

    setNow(2000);

    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(),
      stopJob: vi.fn(),
      isProcessAlive: vi.fn(() => false), // Process 88888 is dead
      now,
    });

    await runtime.reconcileRestart();

    // Verify orphan was reported as lost
    expect(mockClient.report).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-orphan",
        leaseId: "lease-orphan",
        status: "lost",
        endedAt: 2000,
      }),
    );

    // Verify lease file no longer holds the orphan
    const remaining = JSON.parse(readFileSync(leaseFile, "utf8"));
    expect(remaining["job-orphan"]).toBeUndefined();
  });

  it("pulls again after an empty queue or a refused admission", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    let admit = false;
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit }),
      spawnJob: vi.fn(async () => ({
        pid: 2222,
        done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(() => undefined),
      })),
      stopJob: vi.fn(),
      now,
      heartbeatIntervalMs: 60_000,
      assignmentPollIntervalMs: 30,
    });

    try {
      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mockClient.assignment).not.toHaveBeenCalled();

      admit = true;
      await vi.waitFor(() => expect(mockClient.assignment.mock.calls.length).toBeGreaterThan(0));
      expect(runtime.getActiveJobs().size).toBe(0);

      const callsAfterEmpty = mockClient.assignment.mock.calls.length;
      mockClient.assignment.mockResolvedValueOnce({
        outcome: "accepted",
        reply: {
          controllerId, epoch: 1, accepted: true,
          lease: { controllerId, epoch: 1, leaseId: "lease-later", jobId: "job-later", host: workerId },
        },
      });
      await vi.waitFor(() => expect(runtime.getActiveJobs().has("job-later")).toBe(true));
      expect(mockClient.assignment.mock.calls.length).toBeGreaterThan(callsAfterEmpty);

      await runtime.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const callsAtStop = mockClient.assignment.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mockClient.assignment.mock.calls.length).toBe(callsAtStop);
    } finally {
      await runtime.stop();
    }
  });

  it("adopts a surviving process, heartbeats its lease, and settles the observed exit", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const leaseFile = join(dir, "placement", "worker-leases.json");
    mkdirSync(join(dir, "placement"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({
      "job-live": {
        jobId: "job-live",
        leaseId: "lease-live",
        controllerId,
        epoch: 1,
        command: "run-something",
        spawnedAt: 500,
        pid: 4242,
      },
    }), "utf8");

    let finishWatch: ((exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const watched = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishWatch = resolve;
    });
    const stopped: string[] = [];

    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(),
      stopJob: vi.fn(async (id) => {
        stopped.push(id);
        finishWatch?.({ exitCode: null, signal: "SIGTERM" });
      }),
      isProcessAlive: () => true,
      watchProcess: (pid) => {
        expect(pid).toBe(4242);
        return watched;
      },
      now,
    });

    await runtime.reconcileRestart();
    expect(runtime.getActiveJobs().has("job-live")).toBe(true);
    expect(JSON.parse(readFileSync(leaseFile, "utf8"))["job-live"]).toBeDefined();

    mockClient.heartbeat.mockResolvedValueOnce({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["lease-live"] },
    });
    await runtime.tickHeartbeat();
    expect(mockClient.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      leases: ["lease-live"],
    }));
    expect(mockClient.stopReceipt).toHaveBeenCalledWith({ jobId: "job-live", leaseId: "lease-live" });
    expect(stopped).toEqual(["job-live"]);

    await runtime.waitForJob("job-live");
    expect(runtime.getActiveJobs().has("job-live")).toBe(false);
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-live",
      leaseId: "lease-live",
      status: "killed",
      signal: "SIGTERM",
    }));
    expect(JSON.parse(readFileSync(leaseFile, "utf8"))["job-live"]).toBeUndefined();
  });

  it("reports an adopted process as lost when its exit status was not observed", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const leaseFile = join(dir, "placement", "worker-leases.json");
    mkdirSync(join(dir, "placement"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({
      "job-unobserved": {
        jobId: "job-unobserved",
        leaseId: "lease-unobserved",
        controllerId,
        epoch: 1,
        command: "run-something",
        spawnedAt: 500,
        pid: 5151,
      },
    }), "utf8");

    let alive = true;
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(),
      stopJob: vi.fn(),
      isProcessAlive: () => alive,
      adoptedPollIntervalMs: 20,
      now,
    });

    await runtime.reconcileRestart();
    expect(runtime.getActiveJobs().has("job-unobserved")).toBe(true);
    alive = false;
    await vi.waitFor(() => {
      expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "job-unobserved",
        leaseId: "lease-unobserved",
        status: "lost",
        reason: "adopted process exited without an observed status",
      }));
    });
    expect(runtime.getActiveJobs().has("job-unobserved")).toBe(false);
    expect(JSON.parse(readFileSync(leaseFile, "utf8"))["job-unobserved"]).toBeUndefined();
  });

  it("never spawns a lease again when the controller offers it a second time", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const leaseFile = join(dir, "placement", "worker-leases.json");
    let finishJob: ((res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const donePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishJob = resolve;
    });
    const spawnJob = vi.fn(async () => ({ pid: 4321, done: donePromise }));
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob,
      stopJob: vi.fn(),
      now,
    });
    // The controller offers the lease on every pull until it is settled.
    mockClient.assignment.mockResolvedValue({
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-again", jobId: "job-again", host: workerId },
      },
    });

    expect(await runtime.pullAssignment()).toEqual({ polled: true, jobId: "job-again" });
    // offered again while it runs: no second spawn, and the record keeps its pid
    expect(await runtime.pullAssignment()).toEqual({ polled: true, jobId: "job-again" });
    expect(spawnJob).toHaveBeenCalledTimes(1);
    expect(mockClient.payload).toHaveBeenCalledTimes(1);
    expect(readLeases(leaseFile)["job-again"]?.pid).toBe(4321);

    // it ends, and its report does not reach the controller
    mockClient.report.mockResolvedValueOnce({ outcome: "link-failed", reason: "link down" });
    finishJob?.({ exitCode: 0, signal: null });
    await runtime.waitForJob("job-again");
    expect(spool.pending().length).toBe(1);

    // offered again with the report still spooled: the report is delivered, nothing is spawned
    expect(await runtime.pullAssignment()).toEqual({ polled: true, jobId: "job-again" });
    expect(spawnJob).toHaveBeenCalledTimes(1);
    expect(mockClient.payload).toHaveBeenCalledTimes(1);
    expect(spool.pending().length).toBe(0);
    expect(mockClient.report).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "job-again", leaseId: "lease-again", status: "completed" }));
    expect(readLeases(leaseFile)["job-again"]).toBeUndefined();
  });

  it("finds a job's spooled report by name when a lease is offered, never scanning the spool", async () => {
    const { dir, spool, mockClient, now } = fixtureEnv();
    const spawnJob = vi.fn(async () => ({ pid: 4322, done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(() => undefined) }));
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob,
      stopJob: vi.fn(),
      now,
    });
    mockClient.assignment.mockResolvedValue({
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-lookup", jobId: "job-lookup", host: workerId },
      },
    });
    const scan = vi.spyOn(spool, "pending");
    const lookup = vi.spyOn(spool, "get");

    expect(await runtime.pullAssignment()).toEqual({ polled: true, jobId: "job-lookup" });
    expect(spawnJob).toHaveBeenCalledTimes(1);
    // one row read by job id, however many reports are waiting
    expect(lookup).toHaveBeenCalledWith("job-lookup");
    expect(scan).not.toHaveBeenCalled();
  });

  // A worker-leases.json exactly as the runtime wrote it before exit-file
  // settlement existed: the record gained no field, so it must still parse.
  function orphanLease(jobId: string, pid: number | null) {
    return {
      [jobId]: {
        jobId,
        leaseId: `lease-${jobId}`,
        controllerId,
        epoch: 1,
        command: "run-something",
        cwd: "/tmp",
        timeoutMs: 60_000,
        spawnedAt: 500,
        pid,
      },
    };
  }

  function restartedRuntime(
    stored: ReturnType<typeof orphanLease>,
    processes: Pick<PlacementWorkerRuntimeDeps, "readExit" | "isProcessAlive" | "watchProcess" | "adoptedPollIntervalMs" | "passiveReason">,
  ) {
    const env = fixtureEnv();
    const leaseFile = join(env.dir, "placement", "worker-leases.json");
    mkdirSync(join(env.dir, "placement"), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify(stored), "utf8");
    env.setNow(2000);
    const spawnJob = vi.fn<PlacementWorkerRuntimeDeps["spawnJob"]>();
    const stopJob = vi.fn<PlacementWorkerRuntimeDeps["stopJob"]>(async () => undefined);
    const runtime = new PlacementWorkerRuntime({
      client: env.mockClient,
      spool: env.spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: env.dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob,
      stopJob,
      now: env.now,
      ...processes,
    });
    /** The job ids the runtime still holds a lease record for. */
    const remaining = (): string[] => Object.keys(readLeases(leaseFile));
    return { ...env, runtime, remaining, spawnJob, stopJob };
  }

  it("settles a dead lease from its exit file on restart: status 0 is completed", async () => {
    const seen: Array<{ pid: number; jobId?: string }> = [];
    const readExit = vi.fn(() => ({ exitCode: 0, signal: null }));
    const { runtime, mockClient, spool, remaining } = restartedRuntime(orphanLease("job-done", 88888), {
      readExit,
      isProcessAlive: (pid, record) => {
        seen.push({ pid, jobId: record?.jobId });
        return false;
      },
    });

    await runtime.reconcileRestart();

    // the liveness check is given the lease, so it can tell a reused pid
    expect(seen).toEqual([{ pid: 88888, jobId: "job-done" }]);
    expect(readExit).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-done", leaseId: "lease-job-done", spawnedAt: 500 }));
    expect(mockClient.report).toHaveBeenCalledTimes(1);
    expect(mockClient.report).toHaveBeenCalledWith({
      jobId: "job-done",
      leaseId: "lease-job-done",
      status: "completed",
      exitCode: 0,
      signal: null,
      endedAt: 2000,
      reason: undefined,
    });
    expect(remaining()).toEqual([]);
    expect(spool.pending()).toEqual([]);
  });

  it("settles a dead lease from its exit file on restart: a non-zero status is failed with its code", async () => {
    const { runtime, mockClient, remaining } = restartedRuntime(orphanLease("job-three", 88888), {
      readExit: () => ({ exitCode: 3, signal: null }),
      isProcessAlive: () => false,
    });

    await runtime.reconcileRestart();

    expect(mockClient.report).toHaveBeenCalledTimes(1);
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-three",
      status: "failed",
      exitCode: 3,
      signal: null,
      reason: undefined,
    }));
    expect(remaining()).toEqual([]);
  });

  it("settles a lease whose spawn was never confirmed from its exit file too", async () => {
    const isProcessAlive = vi.fn(() => true);
    const { runtime, mockClient } = restartedRuntime(orphanLease("job-no-pid", null), {
      readExit: () => ({ exitCode: 137, signal: "SIGKILL" }),
      isProcessAlive,
    });

    await runtime.reconcileRestart();

    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-no-pid",
      status: "failed",
      exitCode: 137,
      signal: "SIGKILL",
    }));
  });

  it("reports a dead lease lost on restart when it left no exit file, or one that cannot be read", async () => {
    for (const readExit of [() => null, () => { throw new Error("unreadable"); }]) {
      const { runtime, mockClient, remaining } = restartedRuntime(orphanLease("job-gone", 88888), {
        readExit,
        isProcessAlive: () => false,
      });

      await runtime.reconcileRestart();

      expect(mockClient.report).toHaveBeenCalledTimes(1);
      expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "job-gone",
        status: "lost",
        exitCode: null,
        signal: null,
        reason: "worker process restarted while lease was active",
      }));
      expect(remaining()).toEqual([]);
    }
  });

  it("settles an adopted process nobody saw end from its exit file, and passes the watcher its lease", async () => {
    let alive = true;
    let written: { exitCode: number; signal: NodeJS.Signals | null } | null = null;
    const { runtime, mockClient, remaining } = restartedRuntime(orphanLease("job-adopted", 5151), {
      readExit: () => written,
      isProcessAlive: () => alive,
      adoptedPollIntervalMs: 20,
    });

    await runtime.reconcileRestart();
    expect(runtime.getActiveJobs().has("job-adopted")).toBe(true);
    expect(mockClient.report).not.toHaveBeenCalled();

    written = { exitCode: 0, signal: null };
    alive = false;
    await runtime.waitForJob("job-adopted");
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-adopted",
      status: "completed",
      exitCode: 0,
      reason: undefined,
    }));
    expect(remaining()).toEqual([]);

    const watched: Array<{ pid: number; jobId?: string }> = [];
    const rejected = restartedRuntime(orphanLease("job-unseen", 6161), {
      readExit: () => ({ exitCode: 2, signal: null }),
      isProcessAlive: () => true,
      watchProcess: (pid, record) => {
        watched.push({ pid, jobId: record?.jobId });
        return Promise.reject(new Error("not observed"));
      },
    });
    await rejected.runtime.reconcileRestart();
    await vi.waitFor(() => expect(rejected.mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-unseen",
      status: "failed",
      exitCode: 2,
    })));
    expect(watched).toEqual([{ pid: 6161, jobId: "job-unseen" }]);
  });

  it("keeps a controller stop as killed whatever the exit file says, and carries a watcher's reason", async () => {
    // the watcher has not settled yet when the stop arrives
    let endUnobserved: (() => void) | undefined;
    const watched = new Promise<never>((_resolve, reject) => {
      endUnobserved = () => reject(new Error("not observed"));
    });
    const stopped = restartedRuntime(orphanLease("job-stopped", 7171), {
      readExit: () => ({ exitCode: 0, signal: null }),
      isProcessAlive: () => true,
      watchProcess: () => watched,
    });
    stopped.mockClient.heartbeat.mockResolvedValueOnce({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["lease-job-stopped"] },
    });
    await stopped.runtime.reconcileRestart();
    await stopped.runtime.tickHeartbeat();
    endUnobserved?.();
    await stopped.runtime.waitForJob("job-stopped");
    expect(stopped.mockClient.report).toHaveBeenCalledTimes(1);
    expect(stopped.mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-stopped",
      status: "killed",
      reason: "stopped by controller",
    }));

    const limited = restartedRuntime(orphanLease("job-limited", 8181), {
      readExit: () => null,
      isProcessAlive: () => true,
      watchProcess: async () => ({ exitCode: null, signal: null, reason: "run limit reached" }),
    });
    await limited.runtime.reconcileRestart();
    await vi.waitFor(() => expect(limited.mockClient.report).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-limited",
      status: "failed",
      exitCode: null,
      reason: "run limit reached",
    })));
  });

  it("stops the job a pending stop's lease id names, and nothing a job id or another lease names", async () => {
    // The controller's heartbeat reply lists lease ids (`stopNow` in
    // server/placement-leases.ts), never job ids.
    const watched = new Promise<never>(() => undefined);
    const { runtime, mockClient, stopJob } = restartedRuntime(orphanLease("job-held", 9191), {
      isProcessAlive: () => true,
      watchProcess: () => watched,
    });
    await runtime.reconcileRestart();

    // the job's own id, and a lease this worker does not hold: neither is a stop for it
    mockClient.heartbeat.mockResolvedValueOnce({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["job-held", "lease-of-an-earlier-run"] },
    });
    await runtime.tickHeartbeat();
    expect(mockClient.stopReceipt).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
    expect(runtime.getActiveJob("job-held")?.stopRequested).toBeUndefined();

    // the lease it holds: acknowledged with both ids, and stopped by job id, once
    mockClient.heartbeat.mockResolvedValue({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["lease-job-held"] },
    });
    await runtime.tickHeartbeat();
    await runtime.tickHeartbeat();
    expect(mockClient.stopReceipt).toHaveBeenCalledTimes(1);
    expect(mockClient.stopReceipt).toHaveBeenCalledWith({ jobId: "job-held", leaseId: "lease-job-held" });
    expect(stopJob).toHaveBeenCalledTimes(1);
    expect(stopJob).toHaveBeenCalledWith("job-held", "SIGTERM");
    expect(runtime.getActiveJob("job-held")?.stopRequested).toBe(true);
  });

  it("gives the fallback poll the lease, so a liveness check that needs it keeps a live job", async () => {
    // A check that tells a job from a stranger by its lease answers false
    // for a bare pid.  No `watchProcess` here: the runtime polls on its own.
    let alive = true;
    const seen: Array<string | undefined> = [];
    const { runtime, mockClient, remaining } = restartedRuntime(orphanLease("job-polled", 9292), {
      isProcessAlive: (_pid, record) => {
        seen.push(record?.jobId);
        return record !== undefined && alive;
      },
      adoptedPollIntervalMs: 20,
    });
    await runtime.reconcileRestart();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockClient.report).not.toHaveBeenCalled();
    expect(runtime.getActiveJobs().has("job-polled")).toBe(true);
    expect(remaining()).toEqual(["job-polled"]);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((jobId) => jobId === "job-polled")).toBe(true);

    alive = false;
    await runtime.waitForJob("job-polled");
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-polled", status: "lost" }));
  });

  it("admits no work and acts on no stop when it is passive", async () => {
    let end: ((exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const watched = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      end = resolve;
    });
    const held = "this build runs nothing";
    const { runtime, mockClient, spawnJob, stopJob } = restartedRuntime(orphanLease("job-watched", 9393), {
      isProcessAlive: () => true,
      watchProcess: () => watched,
      passiveReason: held,
    });
    // a lease is waiting, and a stop is pending for the job it adopted
    mockClient.assignment.mockResolvedValue({
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-waiting", jobId: "job-waiting", host: workerId },
      },
    });
    mockClient.heartbeat.mockResolvedValue({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["lease-job-watched"] },
    });
    await runtime.reconcileRestart();

    expect(await runtime.pullAssignment()).toEqual({ polled: false, jobId: undefined });
    await runtime.tickHeartbeat();
    expect(mockClient.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ admission: { admit: false, reason: held } }));
    expect(mockClient.assignment).not.toHaveBeenCalled();
    expect(mockClient.payload).not.toHaveBeenCalled();
    expect(spawnJob).not.toHaveBeenCalled();
    // nothing is signalled, so no receipt says the stop arrived
    expect(mockClient.stopReceipt).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();

    // the job ends on its own, and is reported as it ended, never as killed
    end?.({ exitCode: 0, signal: null });
    await runtime.waitForJob("job-watched");
    expect(mockClient.report).toHaveBeenCalledTimes(1);
    expect(mockClient.report).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-watched", status: "completed", exitCode: 0 }));
  });
});
