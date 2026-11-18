/**
 * Worker runtime for server-first placement transport (transport slice T5 of
 * docs/plans/2026-11-03-placement-transport-slices.md).
 *
 * Pulls assignments from the controller, manages worker heartbeats,
 * records leases locally before spawn, handles stop requests and receipts,
 * durably spools and settles terminal reports, and reconciles state on restart.
 *
 * The worker pulls; the controller never dials the worker.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import {
  HOST_ID_PATTERN,
  PLACEMENT_WIRE_VERSION,
  type AdmissionVerdict,
  type CapacitySample,
  type Capability,
  type ClaimReply,
  type HeartbeatReply,
  type HostId,
  type RegisterReply,
  type ReportMessage,
  type ReportReply,
} from "../shared/placement.ts";
import type {
  WorkerCallOutcome,
  PayloadReply,
  StopReceiptReply,
} from "./placement-worker-client.ts";
import { PlacementReportSpool, settlePendingReports } from "./placement-report-spool.ts";

export interface PlacementWorkerClientLike {
  register(req: { capabilities: Capability[]; sample: CapacitySample }): Promise<WorkerCallOutcome<RegisterReply>>;
  heartbeat(req: { leases: string[]; admission: AdmissionVerdict; sample: CapacitySample }): Promise<WorkerCallOutcome<HeartbeatReply>>;
  assignment(): Promise<WorkerCallOutcome<ClaimReply>>;
  payload(req: { jobId: string; leaseId: string }): Promise<WorkerCallOutcome<PayloadReply>>;
  report(report: ReportMessage): Promise<WorkerCallOutcome<ReportReply>>;
  stopReceipt(req: { jobId: string; leaseId: string }): Promise<WorkerCallOutcome<StopReceiptReply>>;
}

export interface WorkerLocalLeaseRecord {
  jobId: string;
  leaseId: string;
  controllerId: HostId;
  epoch: number;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  spawnedAt: number;
  pid?: number | null;
}

const leaseRecordSchema = z.object({
  jobId: z.string().min(1),
  leaseId: z.string().min(1),
  controllerId: z.string().min(1).max(64).regex(HOST_ID_PATTERN).transform((v) => {
    // SAFETY: the regex above matched the HOST_ID_PATTERN shape, so the string is a valid HostId.
    return v as HostId;
  }),
  epoch: z.number().int().nonnegative(),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  spawnedAt: z.number().int().nonnegative(),
  pid: z.number().int().nullable().optional(),
}).strict();

/** The worker's lease store as the runtime writes and reads it: one strict
 *  record per job id.  Exported so a test reads the file through the same
 *  schema the runtime does. */
export const leaseStoreSchema = z.record(z.string(), leaseRecordSchema);

/** How a leased job's process ended, as whoever watched it saw it. */
export interface WorkerJobExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Why it ended, when the status alone does not say (a run limit, say).
   *  A controller stop and an unobserved exit keep their own reasons. */
  reason?: string;
}

export interface WorkerSpawnResult {
  pid: number | null;
  /** Promise that resolves when the spawned process exits. */
  done: Promise<WorkerJobExit>;
}

export interface PlacementWorkerRuntimeDeps {
  client: PlacementWorkerClientLike;
  spool: PlacementReportSpool;
  hostId: HostId;
  capabilities: Capability[];
  dataDir: string;
  sampleProvider: () => CapacitySample;
  admissionProvider: () => AdmissionVerdict;
  spawnJob: (job: { jobId: string; leaseId: string; command: string; cwd?: string; timeoutMs?: number }) => Promise<WorkerSpawnResult>;
  stopJob: (jobId: string, signal?: NodeJS.Signals) => Promise<void>;
  /** Whether `pid` is still the process a lease started.  The restart
   *  reconciliation and the fallback poll both pass the lease record, so a
   *  check can tell the job's own process from a stranger that was handed
   *  the same pid since. */
  isProcessAlive?: (pid: number, record?: WorkerLocalLeaseRecord) => boolean;
  /** Exit of a child that outlived the previous process.  Without it, a later
   *  death is reported lost unless `readExit` finds a status the job left on
   *  disk.  A rejection means the exit could not be observed. */
  watchProcess?: (pid: number, record?: WorkerLocalLeaseRecord) => Promise<WorkerJobExit>;
  /** The exit status a leased job left on disk, or null when it left none.
   *  With it, a job that ended while nothing watched it (the worker was
   *  down, or its adopted process was never observed) is reported completed
   *  or failed from that status instead of lost. */
  readExit?: (record: WorkerLocalLeaseRecord) => { exitCode: number; signal: NodeJS.Signals | null } | null;
  /** Set when this worker's process handling may start and signal nothing
   *  (the read-only rollback build, #1556).  The worker then tells the
   *  controller it admits no work, with this reason, pulls no assignment, and
   *  acts on no stop.  A lease it pulled it could only fail for good, and a
   *  stop it acknowledged it could not carry out: a job it adopted ends on
   *  its own and is reported as it ended. */
  passiveReason?: string;
  now?: () => number;
  heartbeatIntervalMs?: number;
  /** Idle assignment pull. Defaults to the heartbeat interval. */
  assignmentPollIntervalMs?: number;
  /** How often an adopted pid is checked when `watchProcess` is omitted. */
  adoptedPollIntervalMs?: number;
  runningCap?: number;
}

export interface ActiveRunningJob {
  record: WorkerLocalLeaseRecord;
  done: Promise<WorkerJobExit>;
  settled: Promise<void>;
  stopRequested?: boolean;
}

export class PlacementWorkerRuntime {
  private readonly deps: PlacementWorkerRuntimeDeps;
  private readonly leaseFilePath: string;
  private readonly activeJobs = new Map<string, ActiveRunningJob>();
  private readonly now: () => number;
  private readonly isAlive: (pid: number, record?: WorkerLocalLeaseRecord) => boolean;
  private heartbeatTimer?: NodeJS.Timeout;
  private assignmentTimer?: NodeJS.Timeout;
  private pullTail: Promise<void> = Promise.resolve();
  private draining = false;
  private registered = false;
  private running = false;

  constructor(deps: PlacementWorkerRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.isAlive = deps.isProcessAlive ?? ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    const placementDir = join(deps.dataDir, "placement");
    mkdirSync(placementDir, { recursive: true, mode: 0o700 });
    this.leaseFilePath = join(placementDir, "worker-leases.json");
  }

  /** Read currently persisted local lease records. */
  private readStoredLeases(): Map<string, WorkerLocalLeaseRecord> {
    if (!existsSync(this.leaseFilePath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.leaseFilePath, "utf8"));
      const parsed = leaseStoreSchema.safeParse(raw);
      if (!parsed.success) return new Map();
      return new Map(Object.entries(parsed.data));
    } catch {
      return new Map();
    }
  }

  /** Atomically write the local active lease records to disk. */
  private writeStoredLeases(records: Map<string, WorkerLocalLeaseRecord>): void {
    const obj: Record<string, WorkerLocalLeaseRecord> = {};
    for (const [id, rec] of records) {
      obj[id] = rec;
    }
    writeFileAtomic(this.leaseFilePath, JSON.stringify(obj, null, 2));
  }

  private saveLeaseRecord(record: WorkerLocalLeaseRecord): void {
    const records = this.readStoredLeases();
    records.set(record.jobId, record);
    this.writeStoredLeases(records);
  }

  private removeLeaseRecord(jobId: string): void {
    const records = this.readStoredLeases();
    if (records.delete(jobId)) {
      this.writeStoredLeases(records);
    }
  }

  private spoolTerminal(
    record: WorkerLocalLeaseRecord,
    fields: { status: ReportMessage["status"]; exitCode: number | null; signal: string | null; reason?: string },
  ): void {
    const report: ReportMessage = {
      version: PLACEMENT_WIRE_VERSION,
      controllerId: record.controllerId,
      epoch: record.epoch,
      jobId: record.jobId,
      leaseId: record.leaseId,
      hostId: this.deps.hostId,
      status: fields.status,
      exitCode: fields.exitCode,
      signal: fields.signal,
      endedAt: this.now(),
      reason: fields.reason,
    };
    try {
      this.deps.spool.add(report);
    } catch {
      // A different terminal report is already durable.
    }
  }

  private enqueuePull<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pullTail.then(work, work);
    this.pullTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Pull until the controller has nothing eligible or this worker cannot take more. */
  private async drainAssignments(): Promise<void> {
    if (this.draining || !this.running) return;
    this.draining = true;
    try {
      while (this.running) {
        const result = await this.enqueuePull(() => this.pullOne());
        if (!result.keepPulling) return;
      }
    } catch {
      // The next poll interval retries a thrown call so the worker does not stay idle.
    } finally {
      this.draining = false;
    }
  }

  private adoptLiveLease(record: WorkerLocalLeaseRecord): void {
    if (record.pid == null || this.activeJobs.has(record.jobId)) return;
    this.trackJob(record, this.observePid(record.pid, record));
  }

  /** The status a job left on disk.  An unreadable status is no status:
   *  the job is then reported lost, never completed. */
  private exitOnDisk(record: WorkerLocalLeaseRecord): { exitCode: number; signal: NodeJS.Signals | null } | null {
    try {
      return this.deps.readExit?.(record) ?? null;
    } catch {
      return null;
    }
  }

  private observePid(pid: number, record: WorkerLocalLeaseRecord): Promise<WorkerJobExit & { observed: boolean }> {
    const watch = this.deps.watchProcess;
    if (!watch) return this.pollUntilExit(pid, record);
    return watch(pid, record).then(
      (exit) => ({ ...exit, observed: true }),
      () => ({ exitCode: null, signal: null, observed: false }),
    );
  }

  /** The liveness check gets the lease here as it does at restart: a check
   *  that tells the job from a stranger by its lease answers false for a
   *  bare pid, and a live job would be reported lost on the first poll. */
  private pollUntilExit(pid: number, record: WorkerLocalLeaseRecord): Promise<WorkerJobExit & { observed: boolean }> {
    const intervalMs = this.deps.adoptedPollIntervalMs ?? 1000;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.isAlive(pid, record)) return;
        clearInterval(timer);
        resolve({ exitCode: null, signal: null, observed: false });
      }, intervalMs);
      timer.unref();
    });
  }

  private trackJob(
    record: WorkerLocalLeaseRecord,
    done: Promise<WorkerJobExit & { observed: boolean }>,
  ): void {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const activeJob: ActiveRunningJob = {
      record,
      done: done.then(({ exitCode, signal }) => ({ exitCode, signal })),
      settled,
    };
    this.activeJobs.set(record.jobId, activeJob);
    void done.then(async (exit) => {
      try {
        await this.finishJob(record, activeJob, exit);
      } finally {
        resolveSettled();
      }
    });
  }

  private async finishJob(
    record: WorkerLocalLeaseRecord,
    activeJob: ActiveRunningJob,
    seen: WorkerJobExit & { observed: boolean },
  ): Promise<void> {
    this.activeJobs.delete(record.jobId);
    // Nobody saw the process end, but the job may have written its own
    // status before it did: that status is the result, not "lost".
    const written = seen.observed ? null : this.exitOnDisk(record);
    const exit: WorkerJobExit & { observed: boolean } = written ? { ...written, observed: true } : seen;
    const status = activeJob.stopRequested
      ? "killed"
      : !exit.observed
        ? "lost"
        : exit.exitCode === 0
          ? "completed"
          : "failed";
    const reason = activeJob.stopRequested
      ? "stopped by controller"
      : !exit.observed
        ? "adopted process exited without an observed status"
        : exit.reason;
    this.spoolTerminal(record, { status, exitCode: exit.exitCode, signal: exit.signal, reason });
    this.removeLeaseRecord(record.jobId);
    await settlePendingReports(this.deps.spool, this.deps.client);
    if (this.running) void this.drainAssignments();
  }

  /**
   * Reconciles orphan leases from previous crashes and flushes the report spool.
   * Runs before registration on startup.
   */
  async reconcileRestart(): Promise<void> {
    // 1. Settle any terminal reports already spooled.
    await settlePendingReports(this.deps.spool, this.deps.client);

    // 2. Check for orphan leases in the local store.
    const stored = this.readStoredLeases();
    for (const [jobId, record] of stored) {
      const alive = record.pid ? this.isAlive(record.pid, record) : false;
      if (!alive) {
        // The process is gone.  A job that finished while the worker was
        // down left its status on disk and settles from it; one that left
        // none is lost.
        const written = this.exitOnDisk(record);
        if (written) {
          this.spoolTerminal(record, {
            status: written.exitCode === 0 ? "completed" : "failed",
            exitCode: written.exitCode,
            signal: written.signal,
          });
        } else {
          this.spoolTerminal(record, {
            status: "lost",
            exitCode: null,
            signal: null,
            reason: "worker process restarted while lease was active",
          });
        }
        stored.delete(jobId);
      } else {
        this.adoptLiveLease(record);
      }
    }
    this.writeStoredLeases(stored);

    // 3. Settle reports again after reconciling orphans.
    await settlePendingReports(this.deps.spool, this.deps.client);
  }

  /** Announce capabilities and initial capacity to the controller. */
  async register(): Promise<WorkerCallOutcome<{ accepted: boolean; reason?: string }>> {
    const outcome = await this.deps.client.register({
      capabilities: this.deps.capabilities,
      sample: this.deps.sampleProvider(),
    });
    if (outcome.outcome === "accepted") {
      this.registered = true;
    }
    return outcome;
  }

  /** Perform one heartbeat tick: reports leases, admission, sample; handles pending stops. */
  async tickHeartbeat(): Promise<void> {
    const leases = Array.from(this.activeJobs.values()).map((j) => j.record.leaseId);
    const admission = this.admission();
    const sample = this.deps.sampleProvider();

    const outcome = await this.deps.client.heartbeat({ leases, admission, sample });
    // A passive worker signals nothing, so it acknowledges no stop either.
    if (outcome.outcome === "accepted" && this.deps.passiveReason === undefined) {
      // The controller lists the leases to stop (`stopNow` in
      // server/placement-leases.ts adds `message.leaseId`), never job ids.
      // A stop for an earlier lease of a job must not reach its current one.
      for (const leaseId of outcome.reply.pendingStops) {
        const active = [...this.activeJobs.values()].find((job) => job.record.leaseId === leaseId);
        if (active && !active.stopRequested) {
          active.stopRequested = true;
          const { jobId } = active.record;
          // Acknowledge stop receipt to controller.
          await this.deps.client.stopReceipt({ jobId, leaseId });
          // Stop the active process.
          await this.deps.stopJob(jobId, "SIGTERM");
        }
      }
    }

    // Flush any pending reports in spool on heartbeat.
    await settlePendingReports(this.deps.spool, this.deps.client);
  }

  /**
   * Poll for work from the controller.
   * If work is returned, records lease locally, spawns process, and monitors exit.
   */
  async pullAssignment(): Promise<{ polled: boolean; jobId?: string }> {
    const result = await this.enqueuePull(() => this.pullOne());
    return { polled: result.polled, jobId: result.jobId };
  }

  /** What this worker tells the controller, and itself, about taking work.
   *  A passive worker admits none, whatever its capacity says. */
  private admission(): AdmissionVerdict {
    const held = this.deps.passiveReason;
    return held === undefined ? this.deps.admissionProvider() : { admit: false, reason: held };
  }

  private async pullOne(): Promise<{ polled: boolean; jobId?: string; keepPulling: boolean }> {
    const admission = this.admission();
    if (!admission.admit) {
      return { polled: false, keepPulling: false };
    }
    const cap = this.deps.runningCap ?? 10;
    if (this.activeJobs.size >= cap) {
      return { polled: false, keepPulling: false };
    }

    const outcome = await this.deps.client.assignment();
    if (outcome.outcome !== "accepted" || outcome.reply.accepted !== true) {
      return { polled: true, keepPulling: false };
    }

    const lease = outcome.reply.lease;
    // The controller offers a lease again until a heartbeat reports it as
    // held, and again after a report it never received.  A job this worker
    // is running, or holds a durable result for under this lease, is never
    // spawned a second time: the heartbeat and the spooled report answer it.
    if (this.activeJobs.has(lease.jobId)) {
      return { polled: true, jobId: lease.jobId, keepPulling: false };
    }
    // One row read by job id, never the whole spool: a pull happens on every
    // poll, and the spool may hold thousands of undelivered reports.
    if (this.deps.spool.get(lease.jobId)?.message.leaseId === lease.leaseId) {
      await settlePendingReports(this.deps.spool, this.deps.client);
      return { polled: true, jobId: lease.jobId, keepPulling: false };
    }
    // Fetch command payload from controller.
    const payloadOutcome = await this.deps.client.payload({ jobId: lease.jobId, leaseId: lease.leaseId });
    if (payloadOutcome.outcome !== "accepted" || !payloadOutcome.reply.command) {
      return { polled: true, keepPulling: false };
    }

    const { command, cwd, timeoutMs } = payloadOutcome.reply;

    // Record lease locally BEFORE spawning.
    const record: WorkerLocalLeaseRecord = {
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      controllerId: lease.controllerId,
      epoch: lease.epoch,
      command,
      cwd,
      timeoutMs,
      spawnedAt: this.now(),
      pid: null,
    };
    this.saveLeaseRecord(record);

    let spawnResult: WorkerSpawnResult;
    try {
      spawnResult = await this.deps.spawnJob({
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        command,
        cwd,
        timeoutMs,
      });
    } catch (error) {
      // Failed to spawn: record terminal failure.
      const report: ReportMessage = {
        version: PLACEMENT_WIRE_VERSION,
        controllerId: lease.controllerId,
        epoch: lease.epoch,
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        hostId: this.deps.hostId,
        status: "failed",
        exitCode: null,
        signal: null,
        endedAt: this.now(),
        reason: error instanceof Error ? error.message : "failed to spawn process",
      };
      this.deps.spool.add(report);
      this.removeLeaseRecord(lease.jobId);
      await settlePendingReports(this.deps.spool, this.deps.client);
      return { polled: true, jobId: lease.jobId, keepPulling: false };
    }

    record.pid = spawnResult.pid;
    this.saveLeaseRecord(record);
    this.trackJob(record, spawnResult.done.then((exit) => ({ ...exit, observed: true })));
    return { polled: true, jobId: lease.jobId, keepPulling: true };
  }

  getActiveJob(jobId: string): ActiveRunningJob | undefined {
    return this.activeJobs.get(jobId);
  }

  async waitForJob(jobId: string): Promise<void> {
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    await job.settled;
  }

  /** Start background loops (heartbeat and reconciliation). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.reconcileRestart();
    await this.register();

    const interval = this.deps.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat();
    }, interval);
    this.heartbeatTimer.unref();

    const pollInterval = this.deps.assignmentPollIntervalMs ?? interval;
    this.assignmentTimer = setInterval(() => {
      void this.drainAssignments();
    }, pollInterval);
    this.assignmentTimer.unref();
    void this.drainAssignments();
  }

  /** Stop background loops and flush remaining state. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.assignmentTimer) {
      clearInterval(this.assignmentTimer);
      this.assignmentTimer = undefined;
    }
    await settlePendingReports(this.deps.spool, this.deps.client);
  }

  /** Current active jobs running in memory. */
  getActiveJobs(): ReadonlyMap<string, ActiveRunningJob> {
    return this.activeJobs;
  }

  /** Is the worker registered with the controller. */
  isRegistered(): boolean {
    return this.registered;
  }
}
