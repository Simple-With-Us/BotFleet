// The bridge between the placement mode record and the job registry.
//
// The record says which mode this host runs in;  the lease service holds the
// one authoritative queue.  For one job start this module decides which of
// three things happens:
//
//   * This Mac Only:  the registry runs the job here, exactly as before.
//   * A server mode on the controller:  the job is admitted into the
//     controller's own queue, where the record is written as `queued` and
//     the controller places it.
//   * A server mode on a host that does not hold the controller:  the start
//     is refused with a reason.  Forwarding has no route yet, and a local
//     waiting list would be a second queue outside the authoritative one
//     (`docs/plans/2026-10-29-native-server-mode.md`).
//
// The bridge never writes the mode record:  only the person writes the mode,
// and the server's record is the server's copy.
//
// The unreachable sweep lives here too, because it is the one part of the
// lease service that had no production caller:  a controller has to run it to
// notice a worker that went quiet, and nothing is requeued when it does.
import { PLACEMENT_WIRE_VERSION } from "../shared/placement.ts";
import type { EnqueueMessage, EnqueueReply, HostId, PlacementMode } from "../shared/placement.ts";

/** What the registry asks the bridge about one job start. */
export interface PlacementAdmissionRequest {
  /** The job id the registry minted;  the queue is idempotent on it. */
  jobId: string;
  botId: string;
  threadId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** What the bridge answers. */
export type PlacementAdmission =
  /** This Mac Only:  the registry runs the job here, as it always has. */
  | { kind: "local" }
  /** A server mode on the controller:  the job waits in the controller's queue. */
  | { kind: "queued"; jobId: string; queuedReason: string; controllerId: HostId; epoch: number; duplicate: boolean }
  /** A server mode with no controller here:  refused, with the reason. */
  | { kind: "refused"; reason: string };

/** The mode record as the bridge reads it, in one read.
 *
 *  `controllerId` and `epoch` are the live fence, not the record's copy of
 *  it:  who holds the epoch is the truth about the controller, and a record
 *  written at an older epoch says nothing about the present one. */
export interface PlacementBridgeView {
  /** The mode the record holds.  No record is This Mac Only. */
  mode: PlacementMode;
  /** The live controller pair. */
  controllerId: HostId;
  epoch: number;
  /** True when a written record is held at the live fence. */
  acknowledged: boolean;
}

/** The queue's answer:  the record that was written, or the reason the
 *  admission was refused.  The lease service's own result satisfies this
 *  shape, so the bridge needs no adapter between them. */
export type PlacementEnqueueResult =
  | { ok: true; reply: EnqueueReply }
  | { ok: false; reason: string };

export interface PlacementBridgeDeps {
  /** This host's own id. */
  hostId: HostId;
  /** The record and the live fence, read together.  A read that fails is a
   *  refusal, never a mode:  a mode nobody can read is not a mode nobody may
   *  change. */
  view: () => PlacementBridgeView;
  /** The controller's own queue:  admit one job, idempotent on its id. */
  enqueue: (message: EnqueueMessage) => PlacementEnqueueResult;
  /** Why a queued job waits, read from the queue's own record. */
  queuedReason: (jobId: string) => string | undefined;
  /** The authority's unreachable sweep:  the jobs whose worker went quiet. */
  sweepUnreachable: () => string[];
}

/** How often the unreachable sweep runs when nothing else says. */
export const DEFAULT_UNREACHABLE_SWEEP_MS = 30_000;

/** How often a worker says it is alive, when no knob says otherwise. */
export const DEFAULT_PLACEMENT_HEARTBEAT_SECONDS = 15;

/** How long a worker may go quiet before the controller marks it
 *  unreachable, when no knob says otherwise.  It stays at the lease
 *  service's own default, so a host with no knob placed behaves exactly as
 *  it did before the knobs existed. */
export const DEFAULT_PLACEMENT_UNREACHABLE_AFTER_SECONDS = 30;

export class PlacementControllerBridge {
  private readonly deps: PlacementBridgeDeps;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: PlacementBridgeDeps) {
    this.deps = deps;
  }

  /** The mode this host runs in, as the record holds it. */
  mode(): PlacementMode {
    try {
      return this.deps.view().mode;
    } catch {
      // A record that cannot be read is not This Mac Only.  The caller gets
      // the refusal, and this stays a plain read.
      return "localOnly";
    }
  }

  /** The controller's answer for one job start. */
  admit(request: PlacementAdmissionRequest): PlacementAdmission {
    let view: PlacementBridgeView;
    try {
      view = this.deps.view();
    } catch {
      return {
        kind: "refused",
        reason: "The placement mode record could not be read, so no job is admitted.  Run the command with bash if it is short, or switch to This Mac Only in Settings.",
      };
    }
    if (view.mode === "localOnly") return { kind: "local" };
    if (view.controllerId !== this.deps.hostId) {
      return {
        kind: "refused",
        reason: `This computer runs in ${view.mode}, and the controller is ${view.controllerId} at epoch ${view.epoch}, so this computer does not admit jobs of its own.  Run the command with bash if it is short, or switch to This Mac Only in Settings.`,
      };
    }
    if (!view.acknowledged) {
      return {
        kind: "refused",
        reason: `The placement mode record is not held at the current fence (epoch ${view.epoch}), so no job is admitted.  Re-apply the mode in Settings, or switch to This Mac Only.`,
      };
    }
    const result = this.deps.enqueue({
      version: PLACEMENT_WIRE_VERSION,
      controllerId: view.controllerId,
      epoch: view.epoch,
      jobId: request.jobId,
      botId: request.botId,
      threadId: request.threadId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    });
    if (!result.ok) return { kind: "refused", reason: result.reason };
    const reply = result.reply;
    if (!reply.accepted) {
      return { kind: "refused", reason: reply.reason ?? "The controller did not admit the job." };
    }
    return {
      kind: "queued",
      jobId: reply.jobId,
      queuedReason: this.deps.queuedReason(reply.jobId) ?? "waiting for an eligible host",
      controllerId: reply.controllerId,
      epoch: reply.epoch,
      duplicate: reply.duplicate === true,
    };
  }

  /** Run one unreachable sweep and report the jobs whose state changed.
   *  Nothing is requeued, so a job marked unreachable stays with the worker
   *  that went quiet until that worker reports or a person looks. */
  sweepNow(): string[] {
    try {
      return this.deps.sweepUnreachable();
    } catch {
      // A sweep that failed changes nothing and is not retried in place;
      // the next tick runs it again.
      return [];
    }
  }

  /** Run the unreachable sweep on a timer.  A worker that stopped saying so
   *  has its leased jobs marked unreachable, and nothing is requeued, so a
   *  failed sweep must never stop the next one.
   *
   *  The period is read again on every tick, so a knob change applies
   *  without a restart.  The period only decides how soon a quiet worker is
   *  noticed;  the window that decides when it counts as quiet lives in the
   *  lease service and is read live there. */
  startUnreachableSweep(intervalMs: () => number = () => DEFAULT_UNREACHABLE_SWEEP_MS): void {
    if (this.sweepTimer) return;
    const tick = (): void => {
      this.sweepNow();
      this.sweepTimer = setTimeout(tick, Math.max(1_000, intervalMs()));
      this.sweepTimer.unref?.();
    };
    this.sweepTimer = setTimeout(tick, Math.max(1_000, intervalMs()));
    this.sweepTimer.unref?.();
  }

  stopUnreachableSweep(): void {
    if (!this.sweepTimer) return;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }
}
