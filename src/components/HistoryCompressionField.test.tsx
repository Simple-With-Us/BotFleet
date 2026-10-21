// What the History Compression card actually draws.
//
// SSR style, as the rest of this repo's component tests do (see
// MaxToolRoundsField.test.tsx): `renderToStaticMarkup` is the DOM-free path,
// and this component deliberately takes its whole decision as a prop so it
// can be mounted here without the store.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HistoryCompressionField } from "./HistoryCompressionField";
import { historySummaryGate } from "@/lib/bot-settings-gates";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { MAX_HISTORY_TURNS } from "../../shared/bot-profile";

const selection = (instanceId: string): ModelSelection => ({ instanceId, model: "m" });

const ACP = {
  instanceId: "grok",
  driverKind: "grokAgent",
  displayName: "Grok",
  capabilities: { computerMcp: false, agentsMcp: true, localComputerMcp: false, toolLoop: false, historySummary: true },
} as InstanceInfo;

const MINIMAX = {
  instanceId: "minimax",
  driverKind: "openai-compat",
  displayName: "MiniMax",
  capabilities: { computerMcp: false, agentsMcp: true, localComputerMcp: false, toolLoop: true },
} as InstanceInfo;

const render = (
  instances: InstanceInfo[],
  botId: string,
  maxHistoryTurns: number | null,
  historySummaryModel = false,
): string =>
  renderToStaticMarkup(
    createElement(HistoryCompressionField, {
      maxHistoryTurns,
      historySummaryModel,
      onMaxHistoryTurns: () => {},
      onHistorySummaryModel: () => {},
      gate: historySummaryGate(instances, {
        modelSelection: selection(botId),
        maxHistoryTurns,
        historySummaryModel,
      }),
    }),
  );

describe("History Compression, drawn", () => {
  it("builds its caption from the real cap, not a typed-out number", () => {
    const html = render([ACP], "grok", null);
    expect(html).toContain("History Compression");
    expect(html).toContain("Empty keeps them all");
    expect(html).toContain(`Cap is ${MAX_HISTORY_TURNS}`);
  });

  it("is an enabled input and unchecked toggle on an engine that budgets its prompt", () => {
    const html = render([ACP], "grok", null);
    expect(html).toContain('aria-label="Maximum History Turns"');
    expect(html).toContain('aria-label="Model-Written Summary"');
    expect(html).toContain('placeholder="All"');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("checked");
  });

  it("draws saved values on an engine that ignores them, read-only, with the reason", () => {
    const html = render([MINIMAX], "minimax", 25, true);
    expect(html).toContain('value="25"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    expect(html).toContain("MiniMax keeps its own history");
  });

  it("draws an empty field rather than a bogus value when unset", () => {
    const html = render([ACP], "grok", null);
    expect(html).toContain('value=""');
  });

  it("draws a saved cap of 0 as 0, not as an empty field", () => {
    const html = render([ACP], "grok", 0);
    expect(html).toContain('value="0"');
  });
});
