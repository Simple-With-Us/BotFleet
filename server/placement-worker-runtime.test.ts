import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CapacitySample,
  type HostId,
} from "../shared/placement.ts";
import { PlacementReportSpool } from "./placement-report-spool.ts";
import {
  PlacementWorkerRuntime,
  type WorkerSpawnResult,
} from "./placement-worker-runtime.ts";
import type { PlacementWorkerClient, WorkerCallOutcome } from "./placement-worker-client.ts";

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

function fixtureEnv() {
  const dir = mkdtempSync(join(tmpdir(), "bf-worker-runtime-"));
  dirs.push(dir);
  const spool = new PlacementReportSpool(dir);
  let now = 1000;

  const mockClient = {
    controller: vi.fn(() => ({ controllerId, epoch: 1 })),
    register: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } } as WorkerCallOutcome<any>)),
    heartbeat: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, pendingStops: [] } } as WorkerCallOutcome<any>)),
    assignment: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, accepted: false, reason: "no eligible jobs" } } as WorkerCallOutcome<any>)),
    payload: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true, command: "echo test", cwd: "/tmp", timeoutMs: 1000 } } as WorkerCallOutcome<any>)),
    report: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } } as WorkerCallOutcome<any>)),
    stopReceipt: vi.fn(async () => ({ outcome: "accepted", reply: { controllerId, epoch: 1, accepted: true } } as WorkerCallOutcome<any>)),
  } as unknown as PlacementWorkerClient;

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
    const runtime = new PlacementWorkerRuntime({
      client: mockClient,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: dir,
      sampleProvider: () => sample,
      admissionProvider: () => ({ admit: true }),
      spawnJob: vi.fn(),
      stopJob: vi.fn(async (id) => { stopped.push(id); }),
      now,
    });

    // Mock an active job in runtime by mocking an assignment poll
    (mockClient.assignment as any).mockResolvedValueOnce({
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-101", jobId: "job-101", host: workerId },
      },
    });

    let finishJob!: (res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    const donePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishJob = resolve;
    });

    (runtime as any).deps.spawnJob = vi.fn(async () => ({
      pid: 12345,
      done: donePromise,
    }));

    await runtime.pullAssignment();
    expect(runtime.getActiveJobs().has("job-101")).toBe(true);

    // Now mock heartbeat reply with pendingStop for job-101
    (mockClient.heartbeat as any).mockResolvedValueOnce({
      outcome: "accepted",
      reply: { controllerId, epoch: 1, pendingStops: ["job-101"] },
    });

    await runtime.tickHeartbeat();

    // Verify stop receipt was sent and stopJob was called
    expect(mockClient.stopReceipt).toHaveBeenCalledWith({ jobId: "job-101", leaseId: "lease-101" });
    expect(stopped).toEqual(["job-101"]);

    // When the stopped process exits with signal SIGTERM
    finishJob({ exitCode: null, signal: "SIGTERM" });
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

    let finishJob!: (res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    const donePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finishJob = resolve;
    });

    let leaseFileExistedDuringSpawn = false;
    let leaseFileContentDuringSpawn = "";

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
        return {
          pid: 9999,
          done: donePromise,
        } as WorkerSpawnResult;
      }),
      stopJob: vi.fn(),
      now,
    });

    (mockClient.assignment as any).mockResolvedValueOnce({
      outcome: "accepted",
      reply: {
        controllerId, epoch: 1, accepted: true,
        lease: { controllerId, epoch: 1, leaseId: "lease-abc", jobId: "job-abc", host: workerId },
      },
    });

    await runtime.pullAssignment();

    // Proves lease record was written to disk BEFORE spawn completed
    expect(leaseFileExistedDuringSpawn).toBe(true);
    expect(leaseFileContentDuringSpawn).toContain("job-abc");
    expect(leaseFileContentDuringSpawn).toContain("lease-abc");

    // Complete the job cleanly
    finishJob({ exitCode: 0, signal: null });
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
});
