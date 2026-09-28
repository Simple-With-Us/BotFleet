// What the Maximum Tool Rounds control actually draws.
//
// SSR style, as the rest of this repo's component tests do (see
// EngineCallout.test.tsx): `renderToStaticMarkup` is the DOM-free path, and
// this component deliberately takes its whole decision as a prop so it can be
// mounted here without the store.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MaxToolRoundsField } from "./MaxToolRoundsField";
import { toolRoundsGate } from "@/lib/bot-settings-gates";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS } from "../../shared/bot-profile";

const selection = (instanceId: string): ModelSelection => ({ instanceId, model: "m" });

const TOOL_LOOP = {
  instanceId: "minimax",
  driverKind: "openai-compat",
  displayName: "MiniMax",
  capabilities: { computerMcp: false, agentsMcp: true, localComputerMcp: false, toolLoop: true },
} as InstanceInfo;

const CLI = {
  instanceId: "claude",
  driverKind: "cli",
  displayName: "Claude Code",
  capabilities: { computerMcp: false, agentsMcp: true, localComputerMcp: false, toolLoop: false },
} as InstanceInfo;

const render = (
  instances: InstanceInfo[],
  botId: string,
  maxToolRounds: number | null,
): string =>
  renderToStaticMarkup(
    createElement(MaxToolRoundsField, {
      value: maxToolRounds,
      onChange: () => {},
      gate: toolRoundsGate(instances, {
        modelSelection: selection(botId),
        maxToolRounds,
      }),
    }),
  );

describe("Maximum Tool Rounds, drawn", () => {
  it("shows the real default as its placeholder, not a stale literal", () => {
    const html = render([TOOL_LOOP], "minimax", null);
    expect(html).toContain(`placeholder="${DEFAULT_MAX_TOOL_ROUNDS}"`);
    expect(html).toContain(`Empty uses ${DEFAULT_MAX_TOOL_ROUNDS}`);
    expect(html).toContain(`Cap is ${MAX_TOOL_ROUNDS}`);
  });

  it("is an enabled input on a tool-loop engine", () => {
    const html = render([TOOL_LOOP], "minimax", null);
    expect(html).toContain('aria-label="Maximum Tool Rounds"');
    expect(html).not.toContain("disabled");
  });

  it("draws a saved value on an engine that ignores it, read-only, with the reason", () => {
    const html = render([CLI], "claude", 40);
    expect(html).toContain('value="40"');
    expect(html).toContain("disabled");
    expect(html).toContain("Claude Code runs its own tool loop");
  });

  it("draws an empty field rather than a bogus value when unset", () => {
    const html = render([TOOL_LOOP], "minimax", null);
    expect(html).toContain('value=""');
  });
});
