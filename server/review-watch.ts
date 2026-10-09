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
// A full-auto instance whose turn is held in its asking mode for review
// (`SendTurnInput.holdForReview`) is watched too.  Holding sends most of its
// actions to a card first, but not all of them: Claude still edits files
// under acceptEdits and calls the MCP servers it pre-allows, and Codex still
// runs sandboxed commands, without asking.  A step that did reach a card is
// recognised by its item id (`markAsked`) and left to the card, so the watch
// never stops a turn over an action a person may already have allowed.
//
// What it can honestly promise is narrower than a card, and the Bot Profile
// says exactly this:
//
//   - Watch records what the reviewer would have said about each step.
//   - On stops the turn when the reviewer refuses a step.  The stop is not
//     instant.  The step had already started, steps are reviewed one at a
//     time, and each review can take up to 8 seconds per reviewer, so the
//     engine can run more steps before the stop lands.  None of them is
//     undone.
//   - On fails closed: a step it could not check (no reviewer answered, the
//     answer broke the contract, too many steps were waiting, or the turn's
//     review limit was reached) stops the turn the same way a refusal does.
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
  noVerdictRule,
  ReviewBudget,
  runReview as defaultReview,
  type Reviewer,
  type ReviewRequest,
  type ReviewResult,
  type ReviewSpend,
} from "./auto-review.ts";
import type { DecisionRow } from "./decision-log.ts";

/** The kinds of step worth a reviewer call: anything that changes something
 *  or reaches outside the bot (a command, an edit, a fetch, a connected-app
 *  call).  Reads, searches, planning and helper rows are not reviewed: they
 *  would multiply reviewer calls without giving On anything to stop.  A step
 *  whose kind the engine did not report is reviewed — unknown is not safe. */
export const WATCHED_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["execute", "edit", "fetch", "other"]);

/** How many steps may wait for review on one thread.  Past this Watch logs
 *  the step as skipped and On stops the turn. */
export const MAX_PENDING_STEPS = 20;

/** How many stopped turns, and asked steps, are remembered. */
const STOPPED_TURN_MEMORY = 500;
const ASKED_STEP_MEMORY = 2_000;

export function watchesKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || WATCHED_KINDS.has(kind);
}

export interface WatchedStep {
  threadId: string;
  turnId?: string;
  /** The engine's id for the step, which an ask for the same step carries
   *  too (`request.opened.itemId`). */
  itemId?: string;
  /** The provider instance running the step: the stop goes to it alone. */
  instanceId?: string;
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

/** Exactly which turn to stop: one bot's turn on one engine, never the
 *  thread, so a refusal in a room stops only the member that took the step. */
export interface StopTarget {
  threadId: string;
  botId: string;
  instanceId?: string;
  turnId?: string;
}

export interface ReviewWatchDeps {
  /** Whether the turn this step belongs to is still running. */
  turnRunning(threadId: string, turnId: string | undefined): boolean;
  /** Stop that turn, latched like the person's Stop. */
  stopTurn(target: StopTarget): void;
  /** An activity chip on the thread. */
  note(threadId: string, text: string, ok: boolean): void;
  /** One decision-log row. */
  log(row: Omit<DecisionRow, "at">): void;
  /** The per-turn review budget every review path shares. */
  budget?: ReviewBudget;
  /** Injectable for tests. */
  review?: (
    reviewers: readonly Reviewer[],
    request: ReviewRequest,
    options: { budget?: ReviewSpend },
  ) => Promise<ReviewResult>;
}

interface Pending {
  step: WatchedStep;
  plan: WatchPlan;
}

/** Why On stopped a turn without a refusal: the rule for the log and the
 *  words for the chip. */
interface FailClosed {
  rule: string;
  chip: string;
}

export class ReviewWatch {
  private readonly queues = new Map<string, Pending[]>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly stoppedTurns = new Set<string>();
  private readonly asked = new Set<string>();
  // A plain field, not a parameter property: the server runs under Node's
  // strip-only TypeScript, which refuses parameter properties.
  private readonly deps: ReviewWatchDeps;

  constructor(deps: ReviewWatchDeps) {
    this.deps = deps;
  }

  /** Called for every `item.started` tool step, with the caller's plan for
   *  it: null when it is not watched (review off, or an engine whose actions
   *  all reach the card first). */
  observe(step: WatchedStep, plan: WatchPlan | null): void {
    if (!plan || plan.mode === "off") return;
    if (!watchesKind(step.toolKind)) return;
    if (this.isStopped(step) || this.wasAsked(step)) return;
    if (plan.reviewers.length === 0) {
      // Watch has nothing to record.  On has nobody to check this step, and
      // letting it through would make On quieter than Off.
      if (plan.mode === "enforce") {
        this.stop(step, plan, {
          rule: "no reviewer is available",
          chip: `review stopped the turn at ${step.tool}: no reviewer is available`,
        });
      }
      return;
    }
    const budgetKey = ReviewBudget.key(step.threadId, step.turnId);
    if (this.deps.budget?.exhausted(budgetKey)) {
      this.capped(step, plan, this.deps.budget.limit());
      return;
    }
    const queue = this.queues.get(step.threadId) ?? [];
    if (queue.length >= MAX_PENDING_STEPS) {
      this.failClosed(step, plan, {
        rule: `more than ${MAX_PENDING_STEPS} steps were waiting for review`,
        chip: `review stopped the turn at ${step.tool}: too many steps were waiting for review`,
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

  /** An ask for this step reached the permission card (`request.opened`
   *  carrying the step's item id).  The card reviews it before it runs, and
   *  a person may answer it, so the watch drops the step, or, when its
   *  review is already under way, records the answer instead of acting on
   *  it. */
  markAsked(threadId: string, itemId: string): void {
    this.asked.add(`${threadId}:${itemId}`);
    if (this.asked.size > ASKED_STEP_MEMORY) {
      const oldest = this.asked.values().next().value;
      if (oldest !== undefined) this.asked.delete(oldest);
    }
    const queue = this.queues.get(threadId);
    if (queue) {
      this.queues.set(
        threadId,
        queue.filter((pending) => pending.step.itemId !== itemId),
      );
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

  private wasAsked(step: WatchedStep): boolean {
    return step.itemId !== undefined && this.asked.has(`${step.threadId}:${step.itemId}`);
  }

  private markStopped(step: WatchedStep): void {
    this.stoppedTurns.add(this.key(step.threadId, step.turnId));
    if (this.stoppedTurns.size > STOPPED_TURN_MEMORY) {
      const oldest = this.stoppedTurns.values().next().value;
      if (oldest !== undefined) this.stoppedTurns.delete(oldest);
    }
  }

  /** Drop whatever else this turn queued. */
  private dropTurn(step: WatchedStep): void {
    const queue = this.queues.get(step.threadId);
    if (queue) {
      this.queues.set(
        step.threadId,
        queue.filter((pending) => pending.step.turnId !== step.turnId),
      );
    }
  }

  private rowBase(step: WatchedStep, plan: WatchPlan): Omit<DecisionRow, "at" | "decision" | "source"> {
    return {
      threadId: step.threadId,
      botId: plan.botId,
      botName: plan.botName,
      tool: step.tool,
      summary: step.target ?? step.tool,
      unattended: plan.unattended || undefined,
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
      if (this.isStopped(next.step) || this.wasAsked(next.step)) continue;
      try {
        await this.reviewStep(next);
      } catch (error) {
        // An audit that throws must never take the harness down with it, and
        // under On a step nobody finished checking is not let through.
        console.error("review-watch: a step review failed", error);
        try {
          this.failClosed(next.step, next.plan, {
            rule: "the review failed",
            chip: `review stopped the turn at ${next.step.tool}: the review failed`,
          });
        } catch (stopError) {
          console.error("review-watch: could not stop the turn", stopError);
        }
      }
    }
  }

  /** A step nobody could check.  Watch records it as skipped; On stops. */
  private failClosed(step: WatchedStep, plan: WatchPlan, why: FailClosed): void {
    if (plan.mode !== "enforce") {
      this.deps.log({ ...this.rowBase(step, plan), decision: "review-skipped", source: "auto-review-watch", rule: why.rule });
      return;
    }
    this.stop(step, plan, why);
  }

  /** The turn's review limit is spent.  On stops the turn; Watch says once
   *  that it stopped recording, and records nothing more for the turn. */
  private capped(step: WatchedStep, plan: WatchPlan, limit: number): void {
    const rule = noVerdictRule({ kind: "capped", limit });
    if (plan.mode === "enforce") {
      this.stop(step, plan, {
        rule,
        chip: `review stopped the turn at ${step.tool}: it reached its limit of ${limit} reviews for this turn`,
      });
      return;
    }
    this.dropTurn(step);
    if (this.deps.budget && !this.deps.budget.firstNotice(ReviewBudget.key(step.threadId, step.turnId))) return;
    this.deps.note(step.threadId, `review paused for the rest of this turn: it reached its limit of ${limit} reviews`, true);
    this.deps.log({ ...this.rowBase(step, plan), decision: "review-skipped", source: "auto-review-watch", rule });
  }

  /** Stop the step's turn, or, when it already ended, say there was nothing
   *  left to stop. */
  private stop(step: WatchedStep, plan: WatchPlan, why: FailClosed, reviewer?: Reviewer): void {
    if (this.isStopped(step)) return;
    const base = this.rowBase(step, plan);
    if (!this.deps.turnRunning(step.threadId, step.turnId)) {
      this.deps.log({ ...base, decision: "review-skipped", source: "auto-review-watch", rule: why.rule });
      return;
    }
    this.markStopped(step);
    // the turn is being stopped, and a second stop of the same turn would
    // only repeat the chip
    this.dropTurn(step);
    this.deps.stopTurn({ threadId: step.threadId, botId: plan.botId, instanceId: step.instanceId, turnId: step.turnId });
    this.deps.note(step.threadId, why.chip, false);
    this.deps.log({
      ...base,
      decision: "review-stopped-turn",
      source: "auto-review",
      rule: why.rule,
      reviewer: reviewer?.instanceId,
    });
  }

  private async reviewStep({ step, plan }: Pending): Promise<void> {
    const review = this.deps.review ?? ((reviewers, request, options) => defaultReview(reviewers, request, options));
    const budget = this.deps.budget?.forTurn(ReviewBudget.key(step.threadId, step.turnId));
    const result = await review(
      plan.reviewers,
      {
        tool: step.tool,
        summary: step.target ?? step.tool,
        persona: plan.persona,
        timing: "after",
      },
      { budget },
    );
    const base = this.rowBase(step, plan);
    if (this.wasAsked(step)) {
      // The ask reached the card while this review ran.  The card decides;
      // this answer is only a record.
      if (result.kind === "verdict") {
        this.deps.log({
          ...base,
          decision: result.verdict.allow ? "review-would-approve" : "review-would-deny",
          source: "auto-review-watch",
          rule: result.verdict.reason,
          reviewer: result.reviewer.instanceId,
        });
      }
      return;
    }
    if (result.kind === "capped") {
      this.capped(step, plan, result.limit);
      return;
    }
    if (result.kind === "no-answer") {
      this.failClosed(step, plan, {
        rule: noVerdictRule(result),
        chip: `review stopped the turn at ${step.tool}: no reviewer could check it`,
      });
      return;
    }
    const { verdict, reviewer } = result;
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
    this.stop(
      step,
      plan,
      {
        rule: verdict.reason,
        chip: `review stopped the turn after ${step.tool} (${reviewer.name}): ${verdict.reason}`,
      },
      reviewer,
    );
  }
}

/** Every turn running on each thread, by turn id.  A room can run two
 * members at once on one thread, so one slot per thread would let the second
 * member's start hide the first: a refusal of the first member's step would
 * then read as "the turn already ended" and stop nothing. */
export class RunningTurns {
  private readonly byThread = new Map<string, Set<string>>();

  started(threadId: string, turnId: string): void {
    const turns = this.byThread.get(threadId) ?? new Set<string>();
    turns.add(turnId);
    this.byThread.set(threadId, turns);
  }

  /** A turn settled.  Without a turn id nothing says which one, so the
   *  thread is cleared, as it was before rooms ran members side by side. */
  completed(threadId: string, turnId: string | undefined): void {
    const turns = this.byThread.get(threadId);
    if (!turns) return;
    if (turnId) turns.delete(turnId);
    else turns.clear();
    if (turns.size === 0) this.byThread.delete(threadId);
  }

  running(threadId: string, turnId: string | undefined): boolean {
    const turns = this.byThread.get(threadId);
    if (!turns) return false;
    return turnId ? turns.has(turnId) : turns.size > 0;
  }

  /** The one running turn on a thread, or undefined when there is none or
   *  more than one. */
  only(threadId: string): string | undefined {
    const turns = this.byThread.get(threadId);
    return turns?.size === 1 ? turns.values().next().value : undefined;
  }
}
