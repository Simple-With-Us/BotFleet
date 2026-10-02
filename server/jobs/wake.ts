// Waking a bot when its background job ends (jobs P1,
// docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).
//
// A finished job's notice waits in the steer queue's job-notice channel
// (server/steer-queue.ts).  Three things can deliver it, and whichever comes
// first wins, because each one takes the notices out of the queue:
//
//   1. The bot is mid-turn on that thread: the HTTP tool loop drains it
//      between model rounds.
//   2. Any turn starts on that thread (the owner typed, a routine fired): its
//      opening reminder carries it.
//   3. Nothing else happened: this file starts a wake turn.
//
// The wake rules:
//
//   - Completions within 5 s of the first are merged into one wake.
//   - One turn per bot: a busy bot is woken when it settles, after the
//     owner's own queued messages have had their turn.
//   - Each thread gets 3 wakes in a row.  Any message the owner types into
//     it refills them.  Past that, notices wait for the owner.
//   - Rooms get notices only; a room turn is the room's to start.
//   - The spend ceiling and the `jobs.wake: false` kill switch stop wakes
//     without dropping notices.
//   - A wake that cannot dispatch (busy, reloading, quiescing) puts its
//     notices back and waits for the next settle — and, because a bot can
//     go idle without a turn settling (a provider reload ending, a stalled
//     turn released, a failed room dispatch), it is also retried on a timer
//     until it starts or something else delivers its notices.

import type { JobSnapshot } from "../../shared/jobs.ts";
import type { JobNoticeItem } from "../steer-queue.ts";

export interface JobWakeDeps {
  /** `jobs.wake` is not switched off. */
  wakeEnabled(): boolean;
  isRoom(threadId: string): boolean;
  /** The bot is running a turn anywhere (one turn per bot). */
  botBusy(botId: string): boolean;
  /** The spend ceiling refuses unattended work now. */
  spendBlocked(): boolean;
  /** The steer queue's job-notice channel. */
  drainNotices(threadId: string): JobNoticeItem[];
  restoreNotices(threadId: string, items: readonly JobNoticeItem[]): void;
  pendingNotices(threadId: string): readonly JobNoticeItem[];
  /** Start the wake turn: `startTurn` with `automationSource: "job"`.
   *  Rejects when the dispatch could not start. */
  startWake(botId: string, threadId: string, prompt: string, jobIds: string[]): Promise<void>;
  mergeWindowMs?: number;
  /** How long a wake that could not start waits before it tries again. */
  retryMs?: number;
  maxConsecutive?: number;
  /** Schedules the merge window's end; tests capture it rather than wait. */
  setTimer?: (fn: () => void, ms: number) => WakeTimer;
  log?: (line: string) => void;
}

/** A scheduled merge-window end that can be called off. */
export interface WakeTimer {
  cancel(): void;
}

/** The prompt a wake turn runs with: the notices, then what to do with them. */
export function wakePrompt(items: readonly JobNoticeItem[]): string {
  return [
    ...items.map((item) => item.text),
    "",
    "Your background job ended while you were idle.  Read its output with job_output if you need it, finish the work it was for, and tell the owner only what they need to act on.",
  ].join("\n");
}

export class JobWakeCoordinator {
  private readonly deps: JobWakeDeps;
  private readonly mergeWindowMs: number;
  private readonly retryMs: number;
  private readonly maxConsecutive: number;
  private readonly setTimer: (fn: () => void, ms: number) => WakeTimer;
  /** threadId → wakes used since the owner last typed there. */
  private readonly used = new Map<string, number>();
  /** threadId → the merge timer for a pending wake. */
  private readonly scheduled = new Map<string, { botId: string; timer: WakeTimer }>();
  /** threadId → botId: a wake that is due, held until the bot settles. */
  private readonly waiting = new Map<string, string>();
  /** threadId → the retry timer of a waiting wake. */
  private readonly retries = new Map<string, WakeTimer>();

  constructor(deps: JobWakeDeps) {
    this.deps = deps;
    this.mergeWindowMs = deps.mergeWindowMs ?? 5_000;
    this.retryMs = deps.retryMs ?? 30_000;
    this.maxConsecutive = deps.maxConsecutive ?? 3;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
  }

  /** A job ended.  Only a `wake` job on a 1:1 thread schedules anything; the
   *  notice itself is already queued. */
  noteFinished(job: JobSnapshot): void {
    if (job.onComplete !== "wake") return;
    if (this.deps.isRoom(job.threadId)) return;
    if (this.scheduled.has(job.threadId)) return; // merged into the wake already due
    const timer = this.setTimer(() => {
      this.scheduled.delete(job.threadId);
      void this.fire(job.threadId, job.botId);
    }, this.mergeWindowMs);
    this.scheduled.set(job.threadId, { botId: job.botId, timer });
  }

  /** The owner typed into this thread: its wakes are refilled. */
  ownerMessage(threadId: string): void {
    this.used.delete(threadId);
  }

  /** A bot's turn settled: deliver any wake that waited for it. */
  botSettled(botId: string): void {
    // A copy, not the live map: a wake that finds the bot busy again puts
    // its thread straight back, and a live iteration would visit it again.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [threadId, waitingBot] of [...this.waiting]) {
      if (waitingBot !== botId) continue;
      this.unpark(threadId);
      void this.fire(threadId, botId);
    }
  }

  /** Hold a due wake until the bot settles, and try again on a timer too. */
  private park(threadId: string, botId: string): void {
    this.waiting.set(threadId, botId);
    if (this.retries.has(threadId)) return;
    const timer = this.setTimer(() => {
      this.retries.delete(threadId);
      const waitingBot = this.waiting.get(threadId);
      if (waitingBot === undefined) return;
      this.waiting.delete(threadId);
      void this.fire(threadId, waitingBot);
    }, this.retryMs);
    this.retries.set(threadId, timer);
  }

  private unpark(threadId: string): void {
    this.waiting.delete(threadId);
    this.retries.get(threadId)?.cancel();
    this.retries.delete(threadId);
  }

  /** Forget a deleted thread. */
  forgetThread(threadId: string): void {
    this.scheduled.get(threadId)?.timer.cancel();
    this.scheduled.delete(threadId);
    this.unpark(threadId);
    this.used.delete(threadId);
  }

  /** Wakes left on this thread before the owner has to type.  Test seam. */
  wakesLeft(threadId: string): number {
    return this.maxConsecutive - (this.used.get(threadId) ?? 0);
  }

  private async fire(threadId: string, botId: string): Promise<void> {
    // Something else delivered them (a round drain, an owner's turn).
    if (!this.deps.pendingNotices(threadId).some((item) => item.wake)) return;
    if (!this.deps.wakeEnabled()) return;
    if ((this.used.get(threadId) ?? 0) >= this.maxConsecutive) {
      this.deps.log?.(`[jobs] not waking for ${threadId.slice(0, 8)}: ${this.maxConsecutive} wakes in a row; the notice waits for the owner`);
      return;
    }
    if (this.deps.spendBlocked()) {
      this.deps.log?.(`[jobs] not waking for ${threadId.slice(0, 8)}: the spend ceiling holds; the notice waits for the next turn`);
      return;
    }
    if (this.deps.botBusy(botId)) {
      this.park(threadId, botId);
      return;
    }
    const items = this.deps.drainNotices(threadId);
    if (items.length === 0) return;
    this.used.set(threadId, (this.used.get(threadId) ?? 0) + 1);
    try {
      await this.deps.startWake(botId, threadId, wakePrompt(items), items.map((item) => item.jobId));
    } catch (error) {
      // Not delivered: the notices go back, the wake is not spent, and the
      // next settle tries again.
      this.used.set(threadId, Math.max(0, (this.used.get(threadId) ?? 1) - 1));
      this.deps.restoreNotices(threadId, items);
      this.park(threadId, botId);
      this.deps.log?.(`[jobs] wake for ${threadId.slice(0, 8)} did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
