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
  PlacementWorkerRuntime,
  type PlacementWorkerClientLike,
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

    // Now mock heartbeat reply with pendingStop for job-101
    const heartbeatStop: WorkerCallOutcome<HeartbeatReply> = {
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["job-101"] },
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
      reply: { controllerId, epoch: 1, pendingStops: ["job-live"] },
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
});
