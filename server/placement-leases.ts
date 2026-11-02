/** The controller's placement lease book (native server mode plan, slice 8b —
 *  the register / heartbeat / claim / release half).
 *
 *  One authoritative queue lives here on the controller: a job is enqueued
 *  once (idempotent on job id), claimed once (a compare-and-set from
 *  `queued` to leased, fenced on the controller epoch), and reported once
 *  (a replayed report gets the same acknowledgement and changes nothing).
 *  A worker that stops heartbeating takes its leased jobs to
 *  `worker-unreachable`; they are never requeued or re-dispatched from a
 *  timer, so a job can never run twice because a link went quiet.
 *
 *  What this file is not yet: dispatch, stop and takeover (the rest of 8b),
 *  and persistence.  Leases are the controller's live book; the job records
 *  a person reads stay in the job registry. */
import { randomUUID } from "node:crypto";
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
  type ReportMessage,
  type ReportReply,
} from "../shared/placement.ts";

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
  now?: () => number;
  /** A worker unseen for this long is unreachable.  Injectable: the plan
   *  leaves the value to the heartbeat knobs, which are not set yet. */
  unreachableAfterMs?: number;
  newLeaseId?: () => string;
}

export type LeaseResult<T> = { ok: true; reply: T } | { ok: false; reason: string; controller: ControllerEpoch };

const TERMINAL: readonly PlacementJobStatus[] = ["completed", "failed", "killed", "lost"];

export class PlacementLeaseService {
  private current: ControllerEpoch;
  private readonly workers = new Map<HostId, WorkerBook>();
  private readonly jobs = new Map<string, PlacementJob>();
  private readonly now: () => number;
  private readonly unreachableAfterMs: number;
  private readonly newLeaseId: () => string;

  constructor(deps: PlacementLeaseDeps) {
    this.current = { ...deps.controller };
    this.now = deps.now ?? Date.now;
    this.unreachableAfterMs = deps.unreachableAfterMs ?? 30_000;
    this.newLeaseId = deps.newLeaseId ?? (() => `lease_${randomUUID()}`);
  }

  controller(): ControllerEpoch {
    return { ...this.current };
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
   *  refused so the sender converges; a higher pair is refused too, never
   *  adopted — this slice has no takeover path (see the file header), so no
   *  worker message may legitimately carry a newer epoch, and adopting one
   *  would let any skewed or forged bump invalidate outstanding leases.
   *  The future takeover route will own adoption behind its own
   *  authorization; until then the fence fails closed. */
  private fence(message: PlacementMessage): string | null {
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
    return { ok: false, reason, controller: this.controller() };
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
    for (const job of this.jobs.values()) {
      if (job.host === message.hostId && job.leaseId && held.has(job.leaseId) &&
        (job.status === "dispatching" || job.status === "worker-unreachable")) {
        job.status = "running";
      }
    }
    return { ok: true, reply: { pendingStops: [], ...this.current } };
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
    job.status = "queued";
    job.host = undefined;
    job.leaseId = undefined;
    job.placedReason = undefined;
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

export type PlacementLeaseAction = "register" | "heartbeat" | "claim" | "release" | "enqueue" | "report";
export const PLACEMENT_LEASE_ACTIONS: readonly PlacementLeaseAction[] = ["register", "heartbeat", "claim", "release", "enqueue", "report"];

interface PlacementCaller { localOwner: boolean; fromCompanion: boolean; viaNamedTunnel: boolean }
export type PlacementLeaseResponse =
  | { status: 200; body: RegisterReply | HeartbeatReply | ClaimReply | LeaseReleaseReply | EnqueueReply | ReportReply }
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
const schemas = {
  register: z.object({ ...fenced, hostId, role: z.enum(["controller", "worker"]), capabilities, sample }).strict(),
  heartbeat: z.object({
    ...fenced, hostId, leases: z.array(z.string().min(1)),
    admission: z.object({ admit: z.boolean(), reason: z.string().optional() }).strict(), sample,
  }).strict(),
  claim: z.object({ ...fenced, hostId, jobId: z.string().min(1) }).strict(),
  release: z.object({ ...fenced, hostId, jobId: z.string().min(1), leaseId: z.string().min(1) }).strict(),
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
    action === "release" ? service.releaseLease(message as LeaseReleaseMessage) :
    action === "enqueue" ? service.enqueue(message as EnqueueMessage) :
    service.report(message as ReportMessage);
  if (!result.ok) return { status: 409, body: { error: result.reason, ...result.controller } };
  return { status: 200, body: { ...result.reply } };
}
