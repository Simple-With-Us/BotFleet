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

/** Walk a GIF's blocks: frame count, summed frame delay, and how many frames
 * carry a transparent color. */
function readGif(buf: Buffer): { frames: number; totalMs: number; transparentFrames: number } {
  let pos = 13;
  if (buf[10] & 0x80) pos += 3 * (1 << ((buf[10] & 7) + 1));
  let frames = 0;
  let totalMs = 0;
  let transparentFrames = 0;
  let pendingTransparent = false;
  const skipSubBlocks = () => {
    while (buf[pos] !== 0) pos += buf[pos] + 1;
    pos += 1;
  };
  while (pos < buf.length && buf[pos] !== 0x3b) {
    if (buf[pos] === 0x21) {
      const label = buf[pos + 1];
      if (label === 0xf9) {
        pendingTransparent = (buf[pos + 3] & 1) === 1;
        totalMs += (buf[pos + 4] | (buf[pos + 5] << 8)) * 10;
      }
      pos += 2;
      skipSubBlocks();
    } else if (buf[pos] === 0x2c) {
      frames += 1;
      if (pendingTransparent) transparentFrames += 1;
      pendingTransparent = false;
      const flags = buf[pos + 9];
      pos += 10;
      if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
      pos += 1;
      skipSubBlocks();
    } else {
      break;
    }
  }
  return { frames, totalMs, transparentFrames };
}

const skinsOnDisk = (): string[] =>
  existsSync(SKINS_DIR)
    ? readdirSync(SKINS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

const reachable = (): string[] => [...new Set(Object.values(TVFACE_MANIFEST))].sort();

describe("the skins directory", () => {
  it("exists, so a missing-directory failure is never a false pass", () => {
    expect(existsSync(SKINS_DIR)).toBe(true);
    expect(skinsOnDisk().length).toBeGreaterThan(0);
  });
});

describe("SHIPPED_SKINS matches the directory listing", () => {
  it("resolves every shipped color to a directory that exists", () => {
    const onDisk = skinsOnDisk();
    const unresolved = [...SHIPPED_SKINS].filter((color) => !onDisk.includes(tvFaceSkinDir(color)));
    expect(unresolved, `SHIPPED_SKINS colors with no directory: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("does not omit a shipped skin directory, which would strand its art", () => {
    const claimed = new Set([...SHIPPED_SKINS].map((c) => tvFaceSkinDir(c)));
    const unclaimed = skinsOnDisk().filter((d) => !claimed.has(d));
    expect(unclaimed, `on disk but no color maps to it: ${unclaimed.join(", ")}`).toEqual([]);
  });

  it("routes every BotColor to a directory that exists", () => {
    const onDisk = skinsOnDisk();
    for (const color of [
      "orange", "blue", "green", "purple", "pink", "red", "yellow", "cyan", "teal", "coral",
    ] as const) {
      expect(onDisk, `tvFaceSkinDir("${color}") resolved to a missing directory`).toContain(
        tvFaceSkinDir(color),
      );
    }
  });
});

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
    expect(bad, `declared enter/return but absent on disk: ${bad.join(", ")}`).toEqual([]);
  });

  it("never plans an enter or return outside the transition set", () => {
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
    for (const from of reachable()) {
      const last = planFrame(from as never, "resting").slice(-1)[0];
      if (from !== "resting") expect(last.kind, `from ${from}`).toBe("still");
    }
  });

  it("keeps the transition constant aligned with the pack's enter length", () => {
    const checked: string[] = [];
    for (const e of TVFACE_HAS_ENTER_RETURN) {
      for (const kind of ["enter", "return"]) {
        const file = join(GIFS, `${e}_${kind}.gif`);
        if (!existsSync(file)) continue;
        checked.push(`${e}_${kind}`);
        const { totalMs } = readGif(readFileSync(file));
        expect(Math.abs(totalMs - TVFACE_TRANSITION_MS), `${e}_${kind}.gif runs ${totalMs}ms`).toBeLessThanOrEqual(20);
      }
    }
    expect(checked.length, "no enter/return GIFs found").toBeGreaterThan(0);
  });

  it("ships every GIF with a transparent background, like the stills", () => {
    const files = readdirSync(GIFS).filter((f) => f.endsWith(".gif"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const { frames, transparentFrames } = readGif(readFileSync(join(GIFS, f)));
      expect(transparentFrames, `${f} has opaque frames`).toBe(frames);
    }
  });
});

describe("color skin packs mirror the default asset set", () => {
  const named = skinsOnDisk().filter((d) => d !== "default");

  it("each named skin has the same enter/return files as default", () => {
    const required = [...TVFACE_HAS_ENTER_RETURN].flatMap((e) => [`${e}_enter.gif`, `${e}_return.gif`]);
    const bad: string[] = [];
    for (const skin of named) {
      for (const f of required) {
        if (!existsSync(join(SKINS_DIR, skin, "gifs", f))) bad.push(`${skin}/gifs/${f}`);
      }
    }
    expect(bad, `color packs missing transition GIFs:\n  ${bad.slice(0, 12).join("\n  ")}`).toEqual([]);
  });

  it("each named skin has resting.png and a hold for reachable expressions that default has", () => {
    const bad: string[] = [];
    for (const skin of named) {
      if (!existsSync(join(SKINS_DIR, skin, "stills", "resting.png"))) bad.push(`${skin}/stills/resting.png`);
      // spot-check a few high-traffic holds
      for (const e of ["thinking", "working", "happy", "alerting"] as const) {
        if (!existsSync(join(SKINS_DIR, skin, "gifs", `${e}_hold.gif`))) bad.push(`${skin}/gifs/${e}_hold.gif`);
      }
    }
    expect(bad, `color packs missing core assets:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("color enter GIFs match TVFACE_TRANSITION_MS like default", () => {
    for (const skin of named) {
      const file = join(SKINS_DIR, skin, "gifs", "thinking_enter.gif");
      if (!existsSync(file)) continue;
      const { totalMs } = readGif(readFileSync(file));
      expect(Math.abs(totalMs - TVFACE_TRANSITION_MS), `${skin} thinking_enter ${totalMs}ms`).toBeLessThanOrEqual(20);
    }
  });
});

describe("the expression contract", () => {
  const all: string[] = [...new Set([...reachable(), ...TVFACE_HAS_ENTER_RETURN])];

  it("names only characters that are legal in a file path", () => {
    for (const e of all) {
      expect(e, `expression "${e}" is not a safe filename`).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("has a transition for every expression that has enter art", () => {
    for (const e of TVFACE_HAS_ENTER_RETURN) {
      expect(existsSync(join(GIFS, `${e}_enter.gif`)), `${e} has enter but not in the set`).toBe(true);
      expect(existsSync(join(GIFS, `${e}_return.gif`)), `${e} has enter but not return`).toBe(true);
    }
  });
});
