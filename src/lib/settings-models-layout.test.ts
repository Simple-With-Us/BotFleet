// Settings > Models layout: the dialog has to be large enough for fleet
// rows, pills must wrap instead of overlapping, and iOS stacks fallbacks
// under Primary rather than squeezing them onto the same row.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("desktop Settings Models layout", () => {
  const settings = source("src/components/SettingsModal.tsx");
  const fleet = source("src/components/FleetModelsSection.tsx");

  it("grows the Settings dialog about 25–30 percent so fleet rows fit", () => {
    expect(settings).toContain("max-w-[1100px]");
    expect(settings).toContain("h-[min(720px,calc(100dvh-3rem))]");
    expect(settings).not.toContain("max-w-[860px]");
    expect(settings).not.toContain("h-[560px]");
  });

  it("wraps Primary, fallbacks, and Add Fallback instead of a four-column grid", () => {
    expect(fleet).toContain("flex-wrap");
    expect(fleet).toContain("min-w-[16rem]");
    expect(fleet).toContain("Add Fallback");
    expect(fleet).not.toMatch(/grid-cols-\[minmax\(0,1\.1fr\)/);
  });

  it("keeps fallbacks when the primary model changes", () => {
    expect(fleet).toContain("const savePrimary");
    expect(fleet).toContain("fallbacks: bot.modelSelection.fallbacks");
    expect(fleet).toContain("onChange={savePrimary}");
  });

  it("uses Title Case controls and drops developer-speak on this surface", () => {
    expect(fleet).toContain("Set Default");
    expect(fleet).toContain("Workspace Default");
    expect(fleet).toContain("Set All Bots To Default");
    expect(fleet).not.toContain("Set default");
    expect(fleet).not.toContain(">slot<");
    expect(fleet).not.toMatch(/leave this slot/);
    expect(fleet).not.toMatch(/default engine/);
  });
});

describe("Maximum Tool Rounds", () => {
  it("shows a capped desktop control only for a toolLoop engine", () => {
    const panel = source("src/components/SettingsPanel.tsx");
    expect(panel).toContain("Maximum Tool Rounds");
    expect(panel).toContain("Per turn.  Empty uses 12.  Cap is 200.");
    expect(panel).toContain("engine?.capabilities?.toolLoop === true");
    expect(panel).toContain("MAX_TOOL_ROUNDS");
    expect(panel).toContain('from "../../shared/bot-profile"');
    expect(panel).toContain("onChange(null)");
    expect(panel).toContain('| "maxToolRounds"');
  });

  it("shows the same capped control on iOS only when the engine reports toolLoop", () => {
    const profile = source("ios/App/AgentProfileView.swift");
    const models = source("ios/Sources/CompanionCore/Models.swift");
    expect(profile).toContain("Maximum Tool Rounds");
    expect(profile).toContain("Per turn.  Empty uses 12.  Cap is 200.");
    expect(profile).toContain("capabilities?.toolLoop == true");
    expect(profile).toContain("maximumToolRoundsCap = 200");
    expect(profile).toContain("return .clear");
    expect(models).toContain("var toolLoop: Bool?");
    expect(models).toContain("var maxToolRounds: Int?");
  });
});

describe("iOS Models settings layout", () => {
  const profile = source("ios/App/AgentProfileView.swift");

  it("puts Primary Model on its own section and stacks each fallback below", () => {
    expect(profile).toContain('Section("Primary Model")');
    expect(profile).toContain('Section("Fallback \\(index + 1)")');
    expect(profile).toContain("Button(\"Add Fallback\"");
    expect(profile).toContain(".pickerStyle(.navigationLink)");
    expect(profile).not.toContain("Add fallback model");
    expect(profile).not.toContain('Section("Model & Fallbacks")');
  });
});
