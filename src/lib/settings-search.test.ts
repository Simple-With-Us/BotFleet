import { describe, expect, it } from "vitest";
import { searchSettings, sectionBodyHasVisibleItem, SETTINGS_SEARCH_ITEMS } from "./settings-search";

describe("Settings Search Engine", () => {
  it("returns all items when query is empty", () => {
    const result = searchSettings("");
    expect(result.matchingSectionIds.size).toBe(10);
    expect(result.matchingItemIds.size).toBe(SETTINGS_SEARCH_ITEMS.length);
    expect(result.totalMatches).toBe(SETTINGS_SEARCH_ITEMS.length);
  });

  it("keeps the Usage body visible when a query matches only a sub-item", () => {
    // Regression: SettingsModal gated the whole Usage body on usage:summary,
    // so a query matching only usage:pricing rendered a blank section.
    const result = searchSettings("pricing mode");
    expect(result.matchingItemIds.has("usage:pricing")).toBe(true);
    expect(result.matchingItemIds.has("usage:summary")).toBe(false);
    expect(sectionBodyHasVisibleItem("usage", result.matchingItemIds)).toBe(true);
  });

  it("keeps the Observability body visible when a query matches only trace sampling", () => {
    const result = searchSettings("sample rate");
    expect(result.matchingItemIds.has("observability:traces")).toBe(true);
    expect(result.matchingItemIds.has("observability:sentry")).toBe(false);
    expect(sectionBodyHasVisibleItem("observability", result.matchingItemIds)).toBe(true);
  });

  it("reports no visible body items for a query outside the section", () => {
    const result = searchSettings("pricing mode");
    expect(sectionBodyHasVisibleItem("observability", result.matchingItemIds)).toBe(false);
  });

  it("finds subheadings by title (e.g. Channel Turns)", () => {
    const result = searchSettings("Channel Turns");
    expect(result.matchingSectionIds.has("general")).toBe(true);
    expect(result.matchingItemIds.has("general:roomTurnTimeout")).toBe(true);
    expect(result.matchCountBySection.general).toBeGreaterThanOrEqual(1);
  });

  it("finds subheadings by keywords (e.g. timeout)", () => {
    const result = searchSettings("timeout");
    expect(result.matchingSectionIds.has("general")).toBe(true);
    expect(result.matchingItemIds.has("general:roomTurnTimeout")).toBe(true);
  });

  it("finds transcription by whisper", () => {
    const result = searchSettings("whisper");
    expect(result.matchingSectionIds.has("connections")).toBe(true);
    expect(result.matchingItemIds.has("connections:transcription")).toBe(true);
  });

  it("finds SSH and VPS settings by ssh", () => {
    const result = searchSettings("ssh");
    expect(result.matchingSectionIds.has("computers")).toBe(true);
    expect(result.matchingItemIds.has("computers:vpsConnection")).toBe(true);
  });

  it("finds dark mode / skin by theme or dark mode", () => {
    const result = searchSettings("dark mode");
    expect(result.matchingSectionIds.has("general")).toBe(true);
    expect(result.matchingItemIds.has("general:skin")).toBe(true);
  });

  it("finds both Shared VPS VM and Local VM by sandbox or vm", () => {
    const result = searchSettings("sandbox");
    expect(result.matchingSectionIds.has("computers")).toBe(true);
    expect(result.matchingItemIds.has("computers:localVm")).toBe(true);
    expect(result.matchingItemIds.has("computers:sharedVpsVm")).toBe(true);
  });

  it("finds diagnostics by logs or debug", () => {
    const result = searchSettings("diagnostics");
    expect(result.matchingSectionIds.has("general")).toBe(true);
    expect(result.matchingItemIds.has("general:diagnostics")).toBe(true);
  });

  it("finds Sentry and error monitoring by sentry", () => {
    const result = searchSettings("sentry");
    expect(result.matchingSectionIds.has("observability")).toBe(true);
    expect(result.matchingItemIds.has("observability:sentry")).toBe(true);
  });

  it("finds Infisical secrets by infisical or vault", () => {
    const result = searchSettings("vault");
    expect(result.matchingSectionIds.has("secrets")).toBe(true);
    expect(result.matchingItemIds.has("secrets:infisical")).toBe(true);
  });

  it("reports 0 matches for non-existent nonsense query", () => {
    const result = searchSettings("xyznonexistentterm999");
    expect(result.matchingSectionIds.size).toBe(0);
    expect(result.matchingItemIds.size).toBe(0);
    expect(result.totalMatches).toBe(0);
  });
});
