// EngineQuotasPanel placement tests -- SSR-only, per this repo's renderer
// convention (no jsdom or @testing-library/react is installed; see
// MermaidBlock.test.tsx).  `defaultOpen` renders the disclosure's contents in a
// server render because `open` is initialised rather than effect-driven, so
// what a person sees after expanding is observable without a DOM.
//
// These assert WHERE a row lands, not what it says.  The always-open block and
// the disclosure both stamp `data-testid="engine-quota-<instanceId>"`, so a
// count proves the row renders exactly once, in whichever place it belongs.
// The failure they pin is a row that renders ZERO times: a selected
// multi-platform engine whose quota is missing from the panel altogether.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EngineQuotasPanel, type QuotaEngineInfo } from "./EngineQuotasPanel";

function engine(
  instanceId: string,
  displayName: string,
  driverKind: string,
  remainingPercent: number,
): QuotaEngineInfo {
  return {
    instanceId,
    displayName,
    driverKind,
    snapshot: {
      quota: {
        capped: false,
        models: {
          "some-model": { capped: false, remainingPercent, secondaryRemainingPercent: 90 },
        },
      },
    },
  };
}

/** How many times `needle` appears -- 0, 1 or 2 is the whole assertion. */
function occurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe("EngineQuotasPanel row placement", () => {
  it("keeps a selected single-platform engine in the always-open block", () => {
    const markup = renderToStaticMarkup(
      createElement(EngineQuotasPanel, {
        engines: [
          engine("claude-1", "Claude", "claudeAgent", 40),
          engine("grok-1", "Grok", "grokAgent", 70),
        ],
        activeInstanceId: "claude-1",
        defaultOpen: true,
      }),
    );

    expect(markup).toContain("engine-quotas-active");
    // Once in the open block, and not duplicated into the disclosure.
    expect(occurrences(markup, "engine-quota-claude-1")).toBe(1);
  });

  it("keeps a selected multi-platform engine reachable in the disclosure", () => {
    // Clutch fronts three platforms, so its row belongs behind the disclosure
    // rather than in the always-open block -- but it still has to render
    // there.  With Clutch as the only engine, a row filtered out of both
    // places leaves the panel completely empty.
    const markup = renderToStaticMarkup(
      createElement(EngineQuotasPanel, {
        engines: [engine("clutch-1", "Clutch", "dshAgent", 40)],
        activeInstanceId: "clutch-1",
        defaultOpen: true,
      }),
    );

    expect(markup).not.toContain("engine-quotas-active");
    expect(occurrences(markup, "engine-quota-clutch-1")).toBe(1);
  });

  it("labels the disclosure by what it holds, not by whether a block was hidden", () => {
    const wide = renderToStaticMarkup(
      createElement(EngineQuotasPanel, {
        engines: [engine("clutch-1", "Clutch", "dshAgent", 40)],
        activeInstanceId: "clutch-1",
        defaultOpen: true,
      }),
    );
    const narrow = renderToStaticMarkup(
      createElement(EngineQuotasPanel, {
        engines: [
          engine("claude-1", "Claude", "claudeAgent", 40),
          engine("grok-1", "Grok", "grokAgent", 70),
        ],
        activeInstanceId: "claude-1",
        defaultOpen: true,
      }),
    );

    // "Other Engines" would be a lie when the disclosure holds every engine.
    expect(wide).toContain("Engine Quotas");
    expect(wide).not.toContain("Other Engines");
    expect(narrow).toContain("Other Engines");
  });
});