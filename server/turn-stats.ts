import type { TaskStats } from "./store.ts";

/** What one settled turn contributes to a task's running `TaskStats`. */
export interface TurnStatsSample {
  /** Tool steps the turn ran (one per tool `item.started`). */
  steps: number;
  /** Wall time spent neither in a tool nor waiting on a person. */
  modelMs: number;
  /** Wall time with at least one tool in flight — parallel tools overlap, so
   *  this is the union of their intervals, never their sum. */
  toolMs: number;
  /** Turn start to the first streamed token; absent when nothing streamed. */
  ttftMs?: number;
  /** The provider's output-token figure for the turn, when it reported one. */
  outputTokens?: number;
}

type Bucket = "model" | "tool" | "wait";

interface LiveTurn {
  /** The clock's cursor: time up to here is already apportioned. */
  at: number;
  /** Set once any delta or tool has been seen, so a late `turn.started`
   *  cannot move the start past real activity. */
  touched: boolean;
  /** Set once the turn provably reached a model: the provider said it began,
   *  or something streamed, or a tool ran.  A turn that settles without this
   *  (a rejected preflight, a spawn error) only ever spent setup time, and
   *  must not bank that as model time. */
  reachedModel: boolean;
  bucket: Bucket;
  ms: Record<Bucket, number>;
  steps: number;
  /** Tool items in flight, by item id.  A set, so a repeated start cannot
   *  double count and a completion for an item never started cannot end
   *  another tool's interval. */
  activeTools: Set<string>;
  openRequests: number;
  /** Model time at the model's first output of any kind — a token or a tool
   *  call.  A turn that opens with tool calls did not make the person wait
   *  for the whole run of model rounds before the model first spoke. */
  firstOutputMs?: number;
  /** Whether a text or reasoning token ever streamed.  Time to first token is
   *  only banked then: an engine that streams nothing has no such figure. */
  streamed: boolean;
}

/**
 * In-memory clock for the 1:1 turn in flight on each thread.  Time is
 * apportioned by what the turn was doing at each moment: a person's pending
 * approval outranks a running tool, which outranks the model.  Approvals are
 * therefore not billed to either, and parallel tools are not double counted.
 *
 * Only durable aggregates leave this class (see `TaskStats`).  Every entry is
 * dropped by `settle` or `discard`; `begin` replaces a stale one.
 */
export class TurnStatsTracker {
  private readonly live = new Map<string, LiveTurn>();
  private readonly now: () => number;

  // Not a parameter property: the harness runs under Node's strip-only
  // TypeScript mode, which rejects `constructor(private readonly x)` at load
  // and takes the whole server down with it.
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** When the turn in flight on `threadId` began, in epoch milliseconds, or
   *  null when none is being timed.  Read-only: it is what /status prints. */
  startedAt(threadId: string): number | null {
    return this.live.get(threadId)?.at ?? null;
  }

  /** A turn was dispatched.  Replaces any leftover entry for the thread. */
  begin(threadId: string, at = this.now()): void {
    this.live.set(threadId, {
      at,
      touched: false,
      reachedModel: false,
      bucket: "model",
      ms: { model: 0, tool: 0, wait: 0 },
      steps: 0,
      activeTools: new Set(),
      openRequests: 0,
      streamed: false,
    });
  }

  /** The provider says the turn really began.  Provider setup before this is
   *  not the model's time, so the clock restarts — but only before activity. */
  started(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    turn.reachedModel = true;
    if (!turn.touched) turn.at = at;
  }

  /** A token streamed (assistant text or reasoning).  Time to first token is
   *  the model's own time up to its first output, so a tool run or an approval
   *  the turn waited on before speaking is not counted as the model being
   *  slow. */
  firstToken(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    this.advance(turn, at);
    turn.touched = true;
    turn.reachedModel = true;
    turn.streamed = true;
    turn.firstOutputMs ??= turn.ms.model;
  }

  /** A tool item began.  A tool call is model output, so it also fixes the
   *  first-output mark; the time it then runs is tool time, not model time.
   *  Blocking calls (a peer bot's reply, a long command) belong here too — the
   *  caller must pass an item id for every tool it sees, whether or not the
   *  transcript shows a row for it. */
  toolStarted(threadId: string, itemId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn || turn.activeTools.has(itemId)) return;
    this.advance(turn, at);
    turn.touched = true;
    turn.reachedModel = true;
    turn.firstOutputMs ??= turn.ms.model;
    turn.steps += 1;
    turn.activeTools.add(itemId);
    this.reclassify(turn);
  }

  toolEnded(threadId: string, itemId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn || !turn.activeTools.has(itemId)) return;
    this.advance(turn, at);
    turn.activeTools.delete(itemId);
    this.reclassify(turn);
  }

  requestOpened(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    this.advance(turn, at);
    turn.openRequests += 1;
    this.reclassify(turn);
  }

  requestResolved(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn || turn.openRequests === 0) return;
    this.advance(turn, at);
    turn.openRequests -= 1;
    this.reclassify(turn);
  }

  /** The turn ended: close its clock, drop the entry, return what it spent.
   *  Undefined when there is nothing to bank — no live entry, or a turn that
   *  never reached a model (its time was setup, which is nobody's model time
   *  and no reason to count a turn). */
  settle(threadId: string, outputTokens?: number, at = this.now()): TurnStatsSample | undefined {
    const turn = this.live.get(threadId);
    if (!turn) return undefined;
    this.live.delete(threadId);
    const reportedOutput = typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0;
    // a provider that reports output tokens ran a model, whatever else it said
    if (!turn.reachedModel && !reportedOutput) return undefined;
    this.advance(turn, at);
    return {
      steps: turn.steps,
      modelMs: Math.round(turn.ms.model),
      toolMs: Math.round(turn.ms.tool),
      ...(turn.streamed && turn.firstOutputMs !== undefined ? { ttftMs: Math.round(turn.firstOutputMs) } : {}),
      ...(reportedOutput ? { outputTokens: Math.trunc(outputTokens) } : {}),
    };
  }

  /** The turn will never settle (stall release, rejected dispatch). */
  discard(threadId: string): void {
    this.live.delete(threadId);
  }

  get size(): number {
    return this.live.size;
  }

  private advance(turn: LiveTurn, at: number): void {
    const elapsed = at - turn.at;
    if (elapsed > 0) {
      turn.ms[turn.bucket] += elapsed;
      turn.at = at;
    }
  }

  private reclassify(turn: LiveTurn): void {
    turn.bucket = turn.openRequests > 0 ? "wait" : turn.activeTools.size > 0 ? "tool" : "model";
  }
}

const clean = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

/** Fold one settled turn into a task's running aggregate.  Aggregates only —
 *  no per-turn history — so the store stays a few bytes per task. */
export function mergeTaskStats(prev: TaskStats | undefined, sample: TurnStatsSample): TaskStats {
  const base: TaskStats = prev ?? { turns: 0, steps: 0, modelMs: 0, toolMs: 0 };
  const next: TaskStats = {
    turns: clean(base.turns) + 1,
    steps: clean(base.steps) + clean(sample.steps),
    modelMs: clean(base.modelMs) + clean(sample.modelMs),
    toolMs: clean(base.toolMs) + clean(sample.toolMs),
  };
  const ttftSamples = clean(base.ttftSamples);
  if (sample.ttftMs !== undefined) {
    next.ttftMsSum = clean(base.ttftMsSum) + clean(sample.ttftMs);
    next.ttftSamples = ttftSamples + 1;
  } else if (ttftSamples > 0) {
    next.ttftMsSum = clean(base.ttftMsSum);
    next.ttftSamples = ttftSamples;
  }
  // a turn feeds tok/s only when it has both a real output figure and model
  // time to divide it by — otherwise the rate would be a guess
  const feedsRate = clean(sample.outputTokens) > 0 && clean(sample.modelMs) > 0;
  if (feedsRate) {
    next.tpsTokens = clean(base.tpsTokens) + clean(sample.outputTokens);
    next.tpsMs = clean(base.tpsMs) + clean(sample.modelMs);
  } else if (clean(base.tpsMs) > 0) {
    next.tpsTokens = clean(base.tpsTokens);
    next.tpsMs = clean(base.tpsMs);
  }
  return next;
}
