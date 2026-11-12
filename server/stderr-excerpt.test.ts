import { describe, expect, it } from "vitest";

import { STDERR_EXCERPT_HEAD, STDERR_EXCERPT_TAIL, stderrExcerpt } from "./stderr-excerpt.ts";

describe("stderrExcerpt", () => {
  it("returns short output whole", () => {
    expect(stderrExcerpt("  boom  ")).toBe("boom");
  });

  it("keeps the error sentence when a long tool list follows it", () => {
    // The failure that motivated this: the cause is stated first, then the
    // CLI prints every tool it knows, and the tail alone reads as a list.
    const cause = "Error: too many tools configured for this session.";
    const inventory = Array.from({ length: 400 }, (_, i) => `mcp__server__tool_${i}`).join(", ");
    const excerpt = stderrExcerpt(`${cause} Available: ${inventory}`);
    expect(excerpt.startsWith(cause)).toBe(true);
    expect(excerpt).toContain("characters omitted");
    // and the tail is still there, so the last thing it printed survives
    expect(excerpt.endsWith("mcp__server__tool_399")).toBe(true);
  });

  it("says how much it dropped", () => {
    const text = "x".repeat(STDERR_EXCERPT_HEAD + STDERR_EXCERPT_TAIL + 50);
    expect(stderrExcerpt(text)).toContain("… 50 characters omitted …");
  });

  it("keeps output that exactly fills the budget intact", () => {
    const text = "y".repeat(STDERR_EXCERPT_HEAD + STDERR_EXCERPT_TAIL);
    expect(stderrExcerpt(text)).toBe(text);
    expect(stderrExcerpt(text)).not.toContain("omitted");
  });
});
