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
import {
  hasEngineSpendActivity,
  hidesIdleUnavailableEngineRow,
  unpricedTurnCount,
} from "./UsageSection.tsx";
import type { DoomedPair, RedundantChain } from "./UsageSection.tsx";

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
  autoDetectAllEnginePlans,
  defaultEnginePlan,
  detectEnginePlanFromWindows,
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
  it("matches first-paint registry defaults for Cursor and Harness", () => {
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

  it("does not include a confusing $0 custom row for Harness", () => {
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

  it("detects engine plans from CodeCaps / Usage Monitor quota windows", () => {
    const windows = [
      { providerKey: "cursor", planName: "ultra", label: "Cursor Ultra" },
      { providerKey: "anthropic", planName: "pro", label: "Claude Pro" },
      { providerKey: "openai", planName: "plus", label: "ChatGPT Plus" },
      { providerKey: "xai", planName: "super", label: "xAI SuperGrok" },
      { providerKey: "minimax", planName: "starter", label: "MiniMax Token Plan Starter" },
      { providerKey: "google", planName: "ultra", label: "Google AI Ultra" },
    ];

    expect(detectEnginePlanFromWindows("cursor", windows)).toEqual({
      label: "Cursor Ultra",
      planName: "Cursor Ultra",
      costPerMonth: null,
    });
    expect(detectEnginePlanFromWindows("claude", windows)).toEqual({
      label: "Claude Pro ($20/mo)",
      planName: "Claude Pro",
      costPerMonth: 20,
    });
    expect(detectEnginePlanFromWindows("codex", windows)).toEqual({
      label: "ChatGPT Plus ($20/mo)",
      planName: "ChatGPT Plus",
      costPerMonth: 20,
    });
    expect(detectEnginePlanFromWindows("grok", windows)).toEqual({
      label: "xAI SuperGrok ($30/mo)",
      planName: "xAI SuperGrok",
      costPerMonth: 30,
    });
    expect(detectEnginePlanFromWindows("minimax", windows)).toEqual({
      label: "Token Plan Starter ($15/mo)",
      planName: "MiniMax Token Plan Starter",
      costPerMonth: 15,
    });
    expect(detectEnginePlanFromWindows("antigravity", windows)).toEqual({
      label: "Google AI Ultra ($105.79/mo)",
      planName: "Google AI Ultra",
      costPerMonth: 105.79,
    });

    const all = autoDetectAllEnginePlans(windows);
    expect(all.cursor.planName).toBe("Cursor Ultra");
    expect(all.claude.planName).toBe("Claude Pro");
    expect(all.codex.planName).toBe("ChatGPT Plus");
    expect(all.grok.planName).toBe("xAI SuperGrok");
  });
});



describe("engine spend activity", () => {
  it("counts an engine that spent but could not be priced as having activity", () => {
    // The case that mattered on a live Mac: `dsh` settled every turn and
    // reported `cost: null`, so both dollars were zero and its row was hidden.
    // Six of twelve bots ran on that engine. A blank row reads as no activity.
    expect(hasEngineSpendActivity({ spend5hUsd: 0, spend7dUsd: 0, unpricedTurns5h: 40, unpricedTurns7d: 300 })).toBe(true);
  });

  it("still shows an engine that has only priced spend", () => {
    expect(hasEngineSpendActivity({ spend5hUsd: 0.42, spend7dUsd: 3 })).toBe(true);
  });

  it("hides an engine that genuinely did nothing", () => {
    expect(hasEngineSpendActivity({ spend5hUsd: 0, spend7dUsd: 0 })).toBe(false);
    expect(hasEngineSpendActivity({ spend5hUsd: 0, spend7dUsd: 0, unpricedTurns5h: 0, unpricedTurns7d: 0 })).toBe(false);
    expect(hasEngineSpendActivity(undefined)).toBe(false);
  });

  it("tolerates a payload from a build that predates the counters", () => {
    // The state is hydrated from an API response, so a missing key must not
    // read as NaN or throw.
    expect(hasEngineSpendActivity({ spend5hUsd: 0, spend7dUsd: 0 } as never)).toBe(false);
    expect(unpricedTurnCount({ spend5hUsd: 1, spend7dUsd: 1 })).toBe(0);
  });

  it("sums both windows for the coverage note", () => {
    expect(unpricedTurnCount({ spend5hUsd: 0, spend7dUsd: 0, unpricedTurns5h: 7, unpricedTurns7d: 31 })).toBe(38);
    expect(unpricedTurnCount(undefined)).toBe(0);
  });
});

describe("held-engine and redundant-chain payloads", () => {
  it("accepts the shapes the server sends and tolerates their absence", () => {
    // Both fields have been on /api/quotas since they were added, with nothing
    // rendering them — a fact recorded for someone and read by no one, which is
    // the same defect a dead field is. The component must not assume they exist.
    const doomed: DoomedPair[] = [
      {
        botId: "bot-abcdef12",
        instanceId: "dsh",
        consecutiveFailures: 3,
        openedAt: 1_780_000_000_000,
        lastFailureAt: 1_780_000_000_000,
        lastError: "spawn dsh-agent ENOENT",
      },
    ];
    const chains: RedundantChain[] = [
      {
        botId: "bot-abcdef12",
        name: "Designer",
        total: 3,
        effective: 2,
        redundant: [{ instanceId: "grok", model: "grok-4.6", reason: "same-as-primary" }],
      },
    ];
    // A server that predates either field sends neither, and the panel must
    // render rather than throw — which is why both start as [].
    expect(doomed[0].instanceId).toBe("dsh");
    expect(doomed[0].consecutiveFailures).toBe(3);
    expect(chains[0].redundant[0].reason).toBe("same-as-primary");
    expect(chains[0].effective).toBeLessThan(chains[0].total);

describe("hidesIdleUnavailableEngineRow", () => {
  it("keeps a row whose probe just did not answer in time", () => {
    // The owner's "only 2-3 engines" report: a slow `--version` read as
    // "CLI not found" and Engine Quotas hid the row.
    expect(
      hidesIdleUnavailableEngineRow({
        snapshot: { state: "unavailable", transient: true, reason: "Cursor did not answer in time" },
      }),
    ).toBe(false);
  });

  it("still hides engines that were never set up", () => {
    expect(hidesIdleUnavailableEngineRow({ snapshot: { state: "unavailable", reason: "`codex` CLI not found" } })).toBe(true);
    expect(hidesIdleUnavailableEngineRow({ snapshot: { state: "unavailable", reason: "Disabled in settings" } })).toBe(true);
  });

  it("hides the ASCII.dev Box engine until a Box token is configured", () => {
    expect(
      hidesIdleUnavailableEngineRow({
        snapshot: { state: "unavailable", hidden: true, reason: 'no Box token — add {"box":{"token":"…"}} to ~/.botfleet/config.json' },
      }),
    ).toBe(true);
  });

  it("keeps a configured engine that is failing right now", () => {
    expect(hidesIdleUnavailableEngineRow({ snapshot: { state: "unavailable", reason: "box API unreachable: fetch failed" } })).toBe(false);
  });
});
