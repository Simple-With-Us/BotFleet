// The per-turn wall clock and the aggregate it folds into.  The tracker is a
// pure in-memory class driven by explicit timestamps, so every case here is a
// deterministic script of events.  Its wiring in server/index.ts (which cannot
// be imported without booting the harness) is pinned by source at the bottom.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { mergeTaskStats, TurnStatsTracker } from "./turn-stats.ts";

const T = "thread-1";

describe("TurnStatsTracker", () => {
  it("splits a turn into model and tool time and counts steps", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 1_000);
    t.started(T, 1_500); // provider setup before this is not the model's time
    t.firstToken(T, 2_000);
    t.toolStarted(T, 3_000);
    t.toolEnded(T, 5_000);
    const sample = t.settle(T, 120, 6_000);
    expect(sample).toEqual({ steps: 1, modelMs: 2_500, toolMs: 2_000, ttftMs: 500, outputTokens: 120 });
    expect(t.size).toBe(0);
  });

  it("counts overlapping tools once — parallel tool time is the union, not the sum", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    t.toolStarted(T, 1_000);
    t.toolStarted(T, 1_500);
    t.toolEnded(T, 3_000);
    t.toolEnded(T, 4_000);
    const sample = t.settle(T, undefined, 5_000);
    expect(sample?.steps).toBe(2);
    expect(sample?.toolMs).toBe(3_000);
    expect(sample?.modelMs).toBe(2_000);
  });

  it("bills a person's pending approval to neither the model nor the tool", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    t.toolStarted(T, 1_000);
    t.requestOpened(T, 2_000);
    t.requestResolved(T, 12_000); // ten seconds waiting on a person
    t.toolEnded(T, 13_000);
    const sample = t.settle(T, undefined, 14_000);
    expect(sample?.toolMs).toBe(2_000);
    expect(sample?.modelMs).toBe(2_000);
  });

  it("takes time to first token from the model's own time, not tool or approval time", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    t.toolStarted(T, 400);
    t.toolEnded(T, 9_400); // nine seconds in a tool before the model says anything
    t.firstToken(T, 9_800);
    t.firstToken(T, 12_000); // only the first token counts
    expect(t.settle(T, undefined, 13_000)?.ttftMs).toBe(800);
  });

  it("records no time to first token when nothing streamed", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    const sample = t.settle(T, 50, 3_000);
    expect(sample).toEqual({ steps: 0, modelMs: 3_000, toolMs: 0, outputTokens: 50 });
    expect(sample).not.toHaveProperty("ttftMs");
  });

  it("omits output tokens the engine did not report, and never reports NaN or zero", () => {
    for (const reported of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = new TurnStatsTracker();
      t.begin(T, 0);
      expect(t.settle(T, reported, 1_000)).not.toHaveProperty("outputTokens");
    }
  });

  it("does not let a late turn.started move the clock past real activity", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    t.firstToken(T, 500);
    t.started(T, 900); // arrives after a token: ignored
    expect(t.settle(T, undefined, 1_000)?.modelMs).toBe(1_000);
  });

  it("ignores events for a thread with no turn in flight", () => {
    const t = new TurnStatsTracker();
    t.firstToken(T);
    t.toolStarted(T);
    t.toolEnded(T);
    t.requestOpened(T);
    t.requestResolved(T);
    expect(t.settle(T)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it("settles a turn once: a repeated completion banks nothing", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 0);
    expect(t.settle(T, undefined, 100)).toBeDefined();
    expect(t.settle(T, undefined, 200)).toBeUndefined();
  });

  it("holds no entry after settle, discard, or a replaced begin", () => {
    const t = new TurnStatsTracker();
    t.begin("a", 0);
    t.begin("b", 0);
    t.begin("c", 0);
    expect(t.size).toBe(3);
    t.settle("a");
    t.discard("b"); // the abort, stall-release and dispatch-error path
    expect(t.size).toBe(1);
    t.discard("b"); // discarding twice is harmless
    t.begin("c", 5); // a stale entry is replaced, never stacked
    expect(t.size).toBe(1);
    t.discard("c");
    expect(t.size).toBe(0);
  });

  it("never reports a negative duration when the clock steps backwards", () => {
    const t = new TurnStatsTracker();
    t.begin(T, 10_000);
    t.toolStarted(T, 9_000);
    t.toolEnded(T, 8_000);
    const sample = t.settle(T, undefined, 7_000);
    expect(sample?.modelMs).toBeGreaterThanOrEqual(0);
    expect(sample?.toolMs).toBeGreaterThanOrEqual(0);
  });
});

describe("mergeTaskStats", () => {
  it("starts an aggregate from the first turn", () => {
    expect(mergeTaskStats(undefined, { steps: 2, modelMs: 3_000, toolMs: 1_000, ttftMs: 400, outputTokens: 90 })).toEqual({
      turns: 1,
      steps: 2,
      modelMs: 3_000,
      toolMs: 1_000,
      ttftMsSum: 400,
      ttftSamples: 1,
      tpsTokens: 90,
      tpsMs: 3_000,
    });
  });

  it("keeps a turn with no first token or output out of the averages", () => {
    const first = mergeTaskStats(undefined, { steps: 1, modelMs: 2_000, toolMs: 0, ttftMs: 500, outputTokens: 100 });
    const second = mergeTaskStats(first, { steps: 4, modelMs: 8_000, toolMs: 3_000 });
    expect(second).toMatchObject({ turns: 2, steps: 5, modelMs: 10_000, toolMs: 3_000 });
    // the second turn added no sample to either ratio, so neither is dragged down
    expect(second.ttftMsSum).toBe(500);
    expect(second.ttftSamples).toBe(1);
    expect(second.tpsTokens).toBe(100);
    expect(second.tpsMs).toBe(2_000);
  });

  it("does not let an output figure with no model time feed tok/s", () => {
    const next = mergeTaskStats(undefined, { steps: 0, modelMs: 0, toolMs: 0, outputTokens: 500 });
    expect(next).not.toHaveProperty("tpsMs");
    expect(next).not.toHaveProperty("tpsTokens");
  });

  it("repairs a corrupt persisted aggregate instead of propagating NaN", () => {
    const next = mergeTaskStats(
      { turns: Number.NaN, steps: -3, modelMs: Number.POSITIVE_INFINITY, toolMs: 5 },
      { steps: 1, modelMs: 10, toolMs: 0 },
    );
    expect(next).toEqual({ turns: 1, steps: 1, modelMs: 10, toolMs: 5 });
  });
});

describe("turnStats wiring in server/index.ts", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8").split("\n");

  it("clears a turn's clock on every path that ends a turn without a turn.completed", () => {
    // begin() sits beside the turnUsage reset at dispatch; each of the two
    // other places that drop turnUsage without a completion (a stall release
    // and a dispatch error) must drop the clock in the same breath
    const discards = src.flatMap((line, i) => (line.includes("turnStats.discard(") ? [i] : []));
    expect(discards).toHaveLength(2);
    for (const i of discards) {
      const near = src.slice(Math.max(0, i - 2), i + 3).join("\n");
      expect(near).toContain("turnUsage.delete(");
    }
    expect(src.filter((l) => l.includes("turnStats.begin(")).length).toBe(1);
  });

  it("banks timing only when a turn's clock existed, never a fabricated zero turn", () => {
    expect(src.join("\n")).toMatch(/turnStats\.settle\(event\.threadId, tokens\?\.output\)/);
    expect(src.join("\n")).not.toMatch(/stats: turnTiming \?\?/);
  });
});
