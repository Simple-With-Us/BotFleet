// The skin guard is a hand-maintained list of names that must correspond to
// directories on disk. It was previously INVERTED — it named exactly the six
// skins whose directories did not exist, so a bot set to blue built a 404 path
// for every GIF and still. It was fixed by hand, which means the next edit
// can put it back.
//
// These tests read the real directory listing, so the two sources cannot drift
// apart without a red build.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SHIPPED_SKINS, tvFaceSkinDir } from "./TVFaceAvatar";
import { TVFACE_EXPRESSIONS } from "./manifest";

const SKINS_DIR = join(process.cwd(), "public", "tv-face", "skins");

const skinsOnDisk = (): string[] =>
  existsSync(SKINS_DIR) ? readdirSync(SKINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  : [];

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
 * The 15-expression list is a contract change: the pack on disk was generated
 * against the old 40-name union, so the renamed expressions have no art yet.
 * These are pinned rather than ignored, so the suite is green today and goes
 * red the moment the pack is regenerated without them.
 */
const AWAITING_PACK_REGENERATION = ["waiting", "error", "alert"] as const;

describe("the expression contract", () => {
  const skins = skinsOnDisk();

  it("has no duplicate expression names", () => {
    expect(TVFACE_EXPRESSIONS.length).toBe(new Set(TVFACE_EXPRESSIONS).size);
  });

  it("is the 15 the pack is specified to ship", () => {
    // The count was previously stated three different ways across the code and
    // the guidelines. It is now derived from this array; pin it so a later
    // addition is a deliberate change rather than an accident.
    expect(TVFACE_EXPRESSIONS).toHaveLength(15);
  });

  it("names only characters that are legal in a file path", () => {
    // "powering-down" was a BotState with a hyphen and "powering_down" an
    // expression with an underscore, which is exactly the kind of drift the
    // single-sourced list exists to prevent.
    for (const e of TVFACE_EXPRESSIONS) {
      expect(e, `expression "${e}" is not a safe filename`).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("has a still for every expression except the ones awaiting regeneration", () => {
    const missing: string[] = [];
    for (const skin of skins) {
      for (const e of TVFACE_EXPRESSIONS) {
        if (!(AWAITING_PACK_REGENERATION as readonly string[]).includes(e)) {
          if (!existsSync(join(SKINS_DIR, skin, "stills", `${e}.png`))) missing.push(`${skin}/${e}.png`);
        }
      }
    }
    expect(missing, `unexpected missing stills: ${missing.join(", ")}`).toEqual([]);
  });

  it("names only the awaiting-regeneration set that is genuinely absent", () => {
    // Fails if someone deletes an entry here without adding the art, and fails
    // once the art lands so the list can be emptied.
    const stillAbsent = AWAITING_PACK_REGENERATION.filter(
      (e) => !existsSync(join(SKINS_DIR, "default", "stills", `${e}.png`)),
    );
    expect([...stillAbsent].sort()).toEqual([...AWAITING_PACK_REGENERATION].sort());
  });
});

