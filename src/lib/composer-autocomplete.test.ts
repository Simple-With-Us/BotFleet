import { describe, expect, it } from "vitest";
import {
  autocompleteQueryAt,
  getAutocompleteCandidates,
  applyAutocomplete,
  type AutocompleteContext,
} from "./composer-autocomplete";

describe("autocompleteQueryAt", () => {
  it("detects @ at start of input", () => {
    expect(autocompleteQueryAt("@", 1)).toEqual({ trigger: "@", start: 0, query: "" });
    expect(autocompleteQueryAt("@scout", 6)).toEqual({ trigger: "@", start: 0, query: "scout" });
  });

  it("detects # at start of input", () => {
    expect(autocompleteQueryAt("#", 1)).toEqual({ trigger: "#", start: 0, query: "" });
    expect(autocompleteQueryAt("#general", 8)).toEqual({ trigger: "#", start: 0, query: "general" });
  });

  it("detects / at start of input for slash commands", () => {
    expect(autocompleteQueryAt("/", 1)).toEqual({ trigger: "/", start: 0, query: "" });
    expect(autocompleteQueryAt("/stop", 5)).toEqual({ trigger: "/", start: 0, query: "stop" });
  });

  it("ignores / inside paths and URLs", () => {
    expect(autocompleteQueryAt("https://example.com/foo", 23)).toBeNull();
    expect(autocompleteQueryAt("read docs/plans.md", 16)).toBeNull();
  });

  it("detects triggers preceded by whitespace", () => {
    expect(autocompleteQueryAt("hello @", 7)).toEqual({ trigger: "@", start: 6, query: "" });
    expect(autocompleteQueryAt("check out #linear please", 17)).toEqual({ trigger: "#", start: 10, query: "linear" });
  });

  it("detects triggers preceded by opening punctuation", () => {
    expect(autocompleteQueryAt("(@bot", 5)).toEqual({ trigger: "@", start: 1, query: "bot" });
    expect(autocompleteQueryAt("[#general", 9)).toEqual({ trigger: "#", start: 1, query: "general" });
  });

  it("ignores triggers inside words, emails, or hex codes", () => {
    expect(autocompleteQueryAt("user@domain.com", 15)).toBeNull();
    expect(autocompleteQueryAt("color:#fff", 10)).toBeNull();
  });

  it("ignores trigger across newlines", () => {
    expect(autocompleteQueryAt("@hello\nworld", 12)).toBeNull();
  });

  it("does not dismiss valid @ trigger when an embedded # appears later (e.g. issue#5)", () => {
    expect(autocompleteQueryAt("@scout issue#5", 14)).toEqual({
      trigger: "@",
      start: 0,
      query: "scout issue#5",
    });
  });

  it("prioritizes the valid trigger closest to caret", () => {
    expect(autocompleteQueryAt("@scout and #general", 19)).toEqual({
      trigger: "#",
      start: 11,
      query: "general",
    });
  });
});

describe("getAutocompleteCandidates", () => {
  const baseCtx: AutocompleteContext = {
    bots: [
      { id: "b1", name: "Jarvis", role: "Assistant", hidden: false } as any,
      { id: "b2", name: "Scout", role: "Searcher", hidden: false } as any,
    ],
    groups: [
      { id: "g1", name: "general", bulletin: "All fleet topics", dm: false } as any,
      { id: "g2", name: "dm-bot", dm: true } as any,
    ],
    routines: [
      { id: "r1", name: "Morning Brief", description: "Daily updates" } as any,
    ],
    connectedApps: {
      github: { connected: true },
    },
  };

  it("returns bots for @ trigger", () => {
    const candidates = getAutocompleteCandidates({ trigger: "@", start: 0, query: "" }, baseCtx);
    expect(candidates.map((c) => c.name)).toContain("Jarvis");
    expect(candidates.map((c) => c.name)).toContain("Scout");
  });

  it("filters bots by query", () => {
    const candidates = getAutocompleteCandidates({ trigger: "@", start: 0, query: "sco" }, baseCtx);
    expect(candidates.map((c) => c.name)).toEqual(["Scout"]);
  });

  it("returns channels, connected apps, and popular apps for # trigger", () => {
    const candidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "" }, baseCtx);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("general");
    expect(names).toContain("GitHub");
    expect(names).toContain("Slack");
    expect(names).not.toContain("dm-bot");
  });

  it("filters channels and apps by query", () => {
    const candidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "gen" }, baseCtx);
    expect(candidates.map((c) => c.name)).toEqual(["general"]);

    const appCandidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "lin" }, baseCtx);
    expect(appCandidates.map((c) => c.name)).toEqual(["Linear"]);
  });
});

describe("applyAutocomplete", () => {
  it("inserts @bot with trailing space", () => {
    const result = applyAutocomplete("Ask @ja to help", 7, { trigger: "@", start: 4, query: "ja" }, {
      id: "b1",
      name: "Jarvis",
      kind: "bot",
      badge: "Bot",
    });
    expect(result).toEqual({
      text: "Ask @Jarvis to help",
      caret: 12,
    });
  });

  it("inserts #channel with trailing space", () => {
    const result = applyAutocomplete("Check #gen", 10, { trigger: "#", start: 6, query: "gen" }, {
      id: "g1",
      name: "general",
      kind: "channel",
      badge: "Channel",
    });
    expect(result).toEqual({
      text: "Check #general ",
      caret: 15,
    });
  });

  it("inserts slash command labels with trailing space", () => {
    const result = applyAutocomplete("/st", 3, { trigger: "/", start: 0, query: "st" }, {
      id: "botfleet:stop",
      name: "stop",
      kind: "command",
      badge: "BotFleet",
      command: {
        id: "botfleet:stop",
        name: "stop",
        label: "/stop",
        title: "Stop",
        description: "Stop the running turn.",
        source: "botfleet",
        invoke: "server",
        clientAction: null,
        args: null,
        availability: "always",
        enabled: true,
        disabledReason: null,
        runsModelTurn: false,
        collidesWith: null,
      },
    });
    expect(result).toEqual({
      text: "/stop ",
      caret: 6,
    });
  });
});
