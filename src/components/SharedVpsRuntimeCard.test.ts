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
  });

  it("has no two-ASCII-space sentence gap anywhere a person reads", () => {
    const offenders = codeLines.filter((line) => /[.?!] {2}\S/.test(line));
    expect(offenders).toEqual([]);
  });
});
