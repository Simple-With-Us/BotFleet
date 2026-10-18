import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { InstanceInfo, ModelSelection } from "@/state/store";
import { ModelSettings, modelSettingsAvailable } from "./ModelSettings";

const INSTANCE: InstanceInfo = {
  instanceId: "minimax",
  driverKind: "minimax",
  displayName: "MiniMax",
  snapshot: { state: "available" },
  capabilities: { effortLevels: ["low", "high"] },
  models: {
    default: "m31",
    options: [
      { id: "m31", label: "M3.1", contextWindow: 1_000_000, effortLevels: ["low", "high"], contextCaps: [524_288], supportsMaxOutput: true },
      { id: "plain", label: "Plain", effortLevels: [] },
    ],
  },
};

const render = (selection: ModelSelection, props: Partial<Parameters<typeof ModelSettings>[0]> = {}) =>
  renderToStaticMarkup(createElement(ModelSettings, { instance: INSTANCE, selection, onChange: () => {}, ...props }));

describe("ModelSettings", () => {
  const m31: ModelSelection = { instanceId: "minimax", model: "m31", effort: "high", contextCap: 524_288 };

  it("is collapsed by default: the toggle shows, the controls do not", () => {
    const html = render(m31);
    expect(html).toContain("Model Settings");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Max Output Tokens");
    expect(html).not.toContain("data-effort-section");
  });

  it("shows Effort, Context and Max Output Tokens when opened", () => {
    const html = render(m31, { initialOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("data-effort-section");
    expect(html).toContain("data-context-section");
    expect(html).toContain("data-max-output-section");
  });

  it("leaves Effort out when the caller already has it, and renders nothing for a model with no options", () => {
    expect(render(m31, { initialOpen: true, showEffort: false })).not.toContain("data-effort-section");
    expect(render({ instanceId: "minimax", model: "plain" })).toBe("");
    expect(modelSettingsAvailable(undefined, m31)).toBe(false);
  });
});
