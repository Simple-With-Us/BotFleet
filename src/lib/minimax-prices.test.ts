import { describe, expect, it } from "vitest";

import { MINIMAX_PRICE_PER_MILLION, formatPerMillionUsd, minimaxPriceRows } from "./minimax-prices";

// This file cannot import server/drivers/minimax.ts to cross-check the
// numbers directly: that file is reachable from the root tsconfig's `src`
// program (this test lives under src/), and its own `.ts`-extension
// relative imports only typecheck under tsconfig.server.json's
// `allowImportingTsExtensions` — pulling it in here breaks `tsc -b` for
// every file it touches.  The driver's own test suite
// (server/drivers/minimax.test.ts) is what proves the numbers below match
// MINIMAX_PRICE_PER_MILLION there; this file only proves ITS OWN copy is
// internally consistent and formats correctly, the same scope this file's
// DeepSeek sibling (deepseek-prices.test.ts) keeps.
describe("MiniMax published rates", () => {
  it("formats the usage table from those same numbers", () => {
    expect(formatPerMillionUsd(0.3)).toBe("$0.30");
    expect(formatPerMillionUsd(0.06)).toBe("$0.06");
    expect(formatPerMillionUsd(1.2)).toBe("$1.20");
    expect(formatPerMillionUsd(0.6)).toBe("$0.60");
    expect(formatPerMillionUsd(2.4)).toBe("$2.40");
    expect(minimaxPriceRows().map((row) => [row.model, row.input, row.cache, row.output, row.badge])).toEqual([
      ["MiniMax M3.1 Flash Preview", "$0.30", "$0.06", "$1.20", "Default · ≤512K ctx"],
      ["MiniMax M2.7 Highspeed", "$0.60", "$0.06", "$2.40", "API"],
    ]);
  });

  it("has exactly one row per catalog model id — MiniMax-M3.1-Flash-Preview, MiniMax-M2.7-highspeed", () => {
    expect(Object.keys(MINIMAX_PRICE_PER_MILLION).sort()).toEqual(
      ["MiniMax-M2.7-highspeed", "MiniMax-M3.1-Flash-Preview"].sort(),
    );
    // a coverage test can only force a decision when a model is ADDED to
    // the catalog with no row — it cannot, on its own, detect a model
    // silently REMOVED from this table while still shipping in the
    // driver's catalog, which is exactly what server/drivers/minimax.test.ts's
    // "has a real price row for every model in its own catalog" check is
    // for, against the driver's own live MinimaxDriver.models.
    expect(minimaxPriceRows()).toHaveLength(2);
  });

  it("every row parses to finite, positive USD numbers", () => {
    for (const tiers of Object.values(MINIMAX_PRICE_PER_MILLION)) {
      if (!tiers) continue;
      for (const tier of tiers) {
        expect(Number.isFinite(tier.input)).toBe(true);
        expect(Number.isFinite(tier.output)).toBe(true);
        expect(tier.input).toBeGreaterThan(0);
        expect(tier.output).toBeGreaterThan(0);
        if (tier.cachedInput !== undefined) expect(tier.cachedInput).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps MiniMax-M3.1-Flash-Preview's over-512K tier at double the base rate, with no upper bound of its own", () => {
    const [base, over] = MINIMAX_PRICE_PER_MILLION["MiniMax-M3.1-Flash-Preview"]!;
    expect(base.maxInputTokens).toBe(512_000);
    expect(over.maxInputTokens).toBeUndefined();
    expect(over.input).toBeCloseTo(base.input * 2, 10);
    expect(over.output).toBeCloseTo(base.output * 2, 10);
    expect(over.cachedInput).toBeCloseTo((base.cachedInput ?? 0) * 2, 10);
  });
});
