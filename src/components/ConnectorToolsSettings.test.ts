import { describe, expect, it } from "vitest";

import { connectorSlugLinesFrom, parseConnectorSlugLines } from "./ConnectorToolsSettings";

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
