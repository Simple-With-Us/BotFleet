// Settings > Models layout: the dialog has to be large enough for fleet
// rows, pills must wrap instead of overlapping, and iOS stacks fallbacks
// under Primary rather than squeezing them onto the same row.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS } from "../../shared/bot-profile";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("desktop Settings Models layout", () => {
  const settings = source("src/components/SettingsModal.tsx");
  const fleet = source("src/components/FleetModelsSection.tsx");

  it("grows the Settings dialog so the capability table and fleet rows fit with user resizability", () => {
    expect(settings).toContain("DEFAULT_SETTINGS_MODAL_WIDTH_PX = 1292");
    // 976px (880 + 96, 1 inch taller) and 1292px (1100 + 192, 2 inches wider):
    // the Engines section opens on the capability matrix and the reader
    // sees the full table and hover details without cutoffs.
    expect(settings).toContain("DEFAULT_SETTINGS_MODAL_HEIGHT_PX = 976");
    expect(settings).toContain("saveSettingsModalSize");
    expect(settings).not.toContain("h-[min(720px,calc(100dvh-3rem))]");
    expect(settings).not.toContain("max-w-[860px]");
    expect(settings).not.toContain("h-[560px]");
  });

  it("keeps the section nav narrow so the Engines matrix fits the pane", () => {
    // 164px, not 190px.  The content pane is 1100 - nav - 40, and
    // EngineCapabilitiesMatrix.MATRIX_CONTENT_BUDGET_PX is derived from
    // these two numbers; widening the nav back would reintroduce the
    // horizontal scroll the transposed matrix was built to remove.
    expect(settings).toContain("w-[164px]");
    expect(settings).not.toContain("w-[190px]");
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
  // These used to assert that the desktop panel and the iOS profile view both
  // CONTAINED the literal string "Per turn.  Empty uses 12.  Cap is 200."  A
  // string-presence test passes as happily on a wrong number as a right one,
  // so all three surfaces agreed with each other while disagreeing with the
  // harness: the copy said 12, the prompt said 40, and the loop stopped at 12.
  // What is pinned now is AGREEMENT — every surface derives its numbers from
  // the shared constants, and a hardcoded default fails the build.
  const panel = source("src/components/SettingsPanel.tsx");
  const profile = source("ios/App/AgentProfileView.swift");

  it("renders the shared caption rather than a typed-out sentence", () => {
    const field = source("src/components/MaxToolRoundsField.tsx");
    // The component renders the caption it is handed, so the NUMBER is derived
    // in exactly one place (toolRoundsGate) and the field cannot drift from it.
    expect(field).toContain("{gate.caption}");
    expect(field).toContain("DEFAULT_MAX_TOOL_ROUNDS");
    expect(field).not.toContain("Empty uses");
    expect(source("src/lib/bot-settings-gates.ts")).toContain("toolRoundsCaption()");
  });

  it("no surface hardcodes a default round count any more", () => {
    for (const [name, text] of [
      ["SettingsPanel.tsx", panel],
      ["MaxToolRoundsField.tsx", source("src/components/MaxToolRoundsField.tsx")],
      ["AgentProfileView.swift", profile],
    ] as const) {
      expect(text, `${name} hardcodes a round default`).not.toMatch(/Empty uses \d/);
    }
  });

  it("iOS mirrors the shared default and cap as named constants", () => {
    expect(profile).toContain(`private static let defaultToolRounds = ${DEFAULT_MAX_TOOL_ROUNDS}`);
    expect(profile).toContain(`private static let maximumToolRoundsCap = ${MAX_TOOL_ROUNDS}`);
  });

  it("iOS keeps a saved ceiling visible on an engine that ignores it", () => {
    expect(profile).toContain("toolRoundsEditable || !maxToolRoundsText.isEmpty");
    expect(profile).toContain("runs its own tool loop");
  });

  it("iOS does not call a ceiling inapplicable on a cold start", () => {
    // Found by Seer review on #693, and the exact bug this whole change exists
    // to kill: before the engine list loads, `toolRoundsEditable` is false for
    // an engine that may well honor the setting, and the caption used to say it
    // "does not apply" — a permanent-sounding claim from a lookup that simply
    // had not answered.  The two claims must stay distinguishable on iOS the
    // way toolRoundsGate() keeps them distinguishable on the desktop.
    expect(profile).toContain("if toolRoundsEngine == nil {");
    expect(profile).toContain("has not reported its capabilities yet");
    const caption = profile.slice(
      profile.indexOf("private var toolRoundsCaption"),
      profile.indexOf("private var toolRoundsCaption") + 900,
    );
    const unknownBranch = caption.indexOf("has not reported its capabilities yet");
    const knownBranch = caption.indexOf("runs its own tool loop");
    expect(unknownBranch, "both caption branches must exist").toBeGreaterThan(-1);
    expect(knownBranch, "both caption branches must exist").toBeGreaterThan(-1);
    expect(knownBranch, "the unknown branch must be asked first").toBeGreaterThan(unknownBranch);
  });

  it("the desktop control asks the shared gate, not a bare capability check", () => {
    expect(panel).toContain("toolRoundsGate(state.instances, bot)");
    expect(panel).toContain("roundsGate.visible");
    // The old gate, which read an unanswered lookup as a "no".
    expect(panel).not.toContain("engine?.capabilities?.toolLoop === true &&");
  });

  it("the panel reads every engine capability through one call", () => {
    expect(panel).toContain("botCapabilityGates(state.instances, bot)");
    expect(panel).not.toContain("engine?.capabilities?.agentsMcp === true");
    expect(panel).not.toContain("engine?.capabilities?.composioMcp === true");
    expect(panel).not.toContain("engine?.capabilities?.approvalReview === true");
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
