import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  AVATAR_MANIFEST_CHUNK,
  avatarStateFor,
  embedAvatarManifest,
  extractAvatarManifest,
  parseAvatarManifest,
  planAvatarSteps,
  type AvatarManifest,
} from "./avatar-manifest";
import { BOT_AVATAR_CROPS, GROUP_AVATAR_CROPS, avatarCropAfterUpload } from "./bot-avatar";

/** Build a WebP-shaped container so the chunk handling can be exercised
 *  without shipping binary fixtures.  An animated WebP is always extended:
 *  VP8X, then ANIM, then one ANMF per frame. */
function webp(chunks: { fourcc: string; data: Buffer }[]): Buffer {
  let payload = 4;
  for (const chunk of chunks) payload += 8 + chunk.data.length + (chunk.data.length % 2);
  const out = Buffer.alloc(8 + payload);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(payload, 4);
  out.write("WEBP", 8, "latin1");
  let at = 12;
  for (const chunk of chunks) {
    out.write(chunk.fourcc, at, "latin1");
    out.writeUInt32LE(chunk.data.length, at + 4);
    chunk.data.copy(out, at + 8);
    at += 8 + chunk.data.length + (chunk.data.length % 2);
  }
  return out;
}

const EXTENDED = webp([
  { fourcc: "VP8X", data: Buffer.alloc(10, 1) },
  { fourcc: "ANIM", data: Buffer.alloc(6, 2) },
  { fourcc: "ANMF", data: Buffer.alloc(40, 3) },
]);

const MANIFEST: AvatarManifest = {
  formatVersion: 1,
  name: "demo",
  frame: { width: 256, height: 256, count: 130, delayMs: 83 },
  restingFrame: 0,
  states: {
    "*": { hold: { from: 0, to: 29 } },
    working: {
      enter: { from: 31, to: 70 },
      hold: { from: 71, to: 120 },
      return: { from: 121, to: 130 },
    },
  },
};

describe("the manifest chunk", () => {
  it("round trips through the container", () => {
    const out = embedAvatarManifest(EXTENDED, MANIFEST);
    expect(extractAvatarManifest(out)).toEqual(MANIFEST);
  });

  it("keeps the RIFF size field honest", () => {
    const out = embedAvatarManifest(EXTENDED, MANIFEST);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
  });

  it("leaves every other chunk in place, with VP8X still first", () => {
    const out = embedAvatarManifest(EXTENDED, MANIFEST);
    expect(out.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(out.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(out.subarray(12, 16).toString("latin1")).toBe("VP8X");
    expect(out.includes(Buffer.from("ANMF", "latin1"))).toBe(true);
  });

  it("replaces a manifest instead of stacking a second one", () => {
    const once = embedAvatarManifest(EXTENDED, MANIFEST);
    const twice = embedAvatarManifest(once, { ...MANIFEST, name: "demo-2" });
    const count = twice
      .toString("latin1")
      .split(AVATAR_MANIFEST_CHUNK).length - 1;
    expect(count).toBe(1);
    expect(extractAvatarManifest(twice)?.name).toBe("demo-2");
  });

  it("refuses a simple WebP, whose decoder expects its image chunk immediately", () => {
    const simple = webp([{ fourcc: "VP8 ", data: Buffer.alloc(20, 4) }]);
    expect(() => embedAvatarManifest(simple, MANIFEST)).toThrow(/extended WebP/);
  });

  it("returns null for a file with no manifest, and for junk", () => {
    expect(extractAvatarManifest(EXTENDED)).toBeNull();
    expect(extractAvatarManifest(Buffer.from("not a webp at all"))).toBeNull();
    expect(extractAvatarManifest(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for a manifest that does not parse, rather than throwing", () => {
    const broken = webp([
      { fourcc: "VP8X", data: Buffer.alloc(10, 1) },
      { fourcc: AVATAR_MANIFEST_CHUNK, data: Buffer.from("{not json", "utf8") },
    ]);
    expect(extractAvatarManifest(broken)).toBeNull();
  });

  it("reads the manifest out of a real built file", () => {
    // A committed example, built by scripts/avatar-build.ts from the shipped
    // TV-Face art.  Reading it back is the proof that the format survives a
    // real encoder and not only a synthetic container.
    const bytes = readFileSync(
      new URL("../tests/fixtures/avatar/tvface-working-demo.webp", import.meta.url),
    );
    const manifest = extractAvatarManifest(bytes);
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe("tvface-working-demo");
    expect(manifest?.frame).toEqual({ width: 256, height: 256, count: 36, delayMs: 83 });
    expect(manifest?.states["*"].hold).toEqual({ from: 0, to: 35 });
  });
});

describe("parseAvatarManifest", () => {
  it("refuses a manifest that is not shaped like one", () => {
    expect(parseAvatarManifest(JSON.stringify({ ...MANIFEST, formatVersion: 0 }))).toBeNull();
    expect(parseAvatarManifest(JSON.stringify({ ...MANIFEST, name: "" }))).toBeNull();
    expect(
      parseAvatarManifest(
        JSON.stringify({ ...MANIFEST, frame: { width: 0, height: 2, count: 3, delayMs: 80 } }),
      ),
    ).toBeNull();
  });

  it("refuses text that is not JSON at all", () => {
    expect(parseAvatarManifest("not json")).toBeNull();
    expect(parseAvatarManifest("")).toBeNull();
  });

  it("keeps a manifest with no named states, which is a valid resting-only avatar", () => {
    expect(parseAvatarManifest(JSON.stringify({ ...MANIFEST, states: {} }))).not.toBeNull();
  });
});

describe("avatarStateFor", () => {
  it("prefers the exact state over the wildcard", () => {
    expect(avatarStateFor(MANIFEST, "working")?.enter).toEqual({ from: 31, to: 70 });
  });

  it("falls back to the wildcard, then to nothing", () => {
    expect(avatarStateFor(MANIFEST, "thinking")?.hold).toEqual({ from: 0, to: 29 });
    const noWildcard: AvatarManifest = { ...MANIFEST, states: { working: {} } };
    expect(avatarStateFor(noWildcard, "thinking")).toBeNull();
  });
});

describe("planAvatarSteps", () => {
  it("plays the old state's return before the new state's enter", () => {
    const steps = planAvatarSteps(MANIFEST, "working", "thinking");
    expect(steps.map((step) => step.reason)).toEqual(["return", "hold"]);
    // A 130 frame file has frames 0..129, so the declared end of 130 is
    // clamped to the last real frame rather than pointing past it.
    expect(steps[0].range).toEqual({ from: 121, to: 129 });
  });

  it("plays enter once, then loops the hold", () => {
    const steps = planAvatarSteps(MANIFEST, "thinking", "working");
    expect(steps.map((step) => step.reason)).toEqual(["enter", "hold"]);
    expect(steps[0].mode).toBe("once");
    expect(steps[1].mode).toBe("loop");
  });

  it("rests on the resting frame when a state has no hold", () => {
    const noHold: AvatarManifest = {
      ...MANIFEST,
      states: { working: { enter: { from: 31, to: 70 } } },
    };
    const steps = planAvatarSteps(noHold, "thinking", "working");
    const rest = steps.find((step) => step.reason === "resting");
    expect(rest?.range).toEqual({ from: 0, to: 0 });
  });

  it("entering the same state again only loops the hold", () => {
    const steps = planAvatarSteps(MANIFEST, "working", "working");
    expect(steps.map((step) => step.reason)).toEqual(["hold"]);
  });

  it("clamps a range that points past the last frame", () => {
    const over: AvatarManifest = {
      ...MANIFEST,
      states: { "*": { hold: { from: 0, to: 900 } } },
    };
    const steps = planAvatarSteps(over, null, "thinking");
    expect(steps[0].range).toEqual({ from: 0, to: 129 });
  });
});

describe("the animated crop", () => {
  it("is offered for bots and not for groups", () => {
    expect(BOT_AVATAR_CROPS).toContain("animated");
    expect(GROUP_AVATAR_CROPS).not.toContain("animated");
  });

  it("falls back to a circle when a plain image is uploaded over it", () => {
    expect(avatarCropAfterUpload("animated")).toBe("circle");
  });
});

/**
 * The built examples that ship with the repository.
 *
 * These are real files, built by `scripts/avatar-build.ts` out of the shipped
 * TV-Face art, so the tests here read the same bytes a browser would read.
 * A fixture that is only a shape in a test would prove the reader works; a
 * real file proves the writer and the reader agree.
 */
describe("the built examples", () => {
  const fixture = (name: string): Buffer =>
    readFileSync(new URL(`../tests/fixtures/avatar/${name}`, import.meta.url));

  it("carries its manifest inside the file it ships as", () => {
    const manifest = extractAvatarManifest(fixture("tvface-working-demo.webp"));
    expect(manifest?.name).toBe("tvface-working-demo");
    expect(manifest?.frame).toEqual({ width: 256, height: 256, count: 36, delayMs: 83 });
  });

  it("matches the manifest written next to it", () => {
    for (const name of ["tvface-working-demo", "tvface-three-part-demo"]) {
      const beside = JSON.parse(
        fixture(`${name}.manifest.json`).toString("utf8"),
      ) as AvatarManifest;
      expect(extractAvatarManifest(fixture(`${name}.webp`))).toEqual(beside);
    }
  });

  it("is an extended WebP, because a manifest cannot ride in a simple one", () => {
    const bytes = fixture("tvface-working-demo.webp");
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("VP8X");
  });

  it("plans the enter, the hold and the return of the three part example", () => {
    const manifest = extractAvatarManifest(fixture("tvface-three-part-demo.webp"));
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // The example declares four segments across its frames: a resting loop
    // under the wildcard, then the enter, the hold and the return of working.
    //
    // The file holds 152 frames and not the 155 the source folder held,
    // because the encoder stores a frame that looks exactly like the one
    // before it once, holding it for twice as long.  The three seams between
    // the four segments are exactly such a pair, so the file folds three
    // times and the build tool maps the author's frame numbers onto the
    // frames that are really there.
    expect(manifest.frame.count).toBe(152);
    expect(manifest.states["*"]?.hold).toEqual({ from: 0, to: 35 });
    expect(manifest.states.working?.enter).toEqual({ from: 35, to: 58 });
    expect(manifest.states.working?.hold).toEqual({ from: 58, to: 128 });
    expect(manifest.states.working?.return).toEqual({ from: 128, to: 151 });

    // Every range has to land inside the frames the file holds, or the
    // player asks the decoder for a frame that is not there.
    const last = manifest.frame.count - 1;
    for (const entry of Object.values(manifest.states)) {
      for (const range of [entry.enter, entry.hold, entry.return]) {
        if (!range) continue;
        expect(range.from).toBeGreaterThanOrEqual(0);
        expect(range.to).toBeLessThanOrEqual(last);
      }
    }

    // Leaving the resting state for working plays the enter and then the hold.
    const working = planAvatarSteps(manifest, null, "working");
    expect(working.map((step) => step.reason)).toEqual(["enter", "hold"]);

    // Leaving working plays the return and then the wildcard's resting loop.
    const resting = planAvatarSteps(manifest, "working", "idle");
    expect(resting.map((step) => step.reason)).toEqual(["return", "hold"]);
  });
});
