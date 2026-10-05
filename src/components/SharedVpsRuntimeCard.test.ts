import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sharedVpsCardMode } from "./SharedVpsRuntimeCard";

// Card copy renders in plain <div>s, which collapse two ASCII spaces to
// one. AGENTS.md: the sentence gap is a U+00A0 plus a space.
const source = readFileSync(new URL("./SharedVpsRuntimeCard.tsx", import.meta.url), "utf8");
const codeLines = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

describe("sharedVpsCardMode", () => {
  it("hides only when no VPS is configured", () => {
    expect(sharedVpsCardMode(false, "shared")).toBe("hidden");
    expect(sharedVpsCardMode(false, "per-bot")).toBe("hidden");
    expect(sharedVpsCardMode(false, null)).toBe("hidden");
  });

  it("shows the live panel in shared mode and a caption in per-bot mode", () => {
    // Per-bot is a live server mode: the card must say so, not paint
    // nothing (the BF-Designer finding on #700).
    expect(sharedVpsCardMode(true, "shared")).toBe("shared");
    expect(sharedVpsCardMode(true, "per-bot")).toBe("per-bot");
    expect(sharedVpsCardMode(true, null)).toBe("per-bot");
  });
});

describe("the per-bot caption", () => {
  it("names the mode and where to change it", () => {
    expect(source).toContain("Per-bot mode");
    expect(source).toContain("botDefaults.vpsMode");
    expect(source).toContain("Sync CLI Credentials");
    expect(source).toContain("Computer panel");
  });

  it("has no two-ASCII-space sentence gap anywhere a person reads", () => {
    const offenders = codeLines.filter((line) => /[.?!] {2}\S/.test(line));
    expect(offenders).toEqual([]);
  });
});

// The check above only forbids the wrong gap; it cannot catch a gap that
// was DELETED, because a single space passes it. #810 shipped exactly
// that: "…for each bot. Bots share…" left main with a plain space, and
// Deployer's read of it in review looked identical to a fix. Every
// sentence boundary a person reads here must carry the real gap.
describe("the sentence gap is present, not merely not-doubled", () => {
  const boundaries: Array<[string, string]> = [
    ["per-bot caption", "own VPS container.{\"\\u00a0 \"}Use"],
    ["per-bot sync hint", "bot&apos;s container.{\"\\u00a0 \"}The VPS mode"],
    ["shared subtitle", "for each bot.{\"\\u00a0 \"}Bots share"],
    ["runtime error", "inspect the VPS runtime.{\"\\u00a0 \"}{error}"],
    ["disabled notice", "in workspace providers.\\u00a0 Turn it on"],
  ];

  for (const [label, expected] of boundaries) {
    it(`${label} carries U+00A0 plus a space`, () => {
      expect(source).toContain(expected);
    });
  }

  it("has no sentence boundary left as a single ASCII space", () => {
    // A period/question mark followed by exactly one ASCII space and a
    // capital, where the next non-space char is not a tag or expression.
    const offenders = codeLines.filter((line) => /[a-z0-9)][.?!] [A-Z][a-z]/.test(line));
    expect(offenders).toEqual([]);
  });
});
