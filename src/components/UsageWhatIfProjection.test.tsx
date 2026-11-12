// <UsageWhatIfProjection> standalone tests — math + render path.  Kept
// in its own file per the audit's test plan, even though UsageSection's
// test file also exercises it.  The split lets a future pin of "the
// projection card's headline copy never silently drifts" live next to
// the component, not buried inside UsageSection's suite.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageWhatIfProjection, apiEquivalentCost, projectionRows } from "./UsageWhatIfProjection.tsx";
import { ENGINE_CAPABILITIES } from "@/lib/engine-capabilities.tsx";

describe("UsageWhatIfProjection — math", () => {
  it("returns zero cost for zero tokens", () => {
    const usage = { engineId: "minimax", totalTokens: 0, cachedTokens: 0, actualCostUsd: 0 };
    const pricing = ENGINE_CAPABILITIES.minimax.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    expect(apiEquivalentCost(usage, pricing)).toBe(0);
  });

  it("subtracts cached tokens from input at the cached rate", () => {
    // 1M tokens, all cached.  Math: 700k input * cached rate (0.0002/1k)
    // + 300k output * output rate (0.004/1k), all /1000 = 0.14 + 1.2
    // = 1.34.  The /1000 factor is essential — multiplying tokens
    // directly by a per-1k rate inflates the result by 1000x.
    const usage = { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 700_000, actualCostUsd: 0 };
    const pricing = ENGINE_CAPABILITIES.minimax.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    expect(apiEquivalentCost(usage, pricing)).toBeCloseTo(1.34, 2);
  });

  it("matches Grok's PAYG block for a real workload", () => {
    // 1M tokens total, no cache, MiniMax M3-style 70/30 split.
    const usage = { engineId: "grok", totalTokens: 1_000_000, cachedTokens: 0, actualCostUsd: 0 };
    const pricing = ENGINE_CAPABILITIES.grok.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    const cost = apiEquivalentCost(usage, pricing);
    // Grok 4.7: 700k * 0.002/1k + 300k * 0.006/1k = 1.4 + 1.8 = 3.2.
    // The /1000 factor is essential — see the cached-subtract test above.
    expect(cost).toBeCloseTo(3.2, 2);
  });

  it("keeps Grok on base rates because the 200k tier is per request, not per period", () => {
    const pricing = ENGINE_CAPABILITIES.grok.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    const at = (inputTokens: number, cachedTokens = 0) =>
      apiEquivalentCost(
        { engineId: "grok", inputTokens, outputTokens: 10_000, totalTokens: inputTokens + 10_000, cachedTokens, actualCostUsd: 0 },
        pricing,
      );
    // A period sum of 300k (say three 100k prompts) is not a long-context request.
    expect(at(300_000)).toBeCloseTo((300_000 * 0.002 + 10_000 * 0.006) / 1000, 6);
    expect(at(300_000, 100_000)).toBeCloseTo((100_000 * 0.0005 + 200_000 * 0.002 + 10_000 * 0.006) / 1000, 6);
    // Grok never takes MiniMax's generic 512K 2x either.
    expect(at(600_000)).toBeCloseTo((600_000 * 0.002 + 10_000 * 0.006) / 1000, 6);
  });

  it("shows Grok's long-context tier as a note instead", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, {
        periodLabel: "Last 30 days",
        byEngine: [{ engineId: "grok", inputTokens: 300_000, outputTokens: 10_000, totalTokens: 310_000, cachedTokens: 0, actualCostUsd: 0 }],
      }),
    );
    expect(html).toContain("200,000+ tokens");
    expect(html).toContain("$4 input / $1 cached / $12 output per million");
    expect(html).toContain("Per-request prompt sizes are not recorded");
  });
});

describe("UsageWhatIfProjection — row selection", () => {
  it("returns one entry per engine with api or subscription+api pricing", () => {
    const rows = projectionRows([
      { engineId: "minimax", totalTokens: 100, cachedTokens: 0, actualCostUsd: 55 },
      { engineId: "claude", totalTokens: 100, cachedTokens: 0, actualCostUsd: 213.2 },
      { engineId: "antigravity", totalTokens: 100, cachedTokens: 0, actualCostUsd: 105.79 },
      { engineId: "codex", totalTokens: 100, cachedTokens: 0, actualCostUsd: 100 },
    ]);
    const ids = rows.map((row) => row.entry.id);
    expect(ids).toContain("minimax");
    expect(ids).toContain("antigravity");
    // Claude + Codex are subscription-only; skip.
    expect(ids).not.toContain("claude");
    expect(ids).not.toContain("codex");
  });

  it("returns an empty list when no engine has a pricing block", () => {
    const rows = projectionRows([]);
    expect(rows.length).toBe(0);
  });
});

describe("UsageWhatIfProjection — render", () => {
  it("renders the 'Saved by plan' headline column", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, {
        periodLabel: "Last 30 days",
        byEngine: [
          { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 0, actualCostUsd: 55 },
        ],
      }),
    );
    expect(html).toContain("Saved by plan");
    expect(html).toContain("API-equivalent");
  });

  it("shows PAYG engines as PAYG and keeps them out of the cost and saved totals", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, {
        periodLabel: "Last 30 days",
        byEngine: [
          { engineId: "deepseek-harness", totalTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, actualCostUsd: 0 },
        ],
      }),
    );
    expect(html).toContain(">PAYG<");
    expect(html).not.toContain(">$0<");
    // Row saved, row %, and total % all read as a dash; nothing is booked as saved.
    expect(html).not.toMatch(/emerald[^>]*>\$[1-9]/);
  });

  it("renders the no-data message when nothing has a pricing block", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine: [] }),
    );
    expect(html).toContain("No engines with a published API rate");
  });
});
