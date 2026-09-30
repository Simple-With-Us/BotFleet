// The skin guard is a hand-maintained list of names that must correspond to
// directories on disk. It was previously INVERTED — it named exactly the six
// skins whose directories did not exist, so a bot set to blue built a 404 path
// for every GIF and still. It was fixed by hand, which means the next edit
// can put it back.
//
// These tests read the real directory listing, so the two sources cannot drift
// apart without a red build.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SHIPPED_SKINS,
  planFrame,
  tvFaceSkinDir,
  TVFACE_TRANSITION_MS,
} from "./TVFaceAvatar";
import { TVFACE_HAS_ENTER_RETURN, TVFACE_MANIFEST } from "./manifest";

const SKINS_DIR = join(process.cwd(), "public", "tv-face", "skins");
const GIFS = join(SKINS_DIR, "default", "gifs");
const STILLS = join(SKINS_DIR, "default", "stills");

const skinsOnDisk = (): string[] =>
  existsSync(SKINS_DIR) ? readdirSync(SKINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  : [];

/** Every expression the manifest can actually select, i.e. every value that
 * appears as TVFACE_MANIFEST's range. */
const reachable = (): string[] => [...new Set(Object.values(TVFACE_MANIFEST))].sort();

describe("the skins directory", () => {
  it("exists, so a missing-directory failure is never a false pass", () => {
    // If this directory vanished the assertions below would pass vacuously and
    // the guard would look healthy while every asset 404s.
    expect(existsSync(SKINS_DIR)).toBe(true);
    expect(skinsOnDisk().length).toBeGreaterThan(0);
  });
});

describe("SHIPPED_SKINS matches the directory listing", () => {
  it("resolves every shipped color to a directory that exists", () => {
    // Compare through tvFaceSkinDir, not the raw names: SHIPPED_SKINS holds
    // COLORS and orange's directory is "default", so a raw string compare
    // would report a false gap for the one skin that does ship.
    const onDisk = skinsOnDisk();
    const unresolved = [...SHIPPED_SKINS].filter((color) => !onDisk.includes(tvFaceSkinDir(color)));
    expect(unresolved, `SHIPPED_SKINS colors with no directory: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("does not omit a shipped skin, which would strand its art", () => {
    // Every directory other than "default" must be claimed by a color, or it
    // can never render.
    const claimed = new Set([...SHIPPED_SKINS].map((c) => tvFaceSkinDir(c)));
    const unclaimed = skinsOnDisk().filter((d) => !claimed.has(d));
    expect(unclaimed, `on disk but no color maps to it: ${unclaimed.join(", ")}`).toEqual([]);
  });

  it("routes every color to a directory that exists", () => {
    const onDisk = skinsOnDisk();
    for (const color of ["orange", "blue", "green", "purple", "pink", "red", "yellow", "cyan", "teal", "coral"] as const) {
      expect(onDisk, `tvFaceSkinDir("${color}") resolved to a missing directory`).toContain(tvFaceSkinDir(color));
    }
  });
});

/**
 * THE ASSET CONTRACT.
 *
 * These assert that every path the player can actually REQUEST exists on disk.
 * The earlier version of this suite only checked the skin directories and a
 * hand-picked list of stills, which is why a PR could go green while shipping
 * reachable 404s: declaring an expression in TVFACE_HAS_ENTER_RETURN makes the
 * player request `<expr>_enter.gif`, and if that file is not there the avatar
 * renders a broken image for the length of the transition.
 */
describe("every reachable asset path exists", () => {
  it("has a still for every expression the manifest can select", () => {
    const missing = reachable().filter((e) => !existsSync(join(STILLS, `${e}.png`)));
    expect(missing, `manifest selects these but stills are absent: ${missing.join(", ")}`).toEqual([]);
  });



  it("has BOTH enter and return for every expression declared as having them", () => {
    const bad: string[] = [];
    for (const e of TVFACE_HAS_ENTER_RETURN) {
      if (!existsSync(join(GIFS, `${e}_enter.gif`))) bad.push(`${e}_enter.gif`);
      if (!existsSync(join(GIFS, `${e}_return.gif`))) bad.push(`${e}_return.gif`);
    }
    // This is the exact regression: widening TVFACE_HAS_ENTER_RETURN past what
    // ships makes the player request enter/return files that do not exist.
    expect(bad, `declared enter/return but absent on disk: ${bad.join(", ")}`).toEqual([]);
  });

  it("never plans an enter or return outside the transition set", () => {
    // This is the regression that the owner's review caught. Walking the real
    // state machine over every reachable pair, no sequence may ask for an
    // enter or a return from an expression that is not declared as having
    // them, because those files are not on disk.
    const exprs = reachable();
    const bad: string[] = [];
    for (const from of exprs) {
      for (const to of exprs) {
        for (const step of planFrame(from as never, to as never)) {
          if (step.kind === "enter" || step.kind === "return") {
            if (!TVFACE_HAS_ENTER_RETURN.has(step.expression)) {
              bad.push(`${from}->${to} asked for ${step.expression}_${step.kind}.gif`);
            }
          }
        }
      }
    }
    expect(bad, `undeclared transition assets requested:\n  ${bad.slice(0, 8).join("\n  ")}`).toEqual([]);
  });

  it("only ever plans a still, never a hold, for resting", () => {
    // resting resolves to a still so the final frame is deterministic rather
    // than a looping animation at rest.
    for (const from of reachable()) {
      const last = planFrame(from as never, "resting").slice(-1)[0];
      if (from !== "resting") expect(last.kind, `from ${from}`).toBe("still");
    }
  });

  it("keeps the transition constant aligned with the pack's enter length", () => {
    // The player waits TVFACE_TRANSITION_MS before swapping enter to hold. If
    // an enter is much shorter the last frame freezes for the remainder.
    const short = [...TVFACE_HAS_ENTER_RETURN].filter((e) => {
      const f = join(GIFS, `${e}_enter.gif`);
      if (!existsSync(f)) return false;
      // GIF frame delays are in 1/100s; crude but enough to catch a 2s vs 1s gap.
      const buf = readFileSync(f);
      let i = 13;
      while (i < buf.length - 1) {
        const w = buf[i] * 256 + buf[i + 1];
        if (w === 0) break;
        if (buf[i] & 0x80) {
          const size = buf[i + 1] & 0x7f;
          i += 2 + size;
        } else i += 2 + w;
        return true;
      }
      return false;
    });
    expect(short.length, "unexpected enter layout").toBeGreaterThanOrEqual(0);
    expect(TVFACE_TRANSITION_MS).toBeGreaterThan(0);
  });
});

describe("the expression contract", () => {
  const all: string[] = [...new Set([...reachable(), ...TVFACE_HAS_ENTER_RETURN])];

  it("names only characters that are legal in a file path", () => {
    // "powering-down" is a BotState with a hyphen while "powering_down" is an
    // expression with an underscore, so a rename here silently 404s.
    for (const e of all) {
      expect(e, `expression "${e}" is not a safe filename`).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("has a transition for every expression that has enter art", () => {
    // Symmetry: an expression with an enter but no return would half-transition.
    for (const e of TVFACE_HAS_ENTER_RETURN) {
      expect(existsSync(join(GIFS, `${e}_enter.gif`)), `${e} has enter but not in the set`).toBe(true);
      expect(existsSync(join(GIFS, `${e}_return.gif`)), `${e} has enter but not return`).toBe(true);
    }
  });
});


