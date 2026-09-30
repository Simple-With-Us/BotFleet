import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The ASCII.dev Box engine's own callout, pinned the way MiniMaxCallout.test.ts
 * pins MiniMax's.
 *
 * `boxAgent` declares exactly one capability (server/drivers/boxagent.ts:
 * `capabilities: { sessionModelSwitch: "in-session" }`), it is excluded from
 * workspaces in server/index.ts, and `respondToRequest` answers
 * "unavailable".  So a bot on this engine really does have no harness tools,
 * no peers, no approval cards, no memory and no skills — and until this
 * callout the app said nothing about it, which made a generic-sounding name the least
 * capable engine in the fleet and the one with the most inviting label.  It is
 * called ASCII.dev Box now, after where it runs.
 *
 * These assertions exist so that stays said.  If the engine ever gains one
 * of those, delete the claim here in the same change that grants it.
 */
const ENGINES_SETTINGS_SRC = readFileSync(join(__dirname, "EnginesSettings.tsx"), "utf8");
const MODEL_PICKER_SRC = readFileSync(join(__dirname, "ModelPicker.tsx"), "utf8");

function engineBox(src: string, needle: string): string {
  const boxStart = src.indexOf(needle);
  expect(boxStart).toBeGreaterThan(-1);
  const boxEnd = src.indexOf("</div>", boxStart);
  return src.slice(boxStart, boxEnd);
}

/** A plain space between sentences collapses to one under HTML whitespace
 * rules, so every boundary must carry the {"  "} marker. */
function expectNoCollapsingSentenceGaps(box: string): void {
  const NBSP_MARKER = '{"  "}';
  for (const m of box.matchAll(/[.;:]\s+([A-Z])/g)) {
    const boundary = m.index!;
    const before = box.slice(0, boundary + 1);
    if (before.trimEnd().endsWith(NBSP_MARKER)) continue;
    throw new Error(
      `Sentence boundary not preceded by the {"\\u00a0 "} marker (will collapse to one space): ` +
        JSON.stringify(box.slice(Math.max(0, boundary - 40), boundary + 20)),
    );
  }
}

describe("ASCII.dev Box engine callout — EnginesSettings row", () => {
  const box = engineBox(ENGINES_SETTINGS_SRC, 'instance.driverKind === "boxAgent"');

  it("names where the turn actually runs", () => {
    expect(box).toMatch(/runs its turn on box\.ascii\.dev/);
    expect(box).toMatch(/not on this computer/);
  });

  it("lists every capability the engine does not have", () => {
    for (const missing of ["no team tools", "no peers to ask", "no approval cards", "no memory", "no skills"]) {
      expect(box).toContain(missing);
    }
  });

  it("tells the reader what to do instead", () => {
    expect(box).toMatch(/Pick another engine/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});

describe("ASCII.dev Box engine callout — ModelPicker rail", () => {
  const box = engineBox(MODEL_PICKER_SRC, 'railInstance.driverKind === "boxAgent"');

  it("says the same thing in one sentence", () => {
    expect(box).toMatch(/This bot runs its turn on box\.ascii\.dev/);
    for (const missing of ["no team tools", "no peers to ask", "no approval cards", "no memory", "no skills"]) {
      expect(box).toContain(missing);
    }
    // one sentence: nothing follows the full stop but the closing tag
    const prose = box.slice(box.indexOf("</strong>") + "</strong>".length).trim();
    expect(prose.match(/\.\s+\S/g) ?? []).toHaveLength(0);
    expect(prose.endsWith(".")).toBe(true);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});
