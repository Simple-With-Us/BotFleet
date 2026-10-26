import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  collectFrameFiles,
  inspectAvatar,
  mapSourceFramesToEncoded,
  readEncodedFrames,
  readPngSize,
  translateManifestToEncoded,
  validateManifestAgainstFrames,
} from "./avatar-build.ts";

/* A minimal PNG writer, so the test does not depend on a shipped asset and
 * can make a frame of any size it needs. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function png(width, height, tint = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 4;
      raw[px] = 40 + tint;
      raw[px + 1] = 90;
      raw[px + 2] = 200;
      raw[px + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hasTool(name) {
  try {
    execFileSync(name, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MANIFEST = {
  formatVersion: 1,
  name: "demo",
  frame: { width: 256, height: 256, count: 36, delayMs: 83 },
  restingFrame: 0,
  states: { "*": { hold: { from: 0, to: 35 } } },
};

describe("readPngSize", () => {
  it("reads the size out of the IHDR chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      const path = join(dir, "a.png");
      writeFileSync(path, png(320, 240));
      expect(readPngSize(path)).toEqual({ width: 320, height: 240 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not a PNG", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      const path = join(dir, "a.png");
      writeFileSync(path, "not a png");
      expect(() => readPngSize(path)).toThrow(/not a PNG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectFrameFiles", () => {
  it("keeps the images and drops everything else, in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      writeFileSync(join(dir, "02.png"), png(2, 2));
      writeFileSync(join(dir, "01.png"), png(2, 2));
      writeFileSync(join(dir, "notes.txt"), "hello");
      const files = collectFrameFiles(dir).map((path) => path.split("/").pop());
      expect(files).toEqual(["01.png", "02.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateManifestAgainstFrames", () => {
  it("accepts a manifest that matches the frames", () => {
    expect(validateManifestAgainstFrames(MANIFEST, 36, { width: 256, height: 256 })).toEqual([]);
  });

  it("objects when the frame count disagrees", () => {
    const problems = validateManifestAgainstFrames(MANIFEST, 30, { width: 256, height: 256 });
    expect(problems.join(" ")).toMatch(/36 frames but the folder holds 30/);
  });

  it("objects when a range runs past the last frame", () => {
    const over = {
      ...MANIFEST,
      states: { "*": { hold: { from: 0, to: 36 } } },
    };
    const problems = validateManifestAgainstFrames(over, 36, { width: 256, height: 256 });
    expect(problems.join(" ")).toMatch(/run past the last frame/);
    expect(problems.join(" ")).toMatch(/0-35/);
  });

  it("objects when the source size is not the declared size", () => {
    const problems = validateManifestAgainstFrames(MANIFEST, 36, { width: 480, height: 480 });
    expect(problems.join(" ")).toMatch(/480x480/);
  });

  it("objects when the resting frame is past the end", () => {
    const over = { ...MANIFEST, restingFrame: 40 };
    const problems = validateManifestAgainstFrames(over, 36, { width: 256, height: 256 });
    expect(problems.join(" ")).toMatch(/restingFrame 40/);
  });
});

describe("inspectAvatar", () => {
  it("says plainly when a file carries no manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      const path = join(dir, "plain.webp");
      writeFileSync(path, Buffer.from("RIFFxxxxWEBPnot really"));
      expect(inspectAvatar(path)).toMatch(/no embedded manifest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mapSourceFramesToEncoded", () => {
  it("maps every source frame onto the frame the file holds", () => {
    // Three ordinary frames, then one that looks exactly like the one before
    // it and is stored once with a longer duration, then one more.  The
    // durations add up to six frames.
    const mapping = mapSourceFramesToEncoded([83, 83, 166, 83, 83], 83, 6);
    expect(mapping.encodedCount).toBe(5);
    expect(mapping.map).toEqual([0, 1, 2, 2, 3, 4]);
    expect(mapping.folded).toEqual([3]);
  });

  it("folds every frame of a held pose", () => {
    // A hold that holds one pose for three frames is two folds.
    const mapping = mapSourceFramesToEncoded([83, 249, 83], 83, 5);
    expect(mapping.encodedCount).toBe(3);
    expect(mapping.map).toEqual([0, 1, 1, 1, 2]);
    expect(mapping.folded).toEqual([2, 3]);
  });

  it("refuses when the file's timing does not add up to the folder", () => {
    expect(() => mapSourceFramesToEncoded([83, 83], 83, 5)).toThrow(/the folder holds 5/);
  });

  it("refuses a duration that is not a whole number of frames", () => {
    expect(() => mapSourceFramesToEncoded([83, 90], 83, 2)).toThrow(/whole number of 83 ms/);
  });
});

describe("translateManifestToEncoded", () => {
  const mapping = mapSourceFramesToEncoded([83, 166, 83, 83], 83, 5);

  it("counts the frames the file holds, not the frames the folder held", () => {
    const translated = translateManifestToEncoded(
      { ...MANIFEST, frame: { ...MANIFEST.frame, count: 5 } },
      mapping,
    );
    expect(translated.frame.count).toBe(4);
  });

  it("moves every range onto the frames that are really there", () => {
    const translated = translateManifestToEncoded(
      {
        ...MANIFEST,
        frame: { ...MANIFEST.frame, count: 5 },
        states: {
          "*": { hold: { from: 0, to: 1 } },
          working: { enter: { from: 2, to: 2 }, hold: { from: 3, to: 4 } },
        },
      },
      mapping,
    );
    // Source 2 and source 3 are the same picture, stored once, so the enter
    // range collapses onto that one frame.
    expect(translated.states["*"].hold).toEqual({ from: 0, to: 1 });
    expect(translated.states.working.enter).toEqual({ from: 1, to: 1 });
    expect(translated.states.working.hold).toEqual({ from: 2, to: 3 });
  });

  it("moves the resting frame too", () => {
    const translated = translateManifestToEncoded(
      { ...MANIFEST, frame: { ...MANIFEST.frame, count: 5 }, restingFrame: 3 },
      mapping,
    );
    expect(translated.restingFrame).toBe(2);
  });
});

describe("readEncodedFrames", () => {
  it("says a plain file holds no animated frames", () => {
    expect(() => readEncodedFrames(Buffer.from("RIFFxxxxWEBPnot really"))).toThrow(
      /no animated frames/,
    );
  });

  it("refuses a file that is not RIFF at all", () => {
    expect(() => readEncodedFrames(Buffer.from("not a riff file"))).toThrow(/not a RIFF file/);
  });
});

describe("the whole build", () => {
  const toolchain = hasTool("ffmpeg") && hasTool("img2webp");
  it.skipIf(!toolchain)(
    "turns a folder of frames into one animated file with the manifest inside",
    async () => {
      const { buildAvatar } = await import("./avatar-build.ts");
      const dir = mkdtempSync(join(tmpdir(), "avatar-build-test-"));
      try {
        const frames = join(dir, "frames");
        mkdirSync(frames);
        for (let i = 1; i <= 6; i++) {
          writeFileSync(join(frames, `${String(i).padStart(2, "0")}.png`), png(64, 64, i * 20));
        }
        const manifestPath = join(dir, "avatar.json");
        writeFileSync(
          manifestPath,
          JSON.stringify({
            ...MANIFEST,
            frame: { ...MANIFEST.frame, count: 6 },
            states: { "*": { hold: { from: 0, to: 5 } } },
          }),
        );
        const out = join(dir, "out.webp");
        const result = buildAvatar({ framesDir: frames, manifestPath, out });
        expect(result.sourceFrameCount).toBe(6);
        expect(result.encodedFrameCount).toBe(6);
        expect(result.folded).toEqual([]);
        expect(result.outputSize).toEqual({ width: 256, height: 256 });
        expect(result.bytes).toBeGreaterThan(0);

        // The manifest is inside the file, not beside it.
        const bytes = readFileSync(out);
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
        expect(inspectAvatar(out)).toMatch(/demo \(format 1\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!toolchain)(
    "maps the manifest onto the frames when the encoder folds a frame away",
    async () => {
      const { buildAvatar } = await import("./avatar-build.ts");
      const dir = mkdtempSync(join(tmpdir(), "avatar-build-fold-"));
      try {
        const frames = join(dir, "frames");
        mkdirSync(frames);
        // The third and the fourth frame look exactly the same, so the
        // encoder stores one of them once, holding it for twice as long.
        const tints = [20, 40, 60, 60, 100];
        tints.forEach((tint, index) => {
          writeFileSync(
            join(frames, `${String(index + 1).padStart(2, "0")}.png`),
            png(64, 64, tint),
          );
        });
        const manifestPath = join(dir, "avatar.json");
        writeFileSync(
          manifestPath,
          JSON.stringify({
            ...MANIFEST,
            frame: { ...MANIFEST.frame, count: 5 },
            states: { "*": { hold: { from: 0, to: 4 } } },
          }),
        );
        const out = join(dir, "out.webp");
        const result = buildAvatar({ framesDir: frames, manifestPath, out });

        expect(result.sourceFrameCount).toBe(5);
        expect(result.encodedFrameCount).toBe(4);
        expect(result.folded).toEqual([3]);

        // The manifest inside the file counts what the file holds, so the
        // player never asks the decoder for a frame that is not there.
        expect(result.manifest.frame.count).toBe(4);
        expect(result.manifest.states["*"].hold).toEqual({ from: 0, to: 3 });
        expect(inspectAvatar(out)).toMatch(/the file holds 4 frames, which matches the manifest/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
