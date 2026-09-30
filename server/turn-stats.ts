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
  /** Where the turn began — TTFT is measured from here. */
  startedAt: number;
  /** The clock's cursor: time up to here is already apportioned. */
  at: number;
  /** Set once any delta or tool has been seen, so a late `turn.started`
   *  cannot move the start past real activity. */
  touched: boolean;
  bucket: Bucket;
  ms: Record<Bucket, number>;
  steps: number;
  activeTools: number;
  openRequests: number;
  firstTokenMs?: number;
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

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A turn was dispatched.  Replaces any leftover entry for the thread. */
  begin(threadId: string, at = this.now()): void {
    this.live.set(threadId, {
      startedAt: at,
      at,
      touched: false,
      bucket: "model",
      ms: { model: 0, tool: 0, wait: 0 },
      steps: 0,
      activeTools: 0,
      openRequests: 0,
    });
  }

  /** The provider says the turn really began.  Provider setup before this is
   *  not the model's time, so the clock restarts — but only before activity. */
  started(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (turn && !turn.touched) turn.startedAt = turn.at = at;
  }

  /** A token streamed (assistant text or reasoning).  The first one fixes the
   *  turn's time to first token: the model's own time up to here, so a tool run
   *  or an approval the turn waited on before speaking is not counted as the
   *  model being slow. */
  firstToken(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    this.advance(turn, at);
    turn.touched = true;
    turn.firstTokenMs ??= turn.ms.model;
  }

  toolStarted(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    this.advance(turn, at);
    turn.touched = true;
    turn.steps += 1;
    turn.activeTools += 1;
    this.reclassify(turn);
  }

  toolEnded(threadId: string, at = this.now()): void {
    const turn = this.live.get(threadId);
    if (!turn || turn.activeTools === 0) return;
    this.advance(turn, at);
    turn.activeTools -= 1;
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

  /** The turn ended: close its clock, drop the entry, return what it spent. */
  settle(threadId: string, outputTokens?: number, at = this.now()): TurnStatsSample | undefined {
    const turn = this.live.get(threadId);
    if (!turn) return undefined;
    this.live.delete(threadId);
    this.advance(turn, at);
    return {
      steps: turn.steps,
      modelMs: Math.round(turn.ms.model),
      toolMs: Math.round(turn.ms.tool),
      ...(turn.firstTokenMs === undefined ? {} : { ttftMs: Math.round(turn.firstTokenMs) }),
      ...(typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0
        ? { outputTokens: Math.trunc(outputTokens) }
        : {}),
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
    turn.bucket = turn.openRequests > 0 ? "wait" : turn.activeTools > 0 ? "tool" : "model";
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
