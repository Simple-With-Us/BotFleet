import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import {
  CONNECTOR_TOOLS_HEADING,
  ConnectorToolsSettings,
  connectorSlugLinesFrom,
  parseConnectorSlugLines,
} from "./ConnectorToolsSettings";

/** Only `connectorTools` decides which state this card renders, so a bot
 * literal is enough to drive both branches.  The cast is safe because the card
 * reads no other bot field — asserted by the two render cases below, which fail
 * loudly if that ever stops being true. */
const markup = (connectorTools: Bot["connectorTools"]) =>
  renderToStaticMarkup(
    createElement(ConnectorToolsSettings, {
      // SAFETY: partial bot literal; the component reads only connectorTools.
      bot: { connectorTools } as Bot,
      onPatch: () => {},
    }),
  );

const restricted = markup({ gmail: { tools: "*" }, slack: { tools: "*" } });
const unrestricted = markup(undefined);

describe("parseConnectorSlugLines", () => {
  it("reads one slug per line, trimmed and lowercased", () => {
    expect(parseConnectorSlugLines("gmail\n  GitHub  \nslack")).toEqual(["gmail", "github", "slack"]);
  });

  it("also splits on commas, and dedupes in first-seen order", () => {
    expect(parseConnectorSlugLines("gmail, github\ngmail\nslack")).toEqual(["gmail", "github", "slack"]);
  });

  it("drops blank lines and anything that is not a valid slug", () => {
    expect(parseConnectorSlugLines("\n\ngmail\n  \nNOT_A_SLUG!\ngithub\n")).toEqual(["gmail", "github"]);
  });

  it("returns an empty list for a blank box — the fail-closed 'block everything' state", () => {
    expect(parseConnectorSlugLines("")).toEqual([]);
    expect(parseConnectorSlugLines("   \n  \n")).toEqual([]);
  });
});

describe("connectorSlugLinesFrom", () => {
  it("renders no grants as an empty box", () => {
    expect(connectorSlugLinesFrom(undefined)).toBe("");
    expect(connectorSlugLinesFrom(null)).toBe("");
  });

  it("renders every granted service, one per line, sorted", () => {
    expect(connectorSlugLinesFrom({ slack: { tools: "*" }, gmail: { tools: ["GMAIL_SEND_EMAIL"] } })).toBe(
      "gmail\nslack",
    );
  });

  it("renders the empty-grants (block everything) record as an empty box, same as no grants", () => {
    expect(connectorSlugLinesFrom({})).toBe("");
  });

  it("round-trips through parseConnectorSlugLines", () => {
    const grants = { gmail: { tools: "*" as const }, github: { tools: "*" as const } };
    // connectorSlugLinesFrom sorts alphabetically — "github" < "gmail" (the
    // second letter i < m) — so that's the order this round trip preserves.
    expect(parseConnectorSlugLines(connectorSlugLinesFrom(grants))).toEqual(["github", "gmail"]);
  });
});

describe("ConnectorToolsSettings copy", () => {
  it("names the switch as a restriction, so a lit toggle cannot read as a grant", () => {
    // The card used to be titled "Connected App Access" directly under
    // "Connected Apps", with both toggles lit: a lit second switch that meant
    // *less* access was the one state the switch position could not convey.
    expect(CONNECTOR_TOOLS_HEADING).toBe("Restrict To Specific Apps");
  });

  it("spells out both directions of the toggle, in both states", () => {
    expect(restricted).toContain("can use only the Composio apps listed below");
    expect(restricted).toContain("Turn this off to give this bot all connected apps");
    expect(unrestricted).toContain("can use every connected Composio app");
    expect(unrestricted).toContain("Turn this on to pick exactly which apps it may use");
  });

  it("points at the card name to type, and says blank means block-all", () => {
    expect(restricted).toContain("name shown on its card in Connected Apps");
    expect(restricted).toContain("Leave this blank to block every connected app");
  });

  it("shows the granted list, and hides the editor entirely when unrestricted", () => {
    expect(restricted).toContain("<textarea");
    expect(restricted).toContain("gmail");
    expect(restricted).toContain("slack");
    // Unrestricted grants everything, so an empty allowlist box would read as
    // "nothing" rather than "no restriction" — the editor has no meaning there.
    expect(unrestricted).not.toContain("<textarea");
  });
});
