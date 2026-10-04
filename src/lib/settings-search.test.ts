import { describe, expect, it } from "vitest";
import {
  searchSettings,
  sectionBodyHasVisibleItem,
  segmentMatchText,
  SETTINGS_SEARCH_ITEMS,
} from "./settings-search";

describe("Settings Search Engine", () => {
  it("returns all items when query is empty", () => {
    const result = searchSettings("");
    expect(result.matchingSectionIds.size).toBe(10);
    expect(result.matchingItemIds.size).toBe(SETTINGS_SEARCH_ITEMS.length);
    expect(result.matchingItems.length).toBe(SETTINGS_SEARCH_ITEMS.length);
    expect(result.totalMatches).toBe(SETTINGS_SEARCH_ITEMS.length);
  });

  it("every search item has a valid domId, title, and sectionLabel", () => {
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(item.domId).toBeTruthy();
      expect(item.domId).toMatch(/^setting-/);
      expect(item.title).toBeTruthy();
      expect(item.sectionLabel).toBeTruthy();
      expect(item.keywords.length).toBeGreaterThan(0);
    }
  });

  it("uses the labels people see on the destination cards", () => {
    const label = (id: string) => SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)?.title;
    expect(label("general:skin")).toBe("Skin");
    expect(label("computers:providers")).toBe("Providers");
    expect(label("usage:quotas")).toBe("Engine Quotas");
    expect(label("observability:sentry")).toBe("Diagnostics & Error Reporting");
    expect(label("engines:matrix")).toBe("Engine Capabilities");
    expect(label("connections:composioManaged")).toBe("Connections");
    expect(label("companion:pairing")).toBe("Phone");
    expect(label("models:fleet")).toBe("Models");
    expect(label("computers:defaults")).toBe("Default Bot Settings");
    expect(label("secrets:infisical")).toBe("Secret Store");
    expect(label("general:conversationMode")).toBe("Workspace Arrangement");
  });

  it("keeps the Usage body visible when a query matches only a sub-item", () => {
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

  it("finds workspace arrangement by title or keywords", () => {
    const byArrangement = searchSettings("arrangement");
    expect(byArrangement.matchingSectionIds.has("general")).toBe(true);
    expect(byArrangement.matchingItemIds.has("general:conversationMode")).toBe(true);

    const byTitle = searchSettings("Workspace Arrangement");
    expect(byTitle.matchingSectionIds.has("general")).toBe(true);
    expect(byTitle.matchingItemIds.has("general:conversationMode")).toBe(true);
  });

  it("finds both Shared VPS VM and Local VM by sandbox or vm", () => {
    const result = searchSettings("sandbox");
    expect(result.matchingSectionIds.has("computers")).toBe(true);
    expect(result.matchingItemIds.has("computers:localVm")).toBe(true);
    expect(result.matchingItemIds.has("computers:sharedVpsVm")).toBe(true);
  });

  it("finds mcode / MiniMax Code across engine clis and capability matrix", () => {
    const result = searchSettings("mcode");
    expect(result.matchingSectionIds.has("engines")).toBe(true);
    expect(result.matchingItemIds.has("engines:clis")).toBe(true);
    expect(result.matchingItemIds.has("engines:matrix")).toBe(true);
  });

  it("finds the ASCII.dev Box engine by its name, not by Computer", () => {
    const result = searchSettings("ascii.dev box");
    expect(result.matchingSectionIds.has("engines")).toBe(true);
    expect(result.matchingItemIds.has("engines:clis")).toBe(true);
  });

  it("finds where local models are set up, under Add Engine", () => {
    for (const query of ["local models", "ollama", "lm studio"]) {
      const result = searchSettings(query);
      expect(result.matchingItemIds.has("engines:addCustom"), query).toBe(true);
    }
  });

  it("finds host cli credentials sync across computers", () => {
    const result = searchSettings("credentials sync");
    expect(result.matchingSectionIds.has("computers")).toBe(true);
    expect(result.matchingItemIds.has("computers:cliCredentials")).toBe(true);
  });

  it("ranks exact title match higher than keyword match", () => {
    const result = searchSettings("Profile");
    expect(result.matchingItems[0].id).toBe("general:profile");
  });

  it("segments text into matched and non-matched tokens for UI highlighting", () => {
    const segments = segmentMatchText("Shared VPS VM on Linux", "vps");
    expect(segments).toEqual([
      { text: "Shared ", matched: false },
      { text: "VPS", matched: true },
      { text: " VM on Linux", matched: false },
    ]);
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
