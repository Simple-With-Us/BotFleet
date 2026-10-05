import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Card subtitles and most copy here render in plain <div>/<span>s, which
// collapse two ASCII spaces to one.  AGENTS.md: the sentence gap is a
// U+00A0 plus a space.
const source = readFileSync(new URL("./LocalVmRuntimeCard.tsx", import.meta.url), "utf8");
const codeLines = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

describe("LocalVmRuntimeCard runtime UX", () => {
  it("keeps action errors visible until dismissed and times out status checks", () => {
    expect(source).toContain("PersistentActionErrorCard");
    expect(source).toContain("actionError");
    const refreshBlock = source.match(/const refresh = useCallback[\s\S]*?\], \[\]\);/)?.[0] ?? "";
    expect(refreshBlock).not.toContain("setActionError");
    expect(source).not.toContain("productErrorHeadline");
    expect(source).toContain("STATUS_TIMEOUT_MS = 15_000");
    expect(source).not.toContain('void act("start")');
  });
});

describe("LocalVmRuntimeCard copy", () => {
  it("uses the non-breaking sentence gap in the Safety and Storage subtitle", () => {
    const lines = codeLines.filter((line) => line.includes("Computer Driver operates only"));
    // One line each for the per-bot and shared-VM variants.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/[a-z0-9)]\. {1,2}[A-Z]/);
    }
    const joined = lines.join("\n");
    expect(joined).toContain("desktop.\\u00a0 Every");
    expect(joined).toContain("replacement.\\u00a0 Viewers");
    expect(joined).toContain("capabilities.\\u00a0 VMs");
    expect(joined).toContain("needs.\\u00a0 The VM");
  });

  it("has no two-ASCII-space sentence gap anywhere a person reads", () => {
    const offenders = codeLines.filter((line) => /[.?!] {2}\S/.test(line));
    expect(offenders).toEqual([]);
  });
});
