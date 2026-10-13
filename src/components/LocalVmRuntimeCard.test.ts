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
    expect(source).toContain("STATUS_TIMEOUT_MS = 40_000");
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

  // JSX text collapses runs of ASCII spaces, so two spaces render as one.  The
  // gap is a real U+00A0 plus a space, written as the visible escape so a
  // reviewer (or a linter) can see it is not a bare space.
  it("separates the slow-runtime sentences with a non-breaking gap, written as the escape", () => {
    const lines = codeLines.filter((line) => line.includes("did not answer in time"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('busy.{"\\u00a0 "}BotFleet keeps checking.');
  });

  it("never glues two sentences with a single JSX space or a literal U+00A0", () => {
    const bareSpace = codeLines.filter((line) => /[.?!]\{" "\}[A-Z]/.test(line));
    expect(bareSpace).toEqual([]);
    const literalNbsp = source.split("\n").filter((line) => line.includes("\u00a0"));
    expect(literalNbsp).toEqual([]);
  });
});
