import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOM_TERMINOLOGY,
  ROOM_LABEL_MAX_LENGTH,
  ROOM_TERMINOLOGY_OPTIONS,
  ROOM_TERMINOLOGY_PRESETS,
  lowerRoomLabels,
  resolveRoomLabels,
  sanitizeRoomLabel,
  suggestPlural,
} from "../shared/terminology.ts";

describe("room terminology presets", () => {
  it("offers every preset plus custom, and every preset has both forms", () => {
    for (const option of ROOM_TERMINOLOGY_OPTIONS) {
      if (option === "custom") continue;
      const labels = ROOM_TERMINOLOGY_PRESETS[option];
      expect(labels.singular.length, option).toBeGreaterThan(0);
      expect(labels.plural.length, option).toBeGreaterThan(0);
    }
    expect(ROOM_TERMINOLOGY_OPTIONS).toContain("custom");
    expect(ROOM_TERMINOLOGY_OPTIONS).toContain(DEFAULT_ROOM_TERMINOLOGY);
  });

  it("defaults to Channels for an absent or unknown setting", () => {
    expect(resolveRoomLabels(undefined)).toEqual({ singular: "Channel", plural: "Channels" });
    // A value stored by a newer build than this one still renders something.
    expect(resolveRoomLabels("wormholes" as never)).toEqual({
      singular: "Channel",
      plural: "Channels",
    });
  });

  it("resolves each preset", () => {
    expect(resolveRoomLabels("apps")).toEqual({ singular: "App", plural: "Apps" });
    expect(resolveRoomLabels("repos")).toEqual({ singular: "Repo", plural: "Repos" });
    expect(resolveRoomLabels("topics")).toEqual({ singular: "Topic", plural: "Topics" });
  });
});

describe("custom room labels", () => {
  it("uses both typed forms", () => {
    expect(resolveRoomLabels("custom", { singular: "Workspace", plural: "Workspaces" })).toEqual({
      singular: "Workspace",
      plural: "Workspaces",
    });
  });

  it("keeps an irregular plural the person typed", () => {
    expect(resolveRoomLabels("custom", { singular: "Person", plural: "People" })).toEqual({
      singular: "Person",
      plural: "People",
    });
  });

  it("fills a missing plural rather than reverting to Channels", () => {
    expect(resolveRoomLabels("custom", { singular: "Category" })).toEqual({
      singular: "Category",
      plural: "Categories",
    });
  });

  it("falls back to the default only when nothing usable was typed", () => {
    expect(resolveRoomLabels("custom", { singular: "   " })).toEqual({
      singular: "Channel",
      plural: "Channels",
    });
    expect(resolveRoomLabels("custom", null)).toEqual({ singular: "Channel", plural: "Channels" });
  });

  it("uses the plural for both forms when only the plural was typed", () => {
    expect(resolveRoomLabels("custom", { plural: "Squads" })).toEqual({
      singular: "Squads",
      plural: "Squads",
    });
  });
});

describe("sanitizeRoomLabel", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeRoomLabel("  Work   space \n")).toBe("Work space");
  });

  it("caps the length so a pasted label cannot break a header", () => {
    const long = "x".repeat(ROOM_LABEL_MAX_LENGTH + 20);
    expect(sanitizeRoomLabel(long)).toHaveLength(ROOM_LABEL_MAX_LENGTH);
  });

  it("returns null for empty or non-string input", () => {
    expect(sanitizeRoomLabel("")).toBeNull();
    expect(sanitizeRoomLabel("   ")).toBeNull();
    expect(sanitizeRoomLabel(undefined)).toBeNull();
    expect(sanitizeRoomLabel(null)).toBeNull();
    expect(sanitizeRoomLabel(7 as never)).toBeNull();
  });
});

describe("suggestPlural", () => {
  it("adds s to a regular word", () => {
    expect(suggestPlural("App")).toBe("Apps");
    expect(suggestPlural("Repo")).toBe("Repos");
    expect(suggestPlural("Topic")).toBe("Topics");
  });

  it("adds es after a sibilant", () => {
    expect(suggestPlural("Box")).toBe("Boxes");
    expect(suggestPlural("Class")).toBe("Classes");
    expect(suggestPlural("Bench")).toBe("Benches");
    expect(suggestPlural("Dish")).toBe("Dishes");
  });

  it("turns a consonant plus y into ies, but leaves a vowel plus y alone", () => {
    expect(suggestPlural("Category")).toBe("Categories");
    expect(suggestPlural("Day")).toBe("Days");
  });

  it("turns f and fe into ves", () => {
    expect(suggestPlural("Shelf")).toBe("Shelves");
    expect(suggestPlural("Knife")).toBe("Knives");
  });

  it("matches the case of a shouted word", () => {
    expect(suggestPlural("HUB")).toBe("HUBS");
    expect(suggestPlural("BOX")).toBe("BOXES");
  });

  it("handles empty and padded input", () => {
    expect(suggestPlural("")).toBe("");
    expect(suggestPlural("   ")).toBe("");
    expect(suggestPlural("  Lane  ")).toBe("Lanes");
  });
});

describe("lowerRoomLabels", () => {
  it("lowers the first letter for mid-sentence use", () => {
    expect(lowerRoomLabels({ singular: "Channel", plural: "Channels" })).toEqual({
      singular: "channel",
      plural: "channels",
    });
  });

  it("leaves an all-caps custom label alone", () => {
    expect(lowerRoomLabels({ singular: "HUB", plural: "HUBS" })).toEqual({
      singular: "HUB",
      plural: "HUBS",
    });
  });
});
