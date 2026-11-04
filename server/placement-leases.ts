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
 *  An activated SQLite authority commits epochs, reconciliation, queue, lease
 *  history, stops and final reports before acknowledgement.
 *  Worker readiness remains volatile and requires a fresh admission heartbeat.
 *  Ordinary bootstrap retains the legacy JSON epoch contract until activation. */
import { randomUUID } from "node:crypto";
import type { ControllerEpochStore } from "./placement-identity.ts";
import { commandDigest, issuedLease, placementFingerprint, PLACEMENT_ACTIVE_LIMIT, PLACEMENT_QUEUE_EXPIRED_REASON, PlacementStoreError, type PlacementScope, type PlacementState, type PlacementStore, type StoredPlacementJob, type StoredPlacementLease } from "./placement-store.ts";
import { PLACEMENT_QUEUE_WINDOW_MS, type PlacementPayloads } from "./placement-payloads.ts";
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
  report?: { status: ReportMessage["status"]; exitCode: number | null; signal: string | null; endedAt: number; reason?: string };
  payloadDigest?: string;
  fingerprint?: string;
  queuedAt?: number;
  hidden?: boolean;
  queueExpiry?: { deadlineAt: number; expiredAt: number };
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
  /** Epoch-aware compatibility backend until a verified SQLite activation. */
  controllerStore?: ControllerEpochStore;
  store?: PlacementStore;
  payloads?: PlacementPayloads;
  /** Reads the existing resolved queueWaitMinutes setting, without a new knob. */
  queueWindowMs?: () => number;
  /** Explicit legacy seam; production requires the transactional authority. */
  volatileForTests?: true;
  now?: () => number;
  /** A worker unseen for this long is unreachable.  Injectable: the plan
   *  leaves the value to the heartbeat knobs, which are not set yet. */
  unreachableAfterMs?: number;
  newLeaseId?: () => string;
}

export type LeaseResult<T> = { ok: true; reply: T } | { ok: false; reason: string; controller: ControllerEpoch };

export interface WorkerAssignmentMessage extends PlacementMessage { hostId: HostId }
export interface WorkerLeaseMessage extends WorkerAssignmentMessage { jobId: string; leaseId: string }
export type WorkerPayloadReply = ({ accepted: true; command: string; cwd: string; timeoutMs: number } | { accepted: false; reason: string }) & ControllerEpoch;
export type WorkerStopReceiptReply = ({ accepted: true } | { accepted: false; reason: string }) & ControllerEpoch;

const TERMINAL: readonly PlacementJobStatus[] = ["completed", "failed", "killed", "lost"];
function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

export const MAX_TAKEOVER_EPOCH_JUMP = 100_000;

export class PlacementLeaseService {
  private current: ControllerEpoch;
  private readonly controllerStore?: ControllerEpochStore;
  private readonly store?: PlacementStore;
  private readonly payloads?: PlacementPayloads;
  private readonly queueWindowMs: () => number;
  private inTransaction = false;
  private readonly leases = new Map<string, StoredPlacementLease>();
  private readonly removedPayloads = new Set<string>();
  private reconcileState = false;
  private readonly workers = new Map<HostId, WorkerBook>();
  private readonly jobs = new Map<string, PlacementJob>();
  private readonly pendingStops = new Map<HostId, Set<string>>();
  private readonly now: () => number;
  private readonly unreachableAfterMs: number;
  private readonly newLeaseId: () => string;

  constructor(deps: PlacementLeaseDeps) {
    if (!deps.store && !deps.controllerStore && !deps.volatileForTests) throw new Error("A placement authority is required");
    this.store = deps.store;
    this.payloads = deps.payloads;
    this.queueWindowMs = deps.queueWindowMs ?? (() => PLACEMENT_QUEUE_WINDOW_MS);
    this.controllerStore = deps.controllerStore;
    this.current = { ...(deps.store?.readScope().controller ?? deps.controllerStore?.read() ?? deps.controller) };
    this.now = deps.now ?? Date.now;
    this.unreachableAfterMs = deps.unreachableAfterMs ?? 30_000;
    this.newLeaseId = deps.newLeaseId ?? (() => `lease_${randomUUID()}`);
    if (this.store) {
      this.store.transactionScope({ active: true }, (state) => this.reconcilePayloads(state));
      this.installState(this.store.readScope({ active: true }));
      this.cleanupPayloads();
    }
  }

  private storedJob(job: PlacementJob): StoredPlacementJob {
    if (job.payloadDigest === undefined || job.fingerprint === undefined || job.queuedAt === undefined) throw new PlacementStoreError();
    const { command, ...metadata } = job;
    void command;
    return { ...metadata, payloadDigest: job.payloadDigest, fingerprint: job.fingerprint, queuedAt: job.queuedAt };
  }

  private installState(state: PlacementState): void {
    if (state.controller.epoch < this.current.epoch || (state.controller.epoch === this.current.epoch && state.controller.controllerId !== this.current.controllerId)) throw new PlacementStoreError();
    if (state.controller.epoch !== this.current.epoch) this.workers.clear();
    this.current = { ...state.controller };
    this.reconcileState = state.reconcile;
    this.jobs.clear();
    for (const stored of state.jobs) this.jobs.set(stored.jobId, { ...stored, command: "" });
    this.leases.clear();
    for (const lease of state.leases) this.leases.set(lease.leaseId, { ...lease });
    this.pendingStops.clear();
    for (const stop of state.pendingStops) {
      let pending = this.pendingStops.get(stop.hostId);
      if (!pending) { pending = new Set(); this.pendingStops.set(stop.hostId, pending); }
      pending.add(stop.leaseId);
    }
  }

  private cleanupPayloads(): void {
    if (!this.store || !this.payloads) return;
    for (const job of this.jobs.values()) {
      if (TERMINAL.includes(job.status)) {
        if (job.fingerprint !== undefined && this.removedPayloads.has(job.fingerprint)) continue;
        try {
          const stored = this.storedJob(job);
          this.payloads.remove(stored);
          if (this.removedPayloads.size >= PLACEMENT_ACTIVE_LIMIT) {
            const oldest = this.removedPayloads.values().next().value;
            if (oldest !== undefined) this.removedPayloads.delete(oldest);
          }
          this.removedPayloads.add(stored.fingerprint);
        }
        catch { /* Metadata stays authoritative; failed cleanup never permits another execution. */ }
      }
    }
  }

  private reconcilePayloads(state: PlacementState): void {
    this.payloads?.reconcile(state.jobs.filter((job) => !TERMINAL.includes(job.status)));
  }

  private loadJobCommand(job: PlacementJob): void {
    if (this.store) job.command = TERMINAL.includes(job.status) ? "" : this.payloads?.read(this.storedJob(job)) ?? "";
  }

  private mutate<T>(operation: () => T, scope: PlacementScope = {}, reconcileForAdmission = false): T {
    if (!this.store) return operation();
    const before = {
      current: { ...this.current }, reconcile: this.reconcileState,
      jobs: structuredClone(this.jobs), leases: structuredClone(this.leases),
      workers: structuredClone(this.workers), pendingStops: structuredClone(this.pendingStops),
    };
    let result: T;
    try {
      result = this.store.transactionScope({ ...scope, active: true }, (state) => {
        this.installState(state);
        this.inTransaction = true;
        // Orphans are reclaimed only before new payload publication, using
        // fresh committed references while this writer still owns the lock.
        if (reconcileForAdmission) this.reconcilePayloads(state);
        const reply = operation();
        state.controller = { ...this.current };
        state.reconcile = this.reconcileState;
        state.jobs = [...this.jobs.values()].map((job) => this.storedJob(job));
        state.leases = [...this.leases.values()];
        state.pendingStops = [...this.pendingStops].flatMap(([hostId, ids]) => [...ids].map((leaseId) => ({ hostId, leaseId })));
        return reply;
      });
    } catch {
      this.current = before.current;
      this.reconcileState = before.reconcile;
      restoreMap(this.jobs, before.jobs);
      restoreMap(this.leases, before.leases);
      restoreMap(this.workers, before.workers);
      restoreMap(this.pendingStops, before.pendingStops);
      throw new PlacementStoreError();
    } finally { this.inTransaction = false; }
    // A post-commit cleanup failure must not roll memory back or report a failed write.
    try { this.cleanupPayloads(); }
    catch { /* The next mutation retries cleanup against committed metadata. */ }
    return result;
  }

  controller(): ControllerEpoch {
    this.refreshController();
    return { ...this.current };
  }

  private refreshController(scope: PlacementScope = {}): void {
    if (this.store) {
      if (!this.inTransaction) this.installState(this.store.readScope(scope));
      return;
    }
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

  private commitController(next: ControllerEpoch): string | null {
    if (this.store) { this.current = { ...next }; this.workers.clear(); return null; }
    let result: ReturnType<ControllerEpochStore["compareAndSet"]> | undefined;
    try {
      result = this.controllerStore?.compareAndSet(this.current, next);
    } catch {
      return "Controller epoch could not be persisted; transition refused";
    }
    if (result && !result.accepted) return this.verifyController() ?? "Controller epoch changed; retry with the current fence";
    this.current = { ...next };
    return null;
  }

  private verifyController(): string | null {
    try {
      this.refreshController();
      return null;
    } catch {
      return "Controller epoch could not be verified; placement refused";
    }
  }

  reconciling(): boolean {
    if (this.store) this.refreshController();
    return this.reconcileState;
  }

  job(jobId: string): PlacementJob | null {
    if (this.store) this.refreshController({ jobIds: [jobId] });
    const job = this.jobs.get(jobId);
    if (job) this.loadJobCommand(job);
    return job ? { ...job } : null;
  }

  jobsList(): PlacementJob[] {
    if (this.store) this.refreshController({ active: true, recent: true });
    return [...this.jobs.values()].filter((job) => !job.hidden).map((job) => {
      this.loadJobCommand(job);
      return { ...job };
    });
  }

  /** The epoch fence every state-changing message crosses first: versions
   *  before epochs, and only the current pair passes.  A lower pair is
   *  refused so the sender converges; a higher pair is refused on worker
   *  and queue messages too, never adopted outside `takeover`, so no skewed
   *  or forged worker bump can invalidate outstanding leases. */
  private fence(message: PlacementMessage, expireQueues = true): string | null {
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
    if (expireQueues) this.expireQueuedNow();
    return null;
  }

  /** Controller maintenance for the registry's existing queue wait window.
   * This internal operation is not exposed as a worker-supplied disposition. */
  expireQueued(message: PlacementMessage): string[] {
    if (!this.store) return [];
    return this.mutate(() => this.fence(message, false) ? [] : this.expireQueuedNow());
  }

  private expireQueuedNow(at = this.now()): string[] {
    if (!this.store) return [];
    const windowMs = this.queueWindowMs();
    if (!Number.isFinite(at) || !Number.isFinite(windowMs) || windowMs <= 0) throw new PlacementStoreError();
    const expired: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "queued" || job.queuedAt === undefined) continue;
      const deadlineAt = job.queuedAt + windowMs;
      if (!Number.isFinite(deadlineAt)) throw new PlacementStoreError();
      if (at < deadlineAt) continue;
      job.status = "lost";
      job.queueExpiry = { deadlineAt, expiredAt: at };
      job.report = { status: "lost", exitCode: null, signal: null, endedAt: at, reason: PLACEMENT_QUEUE_EXPIRED_REASON };
      job.queuedReason = undefined;
      job.command = "";
      expired.push(job.jobId);
    }
    return expired;
  }

  private refused<T>(reason: string): LeaseResult<T> {
    // Last verified context is never authorization to mutate after a failed read.
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
    return this.mutate(() => this.registerNow(message));
  }

  private registerNow(message: RegisterMessage): LeaseResult<RegisterReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    this.workers.set(message.hostId, {
      hostId: message.hostId,
      role: message.role,
      capabilities: message.capabilities,
      lastSeen: this.now(),
      admission: this.store ? { admit: false, reason: "Waiting for a fresh worker heartbeat" } : { admit: true },
    });
    return { ok: true, reply: { accepted: true, ...this.current } };
  }

  heartbeat(message: HeartbeatMessage): LeaseResult<HeartbeatReply> {
    return this.mutate(() => this.heartbeatNow(message));
  }

  private heartbeatNow(message: HeartbeatMessage): LeaseResult<HeartbeatReply> {
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
    if (stopsForHost && !this.store) {
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
    // Commit expiry and finish its cleanup before publishing into a full spool;
    // the fresh admission transaction must independently validate its fence.
    if (this.store) this.expireQueued(message);
    return this.mutate(() => this.enqueueNow(message), { jobIds: [message.jobId] }, true);
  }

  private enqueueNow(message: EnqueueMessage): LeaseResult<EnqueueReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, jobId: message.jobId, status: "refused", reason: stale, ...this.current } };
    const existing = this.jobs.get(message.jobId);
    if (existing) {
      const samePayload =
        existing.botId === message.botId &&
        existing.threadId === message.threadId &&
        (existing.payloadDigest === undefined ? existing.command === message.command : existing.payloadDigest === commandDigest(message.command)) &&
        existing.cwd === message.cwd &&
        existing.timeoutMs === message.timeoutMs;
      if (!samePayload) {
        return this.refused(`job ${message.jobId} is already queued with a different payload; use a new job id for new work`);
      }
      return { ok: true, reply: { accepted: true, duplicate: true, jobId: existing.jobId, status: existing.status, ...this.current } };
    }
    if (this.store && [...this.jobs.values()].filter((job) => !TERMINAL.includes(job.status)).length >= PLACEMENT_ACTIVE_LIMIT) {
      return this.refused("The existing unresolved placement record limit is reached; settle work before admitting more");
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
    if (this.store) {
      job.payloadDigest = commandDigest(message.command);
      job.fingerprint = placementFingerprint({ ...job, payloadDigest: job.payloadDigest });
      job.queuedAt = this.now();
      if (!this.payloads) return this.refused("Private placement payload storage is unavailable");
      this.payloads.put(this.storedJob(job), message.command);
    }
    this.jobs.set(job.jobId, job);
    return { ok: true, reply: { accepted: true, jobId: job.jobId, status: job.status, ...this.current } };
  }

  /** The compare-and-set lease: only a `queued` job, only at the current
   *  epoch, only for a reachable worker that can run it and last said it
   *  would admit work.  A second claim for the same job is refused. */
  claim(message: ClaimMessage): LeaseResult<ClaimReply> {
    return this.mutate(() => this.claimNow(message), { jobIds: [message.jobId] });
  }

  private claimNow(message: ClaimMessage): LeaseResult<ClaimReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    const refuse = (reason: string): LeaseResult<ClaimReply> => ({ ok: true, reply: { accepted: false, reason, ...this.current } });
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no queued job ${message.jobId} on this controller`);
    if (!this.store && job.status !== "queued") return refuse(`job ${message.jobId} is ${job.status}, not queued; it is never re-dispatched`);
    const worker = this.workers.get(message.hostId);
    if (!worker) return refuse(`${message.hostId} is not registered with this controller`);
    if (this.now() - worker.lastSeen > this.unreachableAfterMs) return refuse(`${message.hostId} has not heartbeated within the window`);
    if (!worker.admission.admit) return refuse(worker.admission.reason ?? `${message.hostId} is not admitting work`);
    const existing = job.leaseId ? this.leases.get(job.leaseId) : undefined;
    if (this.store && job.status === "dispatching" && existing?.state === "active" && existing.host === message.hostId
      && existing.epoch === this.current.epoch && existing.controllerId === this.current.controllerId) {
      return { ok: true, reply: { accepted: true, lease: issuedLease(existing), ...this.current } };
    }
    if (job.status !== "queued") return refuse(`job ${message.jobId} is ${job.status}, not queued; it is never re-dispatched`);
    this.loadJobCommand(job);
    if (this.store && (!job.command || (job.queuedAt !== undefined && this.now() - job.queuedAt >= this.queueWindowMs()))) {
      return refuse("Private placement payload is missing, damaged or expired; the job is held without execution");
    }
    if (!hostCanRunCommand(worker.capabilities, job.command, { cwd: job.cwd })) {
      return refuse(`${message.hostId} cannot run this job (${job.requiredReason ?? "capability missing"})`);
    }
    const lease: Lease = { leaseId: this.newLeaseId(), jobId: job.jobId, host: message.hostId, ...this.current };
    if (this.leases.has(lease.leaseId)) return refuse("lease_conflict");
    this.leases.set(lease.leaseId, { ...lease, state: "active" });
    job.status = "dispatching";
    job.host = message.hostId;
    job.leaseId = lease.leaseId;
    job.queuedReason = undefined;
    job.placedReason = job.requiredReason ?? "claimed by an eligible host";
    return { ok: true, reply: { accepted: true, lease, ...this.current } };
  }

  /** Pull-side assignment: the worker asks for work and the controller picks.
   *  A job this host already holds an unstarted lease on comes first, so a
   *  lost acknowledgement replays the same lease rather than issuing another,
   *  and that job stays offered until a heartbeat reports the lease as held.
   *  Otherwise the oldest queued job this host can run is claimed, through the
   *  same compare-and-set as `claim`. */
  assign(message: WorkerAssignmentMessage): LeaseResult<ClaimReply> {
    return this.mutate(() => this.assignNow(message));
  }

  private assignNow(message: WorkerAssignmentMessage): LeaseResult<ClaimReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
    const queuedOrder = (job: PlacementJob) => job.queuedAt ?? 0;
    const held = [...this.jobs.values()].filter((job) => job.status === "dispatching" && job.host === message.hostId);
    const queued = [...this.jobs.values()].filter((job) => job.status === "queued")
      .sort((a, b) => queuedOrder(a) - queuedOrder(b) || a.jobId.localeCompare(b.jobId));
    let reason = "no job is eligible for this host";
    for (const job of [...held, ...queued]) {
      const result = this.claimNow({ ...message, jobId: job.jobId });
      if (!result.ok || result.reply.accepted) return result;
      reason = result.reply.reason;
    }
    return { ok: true, reply: { accepted: false, reason, ...this.current } };
  }

  /** The job this host holds an active lease on, or the reason it does not. */
  private leasedJob(message: WorkerLeaseMessage): { job: PlacementJob } | { refusal: string } {
    const stale = this.fence(message);
    if (stale) return { refusal: stale };
    const job = this.jobs.get(message.jobId);
    if (!job || job.leaseId !== message.leaseId || job.host !== message.hostId) {
      return { refusal: `lease ${message.leaseId} does not hold job ${message.jobId}` };
    }
    const lease = this.leases.get(message.leaseId);
    if (this.store && lease?.state !== "active") return { refusal: `lease ${message.leaseId} is not active` };
    if (job.status !== "dispatching" && job.status !== "running") return { refusal: `job ${message.jobId} is ${job.status}` };
    return { job };
  }

  /** The command for a lease this host holds.  Reading it never consumes the
   *  claim, so a worker that lost this answer can ask again. */
  leasePayload(message: WorkerLeaseMessage): LeaseResult<WorkerPayloadReply> {
    return this.mutate(() => {
      const found = this.leasedJob(message);
      if ("refusal" in found) return { ok: true, reply: { accepted: false, reason: found.refusal, ...this.current } };
      this.loadJobCommand(found.job);
      if (!found.job.command) {
        return { ok: true, reply: { accepted: false, reason: "Private placement payload is missing or damaged; the job is held without execution", ...this.current } };
      }
      return { ok: true, reply: { accepted: true, command: found.job.command, cwd: found.job.cwd, timeoutMs: found.job.timeoutMs, ...this.current } };
    }, { jobIds: [message.jobId], leaseIds: [message.leaseId] });
  }

  /** Confirms a stop reached the host holding the lease.  It stores nothing:
   *  the stop stays pending until `report` settles the lease. */
  stopReceipt(message: WorkerLeaseMessage): LeaseResult<WorkerStopReceiptReply> {
    return this.mutate(() => {
      const found = this.leasedJob(message);
      if ("refusal" in found) return { ok: true, reply: { accepted: false, reason: found.refusal, ...this.current } };
      return { ok: true, reply: { accepted: true, ...this.current } };
    }, { jobIds: [message.jobId], leaseIds: [message.leaseId] });
  }

  /** Push-side lease assignment: fenced on both the message and the embedded
   *  lease epoch, idempotent on an exact replay of the active lease, and
   *  refused when the job already holds a different lease or is no longer
   *  queued. */
  dispatch(message: DispatchMessage): LeaseResult<DispatchReply> {
    return this.mutate(() => this.dispatchNow(message), { jobIds: [message.lease.jobId], leaseIds: [message.lease.leaseId] });
  }

  private dispatchNow(message: DispatchMessage): LeaseResult<DispatchReply> {
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
    const history = this.leases.get(lease.leaseId);
    if (history && (history.state !== "active" || history.jobId !== lease.jobId || history.host !== lease.host
      || history.controllerId !== lease.controllerId || history.epoch !== lease.epoch)) return refuse("lease_conflict");
    this.loadJobCommand(job);
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
    if (this.store && (job.queuedAt !== undefined && this.now() - job.queuedAt >= this.queueWindowMs())) return refuse("The queued placement payload expired; the job is held without execution");
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
    this.leases.set(lease.leaseId, { ...lease, state: "active" });
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
    return this.mutate(() => this.stopNow(message), { jobIds: [message.jobId], leaseIds: [message.leaseId] });
  }

  private stopNow(message: StopMessage): LeaseResult<StopReply> {
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
    return this.mutate(() => this.releaseNow(message));
  }

  private releaseNow(message: ReleaseMessage): LeaseResult<ControllerReleaseReply> {
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
    return this.mutate(() => this.takeoverNow(message));
  }

  private takeoverNow(message: TakeoverMessage): LeaseResult<TakeoverReply> {
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
    return this.mutate(() => this.reportNow(message), { jobIds: [message.jobId], leaseIds: [message.leaseId] });
  }

  private reportNow(message: ReportMessage): LeaseResult<ReportReply> {
    const stale = this.fence(message);
    const issued = this.leases.get(message.leaseId);
    const issuingFence = this.store && message.version === PLACEMENT_WIRE_VERSION && issued?.controllerId === message.controllerId && issued.epoch === message.epoch;
    if (stale && !issuingFence) return { ok: true, reply: { accepted: false, reason: stale, ...this.current } };
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
        job.report.endedAt === message.endedAt && job.report.reason === message.reason;
      return replayed
        ? { ok: true, reply: { accepted: true, ...this.current } }
        : refuse(`job ${message.jobId} already reported as ${job.status}`);
    }
    job.status = message.status;
    job.report = { status: message.status, exitCode: message.exitCode, signal: message.signal, endedAt: message.endedAt, reason: message.reason };
    if (issued) issued.state = "settled";
    this.clearPendingStop(job.host, job.leaseId);
    return { ok: true, reply: { accepted: true, ...this.current } };
  }

  /** Give back a lease that was claimed but never started.  A running job
   *  cannot be released this way: it ends by report, so nothing is ever
   *  re-dispatched out from under a live process. */
  releaseLease(message: LeaseReleaseMessage): LeaseResult<LeaseReleaseReply> {
    return this.mutate(() => this.releaseLeaseNow(message), { jobIds: [message.jobId], leaseIds: [message.leaseId] });
  }

  private releaseLeaseNow(message: LeaseReleaseMessage): LeaseResult<LeaseReleaseReply> {
    const stale = this.fence(message);
    if (stale) return { ok: true, reply: { accepted: false, jobId: message.jobId, reason: stale, ...this.current } };
    const refuse = (reason: string): LeaseResult<LeaseReleaseReply> => ({ ok: true, reply: { accepted: false, jobId: message.jobId, reason, ...this.current } });
    if (this.store) return refuse("Durable verified worker revocation is required before releasing a lease");
    const job = this.jobs.get(message.jobId);
    if (!job) return refuse(`no job ${message.jobId} on this controller`);
    if (job.leaseId !== message.leaseId || job.host !== message.hostId) return refuse(`lease ${message.leaseId} does not hold job ${message.jobId}`);
    if (job.status !== "dispatching") return refuse(`job ${message.jobId} is ${job.status}; only an unstarted lease can be released`);
    const history = this.leases.get(message.leaseId);
    if (history) { history.state = "released"; history.revocationId = "volatile-test-fixture"; }
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
    return this.mutate(() => this.sweepUnreachableNow(at));
  }

  private sweepUnreachableNow(at: number): string[] {
    // Queue expiry requires a captured expected fence; this sweep has none.
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
  | { status: 400 | 403 | 503; body: { error: string } }
  | { status: 409; body: { error: string } & ControllerEpoch };

const hostId = z.string().max(64).regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: the regex above matched the HOST_ID_PATTERN shape (a fixed
  // `mac:`/`server:` prefix plus a UUID, 43 characters at most; the `.max`
  // is belt-and-braces per the API-schema rules), which is exactly the
  // HostId type TypeScript cannot narrow to.
  return value as HostId;
});
export const placementFence = {
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
const fenced = placementFence;
const capabilities = z.array(z.enum(["shell", "macos", "desktop"]));
const leaseSchema = z.object({
  controllerId: hostId,
  epoch: z.number().int().nonnegative().safe(),
  leaseId: z.string().min(1),
  jobId: z.string().min(1),
  host: hostId,
}).strict();
export const placementMessageSchemas = {
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
 *  lane or the named tunnel.  Workers use their own credential class and
 *  routes:  see `server/placement-worker-routes.ts`. */
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
  const parsed = placementMessageSchemas[action].safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: `invalid ${action} message` } };
  const message = parsed.data;
  // SAFETY: each branch below runs only for the action whose schema just
  // validated `parsed.data`, so each assertion restores its schema's output
  // type; no field is read before its schema's safeParse succeeds.
  try {
    // SAFETY: the selected action's schema validated this message above.
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
  } catch (error) {
    if (error instanceof PlacementStoreError) return { status: 503, body: { error: error.message } };
    throw error;
  }
}
