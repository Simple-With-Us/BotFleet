// The math behind the two footer chips.  Everything here is pure; the one
// rule the whole file enforces is that a figure the engine never reported is
// left OUT (undefined / no row), never rendered as a believable 0.
import { describe, expect, it } from "vitest";

import type { TaskStats, TaskUsage } from "@/state/store";
import {
  cacheHitPercent,
  deriveSessionStats,
  deriveTokenUsage,
  formatDuration,
  formatRate,
} from "./thread-stats";

const usage = (over: Partial<TaskUsage> = {}): TaskUsage => ({ input: 0, output: 0, costUsd: null, turns: 0, ...over });
const stats = (over: Partial<TaskStats> = {}): TaskStats => ({ turns: 1, steps: 0, modelMs: 0, toolMs: 0, ...over });

describe("formatDuration", () => {
  it("formats the shapes the chips show", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(7_300)).toBe("7.3s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(280_000)).toBe("4m40s");
    expect(formatDuration(1_336_000)).toBe("22m16s");
    expect(formatDuration(3_900_000)).toBe("1h05m");
  });

  it("promotes at the boundaries instead of printing 1000ms, 10.0s or 60s", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(999.6)).toBe("1s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(9_960)).toBe("10s");
    expect(formatDuration(59_600)).toBe("1m00s");
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(3_599_400)).toBe("59m59s");
    expect(formatDuration(3_600_000)).toBe("1h00m");
  });

  it("has no answer for a value that is not a duration", () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatDuration(bad as number | undefined)).toBeUndefined();
    }
  });
});

describe("formatRate", () => {
  it("rounds to whole tokens above 10 and keeps a decimal below it", () => {
    expect(formatRate(92.4)).toBe("92 tok/s");
    expect(formatRate(9.96)).toBe("10 tok/s");
    expect(formatRate(4.25)).toBe("4.3 tok/s");
    expect(formatRate(3)).toBe("3 tok/s");
  });

  it("never prints a positive rate as a fake 0", () => {
    // 10 tokens over 5 minutes of model time is 0.033 tok/s: toFixed(1) would say "0.0"
    expect(formatRate(0.033)).toBeUndefined();
    expect(formatRate(0.0999)).toBeUndefined();
    expect(formatRate(0.1)).toBe("0.1 tok/s");
    const view = deriveSessionStats(stats({ turns: 1, tpsTokens: 10, tpsMs: 300_000 }), usage({ turns: 1 }));
    expect(view?.rate).toBeUndefined();
    expect(view?.rows.map((r) => r.label)).not.toContain("Tokens per second");
  });

  it("has no answer for a missing or non-positive rate", () => {
    for (const bad of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRate(bad as number | undefined)).toBeUndefined();
    }
  });
});

describe("deriveSessionStats", () => {
  it("builds the chip and the four popover rows from a full aggregate", () => {
    const view = deriveSessionStats(
      stats({
        turns: 2,
        steps: 27,
        modelMs: 280_000,
        toolMs: 1_336_000,
        ttftMsSum: 3_000,
        ttftSamples: 2,
        tpsTokens: 9_200,
        tpsMs: 100_000,
      }),
      usage({ turns: 2 }),
    );
    expect(view?.turns).toBe("2 turns");
    expect(view?.steps).toBe("27 steps");
    expect(view?.rate).toBe("92 tok/s");
    expect(view?.rows).toEqual([
      { label: "Model time", value: "4m40s" },
      { label: "Tool time", value: "22m16s" },
      { label: "Avg time to first token", value: "1.5s" },
      { label: "Tokens per second", value: "92" },
    ]);
    expect(view?.note).toBeUndefined();
  });

  it("is hidden when the task has no timing at all", () => {
    expect(deriveSessionStats(undefined, usage({ turns: 3 }))).toBeUndefined();
    expect(deriveSessionStats(stats({ turns: 0 }), usage())).toBeUndefined();
  });

  it("omits every row with no data rather than showing a fake 0", () => {
    // an engine that streamed nothing, ran no tools and reported no output
    const view = deriveSessionStats(stats({ turns: 1, modelMs: 6_000 }), usage({ turns: 1 }));
    expect(view?.rows).toEqual([{ label: "Model time", value: "6s" }]);
    expect(view?.steps).toBeUndefined();
    expect(view?.rate).toBeUndefined();
  });

  it("divides by zero nowhere: a zero-time or zero-sample ratio is unknown", () => {
    const view = deriveSessionStats(
      stats({ modelMs: 1_000, ttftMsSum: 500, ttftSamples: 0, tpsTokens: 100, tpsMs: 0 }),
      usage({ turns: 1 }),
    );
    expect(view?.rows.map((r) => r.label)).toEqual(["Model time"]);
    expect(view?.rate).toBeUndefined();
  });

  it("keeps the tool row for a step too quick to time", () => {
    const view = deriveSessionStats(stats({ steps: 1, modelMs: 900 }), usage({ turns: 1 }));
    expect(view?.rows).toContainEqual({ label: "Tool time", value: "0ms" });
    expect(view?.steps).toBe("1 step");
  });

  it("says '1 turn' for one turn", () => {
    expect(deriveSessionStats(stats({ turns: 1, modelMs: 10 }), usage({ turns: 1 }))?.turns).toBe("1 turn");
  });

  it("does not claim a step total for a thread whose earlier turns predate timing", () => {
    const view = deriveSessionStats(stats({ turns: 2, steps: 5, modelMs: 8_000 }), usage({ turns: 7 }));
    expect(view?.turns).toBe("7 turns");
    expect(view?.steps).toBeUndefined();
    expect(view?.note).toBe("Timing covers 2 of 7 turns");
  });
});

describe("cacheHitPercent", () => {
  it("is the cached share of input", () => {
    expect(cacheHitPercent(usage({ input: 1_000, cachedInput: 910 }))).toBe(91);
    expect(cacheHitPercent(usage({ input: 1_000, cachedInput: 0 }))).toBe(0);
  });

  it("never rounds a partial hit up to 100%", () => {
    expect(cacheHitPercent(usage({ input: 10_000, cachedInput: 9_999 }))).toBe(99);
    expect(cacheHitPercent(usage({ input: 10_000, cachedInput: 10_000 }))).toBe(100);
  });

  it("is unknown when the engine never reported a cached share or has no input", () => {
    expect(cacheHitPercent(usage({ input: 1_000 }))).toBeUndefined();
    expect(cacheHitPercent(usage({ input: 0, cachedInput: 0 }))).toBeUndefined();
  });

  it("clamps a cached figure that exceeds input", () => {
    expect(cacheHitPercent(usage({ input: 100, cachedInput: 500 }))).toBe(100);
  });
});

describe("deriveTokenUsage", () => {
  it("builds the chip, header and rows for a cached thread with a known cost", () => {
    const view = deriveTokenUsage(usage({ input: 600_000, output: 45_000, cachedInput: 546_000, costUsd: 1.234, turns: 4 }));
    expect(view?.total).toBe("645k tok");
    expect(view?.cacheHit).toBe("91%");
    expect(view?.headline).toBe("645k tokens");
    expect(view?.rows).toEqual([
      { label: "Cache hit", value: "91%" },
      { label: "Uncached input", value: "54k" },
      { label: "Cached input", value: "546k" },
      { label: "Output", value: "45k" },
      { label: "Cost", value: "$1.23" },
    ]);
  });

  it("is hidden until something was spent", () => {
    expect(deriveTokenUsage(undefined)).toBeUndefined();
    expect(deriveTokenUsage(usage({ turns: 1 }))).toBeUndefined();
  });

  it("drops the cache rows for an engine that reports no cached share", () => {
    const view = deriveTokenUsage(usage({ input: 12_000, output: 800, turns: 1 }));
    expect(view?.cacheHit).toBeUndefined();
    expect(view?.rows).toEqual([
      { label: "Input", value: "12k" },
      { label: "Output", value: "800" },
    ]);
  });

  it("omits Output for an engine that banks none (DSH) and Cost when unpriced", () => {
    const view = deriveTokenUsage(usage({ input: 5_000, output: 0, cachedInput: 0, costUsd: null, turns: 1 }));
    expect(view?.rows.map((r) => r.label)).toEqual(["Cache hit", "Uncached input", "Cached input"]);
    expect(view?.rows).toContainEqual({ label: "Cache hit", value: "0%" });
  });

  it("keeps a zero cost that was reported", () => {
    const view = deriveTokenUsage(usage({ input: 100, output: 10, costUsd: 0, turns: 1 }));
    expect(view?.rows).toContainEqual({ label: "Cost", value: "$0" });
  });

  it("never lets uncached input go negative when cached exceeds input", () => {
    const view = deriveTokenUsage(usage({ input: 100, output: 5, cachedInput: 500, turns: 1 }));
    expect(view?.rows).toContainEqual({ label: "Uncached input", value: "0" });
    expect(view?.rows).toContainEqual({ label: "Cached input", value: "100" });
  });
});
