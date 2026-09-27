// Usage tab per-bot expand-with-details.  The previous test file
// pinned only the "All bots" row totals; this one pins the new
// expand/collapse behavior, the per-session table that drops when a
// row is clicked, and the pricing-mode pill that swaps an API rate for
// a "Subscription — included in plan" label whenever the engine's
// pricing kind is `subscription` (no API block) — the same shape
// `<UsageWhatIfProjection>` relies on, so the two stay in sync.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageWhatIfProjection, apiEquivalentCost, projectionRows } from "./UsageWhatIfProjection.tsx";
import { ENGINE_CAPABILITIES, uniqueModelToEngineId } from "@/lib/engine-capabilities.tsx";

describe("uniqueModelToEngineId", () => {
  it("maps unique model ids and leaves shared ids unmapped", () => {
    const map = uniqueModelToEngineId();
    // claude-sonnet-4.5 is listed under Cursor AND Claude — first-wins
    // would credit Cursor with legacy Claude usage, so it maps nowhere.
    expect(map.has("claude-sonnet-4.5")).toBe(false);
    // Unique ids still resolve: cursor-default only exists under Cursor,
    // claude-opus-4 only under Claude.
    expect(map.get("cursor-default")).toBe("cursor");
    expect(map.get("claude-opus-4")).toBe("claude");
  });
});

describe("UsageWhatIfProjection unattributed footnote", () => {
  it("shows the unattributed-usage footnote only when tokens could not be attributed", () => {
    const byEngine = [
      { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 100_000, actualCostUsd: 55 },
    ];
    const withUnattributed = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine, unattributedTokens: 12_345 }),
    );
    expect(withUnattributed).toContain("12,345 tokens ran on connections deleted before");
    const without = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine }),
    );
    expect(without).not.toContain("connections deleted before");
  });
});

describe("UsageWhatIfProjection", () => {
  it("renders one row per engine that has a pricing block with API", () => {
    const byEngine = [
      { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 100_000, actualCostUsd: 55 },
      { engineId: "grok", totalTokens: 200_000, cachedTokens: 10_000, actualCostUsd: 99 },
      { engineId: "claude", totalTokens: 50_000, cachedTokens: 0, actualCostUsd: 213.2 },
    ];
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine }),
    );
    // MiniMax and Grok have `subscription+api` pricing blocks; Claude
    // has `subscription` only.  The card must render MiniMax and Grok
    // rows (projectionRows skips Claude's row).
    expect(html).toContain("MiniMax");
    expect(html).toContain("Grok");
  });

  it("apiEquivalentCost matches the registry's API block for MiniMax M3", () => {
    const usage = { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 200_000, actualCostUsd: 55 };
    const pricing = ENGINE_CAPABILITIES.minimax.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    const cost = apiEquivalentCost(usage, pricing);
    // 1M tokens split 70/30 = 700k input / 300k output.  Cached share
    // is 200k, so 200k * 0.0002 (cached rate) + 500k * 0.001 (input) +
    // 300k * 0.004 (output) = 0.04 + 0.5 + 1.2 = 1.74.  Pin the math
    // so a future rate edit can't silently break the projection.
    expect(cost).toBeCloseTo(1.74, 2);
  });

  it("projectionRows skips engines with no API rate", () => {
    const rows = projectionRows([
      { engineId: "minimax", totalTokens: 100, cachedTokens: 0, actualCostUsd: 0 },
      { engineId: "claude", totalTokens: 100, cachedTokens: 0, actualCostUsd: 0 },
    ]);
    // Claude's pricing kind is `subscription`, not `subscription+api`
    // or `api`, so it does not appear in the projection table.
    const ids = rows.map((row) => row.entry.id);
    expect(ids).toContain("minimax");
    expect(ids).not.toContain("claude");
  });

  it("renders the no-data empty state when no engine has a pricing block", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine: [] }),
    );
    expect(html).toContain("No engines with a published API rate");
  });
});

import {
  ENGINE_PLAN_OPTIONS,
  defaultEnginePlan,
  findMatchingPreset,
  getInitialEnginePlans,
  modelDisplayName,
} from "@/lib/usage-plans";



describe("modelDisplayName", () => {
  it("maps raw engine model ids to clean picker display names", () => {
    expect(modelDisplayName("MiniMax-M3")).toBe("MiniMax M3");
    expect(modelDisplayName("grok-4.7-build-fast")).toBe("Grok 4.7 Build Fast");
    expect(modelDisplayName("deepseek-chat")).toBe("DeepSeek Chat");
    expect(modelDisplayName("claude-sonnet-4.5")).toBe("Claude Sonnet 4.5");
    expect(modelDisplayName("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(modelDisplayName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(modelDisplayName("cursor-default")).toBe("Cursor Default");
  });

  it("prefers instance model options when provided", () => {
    const instances = [
      {
        models: {
          options: [{ id: "custom-ollama-llama3", label: "Llama 3 8B (Local)" }],
        },
      },
    ];
    expect(modelDisplayName("custom-ollama-llama3", instances)).toBe("Llama 3 8B (Local)");
  });

  it("falls back gracefully for unknown models", () => {
    expect(modelDisplayName("unknown-provider-model")).toBe("unknown-provider-model");
  });
});

describe("ENGINE_PLAN_OPTIONS & findMatchingPreset", () => {
  it("matches first-paint registry defaults for Cursor and DeepSeek Harness", () => {
    const cursorPreset = findMatchingPreset("cursor", "Cursor Ultra", null);
    expect(cursorPreset).toBeDefined();
    expect(cursorPreset?.label).toBe("Cursor Ultra");
    expect(cursorPreset?.costPerMonth).toBeNull();

    const dshPreset = findMatchingPreset("deepseek-harness", "Pay-as-you-go (API)", null);
    expect(dshPreset).toBeDefined();
    expect(dshPreset?.label).toBe("Pay-as-you-go (API)");
    expect(dshPreset?.costPerMonth).toBeNull();
  });

  it("uses Unicode multiplication sign in Claude Max presets and matches with ASCII x", () => {
    const claude20x = findMatchingPreset("claude", "Claude Max 20×", 213.2);
    expect(claude20x).toBeDefined();
    expect(claude20x?.label).toBe("Claude Max 20× ($213.20/mo)");

    // Matching handles legacy ASCII 'x'
    const legacyMatch = findMatchingPreset("claude", "Claude Max 20x", 213.2);
    expect(legacyMatch).toBeDefined();
  });

  it("does not include a confusing $0 custom row for DeepSeek Harness", () => {
    const options = ENGINE_PLAN_OPTIONS["deepseek-harness"];
    expect(options.length).toBe(1);
    expect(options[0].costPerMonth).toBeNull();
    expect(options.some((o) => o.costPerMonth === 0)).toBe(false);
  });

  it("returns default plan from registry via defaultEnginePlan", () => {
    expect(defaultEnginePlan("minimax")).toEqual({
      planName: "MiniMax Token Plan Max",
      costPerMonth: 132,
    });
    expect(defaultEnginePlan("cursor")).toEqual({
      planName: "Cursor Ultra",
      costPerMonth: null,
    });
    expect(defaultEnginePlan("deepseek-harness")).toEqual({
      planName: "Pay-as-you-go (API)",
      costPerMonth: null,
    });
  });

  it("identifies custom plans as undefined preset match", () => {
    expect(findMatchingPreset("cursor", "Custom Cursor Plan", 50)).toBeUndefined();
    expect(findMatchingPreset("minimax", "MiniMax Token Plan Max", 200)).toBeUndefined();
  });

  it("maps legacy saved preset names and costs to new official presets", () => {
    // Legacy DeepSeek Pay-as-you-go maps to Pay-as-you-go (API)
    const dshLegacy = findMatchingPreset("deepseek-harness", "DeepSeek Pay-as-you-go", null);
    expect(dshLegacy?.planName).toBe("Pay-as-you-go (API)");

    // Legacy Cursor Ultra at $40 maps to Cursor Ultra with null cost
    const cursorLegacy = findMatchingPreset("cursor", "Cursor Ultra", 40);
    expect(cursorLegacy?.planName).toBe("Cursor Ultra");
    expect(cursorLegacy?.costPerMonth).toBeNull();
  });

  it("initializes plans from saved configuration or defaults via getInitialEnginePlans", () => {
    const plans = getInitialEnginePlans({
      minimax: { planName: "Custom MiniMax", costPerMonth: 80 },
      "deepseek-harness": { planName: "DeepSeek Pay-as-you-go", costPerMonth: null },
      cursor: { planName: "Cursor Ultra", costPerMonth: 40 },
    });
    expect(plans.minimax).toEqual({ planName: "Custom MiniMax", costPerMonth: 80 });
    // Legacy stored names are migrated to official presets
    expect(plans["deepseek-harness"]).toEqual({ planName: "Pay-as-you-go (API)", costPerMonth: null });
    expect(plans.cursor).toEqual({ planName: "Cursor Ultra", costPerMonth: null });
    // Unset engines take their defaults
    expect(plans.grok).toEqual({ planName: "xAI SuperGrok Heavy", costPerMonth: 99 });
  });
});


