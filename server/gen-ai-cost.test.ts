import { describe, expect, it } from "vitest";

import { MINIMAX_PRICE_PER_MILLION } from "./drivers/minimax.ts";
import {
  CATALOG_MINIMAX_PRICES,
  catalogDeepSeekFamily,
  catalogMinimaxPriceKey,
  estimateCatalogCost,
  isCatalogPricedModel,
} from "./gen-ai-cost.ts";

describe("catalog MiniMax keys", () => {
  it("maps picker ids, thinking suffixes, and DSH wire names", () => {
    expect(catalogMinimaxPriceKey("MiniMax-M3.1-Flash-Preview")).toBe("MiniMax-M3.1-Flash-Preview");
    expect(catalogMinimaxPriceKey("MiniMax-M3.1-Flash-Preview-thinking")).toBe("MiniMax-M3.1-Flash-Preview");
    expect(catalogMinimaxPriceKey("MiniMax-M2.7-highspeed")).toBe("MiniMax-M2.7-highspeed");
    expect(catalogMinimaxPriceKey("MiniMax-M2.7-highspeed-thinking")).toBe("MiniMax-M2.7-highspeed");
    expect(catalogMinimaxPriceKey("MiniMax-M2.7")).toBe("MiniMax-M2.7");
    expect(catalogMinimaxPriceKey("dsh/minimax/MiniMax-M3.1-Flash-Preview")).toBe("MiniMax-M3.1-Flash-Preview");
  });

  it("leaves Grok and Claude unpriced", () => {
    expect(catalogMinimaxPriceKey("grok-4.7")).toBeNull();
    expect(catalogMinimaxPriceKey("claude-sonnet-4-5")).toBeNull();
    expect(catalogMinimaxPriceKey("")).toBeNull();
    expect(catalogMinimaxPriceKey(null)).toBeNull();
  });
});

describe("catalog DeepSeek family", () => {
  it("reads Pro vs Flash from the catalog id", () => {
    expect(catalogDeepSeekFamily("DeepSeek-V4.1-Pro")).toBe("pro");
    expect(catalogDeepSeekFamily("deepseek-v4-pro")).toBe("pro");
    expect(catalogDeepSeekFamily("DeepSeek-V4.1-Flash")).toBe("flash");
    expect(catalogDeepSeekFamily("deepseek-flash")).toBe("flash");
  });

  it("ignores a model that is not DeepSeek", () => {
    expect(catalogDeepSeekFamily("MiniMax-M3.1-Flash-Preview")).toBeNull();
    expect(catalogDeepSeekFamily("gpt-5")).toBeNull();
  });
});

describe("estimateCatalogCost", () => {
  it("prices MiniMax M3.1 at the published ≤512K rate", () => {
    expect(
      estimateCatalogCost("MiniMax-M3.1-Flash-Preview", { input: 1_000_000, output: 500_000 }),
    ).toBeCloseTo(0.3 + 0.6, 10);
  });

  it("prices mcode thinking ids the same as the base model", () => {
    const base = estimateCatalogCost("MiniMax-M3.1-Flash-Preview", { input: 10_000, output: 2_000 });
    const thinking = estimateCatalogCost("MiniMax-M3.1-Flash-Preview-thinking", {
      input: 10_000,
      output: 2_000,
    });
    expect(thinking).toBe(base);
    expect(thinking).not.toBeNull();
  });

  it("uses DeepSeek peak rates for a Flash id", () => {
    expect(
      estimateCatalogCost("DeepSeek-V4.1-Flash", { input: 1_000_000, output: 1_000_000 }),
    ).toBeCloseTo(0.3 + 1.2, 10);
  });

  it("returns null when the model or the tokens are missing", () => {
    expect(estimateCatalogCost("grok-4.7", { input: 100, output: 10 })).toBeNull();
    expect(estimateCatalogCost("MiniMax-M3.1-Flash-Preview", { output: 10 })).toBeNull();
    expect(estimateCatalogCost("MiniMax-M3.1-Flash-Preview", null)).toBeNull();
    expect(isCatalogPricedModel("MiniMax-M2.7-highspeed-thinking")).toBe(true);
    expect(isCatalogPricedModel("grok-4.7")).toBe(false);
  });

  it("stays in lockstep with the MiniMax HTTP driver's published table", () => {
    for (const [id, tiers] of Object.entries(MINIMAX_PRICE_PER_MILLION)) {
      expect(CATALOG_MINIMAX_PRICES[id], id).toEqual(tiers);
    }
  });
});
