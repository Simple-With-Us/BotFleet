import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Card subtitles and most copy here render in plain <div>/<span>s, which
// collapse two ASCII spaces to one.  AGENTS.md: the sentence gap is a
// U+00A0 plus a space.
const source = readFileSync(new URL("./LocalVmRuntimeCard.tsx", import.meta.url), "utf8");
const codeLines = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

describe("LocalVmRuntimeCard copy", () => {
  it("uses the non-breaking sentence gap in the Safety and Storage subtitle", () => {
    const lines = codeLines.filter((line) => line.includes("operates only"));
    // One line each for the per-bot and shared-VM variants.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/[a-z0-9)]\. {1,2}[A-Z]/);
    }
    const joined = lines.join("\n");
    expect(joined).toContain("desktop.\\u00a0 Every");
    expect(joined).toContain("replacement.\\u00a0 Viewers");
    expect(joined).toContain("container.\\u00a0 Each");
  });

  it("has no two-ASCII-space sentence gap anywhere a person reads", () => {
    const offenders = codeLines.filter((line) => /[.?!] {2}\S/.test(line));
    expect(offenders).toEqual([]);
  });
});
