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
// never stops a turn over an action a person may already have allowed.  An
// engine reports a step as it starts and asks about it a moment later, so a
// held turn's steps wait a short grace (`HELD_ASK_GRACE_MS`) for that ask
// before they are reviewed: a step that asks is judged once, at the card,
// instead of twice.
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
// It never approves anything, so it is safe on an unattended turn too.  That
// is also why it needs no `local-computer` exclusion, which the card paths do
// (server/auto-review.ts `shouldReview`, `reviewsGrant`): there the reviewer
// would ANSWER an ask for control of the owner's own machine, and it never
// may.  Here `ReviewWatchDeps` has no way to answer anything.  A step on the
// host computer is reviewed like any other, and the reviewer can only record
// its opinion or, under On, stop the turn.
//
// Steps are reviewed one at a time per TURN, in the order they started, so a
// chatty engine costs one reviewer call at a time rather than a burst, and a
// refusal stops the turn before the reviewer is asked about anything that came
// after it.  The queue belongs to the turn, not the thread: in a room two
// members run side by side, and one member's backlog must neither delay the
// other's reviews nor push the other's next step into the queue limit.
//
// A turn can end with steps still queued: an engine that reports its work
// afterwards (Box Agent) announces a burst of steps and completes at once.
// Those steps are still reviewed, late.  Nothing is left to stop by then, so
// a refusal is shown and recorded as a flag, a step nobody could check is
// recorded as skipped, and neither ever stops a turn (see `turnEnded`).
// Dropping them unreviewed would let a fast engine finish before its first
// step was looked at, and turn On into Off for that engine.

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
import { HARNESS_TOOLS } from "./tools/registry.ts";

/** The kinds of step worth a reviewer call: anything that changes something
 *  or reaches outside the bot (a command, an edit, a fetch, a connected-app
 *  call).  Reads, searches, planning and helper rows are not reviewed: they
 *  would multiply reviewer calls without giving On anything to stop.  A step
 *  whose kind the engine did not report is reviewed — unknown is not safe. */
export const WATCHED_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["execute", "edit", "fetch", "other"]);

/** How many steps may wait for review on one turn.  Past this Watch logs the
 *  step as skipped and On stops the turn. */
export const MAX_PENDING_STEPS = 20;

/** How long a step on a held turn waits before it is reviewed, in case its
 *  ask is about to reach the card.  An engine reports a step as it starts and
 *  asks about it a moment later, so reviewing at once would judge every step
 *  that asks twice (once here, once at the card) and spend the turn's review
 *  limit at double the rate.  A step that never asks is reviewed after this
 *  delay, which only makes the stop a little later. */
export const HELD_ASK_GRACE_MS = 750;

/** How many stopped turns, and turns with asked steps, are remembered. */
const STOPPED_TURN_MEMORY = 500;
const ASKED_TURN_MEMORY = 500;
const ASKED_STEPS_PER_TURN = 2_000;

export function watchesKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || WATCHED_KINDS.has(kind);
}

/** The harness's own tools that change something or reach someone, by the
 *  names the registry gives them: a message to a peer (`ask_bot`,
 *  `delegate_bot`), a new bot, a credential request, a routine, a Zulip post
 *  or reply, a job start or kill.  They are what a bot calls on the `agents`
 *  MCP server.  Their reads (`list_bots`, `job_output`) are not here, for the
 *  same reason no other read is reviewed.  Derived from the registry, so a new
 *  tool that writes is watched without anyone remembering to add it. */
const WATCHED_HARNESS_TOOLS: readonly string[] = HARNESS_TOOLS.filter(
  (tool) => tool.surfaces.mcp && tool.sideEffect === "write",
).map((tool) => tool.name);

/** Whether a step is one of the harness's own writing tools, however the
 *  engine spells it.  The name is classed as a delegation (`task`) on every
 *  engine that prefixes the server, because the server is called `agents` and
 *  `classifyTool` reads "agent" anywhere in a name, so the kind cannot be
 *  trusted to select these.
 *
 *  The name is cut at `__` and at anything that is not a letter, digit or
 *  underscore, and a piece counts when it IS a tool name or ends in `_` and
 *  one.  That covers `mcp__agents__job_start` (Claude), a bare `job_start`
 *  (Codex reports an MCP tool by its tool name alone), `agents.job_start`,
 *  `agents/job_start`, `mcp:agents/job_start`, `mcp_agents_job_start`,
 *  `agents_job_start`, and an ACP title that wraps the name in words
 *  (`Tool: agents/job_start`, `job_start (agents MCP Server)`).  An ACP agent
 *  chooses its own `tool_call` title and this repository holds no captured
 *  frame of an MCP call, so those last two are the spellings engines are
 *  known to use rather than ones read out of a fixture.  A name that merely
 *  begins with a tool name (`ask_bot_later`) is not one.  Matching more only
 *  costs a reviewer call; matching less leaves a tool nobody reviews. */
export function isWatchedHarnessTool(tool: string): boolean {
  const pieces = tool.toLowerCase().split(/__|[^a-z0-9_]+/);
  return pieces.some((piece) => WATCHED_HARNESS_TOOLS.some((name) => piece === name || piece.endsWith(`_${name}`)));
}

/** Whether a step is worth a reviewer call: its kind, or one of the
 *  harness's own writing tools. */
export function watchesStep(step: Pick<WatchedStep, "tool" | "toolKind">): boolean {
  return watchesKind(step.toolKind) || isWatchedHarnessTool(step.tool);
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
  /** Set on a turn held in its asking mode for review: how long a step waits
   *  for its ask to reach the card before the watch reviews it (see
   *  `HELD_ASK_GRACE_MS`).  Absent on an engine that never asks. */
  askGraceMs?: number;
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
  /** Injectable for tests: wait this long, and read the clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  /** Not reviewed before this time (ms on the watch's clock): a held turn's
   *  step gives its ask a moment to arrive. */
  readyAt: number;
  /** Set when the step's turn ended while it waited: what was left of the
   *  turn's review limit at that moment.  The turn's budget is released when
   *  the turn settles, so a late review is charged to this instead and can
   *  neither overspend the limit nor leave a stale entry behind. */
  lateBudget?: ReviewSpend;
}

/** `left` reviewer calls, spent one at a time.  `limit` stays the turn's
 *  configured limit, not `left`: a capped late review reports it as "review
 *  limit of N reached for this turn", and N is that limit. */
function snapshotSpend(left: number, limit: number): ReviewSpend {
  let remaining = left;
  return { limit, spend: () => (remaining > 0 ? (remaining--, true) : false) };
}

/** Why On stopped a turn without a refusal: the rule for the log and the
 *  words for the chip. */
interface FailClosed {
  rule: string;
  chip: string;
}

export class ReviewWatch {
  // One queue, and one drain, per turn (thread + turn id).
  private readonly queues = new Map<string, Pending[]>();
  private readonly draining = new Map<string, { threadId: string; run: Promise<void> }>();
  private readonly stoppedTurns = new Set<string>();
  // The steps whose turn ended while they waited.  By identity, not by turn
  // key: an engine that reports no turn id shares one key across turns, and a
  // late step must never be taken for part of the turn running now.
  private readonly endedSteps = new WeakSet<WatchedStep>();
  // The step each turn's drain has taken off the queue and not finished with,
  // whether it is waiting out its grace or being reviewed: `turnEnded` cannot
  // find it in the queue, and it is just as much a step of the turn that ended.
  private readonly handling = new Map<string, Pending>();
  // The steps whose ask reached the card, by turn.  An id is only meaningful
  // inside its turn: an engine may number its steps again in the next one.
  private readonly asked = new Map<string, Set<string>>();
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
    if (!watchesStep(step)) return;
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
    const turnKey = this.key(step.threadId, step.turnId);
    const queue = this.queues.get(turnKey) ?? [];
    if (queue.length >= MAX_PENDING_STEPS) {
      this.failClosed(step, plan, {
        rule: `more than ${MAX_PENDING_STEPS} steps were waiting for review`,
        chip: `review stopped the turn at ${step.tool}: too many steps were waiting for review`,
      });
      return;
    }
    // Only a step that carries an id can be matched to an ask, so only one
    // that does is held back for it.
    const grace = step.itemId !== undefined ? (plan.askGraceMs ?? 0) : 0;
    queue.push({ step, plan, readyAt: this.now() + grace });
    this.queues.set(turnKey, queue);
    this.startDrain(turnKey, step.threadId);
  }

  /** An ask for this step reached the permission card (`request.opened`
   *  carrying the step's item id).  The card reviews it before it runs, and
   *  a person may answer it, so the watch drops the step, or, when its
   *  review is already under way, records the answer instead of acting on
   *  it. */
  markAsked(threadId: string, turnId: string | undefined, itemId: string): void {
    const turnKey = this.key(threadId, turnId);
    const items = this.asked.get(turnKey) ?? new Set<string>();
    // re-inserted so the turns asked about most recently are the ones kept
    this.asked.delete(turnKey);
    this.asked.set(turnKey, items);
    items.add(itemId);
    if (items.size > ASKED_STEPS_PER_TURN) {
      const oldest = items.values().next().value;
      if (oldest !== undefined) items.delete(oldest);
    }
    if (this.asked.size > ASKED_TURN_MEMORY) {
      const oldest = this.asked.keys().next().value;
      if (oldest !== undefined) this.asked.delete(oldest);
    }
    const queue = this.queues.get(turnKey);
    if (queue) {
      this.queues.set(
        turnKey,
        queue.filter((pending) => pending.step.itemId !== itemId),
      );
    }
  }

  /** A turn settled: forget what was latched or asked for it, and hand what
   *  it still had queued to a late review.  Without a turn id nothing says
   *  which one, so everything on the thread goes, as `RunningTurns.completed`
   *  does.  A stop is latched only for the life of its turn, so the next turn
   *  on the thread is watched again.
   *
   *  The queue is NOT discarded.  Steps that started before the turn ended
   *  are reviewed all the same, and since nothing is left to stop they can
   *  only be flagged or recorded: a refusal becomes a flag, and a step nobody
   *  could check is recorded as skipped.  Their grace to ask is over, so they
   *  go straight to the reviewer, and they spend what the turn had left of its
   *  review limit (`Pending.lateBudget`). */
  turnEnded(threadId: string, turnId: string | undefined): void {
    const prefix = `${threadId}:`;
    const onThread = (key: string) => (turnId === undefined ? key.startsWith(prefix) : key === this.key(threadId, turnId));
    // deleting the entry being visited is well defined for a Set or a Map
    for (const key of this.stoppedTurns) if (onThread(key)) this.stoppedTurns.delete(key);
    for (const key of this.asked.keys()) if (onThread(key)) this.asked.delete(key);
    const keys = new Set([...this.handling.keys(), ...this.queues.keys()].filter(onThread));
    for (const key of keys) {
      // the queue key and the budget key are built the same way
      const left = this.deps.budget?.remaining(key);
      const lateBudget = left === undefined ? undefined : snapshotSpend(left, this.deps.budget!.limit());
      // the step the drain is waiting on or reviewing is no longer in the
      // queue, and is as much a step of the turn that ended as the rest
      const current = this.handling.get(key);
      for (const pending of [...(current ? [current] : []), ...(this.queues.get(key) ?? [])]) {
        this.endedSteps.add(pending.step);
        pending.readyAt = 0;
        pending.lateBudget = lateBudget;
      }
    }
  }

  /** Resolves once every step queued on the thread (or on every thread) has
   *  been reviewed.  For tests and for an orderly shutdown. */
  async settled(threadId?: string): Promise<void> {
    for (;;) {
      const runs = [...this.draining.values()]
        .filter((entry) => threadId === undefined || entry.threadId === threadId)
        .map((entry) => entry.run);
      if (runs.length === 0) return;
      await Promise.all(runs);
    }
  }

  private key(threadId: string, turnId: string | undefined): string {
    return `${threadId}:${turnId ?? ""}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Whether the step's turn was stopped.  A step whose turn ended is never
   *  covered by a stop: with no turn id every turn on the thread shares one
   *  key, so the stop latched for the turn running now is not the end of a
   *  review owed for an earlier one. */
  private isStopped(step: WatchedStep): boolean {
    return !this.endedSteps.has(step) && this.stoppedTurns.has(this.key(step.threadId, step.turnId));
  }

  /** Whether this step's ask reached the card.  An ask that named no turn is
   *  filed under the thread alone, and counts for every turn on it. */
  private wasAsked(step: WatchedStep): boolean {
    if (step.itemId === undefined) return false;
    return (
      this.asked.get(this.key(step.threadId, step.turnId))?.has(step.itemId) === true ||
      this.asked.get(this.key(step.threadId, undefined))?.has(step.itemId) === true
    );
  }

  private markStopped(step: WatchedStep): void {
    this.stoppedTurns.add(this.key(step.threadId, step.turnId));
    if (this.stoppedTurns.size > STOPPED_TURN_MEMORY) {
      const oldest = this.stoppedTurns.values().next().value;
      if (oldest !== undefined) this.stoppedTurns.delete(oldest);
    }
  }

  /** Drop whatever else this turn queued.  A step left over from an earlier
   *  turn that shared this key is not this turn's to drop. */
  private dropTurn(step: WatchedStep): void {
    const key = this.key(step.threadId, step.turnId);
    const leftOver = (this.queues.get(key) ?? []).filter((pending) => this.endedSteps.has(pending.step));
    if (leftOver.length > 0) this.queues.set(key, leftOver);
    else this.queues.delete(key);
  }

  /** Whether there is nothing left to stop for this step: its turn ended
   *  while it waited, or ended while it was being reviewed.  A step that
   *  waited is judged by that alone, never by `turnRunning`: an engine with no
   *  turn id shares one key across turns, and a turn running NOW is not the
   *  one this step belonged to. */
  private turnOver(step: WatchedStep): boolean {
    return this.endedSteps.has(step) || !this.deps.turnRunning(step.threadId, step.turnId);
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

  /** Start the turn's drain unless one is running. */
  private startDrain(turnKey: string, threadId: string): void {
    if (this.draining.has(turnKey)) return;
    const run = this.drain(turnKey).finally(() => {
      this.draining.delete(turnKey);
      // a step queued in the instant between the drain finding the queue
      // empty and this cleanup would otherwise wait for the next one
      if ((this.queues.get(turnKey)?.length ?? 0) > 0) this.startDrain(turnKey, threadId);
    });
    this.draining.set(turnKey, { threadId, run });
  }

  private async drain(turnKey: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(turnKey);
      const next = queue?.shift();
      if (!next) {
        this.queues.delete(turnKey);
        return;
      }
      this.handling.set(turnKey, next);
      try {
        await this.handle(next);
      } finally {
        this.handling.delete(turnKey);
      }
    }
  }

  /** One step off the queue: wait out its grace, then review it. */
  private async handle(next: Pending): Promise<void> {
    if (this.isStopped(next.step) || this.wasAsked(next.step)) return;
    const wait = next.readyAt - this.now();
    if (wait > 0) {
      await this.sleep(wait);
      // its ask may have reached the card, or the turn been stopped, while
      // the step waited
      if (this.isStopped(next.step) || this.wasAsked(next.step)) return;
    }
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
    if (plan.mode === "enforce" && !this.endedSteps.has(step)) {
      this.stop(step, plan, {
        rule,
        chip: `review stopped the turn at ${step.tool}: it reached its limit of ${limit} reviews for this turn`,
      });
      return;
    }
    if (plan.mode === "enforce") {
      // Late step: stop() -> turnOver() produces its own note
      this.stop(step, plan, { rule, chip: "" });
      return;
    }
    if (this.endedSteps.has(step)) {
      // The turn is over, so there is nothing to pause, and the steps behind
      // this one are not ours to drop: each is a step nobody checked.
      this.deps.log({ ...this.rowBase(step, plan), decision: "review-skipped", source: "auto-review-watch", rule });
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
    if (this.turnOver(step)) {
      // Not a stop, so no claim of one; but On promised to check this step
      // and could not, and a log row alone is easy to miss.
      this.deps.note(step.threadId, `review could not check ${step.tool} before the turn ended: ${why.rule}`, false);
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

  private async reviewStep({ step, plan, lateBudget }: Pending): Promise<void> {
    const review = this.deps.review ?? ((reviewers, request, options) => defaultReview(reviewers, request, options));
    const budget = lateBudget ?? this.deps.budget?.forTurn(ReviewBudget.key(step.threadId, step.turnId));
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
    if (this.turnOver(step)) {
      // The turn ended while the step waited or the reviewer thought.  Nothing
      // is left to stop, so the refusal is shown and recorded rather than
      // claimed as a stop.
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
