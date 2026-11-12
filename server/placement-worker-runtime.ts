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

const leaseStoreSchema = z.record(z.string(), leaseRecordSchema);

export interface WorkerSpawnResult {
  pid: number | null;
  /** Promise that resolves when the spawned process exits. */
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
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
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  heartbeatIntervalMs?: number;
  runningCap?: number;
}

export interface ActiveRunningJob {
  record: WorkerLocalLeaseRecord;
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  stopRequested?: boolean;
}

export class PlacementWorkerRuntime {
  private readonly deps: PlacementWorkerRuntimeDeps;
  private readonly leaseFilePath: string;
  private readonly activeJobs = new Map<string, ActiveRunningJob>();
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private heartbeatTimer?: NodeJS.Timeout;
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
      const alive = record.pid ? this.isAlive(record.pid) : false;
      if (!alive) {
        // Process is dead; mark as lost and spool report.
        const report: ReportMessage = {
          version: PLACEMENT_WIRE_VERSION,
          controllerId: record.controllerId,
          epoch: record.epoch,
          jobId: record.jobId,
          leaseId: record.leaseId,
          hostId: this.deps.hostId,
          status: "lost",
          exitCode: null,
          signal: null,
          endedAt: this.now(),
          reason: "worker process restarted while lease was active",
        };
        try {
          this.deps.spool.add(report);
        } catch {
          // If a different terminal report is already durable, keep that one.
        }
        stored.delete(jobId);
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
    const admission = this.deps.admissionProvider();
    const sample = this.deps.sampleProvider();

    const outcome = await this.deps.client.heartbeat({ leases, admission, sample });
    if (outcome.outcome === "accepted") {
      const { pendingStops } = outcome.reply;
      for (const jobId of pendingStops) {
        const active = this.activeJobs.get(jobId);
        if (active && !active.stopRequested) {
          active.stopRequested = true;
          // Acknowledge stop receipt to controller.
          await this.deps.client.stopReceipt({ jobId, leaseId: active.record.leaseId });
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
    const admission = this.deps.admissionProvider();
    if (!admission.admit) {
      return { polled: false };
    }
    const cap = this.deps.runningCap ?? 10;
    if (this.activeJobs.size >= cap) {
      return { polled: false };
    }

    const outcome = await this.deps.client.assignment();
    if (outcome.outcome !== "accepted" || outcome.reply.accepted !== true) {
      return { polled: true };
    }

    const lease = outcome.reply.lease;
    // Fetch command payload from controller.
    const payloadOutcome = await this.deps.client.payload({ jobId: lease.jobId, leaseId: lease.leaseId });
    if (payloadOutcome.outcome !== "accepted" || !payloadOutcome.reply.command) {
      return { polled: true };
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
      return { polled: true, jobId: lease.jobId };
    }

    record.pid = spawnResult.pid;
    this.saveLeaseRecord(record);

    const activeJob: ActiveRunningJob = {
      record,
      done: spawnResult.done,
    };
    this.activeJobs.set(lease.jobId, activeJob);

    // Attach completion listener.
    void spawnResult.done.then(async ({ exitCode, signal }) => {
      this.activeJobs.delete(lease.jobId);
      const status = activeJob.stopRequested
        ? "killed"
        : (exitCode === 0 ? "completed" : "failed");

      const report: ReportMessage = {
        version: PLACEMENT_WIRE_VERSION,
        controllerId: lease.controllerId,
        epoch: lease.epoch,
        jobId: lease.jobId,
        leaseId: lease.leaseId,
        hostId: this.deps.hostId,
        status,
        exitCode,
        signal,
        endedAt: this.now(),
        reason: activeJob.stopRequested ? "stopped by controller" : undefined,
      };

      try {
        this.deps.spool.add(report);
      } catch {
        // Report already durable.
      }
      this.removeLeaseRecord(lease.jobId);
      await settlePendingReports(this.deps.spool, this.deps.client);

      // Trigger next work pull if running.
      if (this.running) {
        void this.pullAssignment();
      }
    });

    return { polled: true, jobId: lease.jobId };
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

    // Pull initial work if capacity allows.
    void this.pullAssignment();
  }

  /** Stop background loops and flush remaining state. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
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
