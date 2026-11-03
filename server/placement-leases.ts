/** The controller's placement lease book (native server mode plan, slice 8b —
 *  register, heartbeat, claim, dispatch, stop, release, release-controller,
 *  takeover, enqueue, and report).
 *
 *  One authoritative queue lives here on the controller: a job is enqueued
 *  once (idempotent on job id), claimed or dispatched once (a compare-and-set
 *  from `queued` to leased, fenced on the controller epoch), and reported once
 *  (a replayed report gets the same acknowledgement and changes nothing).
 *  A worker that stops heartbeating takes its leased jobs to
 *  `worker-unreachable`; they are never requeued or re-dispatched from a
 *  timer, so a job can never run twice because a link went quiet.
 *
 *  Controller epochs persist before acknowledgement; leases and queue state
 *  remain the controller's live book, without restart persistence.
 *  The job records a person reads stay in the job registry. */
import { randomUUID } from "node:crypto";
import type { ControllerEpochStore } from "./placement-identity.ts";
import { z } from "zod";
import { derivedCapability, hostCanRunCommand } from "../shared/mac-only-capabilities.ts";
import {
  HOST_ID_PATTERN,
  PLACEMENT_WIRE_VERSION,
  type AdmissionVerdict,
  type Capability,
  type ClaimMessage,
  type ClaimReply,
  type ControllerEpoch,
  type ControllerReleaseReply,
  type DispatchMessage,
  type DispatchReply,
  type EnqueueMessage,
  type EnqueueReply,
  type HeartbeatMessage,
  type HeartbeatReply,
  type HostId,
  type Lease,
  type LeaseReleaseMessage,
  type LeaseReleaseReply,
  type PlacementMessage,
  type RegisterMessage,
  type RegisterReply,
  type ReleaseMessage,
  type ReportMessage,
  type ReportReply,
  type StopMessage,
  type StopReply,
  type TakeoverMessage,
  type TakeoverReply,
} from "../shared/placement.ts";

export type { ControllerReleaseReply, DispatchReply, StopReply, TakeoverReply } from "../shared/placement.ts";

export type PlacementJobStatus =
  | "queued" | "dispatching" | "running" | "worker-unreachable"
  | "completed" | "failed" | "killed" | "lost";

export interface PlacementJob {
  jobId: string;
  botId: string;
  threadId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  status: PlacementJobStatus;
  host?: HostId;
  leaseId?: string;
  /** "needs xcodebuild" when derivation pinned the capability, else absent. */
  requiredReason?: string;
  queuedReason?: string;
  placedReason?: string;
  stopReason?: string;
  /** Set when a forced takeover adopts a higher epoch while this job was in flight. */
  ranAfterTakeover?: boolean;
  report?: { status: ReportMessage["status"]; exitCode: number | null; signal: string | null; endedAt: number };
}

interface WorkerBook {
  hostId: HostId;
  role: "controller" | "worker";
  capabilities: Capability[];
  lastSeen: number;
  admission: AdmissionVerdict;
}

export interface PlacementLeaseDeps {
  hostId: HostId;
  controller: ControllerEpoch;
  /** Required by the server; omitted only for isolated in-memory fixtures. */
  controllerStore?: ControllerEpochStore;
  now?: () => number;
  /** A worker unseen for this long is unreachable.  Injectable: the plan
   *  leaves the value to the heartbeat knobs, which are not set yet. */
  unreachableAfterMs?: number;
  newLeaseId?: () => string;
}

export type LeaseResult<T> = { ok: true; reply: T } | { ok: false; reason: string; controller: ControllerEpoch };

const TERMINAL: readonly PlacementJobStatus[] = ["completed", "failed", "killed", "lost"];

export const MAX_TAKEOVER_EPOCH_JUMP = 100_000;

export class PlacementLeaseService {
  private current: ControllerEpoch;
  private readonly controllerStore?: ControllerEpochStore;
  private reconcileState = false;
  private readonly workers = new Map<HostId, WorkerBook>();
  private readonly jobs = new Map<string, PlacementJob>();
  private readonly pendingStops = new Map<HostId, Set<string>>();
  private readonly now: () => number;
  private readonly unreachableAfterMs: number;
  private readonly newLeaseId: () => string;

  constructor(deps: PlacementLeaseDeps) {
    this.controllerStore = deps.controllerStore;
    this.current = { ...(deps.controllerStore?.read() ?? deps.controller) };
    this.now = deps.now ?? Date.now;
    this.unreachableAfterMs = deps.unreachableAfterMs ?? 30_000;
    this.newLeaseId = deps.newLeaseId ?? (() => `lease_${randomUUID()}`);
  }

  controller(): ControllerEpoch {
    this.refreshController();
    return { ...this.current };
  }

  private refreshController(): void {
    const stored = this.controllerStore?.read();
    if (stored && (stored.controllerId !== this.current.controllerId || stored.epoch !== this.current.epoch)) {
      if (stored.epoch <= this.current.epoch) throw new Error("persisted controller epoch regressed");
      this.current = { ...stored };
      this.reconcileState = true;
      this.markOrphanedJobs();
    }
  }

  private markOrphanedJobs(): string[] {
    const orphanedJobIds: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "dispatching" || job.status === "running" || job.status === "worker-unreachable") {
        job.ranAfterTakeover = true;
        orphanedJobIds.push(job.jobId);
      }
    }
    return orphanedJobIds;
  }

  private verifyController(): string | null {
    try {
      this.refreshController();
      return null;
    } catch {
      return "Controller epoch could not be verified; placement refused";
    }
  }

  private commitController(next: ControllerEpoch): string | null {
    try {
      const result = this.controllerStore?.compareAndSet(this.current, next);
      if (result && !result.accepted) {
        this.refreshController();
        return "Controller epoch changed; retry with the current fence";
      }
    } catch {
      return "Controller epoch could not be persisted; transition refused";
    }
    this.current = { ...next };
    return null;
  }

  reconciling(): boolean {
    return this.reconcileState;
  }

  job(jobId: string): PlacementJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  jobsList(): PlacementJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  /** The epoch fence every state-changing message crosses first: versions
   *  before epochs, and only the current pair passes.  A lower pair is
   *  refused so the sender converges; a higher pair is refused on worker
   *  and queue messages too, never adopted outside `takeover`, so no skewed
   *  or forged worker bump can invalidate outstanding leases. */
  private fence(message: PlacementMessage): string | null {
    const failure = this.verifyController();
    if (failure) return failure;
    if (message.version !== PLACEMENT_WIRE_VERSION) {
      return `placement version ${message.version} is not spoken here (this host speaks ${PLACEMENT_WIRE_VERSION})`;
    }
    if (message.epoch > this.current.epoch) {
      return `stale controller epoch ${message.epoch}; the controller is ${this.current.controllerId} at epoch ${this.current.epoch}`;
    }
    if (message.epoch < this.current.epoch || message.controllerId !== this.current.controllerId) {
      return `stale controller epoch ${message.epoch}; the controller is ${this.current.controllerId} at epoch ${this.current.epoch}`;
    }
    return null;
  }

  private refused<T>(reason: string): LeaseResult<T> {
    // A refusal may follow a failed durable read; return only the last
    // verified pair as context, never as authorization to mutate state.
    return { ok: false, reason, controller: { ...this.current } };
  }

  private clearPendingStop(hostId: HostId | undefined, leaseId: string | undefined): void {
    if (!hostId || !leaseId) return;
    const set = this.pendingStops.get(hostId);
    if (!set) return;
    set.delete(leaseId);
    if (set.size === 0) {
      this.pendingStops.delete(hostId);
    }
  }

  register(message: RegisterMessage): LeaseResult<RegisterReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    this.workers.set(message.hostId, {
      hostId: message.hostId,
      role: message.role,
      capabilities: message.capabilities,
      lastSeen: this.now(),
      admission: { admit: true },
    });
    return { ok: true, reply: { accepted: true, ...this.current } };
  }

  heartbeat(message: HeartbeatMessage): LeaseResult<HeartbeatReply> {
    const stale = this.fence(message);
    if (stale) return this.refused(stale);
    const worker = this.workers.get(message.hostId);
    if (!worker) return this.refused(`${message.hostId} is not registered with this controller`);
    worker.lastSeen = this.now();
    worker.admission = message.admission;
    const held = new Set(message.leases);
    const dispatchingOnHost = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.host === message.hostId && job.leaseId) {
        if (held.has(job.leaseId) && (job.status === "dispatching" || job.status === "worker-unreachable")) {
          job.status = "running";
        } else if (job.status === "dispatching") {
          dispatchingOnHost.add(job.leaseId);
        }
      }
    }
    const stopsForHost = this.pendingStops.get(message.hostId);
    if (stopsForHost) {
      for (const leaseId of stopsForHost) {
        if (!held.has(leaseId) && !dispatchingOnHost.has(leaseId)) {
          stopsForHost.delete(leaseId);
        }
      }
      if (stopsForHost.size === 0) {
        this.pendingStops.delete(message.hostId);
      }
    }
    const pendingStops = [...(this.pendingStops.get(message.hostId) ?? [])];
    return { ok: true, reply: { pendingStops, ...this.current } };
  }

  /** Admit a job to the one authoritative queue.  Idempotent on job id: an
   *  exact replay answers with the existing record and enqueues nothing
   *  twice, but the same id with a different payload is a conflict (409),
   *  never a silent drop — the caller must use a new job id for new work. */
  enqueue(message: EnqueueMessage): LeaseResult<EnqueueReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, jobId: message.jobId, status: "refused", reason: stale, ...this.current } };
    const existing = this.jobs.get(message.jobId);
    if (existing) {
      const samePayload =
        existing.botId === message.botId &&
        existing.threadId === message.threadId &&
        existing.command === message.command &&
        existing.cwd === message.cwd &&
        existing.timeoutMs === message.timeoutMs;
      if (!samePayload) {
        return this.refused(`job ${message.jobId} is already queued with a different payload; use a new job id for new work`);
      }
      return { ok: true, reply: { accepted: true, duplicate: true, jobId: existing.jobId, status: existing.status, ...this.current } };
    }
    const derived = derivedCapability(message.command, { cwd: message.cwd });
    const job: PlacementJob = {
      jobId: message.jobId,
      botId: message.botId,
      threadId: message.threadId,
      command: message.command,
      cwd: message.cwd,
      timeoutMs: message.timeoutMs,
      status: "queued",
      requiredReason: derived?.reason,
      queuedReason: "waiting for an eligible host",
    };
    this.jobs.set(job.jobId, job);
    return { ok: true, reply: { accepted: true, jobId: job.jobId, status: job.status, ...this.current } };
  }

  /** The compare-and-set lease: only a `queued` job, only at the current
   *  epoch, only for a reachable worker that can run it and last said it
   *  would admit work.  A second claim for the same job is refused. */
  claim(message: ClaimMessage): LeaseResult<ClaimReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    const refuse = (reason: string): LeaseResult<ClaimReply> => ({ ok: true, reply: { accepted: false, reason, ...this.current } });
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no queued job ${message.jobId} on this controller`);
    if (job.status !== "queued") return refuse(`job ${message.jobId} is ${job.status}, not queued; it is never re-dispatched`);
    const worker = this.workers.get(message.hostId);
    if (!worker) return refuse(`${message.hostId} is not registered with this controller`);
    if (this.now() - worker.lastSeen > this.unreachableAfterMs) return refuse(`${message.hostId} has not heartbeated within the window`);
    if (!worker.admission.admit) return refuse(worker.admission.reason ?? `${message.hostId} is not admitting work`);
    if (!hostCanRunCommand(worker.capabilities, job.command, { cwd: job.cwd })) {
      return refuse(`${message.hostId} cannot run this job (${job.requiredReason ?? "capability missing"})`);
    }
    const lease: Lease = { leaseId: this.newLeaseId(), jobId: job.jobId, host: message.hostId, ...this.current };
    job.status = "dispatching";
    job.host = message.hostId;
    job.leaseId = lease.leaseId;
    job.queuedReason = undefined;
    job.placedReason = job.requiredReason ?? "claimed by an eligible host";
    return { ok: true, reply: { accepted: true, lease, ...this.current } };
  }

  /** Push-side lease assignment: fenced on both the message and the embedded
   *  lease epoch, idempotent on an exact replay of the active lease, and
   *  refused when the job already holds a different lease or is no longer
   *  queued. */
  dispatch(message: DispatchMessage): LeaseResult<DispatchReply> {
    const { lease } = message;
    const refuse = (reason: string): LeaseResult<DispatchReply> => ({
      ok: true,
      reply: { accepted: false, leaseId: lease.leaseId, reason, ...this.current },
    });
    const stale = this.fence(message);
    if (stale) return refuse(stale);
    if (lease.controllerId !== this.current.controllerId || lease.epoch !== this.current.epoch) {
      return refuse(`stale lease epoch ${lease.epoch}; the controller is ${this.current.controllerId} at epoch ${this.current.epoch}`);
    }
    const job = this.jobs.get(lease.jobId);
    if (!job) return refuse(`no queued job ${lease.jobId} on this controller`);
    const samePayload =
      job.command === message.command &&
      job.cwd === message.cwd &&
      job.timeoutMs === message.timeoutMs;
    if (job.status === "dispatching" || job.status === "running" || job.status === "worker-unreachable") {
      if (job.leaseId === lease.leaseId && job.host === lease.host && samePayload) {
        return { ok: true, reply: { accepted: true, leaseId: lease.leaseId, ...this.current } };
      }
      return refuse(`job ${job.jobId} is already leased as ${job.leaseId ?? "unleased"} on ${job.host ?? "unknown"}; it is never leased twice`);
    }
    if (job.status !== "queued") {
      return refuse(`job ${job.jobId} is ${job.status}, not queued; it is never re-dispatched`);
    }
    if (!samePayload) {
      return refuse(`dispatch payload for job ${job.jobId} does not match the queued job`);
    }
    for (const other of this.jobs.values()) {
      if (other.jobId !== job.jobId && other.leaseId === lease.leaseId) {
        return refuse("lease_conflict");
      }
    }
    const worker = this.workers.get(lease.host);
    if (!worker) return refuse(`${lease.host} is not registered with this controller`);
    if (this.now() - worker.lastSeen > this.unreachableAfterMs) return refuse(`${lease.host} has not heartbeated within the window`);
    if (!worker.admission.admit) return refuse(worker.admission.reason ?? `${lease.host} is not admitting work`);
    if (!hostCanRunCommand(worker.capabilities, job.command, { cwd: job.cwd })) {
      return refuse(`${lease.host} cannot run this job (${job.requiredReason ?? "capability missing"})`);
    }
    job.status = "dispatching";
    job.host = lease.host;
    job.leaseId = lease.leaseId;
    job.queuedReason = undefined;
    job.placedReason = job.requiredReason ?? "dispatched to an eligible host";
    return { ok: true, reply: { accepted: true, leaseId: lease.leaseId, ...this.current } };
  }

  /** Record a pending stop for an active lease so the holding worker receives
   *  the lease id on its next heartbeat and terminates the process. */
  stop(message: StopMessage): LeaseResult<StopReply> {
    const refuse = (reason: string): LeaseResult<StopReply> => ({
      ok: true,
      reply: { accepted: false, jobId: message.jobId, leaseId: message.leaseId, reason, ...this.current },
    });
    const stale = this.fence(message);
    if (stale) return refuse(stale);
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no job ${message.jobId} on this controller`);
    if (!job.host || job.leaseId !== message.leaseId) {
      return refuse(`lease ${message.leaseId} does not hold job ${message.jobId}`);
    }
    if (TERMINAL.includes(job.status)) {
      return refuse(`job ${message.jobId} is already ${job.status}`);
    }
    let stops = this.pendingStops.get(job.host);
    if (!stops) {
      stops = new Set<string>();
      this.pendingStops.set(job.host, stops);
    }
    stops.add(message.leaseId);
    job.stopReason = message.reason;
    return { ok: true, reply: { accepted: true, jobId: message.jobId, leaseId: message.leaseId, ...this.current } };
  }

  /** Clean controller handoff (transition 4): requires zero active jobs on
   *  this controller, then increments the epoch and hands the controller role
   *  to `toControllerId`. */
  release(message: ReleaseMessage): LeaseResult<ControllerReleaseReply> {
    const refuse = (reason: string): LeaseResult<ControllerReleaseReply> => ({
      ok: true,
      reply: { accepted: false, reason, ...this.current },
    });
    const stale = this.fence(message);
    if (stale) return refuse(stale);
    let activeCount = 0;
    for (const job of this.jobs.values()) {
      if (!TERMINAL.includes(job.status)) {
        activeCount += 1;
        break;
      }
    }
    if (activeCount > 0) {
      return refuse("Settle all active jobs with terminal reports before releasing the controller");
    }
    const previousEpoch = this.current.epoch;
    if (!Number.isSafeInteger(previousEpoch + 1)) return refuse("Controller epoch is exhausted");
    const failed = this.commitController({ controllerId: message.toControllerId, epoch: previousEpoch + 1 });
    if (failed) return refuse(failed);
    this.reconcileState = false;
    return {
      ok: true,
      reply: {
        accepted: true,
        releasedFromEpoch: previousEpoch,
        ...this.current,
      },
    };
  }

  /** Forced takeover (transition 5): adopts a strictly higher epoch from the
   *  taking-over controller, records reconcile mode, and marks in-flight
   *  leased jobs as `ranAfterTakeover` so they are surfaced and never
   *  re-dispatched automatically. */
  takeover(message: TakeoverMessage): LeaseResult<TakeoverReply> {
    const refuse = (reason: string): LeaseResult<TakeoverReply> => ({
      ok: true,
      reply: { accepted: false, reconcile: false, orphanedJobIds: [], reason, ...this.current },
    });
    const failure = this.verifyController();
    if (failure) return refuse(failure);
    if (message.version !== PLACEMENT_WIRE_VERSION) {
      return refuse(`placement version ${message.version} is not spoken here (this host speaks ${PLACEMENT_WIRE_VERSION})`);
    }
    if (!Number.isSafeInteger(message.epoch) || message.epoch <= this.current.epoch || message.epoch - this.current.epoch > MAX_TAKEOVER_EPOCH_JUMP) {
      return refuse(`takeover epoch ${message.epoch} must exceed current epoch ${this.current.epoch} on ${this.current.controllerId} within bounds`);
    }
    const failed = this.commitController({ controllerId: message.controllerId, epoch: message.epoch });
    if (failed) return refuse(failed);
    this.reconcileState = message.reconcile;
    const orphanedJobIds = this.markOrphanedJobs();
    return {
      ok: true,
      reply: {
        accepted: true,
        reconcile: message.reconcile,
        orphanedJobIds,
        ...this.current,
      },
    };
  }

  /** Record a worker's final word on a job.  Idempotent on job id: the
   *  first report settles the job, a replay of it is acknowledged and
   *  applies nothing twice. */
  report(message: ReportMessage): LeaseResult<ReportReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    const refuse = (reason: string): LeaseResult<ReportReply> => ({ ok: true, reply: { accepted: false, reason, ...this.current } });
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no job ${message.jobId} on this controller`);
    // The report settles only from the holding host with the holding lease:
    // a leaked lease id in another host's hands settles nothing.
    if (job.leaseId !== message.leaseId || job.host !== message.hostId) {
      return refuse(`lease ${message.leaseId} does not hold job ${message.jobId}`);
    }
    if (TERMINAL.includes(job.status)) {
      const replayed =
        job.report?.status === message.status &&
        job.report.exitCode === message.exitCode &&
        job.report.signal === message.signal &&
        job.report.endedAt === message.endedAt;
      return replayed
        ? { ok: true, reply: { accepted: true, ...this.current } }
        : refuse(`job ${message.jobId} already reported as ${job.status}`);
    }
    job.status = message.status;
    job.report = { status: message.status, exitCode: message.exitCode, signal: message.signal, endedAt: message.endedAt };
    this.clearPendingStop(job.host, job.leaseId);
    return { ok: true, reply: { accepted: true, ...this.current } };
  }

  /** Give back a lease that was claimed but never started.  A running job
   *  cannot be released this way: it ends by report, so nothing is ever
   *  re-dispatched out from under a live process. */
  releaseLease(message: LeaseReleaseMessage): LeaseResult<LeaseReleaseReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, jobId: message.jobId, reason: stale, ...this.current } };
    const refuse = (reason: string): LeaseResult<LeaseReleaseReply> => ({ ok: true, reply: { accepted: false, jobId: message.jobId, reason, ...this.current } });
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no job ${message.jobId} on this controller`);
    if (job.leaseId !== message.leaseId || job.host !== message.hostId) return refuse(`lease ${message.leaseId} does not hold job ${message.jobId}`);
    if (job.status !== "dispatching") return refuse(`job ${message.jobId} is ${job.status}; only an unstarted lease can be released`);
    this.clearPendingStop(job.host, job.leaseId);
    job.status = "queued";
    job.host = undefined;
    job.leaseId = undefined;
    job.placedReason = undefined;
    job.stopReason = undefined;
    job.queuedReason = "waiting for an eligible host";
    return { ok: true, reply: { accepted: true, jobId: job.jobId, ...this.current } };
  }

  /** Mark quiet workers' leased jobs unreachable.  Returns the jobs whose
   *  state changed; nothing is requeued, so nothing runs twice. */
  sweepUnreachable(at = this.now()): string[] {
    const changed: string[] = [];
    for (const job of this.jobs.values()) {
      if (!job.host || (job.status !== "dispatching" && job.status !== "running")) continue;
      const worker = this.workers.get(job.host);
      if (!worker || at - worker.lastSeen > this.unreachableAfterMs) {
        job.status = "worker-unreachable";
        changed.push(job.jobId);
      }
    }
    return changed;
  }
}

// ── routes ────────────────────────────────────────────────────────────────

export type PlacementLeaseAction =
  | "register"
  | "heartbeat"
  | "claim"
  | "dispatch"
  | "stop"
  | "release"
  | "release-controller"
  | "takeover"
  | "enqueue"
  | "report";
export const PLACEMENT_LEASE_ACTIONS: readonly PlacementLeaseAction[] = [
  "register",
  "heartbeat",
  "claim",
  "dispatch",
  "stop",
  "release",
  "release-controller",
  "takeover",
  "enqueue",
  "report",
];

interface PlacementCaller { localOwner: boolean; fromCompanion: boolean; viaNamedTunnel: boolean }
export type PlacementLeaseResponse =
  | {
      status: 200;
      body:
        | RegisterReply
        | HeartbeatReply
        | ClaimReply
        | DispatchReply
        | StopReply
        | LeaseReleaseReply
        | ControllerReleaseReply
        | TakeoverReply
        | EnqueueReply
        | ReportReply;
    }
  | { status: 400 | 403; body: { error: string } }
  | { status: 409; body: { error: string } & ControllerEpoch };

const hostId = z.string().max(64).regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: the regex above matched the HOST_ID_PATTERN shape (a fixed
  // `mac:`/`server:` prefix plus a UUID, 43 characters at most; the `.max`
  // is belt-and-braces per the API-schema rules), which is exactly the
  // HostId type TypeScript cannot narrow to.
  return value as HostId;
});
const fenced = {
  controllerId: hostId,
  epoch: z.number().int().nonnegative().safe(),
  version: z.string().min(1),
};
/** The full `CapacitySample` wire shape, strictly parsed: at this owned
 *  boundary unknown keys fail closed so contract drift is visible, and the
 *  service never silently accepts a sample it does not understand. */
const sample = z.object({
  at: z.number(),
  cores: z.number().nullable(),
  loadPerCore: z.number().nullable(),
  ramTotalBytes: z.number().nullable(),
  ramAvailableBytes: z.number().nullable(),
  memoryPressure: z.enum(["normal", "warning", "critical"]).nullable(),
  memoryAvailablePercent: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
  inodesTotal: z.number().nullable(),
  inodesFree: z.number().nullable(),
  dataVolume: z.object({ device: z.string(), mountPoint: z.string() }).strict().nullable(),
  rootDiskFreeBytes: z.number().nullable(),
  storage: z.object({
    online: z.boolean(),
    dataDevice: z.string().nullable(),
    rootDevice: z.string().nullable(),
    reason: z.string().optional(),
  }).strict().nullable().optional(),
}).strict();
const capabilities = z.array(z.enum(["shell", "macos", "desktop"]));
const leaseSchema = z.object({
  controllerId: hostId,
  epoch: z.number().int().nonnegative().safe(),
  leaseId: z.string().min(1),
  jobId: z.string().min(1),
  host: hostId,
}).strict();
const schemas = {
  register: z.object({ ...fenced, hostId, role: z.enum(["controller", "worker"]), capabilities, sample }).strict(),
  heartbeat: z.object({
    ...fenced, hostId, leases: z.array(z.string().min(1)),
    admission: z.object({ admit: z.boolean(), reason: z.string().optional() }).strict(), sample,
  }).strict(),
  claim: z.object({ ...fenced, hostId, jobId: z.string().min(1) }).strict(),
  dispatch: z.object({
    ...fenced, lease: leaseSchema,
    command: z.string().min(1).max(16_000), cwd: z.string().min(1), timeoutMs: z.number().positive(),
  }).strict(),
  stop: z.object({
    ...fenced, jobId: z.string().min(1), leaseId: z.string().min(1), reason: z.string().min(1),
  }).strict(),
  release: z.object({ ...fenced, hostId, jobId: z.string().min(1), leaseId: z.string().min(1) }).strict(),
  "release-controller": z.object({ ...fenced, toControllerId: hostId }).strict(),
  takeover: z.object({ ...fenced, reconcile: z.boolean() }).strict(),
  enqueue: z.object({
    ...fenced, jobId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
    command: z.string().min(1).max(16_000), cwd: z.string().min(1), timeoutMs: z.number().positive(),
  }).strict(),
  report: z.object({
    ...fenced, jobId: z.string().min(1), leaseId: z.string().min(1), hostId,
    status: z.enum(["completed", "failed", "killed", "lost"]),
    exitCode: z.number().int().nullable(), signal: z.string().nullable(),
    endedAt: z.number(), reason: z.string().optional(),
  }).strict(),
};

/** One placement lease route under `/api/placement/`, behind exactly the
 *  owner boundary `/api/placement/identity` and `/api/host/resources` keep:
 *  the local owner or the authenticated server gate, never the companion
 *  lane or the named tunnel.  A worker-scoped credential class is the
 *  plan's open question 3; until Jay answers it no new credential type is
 *  invented here. */
export function placementLeaseRoute(
  caller: PlacementCaller,
  action: PlacementLeaseAction,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validation boundary: the wire body is untrusted and safeParse-checked per action before any field is read
  body: unknown,
  service: PlacementLeaseService,
): PlacementLeaseResponse {
  if (!caller.localOwner || caller.fromCompanion || caller.viaNamedTunnel) {
    return { status: 403, body: { error: "Placement routes are available only through the local owner or authenticated server gate" } };
  }
  const parsed = schemas[action].safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: `invalid ${action} message` } };
  const message = parsed.data;
  // SAFETY: each branch below runs only for the action whose schema just
  // validated `parsed.data`, so each assertion restores its schema's output
  // type; no field is read before its schema's safeParse succeeds.
  const result =
    action === "register" ? service.register(message as RegisterMessage) :
    action === "heartbeat" ? service.heartbeat(message as HeartbeatMessage) :
    action === "claim" ? service.claim(message as ClaimMessage) :
    action === "dispatch" ? service.dispatch(message as DispatchMessage) :
    action === "stop" ? service.stop(message as StopMessage) :
    action === "release" ? service.releaseLease(message as LeaseReleaseMessage) :
    action === "release-controller" ? service.release(message as ReleaseMessage) :
    action === "takeover" ? service.takeover(message as TakeoverMessage) :
    action === "enqueue" ? service.enqueue(message as EnqueueMessage) :
    service.report(message as ReportMessage);
  if (!result.ok) return { status: 409, body: { error: result.reason, ...result.controller } };
  return { status: 200, body: { ...result.reply } };
}
