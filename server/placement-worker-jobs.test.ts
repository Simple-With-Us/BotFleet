/** The runner-backed spawn, stop and adopt adapter of the placement worker
 *  runtime (the remainder of transport slice T5, BF-2559).  Every process
 *  here is real and every file lives in a temporary folder. */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapacitySample, ClaimReply, HeartbeatReply, HostId, RegisterReply, ReportMessage, ReportReply } from "../shared/placement.ts";
import { PlacementReportSpool } from "./placement-report-spool.ts";
import type { PayloadReply, StopReceiptReply, WorkerCallOutcome } from "./placement-worker-client.ts";
import {
  createPlacementWorkerJobs,
  PLACEMENT_JOB_PASSIVE_REFUSAL,
  type PlacementWorkerJobs,
  type PlacementWorkerJobsDeps,
} from "./placement-worker-jobs.ts";
import {
  leaseStoreSchema,
  PlacementWorkerRuntime,
  type PlacementWorkerClientLike,
  type WorkerLocalLeaseRecord,
} from "./placement-worker-runtime.ts";
import { nonceRuns } from "./testing/two-process.ts";

const posix = describe.skipIf(process.platform === "win32");
const execFileAsync = promisify(execFile);

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const nonceScript = fileURLToPath(new URL("./testing/nonce-job.mjs", import.meta.url));

const sample: CapacitySample = {
  at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null,
  memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null,
  diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null,
  dataVolume: null, rootDiskFreeBytes: null,
};

const dirs: string[] = [];
const adapters: Array<{ jobs: PlacementWorkerJobs; ids: string[] }> = [];

afterEach(async () => {
  // Nothing a test started may outlive it, whatever the test asserted.
  for (const { jobs, ids } of adapters.splice(0)) {
    await Promise.all(ids.map((id) => jobs.stopJob(id, "SIGKILL")));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const base = mkdtempSync(join(tmpdir(), "bf-worker-jobs-"));
  dirs.push(base);
  const dataDir = join(base, "data");
  const workDir = join(base, "work");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(workDir);
  return { dataDir, workDir };
}

/** An adapter whose jobs are stopped when the test ends. */
function adapter(dataDir: string, extra: Partial<PlacementWorkerJobsDeps> = {}): PlacementWorkerJobs {
  const jobs = createPlacementWorkerJobs({ dataDir, cpuCores: () => 2, graceMs: 200, adoptedPollMs: 20, ...extra });
  const ids: string[] = [];
  adapters.push({ jobs, ids });
  return {
    ...jobs,
    spawnJob: async (job) => {
      const spawned = await jobs.spawnJob(job);
      ids.push(job.jobId);
      return spawned;
    },
    watchProcess: (pid, record) => {
      if (record) ids.push(record.jobId);
      return jobs.watchProcess(pid, record);
    },
  };
}

/** Waits for a real process or file to reach a state: the framework retries
 *  the read, bounded by `ms`, and fails the test when it never holds. */
async function until<T>(read: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  return vi.waitFor(() => {
    const value = read();
    if (!value) throw new Error("condition never held");
    return value;
  }, { timeout: ms, interval: 25 });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid a job printed on a line of its own. */
function printedPid(logPath: string): number | null {
  if (!existsSync(logPath)) return null;
  const match = /^(\d+)$/m.exec(readFileSync(logPath, "utf8"));
  return match ? Number(match[1]) : null;
}

function leaseRecord(lease: { jobId: string; leaseId: string }, fields: Partial<WorkerLocalLeaseRecord> = {}): WorkerLocalLeaseRecord {
  return { ...lease, controllerId, epoch: 1, command: "leased", spawnedAt: Date.now(), ...fields };
}

/** A worker runtime over the real adapter and a controller that hands out
 *  one lease and records every terminal report.  `undeclared` is a composer
 *  that left the adapter's passive reason out of the runtime. */
function leasedRuntime(
  jobs: PlacementWorkerJobs,
  dataDir: string,
  payload: { command: string; cwd?: string; timeoutMs?: number },
  composed: { undeclared?: boolean } = {},
) {
  const reports: Array<Omit<ReportMessage, "version" | "controllerId" | "epoch" | "hostId">> = [];
  const fence = { controllerId, epoch: 1 };
  const lease = { ...fence, leaseId: "lease-1", jobId: "job-1", host: workerId };
  const registerReply: WorkerCallOutcome<RegisterReply> = { outcome: "accepted", reply: { ...fence, accepted: true } };
  const heartbeatReply: WorkerCallOutcome<HeartbeatReply> = { outcome: "accepted", reply: { ...fence, pendingStops: [] } };
  const assignmentReply: WorkerCallOutcome<ClaimReply> = { outcome: "accepted", reply: { ...fence, accepted: true, lease } };
  const payloadReply: WorkerCallOutcome<PayloadReply> = { outcome: "accepted", reply: { ...fence, accepted: true, ...payload } };
  const reportReply: WorkerCallOutcome<ReportReply> = { outcome: "accepted", reply: { ...fence, accepted: true } };
  const stopReceiptReply: WorkerCallOutcome<StopReceiptReply> = { outcome: "accepted", reply: { ...fence, accepted: true } };
  const client: PlacementWorkerClientLike = {
    register: vi.fn(async () => registerReply),
    heartbeat: vi.fn(async () => heartbeatReply),
    assignment: vi.fn(async () => assignmentReply),
    payload: vi.fn(async () => payloadReply),
    report: vi.fn(async (report) => {
      reports.push(report);
      return reportReply;
    }),
    stopReceipt: vi.fn(async () => stopReceiptReply),
  };
  const runtime = new PlacementWorkerRuntime({
    client,
    spool: new PlacementReportSpool(dataDir),
    hostId: workerId,
    capabilities: ["shell"],
    dataDir,
    sampleProvider: () => sample,
    admissionProvider: () => ({ admit: true }),
    spawnJob: jobs.spawnJob,
    stopJob: jobs.stopJob,
    watchProcess: jobs.watchProcess,
    isProcessAlive: jobs.isProcessAlive,
    readExit: jobs.readExit,
    passiveReason: composed.undeclared ? undefined : jobs.passiveReason,
  });
  /** The job ids the runtime still holds a lease record for. */
  const storedLeases = (): string[] =>
    Object.keys(leaseStoreSchema.parse(JSON.parse(readFileSync(join(dataDir, "placement", "worker-leases.json"), "utf8"))));
  return { runtime, client, reports, lease, storedLeases };
}

describe("placement worker jobs: production stays inactive", () => {
  it("is constructed by no production module, and neither is the worker runtime", () => {
    // Activation is slice T9 and the owner's decision.  Composing either in
    // production has to change this test, so it cannot happen in passing.
    const serverDir = fileURLToPath(new URL(".", import.meta.url));
    const production = readdirSync(serverDir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("testing"));
    expect(production).toContain("placement-worker-jobs.ts");
    expect(production).toContain("index.ts");
    const composing = production
      .filter((name) => name !== "placement-worker-jobs.ts")
      .filter((name) => /placement-worker-jobs|createPlacementWorkerJobs|new PlacementWorkerRuntime\b/.test(readFileSync(join(serverDir, name), "utf8")));
    expect(composing).toEqual([]);
  });
});

posix("placement worker jobs: one leased job through the real runner", () => {
  it("runs the command once, logs to a 0600 file and writes the exit status atomically", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    // A job id is an arbitrary string on the wire: it must never reach a path.
    const lease = { jobId: "../../escape me", leaseId: "lease/one" };
    process.env.OMB_HARNESS_ONLY_PROBE = "harness";
    let spawned: Awaited<ReturnType<PlacementWorkerJobs["spawnJob"]>>;
    try {
      spawned = await jobs.spawnJob({
        ...lease,
        cwd: workDir,
        timeoutMs: 10_000,
        command: `"${process.execPath}" "${nonceScript}" "${workDir}" one-run && printf '%s|%s|%s' "$BOTFLEET_JOB_ID" "\${OMB_HARNESS_ONLY_PROBE:-unset}" "$PWD"`,
      });
    } finally {
      delete process.env.OMB_HARNESS_ONLY_PROBE;
    }
    expect(jobs.running()).toBe(1);
    expect(spawned.pid).toBeGreaterThan(0);
    expect(await spawned.done).toEqual({ exitCode: 0, signal: null });
    expect(jobs.running()).toBe(0);

    expect(nonceRuns(workDir, "one-run").length).toBe(1);
    const jobsDir = join(dataDir, "placement", "jobs");
    const names = readdirSync(jobsDir).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^job-[0-9a-f]{32}\.exit$/);
    expect(names[1]).toMatch(/^job-[0-9a-f]{32}\.log$/);
    const { logPath, exitPath } = jobs.files(lease);
    expect(logPath).toBe(join(jobsDir, names[1]!));
    expect(exitPath).toBe(join(jobsDir, names[0]!));
    expect(readFileSync(exitPath, "utf8")).toBe("0\n");
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(jobsDir).mode & 0o077).toBe(0);
    // only the model shell environment plus the job id, in the leased folder
    expect(readFileSync(logPath, "utf8")).toBe(`${lease.jobId}|unset|${realpathSync(workDir)}`);
    expect(jobs.readExit(leaseRecord(lease))).toEqual({ exitCode: 0, signal: null });
    // another lease of the same job never reads this lease's status
    expect(jobs.readExit(leaseRecord({ jobId: lease.jobId, leaseId: "lease/two" }))).toBeNull();
  });

  it("refuses to start a lease twice, so one lease is at most one run", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const refusal = "This lease was already started on this worker.";
    const job = {
      jobId: "job-once",
      leaseId: "lease-once",
      cwd: workDir,
      timeoutMs: 10_000,
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" once`,
    };
    const first = await jobs.spawnJob(job);
    await first.done;
    await expect(jobs.spawnJob(job)).rejects.toThrow(refusal);
    // a restarted worker holds no memory of the first run, only its files
    await expect(adapter(dataDir).spawnJob(job)).rejects.toThrow(refusal);
    expect(nonceRuns(workDir, "once").length).toBe(1);

    // A lease still running when the worker restarted, whose record was lost:
    // nothing adopted it, it has no exit file yet, and it still runs once.
    const held = { ...job, jobId: "job-held", leaseId: "lease-held", command: `"${process.execPath}" "${nonceScript}" "${workDir}" held 30000` };
    await jobs.spawnJob(held);
    await until(() => nonceRuns(workDir, "held").length === 1);
    const restarted = adapter(dataDir);
    await expect(restarted.spawnJob(held)).rejects.toThrow(refusal);
    expect(restarted.running()).toBe(0);
    expect(nonceRuns(workDir, "held").length).toBe(1);
  });

  it("refuses a second spawn of a job that is still running", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const job = { jobId: "job-busy", leaseId: "lease-busy", cwd: workDir, timeoutMs: 10_000, command: "sleep 30" };
    const first = await jobs.spawnJob(job);
    await expect(jobs.spawnJob({ ...job, leaseId: "lease-other" })).rejects.toThrow("already running");
    await jobs.stopJob(job.jobId);
    expect(await first.done).toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  it("takes back the log of a start that failed, so the lease is not spent by a run that never was", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const lease = { jobId: "job-failed-start", leaseId: "lease-failed-start" };
    const command = `"${process.execPath}" "${nonceScript}" "${workDir}" after-failed-start`;
    // the shell cannot start in a folder that is not there
    await expect(jobs.spawnJob({ ...lease, cwd: join(workDir, "missing"), timeoutMs: 10_000, command }))
      .rejects.toThrow(/did not start|Could not start/);
    expect(existsSync(jobs.files(lease).logPath)).toBe(false);
    expect(jobs.running()).toBe(0);

    // nothing ran, so the lease may still be started, and it runs once
    const second = await jobs.spawnJob({ ...lease, cwd: workDir, timeoutMs: 10_000, command });
    expect(await second.done).toEqual({ exitCode: 0, signal: null });
    expect(nonceRuns(workDir, "after-failed-start").length).toBe(1);
    await expect(jobs.spawnJob({ ...lease, cwd: workDir, timeoutMs: 10_000, command })).rejects.toThrow("already started");
  });

  it("refuses a payload with no working folder, no run limit, a limit past the ceiling, or an unreadable CPU setting", async () => {
    const { dataDir, workDir } = folder();
    const command = `"${process.execPath}" "${nonceScript}" "${workDir}" never`;
    const lease = { jobId: "job-refused", leaseId: "lease-refused", command };
    const jobs = adapter(dataDir);
    await expect(jobs.spawnJob({ ...lease, timeoutMs: 1_000 })).rejects.toThrow("no working folder");
    await expect(jobs.spawnJob({ ...lease, cwd: "", timeoutMs: 1_000 })).rejects.toThrow("no working folder");
    await expect(jobs.spawnJob({ ...lease, cwd: workDir })).rejects.toThrow("no run limit");
    await expect(jobs.spawnJob({ ...lease, cwd: workDir, timeoutMs: 0 })).rejects.toThrow("no run limit");
    await expect(jobs.spawnJob({ ...lease, cwd: workDir, timeoutMs: Number.NaN })).rejects.toThrow("no run limit");
    await expect(jobs.spawnJob({ ...lease, cwd: workDir, timeoutMs: 361 * 60_000 })).rejects.toThrow("360 minutes");
    for (const cpuCores of [Number.NaN, 0, -1]) {
      await expect(adapter(dataDir, { cpuCores: () => cpuCores }).spawnJob({ ...lease, cwd: workDir, timeoutMs: 1_000 }))
        .rejects.toThrow("CPU limit");
    }
    expect(nonceRuns(workDir, "never")).toEqual([]);
    expect(existsSync(join(dataDir, "placement", "jobs"))).toBe(false);
    expect(jobs.running()).toBe(0);
  });

  it("gives the runner the run limit as CPU seconds across the configured cores", async () => {
    const { dataDir, workDir } = folder();
    const specs: Array<{ cpuSeconds: number; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const jobs = adapter(dataDir, {
      cpuCores: () => 3,
      spawn: (spec) => {
        specs.push(spec);
        return { ok: false, error: "not started" };
      },
    });
    await expect(jobs.spawnJob({ jobId: "job-cpu", leaseId: "lease-cpu", cwd: workDir, timeoutMs: 90_000, command: "true" }))
      .rejects.toThrow("not started");
    expect(specs).toHaveLength(1);
    expect(specs[0]!.cpuSeconds).toBe(270);
    expect(specs[0]!.cwd).toBe(workDir);
    expect(specs[0]!.env.BOTFLEET_JOB_ID).toBe("job-cpu");
    expect(jobs.running()).toBe(0);
  });

  it("drops the files of leases that ended long ago, and nothing else", async () => {
    const { dataDir, workDir } = folder();
    const jobsDir = join(dataDir, "placement", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const old = (name: string): string => {
      const path = join(jobsDir, name);
      writeFileSync(path, "0\n");
      const longAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(path, longAgo, longAgo);
      return path;
    };
    const stale = [old(`job-${"a".repeat(32)}.log`), old(`job-${"a".repeat(32)}.exit`), old(`job-${"b".repeat(32)}.exit.tmp`)];
    const foreign = old("notes.txt");
    const recent = join(jobsDir, `job-${"c".repeat(32)}.exit`);
    writeFileSync(recent, "0\n");

    const jobs = adapter(dataDir, { fileMaxAgeMs: 10 * 60_000 });
    const spawned = await jobs.spawnJob({ jobId: "job-prune", leaseId: "lease-prune", cwd: workDir, timeoutMs: 10_000, command: "true" });
    await spawned.done;
    for (const path of stale) expect(existsSync(path)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(jobs.files({ jobId: "job-prune", leaseId: "lease-prune" }).exitPath)).toBe(true);
  });

  it("reads an exit status above 128 as its signal, and an unreadable one as none", () => {
    const { dataDir } = folder();
    const jobs = adapter(dataDir);
    const lease = { jobId: "job-read", leaseId: "lease-read" };
    expect(jobs.readExit(leaseRecord(lease))).toBeNull();
    mkdirSync(join(dataDir, "placement", "jobs"), { recursive: true });
    writeFileSync(jobs.files(lease).exitPath, "137\n");
    expect(jobs.readExit(leaseRecord(lease))).toEqual({ exitCode: 137, signal: "SIGKILL" });
    writeFileSync(jobs.files(lease).exitPath, "3\n");
    expect(jobs.readExit(leaseRecord(lease))).toEqual({ exitCode: 3, signal: null });
    writeFileSync(jobs.files(lease).exitPath, "done\n");
    expect(jobs.readExit(leaseRecord(lease))).toBeNull();
  });
});

posix("placement worker jobs: reports through the worker runtime", () => {
  it("reports a non-zero exit as failed with its code", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const { runtime, reports, storedLeases } = leasedRuntime(jobs, dataDir, {
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" fails; exit 3`,
      cwd: workDir,
      timeoutMs: 10_000,
    });
    const { jobId } = await runtime.pullAssignment();
    expect(jobId).toBe("job-1");
    await runtime.waitForJob("job-1");
    expect(reports).toEqual([expect.objectContaining({ jobId: "job-1", leaseId: "lease-1", status: "failed", exitCode: 3, signal: null })]);
    expect(reports[0]!.reason).toBeUndefined();
    expect(nonceRuns(workDir, "fails").length).toBe(1);
    expect(storedLeases()).toEqual([]);
  });

  it("stops the whole process group on a controller stop, a grandchild included", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const { runtime, client, reports, lease } = leasedRuntime(jobs, dataDir, {
      command: "sleep 30 & echo $!; wait",
      cwd: workDir,
      timeoutMs: 60_000,
    });
    await runtime.pullAssignment();
    const grandchild = await until(() => printedPid(jobs.files(lease).logPath));
    const leader = runtime.getActiveJob("job-1")?.record.pid;
    expect(leader).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    // the controller names the lease to stop, never the job
    vi.mocked(client.heartbeat).mockResolvedValueOnce({ outcome: "accepted", reply: { controllerId, epoch: 1, pendingStops: ["lease-1"] } });
    await runtime.tickHeartbeat();
    await runtime.waitForJob("job-1");

    expect(client.stopReceipt).toHaveBeenCalledWith({ jobId: "job-1", leaseId: "lease-1" });
    expect(reports).toEqual([expect.objectContaining({ jobId: "job-1", status: "killed", reason: "stopped by controller" })]);
    await until(() => !alive(grandchild));
    expect(jobs.running()).toBe(0);
    expect(existsSync(jobs.files(lease).exitPath)).toBe(false);
  });

  it("ends a job at its run limit and says so", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const { runtime, reports, lease } = leasedRuntime(jobs, dataDir, {
      command: "sleep 30 & echo $!; wait",
      cwd: workDir,
      // long enough for a loaded host to start the shell and print the pid
      timeoutMs: 2_000,
    });
    await runtime.pullAssignment();
    const grandchild = await until(() => printedPid(jobs.files(lease).logPath));
    await runtime.waitForJob("job-1");
    expect(reports).toEqual([
      expect.objectContaining({ jobId: "job-1", status: "failed", exitCode: null, signal: "SIGTERM", reason: "run limit reached" }),
    ]);
    await until(() => !alive(grandchild));
    expect(jobs.running()).toBe(0);
  });

  it("stops what a finished command left running", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const { runtime, reports, lease } = leasedRuntime(jobs, dataDir, {
      command: "sleep 30 & echo $!",
      cwd: workDir,
      timeoutMs: 60_000,
    });
    await runtime.pullAssignment();
    await runtime.waitForJob("job-1");
    const leftover = await until(() => printedPid(jobs.files(lease).logPath));
    expect(reports).toEqual([
      expect.objectContaining({ jobId: "job-1", status: "completed", exitCode: 0, reason: "processes it left running were stopped" }),
    ]);
    await until(() => !alive(leftover));
  });

  it("pulls no lease when passive: the worker admits no work, and no queued job is failed", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir, { passive: true });
    expect(jobs.passiveReason).toBe(PLACEMENT_JOB_PASSIVE_REFUSAL);
    expect(adapter(dataDir).passiveReason).toBeUndefined();
    const { runtime, client, reports } = leasedRuntime(jobs, dataDir, {
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" passive-held`,
      cwd: workDir,
      timeoutMs: 10_000,
    });
    // A lease is waiting on the controller.  A worker that pulled it would
    // have to fail it for good, so a passive worker never asks.
    expect(await runtime.pullAssignment()).toEqual({ polled: false, jobId: undefined });
    await runtime.tickHeartbeat();
    expect(client.assignment).not.toHaveBeenCalled();
    expect(client.payload).not.toHaveBeenCalled();
    expect(client.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ admission: { admit: false, reason: PLACEMENT_JOB_PASSIVE_REFUSAL } }));
    expect(reports).toEqual([]);
    expect(nonceRuns(workDir, "passive-held")).toEqual([]);
    expect(existsSync(join(dataDir, "placement", "jobs"))).toBe(false);
    expect(runtime.getActiveJobs().size).toBe(0);
  });

  it("still refuses to spawn when a composer leaves the passive reason out, and the refusal is the failed report", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir, { passive: true });
    const { runtime, reports, storedLeases } = leasedRuntime(jobs, dataDir, {
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" passive`,
      cwd: workDir,
      timeoutMs: 10_000,
    }, { undeclared: true });
    // the reason must not say the job is held: this report fails it for good
    expect(PLACEMENT_JOB_PASSIVE_REFUSAL).not.toMatch(/held/i);
    const { jobId } = await runtime.pullAssignment();
    expect(jobId).toBe("job-1");
    expect(reports).toEqual([
      expect.objectContaining({ jobId: "job-1", status: "failed", exitCode: null, signal: null, reason: PLACEMENT_JOB_PASSIVE_REFUSAL }),
    ]);
    expect(nonceRuns(workDir, "passive")).toEqual([]);
    expect(existsSync(join(dataDir, "placement", "jobs"))).toBe(false);
    expect(runtime.getActiveJobs().size).toBe(0);
    expect(storedLeases()).toEqual([]);
  });

  it("turns a spawn error into a failed report", async () => {
    const { dataDir, workDir } = folder();
    const jobs = adapter(dataDir);
    const { runtime, reports, storedLeases } = leasedRuntime(jobs, dataDir, {
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" no-folder`,
      cwd: join(workDir, "missing"),
      timeoutMs: 10_000,
    });
    await runtime.pullAssignment();
    expect(reports).toEqual([
      expect.objectContaining({ jobId: "job-1", status: "failed", exitCode: null, signal: null, reason: "The job's shell did not start." }),
    ]);
    expect(nonceRuns(workDir, "no-folder")).toEqual([]);
    expect(jobs.running()).toBe(0);
    expect(runtime.getActiveJobs().size).toBe(0);
    expect(storedLeases()).toEqual([]);
  });
});

posix("placement worker jobs: a restarted worker", () => {
  it("adopts its own surviving job by start time, and settles it from the exit file", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-adopt", leaseId: "lease-adopt" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 1; exit 4" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // the restarted worker: a new adapter over the same data folder
    const after = adapter(dataDir);
    expect(after.isProcessAlive(pid, record)).toBe(true);
    // a bare pid, or one that started at another time, is a stranger
    expect(after.isProcessAlive(pid)).toBe(false);
    expect(after.isProcessAlive(pid, { ...record, spawnedAt: spawnedAt - 60 * 60_000 })).toBe(false);

    const watched = after.watchProcess(pid, record);
    expect(after.running()).toBe(1);
    expect(after.isProcessAlive(pid)).toBe(true);
    expect(await watched).toEqual({ exitCode: 4, signal: null });
    expect(after.running()).toBe(0);
    // the first worker's handle has reaped the leader by the time it settles
    await spawned.done;
    expect(after.isProcessAlive(pid, record)).toBe(false);
    expect(after.readExit(record)).toEqual({ exitCode: 4, signal: null });
  });

  it("cannot observe an adopted job that died without an exit status", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-died", leaseId: "lease-died" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    const after = adapter(dataDir);
    const watched = after.watchProcess(pid, record);
    await expect(after.watchProcess(pid, record)).rejects.toThrow("already watched");
    await expect(after.watchProcess(pid)).rejects.toThrow("No lease record");
    process.kill(-pid, "SIGKILL");
    await expect(watched).rejects.toThrow("without leaving an exit status");
    expect(after.readExit(record)).toBeNull();
    expect(after.running()).toBe(0);
  });

  it("stops an adopted job on request, the whole group", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-stop", leaseId: "lease-stop" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30 & echo $!; wait" });
    const pid = spawned.pid!;
    const grandchild = await until(() => printedPid(before.files(lease).logPath));
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    const after = adapter(dataDir);
    const watched = after.watchProcess(pid, record);
    watched.catch(() => undefined);
    await after.stopJob(lease.jobId);
    await expect(watched).rejects.toThrow("without leaving an exit status");
    await until(() => !alive(grandchild));
    expect(alive(pid)).toBe(false);
  });

  it("ends an adopted job whose run limit passed while the worker was down", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-late", leaseId: "lease-late" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // the restarted worker's clock is a minute on: the limit is behind it
    const after = adapter(dataDir, { now: () => Date.now() + 60_000 });
    expect(await after.watchProcess(pid, record)).toEqual({ exitCode: null, signal: null, reason: "run limit reached" });
    expect(alive(pid)).toBe(false);
  });

  it("reads the start time the same in whatever zone the harness runs", async () => {
    // The restarted worker is a process of its own, run here with its zone
    // set in its environment (never by changing this one's).  The zones are
    // many hours apart, so at least one is not this machine's: `ps` printing
    // in one zone and the worker reading in another would put the start time
    // hours from the spawn.
    const adapterModule = new URL("./placement-worker-jobs.ts", import.meta.url).href;
    const restarted = `
      import { createPlacementWorkerJobs } from ${JSON.stringify(adapterModule)};
      const { dataDir, pid, record } = JSON.parse(process.env.BF_ZONE_CASE);
      const jobs = createPlacementWorkerJobs({ dataDir, cpuCores: () => 2, graceMs: 200, adoptedPollMs: 20 });
      const hour = 60 * 60_000;
      const answer = {
        sameStart: jobs.isProcessAlive(pid, record),
        startedAnHourEarlier: jobs.isProcessAlive(pid, { ...record, spawnedAt: record.spawnedAt - hour }),
        startedAnHourLater: jobs.isProcessAlive(pid, { ...record, spawnedAt: record.spawnedAt + hour }),
      };
      // and the adopted job can still be stopped there
      const ended = jobs.watchProcess(pid, record).then(() => "settled", (error) => error.message);
      await jobs.stopJob(record.jobId);
      answer.ended = await ended;
      console.log(JSON.stringify(answer));
    `;
    const answerSchema = z.object({
      sameStart: z.boolean(),
      startedAnHourEarlier: z.boolean(),
      startedAnHourLater: z.boolean(),
      ended: z.string(),
    }).strict();

    for (const [index, harnessZone] of ["Asia/Tokyo", "America/Los_Angeles"].entries()) {
      const { dataDir, workDir } = folder();
      const before = adapter(dataDir);
      const lease = { jobId: `job-zone-${index}`, leaseId: `lease-zone-${index}` };
      const spawnedAt = Date.now();
      const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
      const pid = spawned.pid!;
      const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", restarted], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: dataDir,
          USERPROFILE: dataDir,
          TZ: harnessZone,
          BF_ZONE_CASE: JSON.stringify({ dataDir, pid, record }),
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(answerSchema.parse(JSON.parse(stdout))).toEqual({
        sameStart: true,
        startedAnHourEarlier: false,
        startedAnHourLater: false,
        ended: "The adopted job ended without leaving an exit status.",
      });
      await until(() => !alive(pid));
    }
  });

  it("holds a slow ps to half a second of the worker's time, and reads that as no answer", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-slow-ps", leaseId: "lease-slow-ps" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // a `ps` that hangs, found first on the PATH the adapter hands it
    const bin = join(dataDir, "slow-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nexec sleep 5\n");
    chmodSync(join(bin, "ps"), 0o755);
    const path = process.env.PATH;
    let verdict: boolean;
    let blockedMs: number;
    try {
      process.env.PATH = `${bin}:${path ?? ""}`;
      const after = adapter(dataDir);
      const began = performance.now();
      verdict = after.isProcessAlive(pid, record);
      blockedMs = performance.now() - began;
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    // the worker was held for well under the old five seconds, and a start
    // time that was not read leaves the job adopted rather than lost
    expect(blockedMs).toBeLessThan(2_500);
    expect(verdict).toBe(true);
  });

  it("treats a start-time check that throws as no answer, never as a stranger", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-throws", leaseId: "lease-throws" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    let broken = true;
    const after = adapter(dataDir, {
      leaderStartedNear: () => {
        if (broken) throw new Error("ps could not be run");
        return true;
      },
    });
    expect(after.isProcessAlive(pid, record)).toBe(true);
    const watched = after.watchProcess(pid, record);
    watched.catch(() => undefined);
    // the stop is owed, not lost to a throw out of a timer
    await after.stopJob(lease.jobId);
    expect(alive(pid)).toBe(true);
    expect(after.running()).toBe(1);

    broken = false;
    await expect(watched).rejects.toThrow("without leaving an exit status");
    await until(() => !alive(pid));
  });

  it("keeps an adopted job, and the stop it is owed, while its start time cannot be read", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-unread", leaseId: "lease-unread" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30 & echo $!; wait" });
    const pid = spawned.pid!;
    const grandchild = await until(() => printedPid(before.files(lease).logPath));
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // `ps` fails (it timed out, could not be started, or printed nothing).
    let answer: boolean | null = null;
    let reads = 0;
    const after = adapter(dataDir, { leaderStartedNear: () => { reads += 1; return answer; } });
    // not knowing is not proof the job is dead: it is adopted, not reported lost
    expect(after.isProcessAlive(pid, record)).toBe(true);
    let settled = false;
    const watched = after.watchProcess(pid, record);
    watched.then(() => { settled = true; }, () => { settled = true; });

    await after.stopJob(lease.jobId);
    // The owed stop goes round again while `ps` stays silent: wait for two
    // more tries, not for a stretch of the clock.
    const readsAtStop = reads;
    await until(() => reads >= readsAtStop + 2);
    // nothing was signalled, and the job is neither settled nor forgotten
    expect(alive(pid)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    expect(settled).toBe(false);
    expect(after.running()).toBe(1);

    // `ps` answers again: the stop that was owed goes out
    answer = true;
    await expect(watched).rejects.toThrow("without leaving an exit status");
    await until(() => !alive(grandchild));
    expect(alive(pid)).toBe(false);
    expect(after.running()).toBe(0);
  });

  it("still ends an adopted job past its run limit once its start time can be read", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-late-unread", leaseId: "lease-late-unread" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    let answer: boolean | null = null;
    let reads = 0;
    const after = adapter(dataDir, { now: () => Date.now() + 60_000, leaderStartedNear: () => { reads += 1; return answer; } });
    let settled = false;
    const watched = after.watchProcess(pid, record);
    watched.then(() => { settled = true; }, () => { settled = true; });
    // The run limit is behind the clock, so its kill is due at once and is
    // owed while `ps` is silent.  Wait for it to be tried three times.
    await until(() => reads >= 3);
    expect(alive(pid)).toBe(true);
    expect(settled).toBe(false);

    answer = true;
    expect(await watched).toEqual({ exitCode: null, signal: null, reason: "run limit reached" });
    expect(alive(pid)).toBe(false);
  });

  it("never signals a pid whose process started at another time", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-stranger", leaseId: "lease-stranger" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // `ps` answered, and the start time is not the lease's: a stranger.
    const after = adapter(dataDir, { leaderStartedNear: () => false });
    expect(after.isProcessAlive(pid, record)).toBe(false);
    const watched = after.watchProcess(pid, record);
    watched.catch(() => undefined);
    await after.stopJob(lease.jobId);
    await after.stopJob(lease.jobId, "SIGKILL");
    await expect(watched).rejects.toThrow("without leaving an exit status");
    expect(alive(pid)).toBe(true);
    expect(after.running()).toBe(0);
  });

  it("settles an adopted job whose pid a stranger took over after the leader ended without a status", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-recycled", leaseId: "lease-recycled" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 30_000, pid });

    // The start time matched when the job was adopted.  Later `ps` reads
    // another start time for the same pid: the leader ended, and its number
    // went to someone else.  The pid is alive throughout and the run limit is
    // half a minute away, so only the poll's own check can end the wait.
    let answer: boolean | null = true;
    const after = adapter(dataDir, { leaderStartedNear: () => answer });
    expect(after.isProcessAlive(pid, record)).toBe(true);
    const watched = after.watchProcess(pid, record);
    watched.catch(() => undefined);
    answer = false;
    await expect(watched).rejects.toThrow("without leaving an exit status");
    // nothing was signalled, and the slot is free
    expect(alive(pid)).toBe(true);
    expect(after.running()).toBe(0);
  });

  it("waits for a leader that left its exit status and still lives, so what it left running is stopped", async () => {
    const { dataDir, workDir } = folder();
    const lease = { jobId: "job-finishing", leaseId: "lease-finishing" };
    const reads: number[] = [];
    const after = adapter(dataDir, { adoptedPollMs: 300, leaderStartedNear: () => { reads.push(1); return true; } });
    // The leader is a process of this test, so no other adapter reaps it.
    const leader = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > "${join(workDir, "left")}"; wait`], { detached: true, stdio: "ignore", cwd: workDir });
    const pid = leader.pid!;
    try {
      const grandchild = await until(() => {
        const printed = existsSync(join(workDir, "left")) ? Number(readFileSync(join(workDir, "left"), "utf8").trim()) : 0;
        return printed > 0 ? printed : null;
      });
      // The wrapper writes its status and then exits.  This is the moment
      // between: the status is on disk and the leader is alive.
      mkdirSync(join(dataDir, "placement", "jobs"), { recursive: true });
      writeFileSync(after.files(lease).exitPath, "0\n");
      const watched = after.watchProcess(pid, leaseRecord(lease, { timeoutMs: 30_000, pid }));
      let settled = false;
      watched.then(() => { settled = true; }, () => { settled = true; });

      // the first poll has run, saw the status with the leader alive, and waited
      await until(() => reads.length > 0);
      expect(settled).toBe(false);
      expect(alive(grandchild)).toBe(true);

      // the leader exits (alone: its group is left standing)
      process.kill(pid, "SIGKILL");
      expect(await watched).toEqual({ exitCode: 0, signal: null, reason: "processes it left running were stopped" });
      await until(() => !alive(grandchild));
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
  });

  it("stops what a leader that outlasts the wait left running, judging its group by its start time", async () => {
    const { dataDir, workDir } = folder();
    const lease = { jobId: "job-lingering", leaseId: "lease-lingering" };
    // The wait for a finishing leader is three polls; this leader is still
    // alive after them, so the poll settles with it alive and its pid held.
    const after = adapter(dataDir, { adoptedPollMs: 20, leaderStartedNear: () => true });
    const leader = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > "${join(workDir, "left")}"; wait`], { detached: true, stdio: "ignore", cwd: workDir });
    const pid = leader.pid!;
    try {
      const grandchild = await until(() => {
        const printed = existsSync(join(workDir, "left")) ? Number(readFileSync(join(workDir, "left"), "utf8").trim()) : 0;
        return printed > 0 ? printed : null;
      });
      mkdirSync(join(dataDir, "placement", "jobs"), { recursive: true });
      writeFileSync(after.files(lease).exitPath, "0\n");
      const watched = after.watchProcess(pid, leaseRecord(lease, { timeoutMs: 30_000, pid }));
      // A leader that is alive and whose start time matches is the lease's own
      // process, not a stranger's: its group is stopped and the job says so.
      expect(await watched).toEqual({ exitCode: 0, signal: null, reason: "processes it left running were stopped" });
      await until(() => !alive(grandchild));
      await until(() => !alive(pid));
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
  });

  it("tries a stop it is owed again while it waits for a finishing leader", async () => {
    const { dataDir, workDir } = folder();
    const lease = { jobId: "job-owed-finishing", leaseId: "lease-owed-finishing" };
    let answer: boolean | null = null;
    let reads = 0;
    // Slow polls, so the three-poll wait is long next to the retry's delay.
    const after = adapter(dataDir, { adoptedPollMs: 300, leaderStartedNear: () => { reads += 1; return answer; } });
    const leader = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > "${join(workDir, "left")}"; wait`], { detached: true, stdio: "ignore", cwd: workDir });
    const pid = leader.pid!;
    try {
      const grandchild = await until(() => {
        const printed = existsSync(join(workDir, "left")) ? Number(readFileSync(join(workDir, "left"), "utf8").trim()) : 0;
        return printed > 0 ? printed : null;
      });
      mkdirSync(join(dataDir, "placement", "jobs"), { recursive: true });
      writeFileSync(after.files(lease).exitPath, "0\n");
      const watched = after.watchProcess(pid, leaseRecord(lease, { timeoutMs: 30_000, pid }));
      let settled = false;
      watched.then(() => { settled = true; }, () => { settled = true; });
      // `ps` is silent, so the stop is owed and nothing is signalled.  Its
      // retry is due on the second poll; the wait for the leader ends only on
      // the fourth.  The read the first poll makes and the one the stop made
      // are two; a third before the job settles is the retry.
      await after.stopJob(lease.jobId);
      await until(() => reads >= 3);
      expect(settled).toBe(false);
      expect(alive(grandchild)).toBe(true);
      // `ps` answers again: the group goes, whichever poll gets to it first
      answer = true;
      expect(await watched).toMatchObject({ exitCode: 0, signal: null });
      await until(() => !alive(grandchild));
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
  });

  it("never signals a process when passive", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-held", leaseId: "lease-held" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({ ...lease, cwd: workDir, timeoutMs: 30_000, command: "sleep 30" });
    const pid = spawned.pid!;
    // a record whose limit is long past: a passive adapter still leaves it alone
    const record = leaseRecord(lease, { spawnedAt, timeoutMs: 1, pid });

    // A passive adapter has no kill to wait on, so the polls are what is
    // counted: each one reads the clock once.
    let ticks = 0;
    const passive = adapter(dataDir, { passive: true, now: () => { ticks += 1; return Date.now() + 60_000; } });
    const watched = passive.watchProcess(pid, record);
    watched.catch(() => undefined);
    await passive.stopJob(lease.jobId);
    await passive.stopJob(lease.jobId, "SIGKILL");
    await until(() => ticks >= 5);
    expect(alive(pid)).toBe(true);

    await before.stopJob(lease.jobId);
    expect(await spawned.done).toEqual({ exitCode: null, signal: "SIGTERM" });
    await expect(watched).rejects.toThrow("without leaving an exit status");
  });

  it("settles a job that finished while the worker was down as completed, through the runtime", async () => {
    const { dataDir, workDir } = folder();
    const before = adapter(dataDir);
    const lease = { jobId: "job-1", leaseId: "lease-1" };
    const spawnedAt = Date.now();
    const spawned = await before.spawnJob({
      ...lease,
      cwd: workDir,
      timeoutMs: 10_000,
      command: `"${process.execPath}" "${nonceScript}" "${workDir}" while-down`,
    });
    await spawned.done;
    mkdirSync(join(dataDir, "placement"), { recursive: true });
    writeFileSync(
      join(dataDir, "placement", "worker-leases.json"),
      JSON.stringify({ "job-1": leaseRecord(lease, { spawnedAt, timeoutMs: 10_000, pid: spawned.pid }) }),
    );

    const after = adapter(dataDir);
    const { runtime, reports, storedLeases } = leasedRuntime(after, dataDir, { command: "unused" });
    await runtime.reconcileRestart();
    expect(reports).toEqual([expect.objectContaining({ jobId: "job-1", leaseId: "lease-1", status: "completed", exitCode: 0, signal: null })]);
    expect(reports[0]!.reason).toBeUndefined();
    expect(storedLeases()).toEqual([]);
    expect(nonceRuns(workDir, "while-down").length).toBe(1);
    expect(runtime.getActiveJobs().size).toBe(0);
  });
});
