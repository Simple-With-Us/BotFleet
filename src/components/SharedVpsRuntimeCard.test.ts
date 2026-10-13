import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { formatBuildElapsed, sharedVpsCardMode, sharedVpsImageAction, sharedVpsStatusLabel } from "./SharedVpsRuntimeCard";

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
    // An expression, not a quoted attribute: JSX does not process escapes in
    // `subtitle="..."`, and the plain substring alone passed while it did not.
    ["shared subtitle", "subtitle={\"The shared Linux sandbox running on your VPS, with a separate desktop for each bot.\\u00a0 Bots share"],
    ["runtime error", "inspect the VPS runtime.{\"\\u00a0 \"}{error}"],
    ["disabled notice", "in workspace providers.\\u00a0 Turn it on"],
    ["build progress", "so far.{\"\\u00a0 \"}"],
    ["prepare hint", "Prepare the new image first.\\u00a0 It builds"],
    ["switch hint", "The new image is ready.\\u00a0 Switching replaces"],
    ["switch confirm", "about a minute.\\u00a0 \" +"],
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

describe("a container on an older image", () => {
  it("is never labelled a clean Running", () => {
    expect(sharedVpsStatusLabel({ container: "running", imageOutdated: true })).toEqual({
      label: "Running (outdated image)",
      tone: "warn",
    });
    expect(sharedVpsStatusLabel({ container: "stopped", imageOutdated: true }).label).toBe("Stopped (outdated image)");
    expect(sharedVpsStatusLabel({ container: "running", imageOutdated: false })).toEqual({ label: "Running", tone: "ok" });
    // an older harness sends no imageOutdated; that is not outdated
    expect(sharedVpsStatusLabel({ container: "running" }).label).toBe("Running");
    expect(sharedVpsStatusLabel({ container: "missing" }).label).toBe("Missing");
  });

  it("offers Prepare Image, then progress, then Switch to New Image", () => {
    const base = { container: "running" as const, imageOutdated: true };
    expect(sharedVpsImageAction({ ...base, image: false })).toBe("prepare");
    expect(
      sharedVpsImageAction({ ...base, image: false, imageBuild: { phase: "failed", startedAt: 1, elapsedMs: null, error: "x" } }),
    ).toBe("prepare");
    expect(
      sharedVpsImageAction({ ...base, image: false, imageBuild: { phase: "building", startedAt: 1, elapsedMs: 5, error: null } }),
    ).toBe("building");
    expect(sharedVpsImageAction({ ...base, image: true })).toBe("switch");
    expect(sharedVpsImageAction({ container: "running", image: true, imageOutdated: false })).toBe("none");
  });

  it("leaves a missing container to the provision flow, showing only a running build", () => {
    expect(sharedVpsImageAction({ container: "missing", image: false })).toBe("none");
    expect(
      sharedVpsImageAction({
        container: "missing",
        image: false,
        imageBuild: { phase: "building", startedAt: 1, elapsedMs: 5, error: null },
      }),
    ).toBe("building");
  });

  it("formats the build's elapsed time", () => {
    expect(formatBuildElapsed(null)).toBe("0s");
    expect(formatBuildElapsed(42_000)).toBe("42s");
    expect(formatBuildElapsed(185_000)).toBe("3m 05s");
    expect(formatBuildElapsed(3_720_000)).toBe("1h 02m");
  });
});
