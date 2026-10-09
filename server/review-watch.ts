// Auto-review for an engine that never asks before it acts.
//
// WHY THIS FILE EXISTS.  Auto-review normally runs at the permission card: an
// engine asks, the reviewer answers before anything happens.  Some engines
// cannot ask.  Antigravity's print mode has no permission hook, Box Agent runs
// on the box and reports afterwards, pi runs its own bash and edits without a
// card, and a full-auto instance was told never to ask.  Every one of them
// still reports each step as an `item.started` while it runs, so that is
// where this watches.
//
// What it can honestly promise is narrower than a card, and the Bot Profile
// says exactly this:
//
//   - Watch records what the reviewer would have said about each step.
//   - On stops the turn when the reviewer refuses a step.  It cannot undo the
//     step that was refused — that step had already started — but nothing
//     after it runs.
//
// It never approves anything, so it is safe on an unattended turn too.
//
// Steps are reviewed one at a time per thread, in the order they started, so
// a chatty engine costs one reviewer call at a time rather than a burst, and
// a refusal stops the turn before the reviewer is asked about anything that
// came after it.

import type { ToolKind } from "../shared/tool-activity.ts";
import type { AutoReviewMode } from "../shared/auto-review.ts";
import {
  reviewWithReviewers as defaultReview,
  type Reviewer,
  type ReviewOutcome,
  type ReviewRequest,
} from "./auto-review.ts";
import type { DecisionRow } from "./decision-log.ts";

/** The kinds of step worth a reviewer call: anything that changes something
 *  or reaches outside the bot (a command, an edit, a fetch, a connected-app
 *  call).  Reads, searches, planning and helper rows are not reviewed: they
 *  would multiply reviewer calls without giving On anything to stop.  A step
 *  whose kind the engine did not report is reviewed — unknown is not safe. */
export const WATCHED_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["execute", "edit", "fetch", "other"]);

/** How many steps may wait for review on one thread.  Past this the step is
 *  logged as skipped rather than queued without bound. */
export const MAX_PENDING_STEPS = 20;

/** How many stopped turns are remembered, so their late steps are ignored. */
const STOPPED_TURN_MEMORY = 500;

export function watchesKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || WATCHED_KINDS.has(kind);
}

export interface WatchedStep {
  threadId: string;
  turnId?: string;
  /** The step's tool name, as the transcript shows it. */
  tool: string;
  /** What it acted on: a command, a path, a URL. */
  target?: string;
  toolKind?: ToolKind;
}

/** Who is acting and who reviews, decided by the caller per step. */
export interface WatchPlan {
  botId: string;
  botName: string;
  persona: string;
  mode: AutoReviewMode;
  reviewers: Reviewer[];
  unattended?: boolean;
}

export interface ReviewWatchDeps {
  /** Whether the turn this step belongs to is still running. */
  turnRunning(threadId: string, turnId: string | undefined): boolean;
  /** Stop the running turn on this thread, latched like the person's Stop. */
  stopTurn(threadId: string, botId: string): void;
  /** An activity chip on the thread. */
  note(threadId: string, text: string, ok: boolean): void;
  /** One decision-log row. */
  log(row: Omit<DecisionRow, "at">): void;
  /** Injectable for tests. */
  review?: (reviewers: readonly Reviewer[], request: ReviewRequest) => Promise<ReviewOutcome | null>;
}

interface Pending {
  step: WatchedStep;
  plan: WatchPlan;
}

export class ReviewWatch {
  private readonly queues = new Map<string, Pending[]>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly stoppedTurns = new Set<string>();

  constructor(private readonly deps: ReviewWatchDeps) {}

  /** Called for every `item.started` tool step, with the caller's plan for
   *  it: null when it is not watched (review off, no reviewer, or an engine
   *  whose asks already reach the card). */
  observe(step: WatchedStep, plan: WatchPlan | null): void {
    if (!plan || plan.mode === "off" || plan.reviewers.length === 0) return;
    if (!watchesKind(step.toolKind)) return;
    if (this.isStopped(step)) return;
    const queue = this.queues.get(step.threadId) ?? [];
    if (queue.length >= MAX_PENDING_STEPS) {
      this.deps.log({
        ...this.rowBase(step, plan),
        decision: "review-skipped",
        source: "auto-review-watch",
        rule: `more than ${MAX_PENDING_STEPS} steps were waiting for review`,
      });
      return;
    }
    queue.push({ step, plan });
    this.queues.set(step.threadId, queue);
    if (!this.draining.has(step.threadId)) {
      const run = this.drain(step.threadId).finally(() => this.draining.delete(step.threadId));
      this.draining.set(step.threadId, run);
    }
  }

  /** Resolves once every step queued on the thread (or on every thread) has
   *  been reviewed.  For tests and for an orderly shutdown. */
  async settled(threadId?: string): Promise<void> {
    for (;;) {
      const runs = threadId
        ? [this.draining.get(threadId)].filter((run): run is Promise<void> => run !== undefined)
        : [...this.draining.values()];
      if (runs.length === 0) return;
      await Promise.all(runs);
    }
  }

  private key(threadId: string, turnId: string | undefined): string {
    return `${threadId}:${turnId ?? ""}`;
  }

  private isStopped(step: WatchedStep): boolean {
    return this.stoppedTurns.has(this.key(step.threadId, step.turnId));
  }

  private markStopped(step: WatchedStep): void {
    this.stoppedTurns.add(this.key(step.threadId, step.turnId));
    if (this.stoppedTurns.size > STOPPED_TURN_MEMORY) {
      const oldest = this.stoppedTurns.values().next().value;
      if (oldest !== undefined) this.stoppedTurns.delete(oldest);
    }
  }

  private rowBase(step: WatchedStep, plan: WatchPlan): Omit<DecisionRow, "at" | "decision" | "source"> {
    return {
      threadId: step.threadId,
      botId: plan.botId,
      botName: plan.botName,
      tool: step.tool,
      summary: step.target ?? step.tool,
      ...(plan.unattended ? { unattended: true } : {}),
    };
  }

  private async drain(threadId: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(threadId);
      const next = queue?.shift();
      if (!next) {
        this.queues.delete(threadId);
        return;
      }
      if (this.isStopped(next.step)) continue;
      try {
        await this.reviewStep(next);
      } catch (error) {
        // An audit that throws must never take the harness down with it.
        console.error("review-watch: a step review failed", error);
      }
    }
  }

  private async reviewStep({ step, plan }: Pending): Promise<void> {
    const review = this.deps.review ?? defaultReview;
    const outcome = await review(plan.reviewers, {
      tool: step.tool,
      summary: step.target ?? step.tool,
      persona: plan.persona,
      timing: "after",
    });
    const base = this.rowBase(step, plan);
    if (!outcome) {
      // Honest about it: nothing was checked, so nothing was stopped.
      this.deps.log({ ...base, decision: "review-skipped", source: "auto-review-watch", rule: "no reviewer answered" });
      return;
    }
    const { verdict, reviewer } = outcome;
    if (plan.mode !== "enforce" || verdict.allow) {
      this.deps.log({
        ...base,
        decision: verdict.allow ? "review-would-approve" : "review-would-deny",
        source: "auto-review-watch",
        rule: verdict.reason,
        reviewer: reviewer.instanceId,
      });
      return;
    }
    if (this.isStopped(step)) return;
    if (!this.deps.turnRunning(step.threadId, step.turnId)) {
      // The turn ended while the reviewer thought.  Nothing is left to stop,
      // so the refusal is shown and recorded rather than claimed as a stop.
      this.deps.note(step.threadId, `review flagged ${step.tool} after the turn ended (${reviewer.name}): ${verdict.reason}`, false);
      this.deps.log({
        ...base,
        decision: "review-would-deny",
        source: "auto-review-watch",
        rule: verdict.reason,
        reviewer: reviewer.instanceId,
      });
      return;
    }
    this.markStopped(step);
    // Drop whatever else this turn queued: the turn is being stopped, and a
    // second refusal of the same turn would only repeat the chip.
    const queue = this.queues.get(step.threadId);
    if (queue) {
      this.queues.set(
        step.threadId,
        queue.filter((pending) => pending.step.turnId !== step.turnId),
      );
    }
    this.deps.stopTurn(step.threadId, plan.botId);
    this.deps.note(step.threadId, `review stopped the turn after ${step.tool} (${reviewer.name}): ${verdict.reason}`, false);
    this.deps.log({
      ...base,
      decision: "review-stopped-turn",
      source: "auto-review",
      rule: verdict.reason,
      reviewer: reviewer.instanceId,
    });
  }
}
