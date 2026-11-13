import { describe, expect, it } from "vitest";

import { costUsd, type ChatCompletionsPriceTable } from "./pricing.ts";

const PRICES: ChatCompletionsPriceTable = {
  flat: [{ input: 1, output: 2 }],
  cached: [{ input: 1, output: 2, cachedInput: 0.5 }],
  tiered: [
    { maxInputTokens: 512_000, input: 0.3, output: 1.2, cachedInput: 0.06 },
    { input: 0.6, output: 2.4, cachedInput: 0.12 },
  ],
  unpriced: null,
};

describe("costUsd", () => {
  it("prices a flat model against known token counts", () => {
    // 1,000,000 input @ $1/M + 500,000 output @ $2/M = $1 + $1 = $2
    expect(costUsd({ input: 1_000_000, output: 500_000 }, PRICES, "flat")).toBe(2);
  });

  it("returns null — never 0 — for a model absent from the table", () => {
    expect(costUsd({ input: 100, output: 100 }, PRICES, "does-not-exist")).toBeNull();
  });

  it("returns null for a model explicitly priced null", () => {
    expect(costUsd({ input: 100, output: 100 }, PRICES, "unpriced")).toBeNull();
  });

  it("bills cachedInput at the cache rate and the remainder at the input rate", () => {
    // 1,000,000 input, 400,000 of which are cached:
    //   600,000 uncached @ $1/M = $0.60
    //   400,000 cached   @ $0.5/M = $0.20
    //   0 output
    // total = $0.80
    expect(costUsd({ input: 1_000_000, output: 0, cachedInput: 400_000 }, PRICES, "cached")).toBeCloseTo(0.8, 10);
  });

  it("falls back to the input rate when a model publishes no cached rate", () => {
    // cachedInput is a subset of input; with no cachedInput rate every
    // token — cached or not — is billed at the flat input rate, so the
    // total must equal treating cachedInput as ordinary input.
    const withCache = costUsd({ input: 1000, output: 0, cachedInput: 400 }, PRICES, "flat");
    const withoutCache = costUsd({ input: 1000, output: 0 }, PRICES, "flat");
    expect(withCache).toBe(withoutCache);
  });

  it("clamps a cachedInput larger than input rather than going negative", () => {
    // A driver bug (or a provider double-count) reporting cachedInput >
    // input must never make the "uncached" remainder negative.
    expect(costUsd({ input: 100, output: 0, cachedInput: 10_000 }, PRICES, "cached")).toBeCloseTo(
      (100 * 0.5) / 1_000_000,
      12,
    );
  });

  it("selects the tier matching the round's input token count", () => {
    // at the boundary: 512,000 input tokens is still the cheap tier
    expect(costUsd({ input: 512_000, output: 0 }, PRICES, "tiered")).toBeCloseTo(
      (512_000 * 0.3) / 1_000_000,
      10,
    );
    // one token past the boundary: the expensive tier applies to the WHOLE
    // round, matching how the provider itself bills a single request
    expect(costUsd({ input: 512_001, output: 0 }, PRICES, "tiered")).toBeCloseTo(
      (512_001 * 0.6) / 1_000_000,
      6,
    );
  });

  it("uses each tier's own cached rate, not the first tier's", () => {
    expect(
      costUsd({ input: 600_000, output: 0, cachedInput: 600_000 }, PRICES, "tiered"),
    ).toBeCloseTo((600_000 * 0.12) / 1_000_000, 10);
  });
});
