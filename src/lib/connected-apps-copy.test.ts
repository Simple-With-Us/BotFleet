import { describe, expect, it } from "vitest";

import { CONNECTED_APPS_HEADING, connectedAppsBlurb } from "./connected-apps-copy";

const state = (over: Partial<Parameters<typeof connectedAppsBlurb>[0]> = {}) =>
  connectedAppsBlurb({ configured: true, canUse: true, enabled: true, ...over });

describe("connectedAppsBlurb", () => {
  it("names Composio in the heading, so the grant is not read as a BotFleet built-in", () => {
    expect(CONNECTED_APPS_HEADING).toBe("Connected Apps via Composio");
  });

  it("names Composio in the enabled state, because a third party holds those accounts", () => {
    expect(state()).toContain("through Composio");
  });

  it("says what the engine-can't state means for reachability, not just that it is unsupported", () => {
    // The engine gate is a real dead end: the toggle is disabled and the bot
    // can reach nothing.  Saying only "cannot use connected apps" reads like a
    // temporary problem; no connected app is *reachable* is the outcome.
    expect(state({ canUse: false })).toBe(
      "This bot's engine cannot call Composio tools, so no connected app is reachable.",
    );
  });

  it("points an unconfigured workspace at the place Composio is configured", () => {
    const blurb = state({ configured: false });
    expect(blurb).toContain("Composio is not set up");
    // `configured` is the service, not the account list: no key at all, as
    // opposed to a configured service with zero accounts attached.
    expect(blurb).toContain("App Settings → Connections");
  });

  it("reads the off state as withholding, matching every other switch in the panel", () => {
    expect(state({ enabled: false })).toBe(
      "Keep every connected Composio account off limits to this bot.",
    );
  });

  it("keeps Composio in every state, so the provider is never left implicit", () => {
    for (const blurb of [
      state(),
      state({ enabled: false }),
      state({ canUse: false }),
      state({ configured: false }),
    ]) {
      expect(blurb).toContain("Composio");
    }
  });
});
