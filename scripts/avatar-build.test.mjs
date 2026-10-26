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
  readImageSize,
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

/* A minimal JPEG, so the test does not need a real photo to check that the
 * build can read the size of a JPEG.  The frame header is the segment that
 * says how big the picture is. */
function jpeg(width, height) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8; // the precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from("ffe000104a46494600010100000100010000", "hex"),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/* A minimal extended WebP: the VP8X chunk says how big the canvas is. */
function webp(width, height) {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const payload = 4 + 8 + vp8x.length;
  const out = Buffer.alloc(8 + payload);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(payload, 4);
  out.write("WEBP", 8, "latin1");
  out.write("VP8X", 12, "latin1");
  out.writeUInt32LE(vp8x.length, 16);
  vp8x.copy(out, 20);
  return out;
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

  it("keeps every format the size reader can read", () => {
    // The collector and the reader have to agree: a file the build collects
    // is a file whose size the build can read.
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      writeFileSync(join(dir, "01.png"), png(2, 2));
      writeFileSync(join(dir, "02.jpg"), jpeg(3, 4));
      writeFileSync(join(dir, "03.jpeg"), jpeg(5, 6));
      writeFileSync(join(dir, "04.webp"), webp(7, 8));
      const files = collectFrameFiles(dir).map((path) => path.split("/").pop());
      expect(files).toEqual(["01.png", "02.jpg", "03.jpeg", "04.webp"]);
      expect(readImageSize(join(dir, "01.png"))).toEqual({ width: 2, height: 2 });
      expect(readImageSize(join(dir, "02.jpg"))).toEqual({ width: 3, height: 4 });
      expect(readImageSize(join(dir, "03.jpeg"))).toEqual({ width: 5, height: 6 });
      expect(readImageSize(join(dir, "04.webp"))).toEqual({ width: 7, height: 8 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readImageSize", () => {
  it("reads the size of a PNG, a JPEG and a WebP", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      const pngPath = join(dir, "a.png");
      writeFileSync(pngPath, png(320, 240));
      expect(readImageSize(pngPath)).toEqual({ width: 320, height: 240 });

      const jpegPath = join(dir, "b.jpg");
      writeFileSync(jpegPath, jpeg(160, 120));
      expect(readImageSize(jpegPath)).toEqual({ width: 160, height: 120 });

      const webpPath = join(dir, "c.webp");
      writeFileSync(webpPath, webp(64, 48));
      expect(readImageSize(webpPath)).toEqual({ width: 64, height: 48 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the size of a real built WebP", () => {
    // A committed example, built by the tool itself: the reader has to
    // understand the files the build writes.
    const path = new URL("../tests/fixtures/avatar/tvface-working-demo.webp", import.meta.url);
    expect(readImageSize(path.pathname)).toEqual({ width: 256, height: 256 });
  });

  it("says plainly that a file it cannot read is not an image it knows", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
    try {
      const path = join(dir, "a.png");
      writeFileSync(path, "not an image at all");
      expect(() => readImageSize(path)).toThrow(/not a PNG, a JPEG or a WebP/);
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

  it("refuses a manifest that declares a size the frames do not have", async () => {
    // The manifest says 256x256 and the frames are 64x64.  The size check
    // has to compare the manifest with the frames that are really there: a
    // check that compares the manifest with itself can never say anything.
    const { buildAvatar } = await import("./avatar-build.ts");
    const dir = mkdtempSync(join(tmpdir(), "avatar-build-size-"));
    try {
      const frames = join(dir, "frames");
      mkdirSync(frames);
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(frames, `${String(i).padStart(2, "0")}.png`), png(64, 64, i * 20));
      }
      const manifestPath = join(dir, "avatar.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...MANIFEST,
          frame: { ...MANIFEST.frame, count: 3 },
          states: { "*": { hold: { from: 0, to: 2 } } },
        }),
      );
      expect(() =>
        buildAvatar({ framesDir: frames, manifestPath, out: join(dir, "out.webp") }),
      ).toThrow(/the source frames are 64x64 but the manifest declares 256x256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!toolchain)(
    "turns a folder of frames into one animated file with the manifest inside",
    async () => {
      const { buildAvatar } = await import("./avatar-build.ts");
      const dir = mkdtempSync(join(tmpdir(), "avatar-build-test-"));
      try {
        const frames = join(dir, "frames");
        mkdirSync(frames);
        for (let i = 1; i <= 6; i++) {
          writeFileSync(join(frames, `${String(i).padStart(2, "0")}.png`), png(256, 256, i * 20));
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
            png(256, 256, tint),
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
