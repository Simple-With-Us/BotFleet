// Runs the PNG gate embedded in scripts/ios-tvface-screenshot.sh against
// synthetic PNGs written with every row filter (0-4), so a capture encoded
// with Average or Paeth rows is compared rather than refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(join(ROOT, "scripts/ios-tvface-screenshot.sh"), "utf8");
const START = "<<'PNG_COMPARE'\n";
const GATE = SCRIPT.slice(SCRIPT.indexOf(START) + START.length, SCRIPT.lastIndexOf("PNG_COMPARE\n"));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Encodes pixels of PNG color type `color` (6 = RGBA by default), choosing
// each row's filter from `filters` in turn.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
function png(width, height, pixels, filters, color = 6) {
  const bpp = CHANNELS[color], stride = width * bpp, out = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const f = filters[y % filters.length];
    const enc = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      enc[i] = (row[i] - pred) & 0xff;
    }
    out.push(Buffer.from([f]), enc);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = color;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(out))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function compare(baseline, capture) {
  const dir = mkdtempSync(join(tmpdir(), "tvface-png-"));
  try {
    writeFileSync(join(dir, "a.png"), baseline);
    writeFileSync(join(dir, "b.png"), capture);
    return spawnSync("python3", ["-", join(dir, "a.png"), join(dir, "b.png")], { input: GATE, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const W = 7, H = 6;
const pixels = Buffer.from(Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff));

test("gate is embedded in the screenshot script", () => {
  assert.match(GATE, /def rows\(/);
});

test("identical images match whichever row filters encode them", () => {
  const plain = png(W, H, pixels, [0]);
  for (const filters of [[1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
    const r = compare(plain, png(W, H, pixels, filters));
    assert.equal(r.status, 0, `filters ${filters}: ${r.stderr}`);
    assert.match(r.stdout, /matches baseline/);
  }
});

test("a changed pixel is reported as a mismatch under Average and Paeth rows", () => {
  const changed = Buffer.from(pixels); changed[W * 4 * 3 + 5] ^= 0x40;
  for (const filters of [[3], [4]]) {
    const r = compare(png(W, H, pixels, filters), png(W, H, changed, filters));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /differs from baseline \(1 byte mismatches\)/);
  }
});

test("a different size is refused before comparing", () => {
  const r = compare(png(W, H, pixels, [0]), png(W, H - 1, pixels.subarray(0, W * (H - 1) * 4), [0]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /size mismatch/);
});

// Drops channels from RGBA pixels:  RGB keeps r,g,b;  gray keeps r (all equal).
const channels = (rgba, keep) => Buffer.from(rgba.filter((_, i) => keep.includes(i % 4)));

test("the same pixels match across RGBA, RGB and gray color types", () => {
  const opaque = Buffer.from(pixels); for (let i = 3; i < opaque.length; i += 4) opaque[i] = 0xff;
  const rgb = channels(opaque, [0, 1, 2]);
  let r = compare(png(W, H, opaque, [0]), png(W, H, rgb, [4], 2));
  assert.equal(r.status, 0, r.stderr);
  const grayRgba = Buffer.from(opaque);
  for (let i = 0; i < grayRgba.length; i += 4) grayRgba[i + 1] = grayRgba[i + 2] = grayRgba[i];
  r = compare(png(W, H, grayRgba, [0]), png(W, H, channels(grayRgba, [0]), [3], 0));
  assert.equal(r.status, 0, r.stderr);
  const changed = Buffer.from(rgb); changed[4] ^= 0x10;
  r = compare(png(W, H, opaque, [0]), png(W, H, changed, [0], 2));
  assert.match(r.stderr, /differs from baseline \(1 byte mismatches\)/);
});

test("a capture with no IEND or a short chunk is refused", () => {
  const good = png(W, H, pixels, [0]);
  let r = compare(good, good.subarray(0, good.length - 12));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing IEND/);
  r = compare(good, good.subarray(0, good.length - 20));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /truncated PNG chunk/);
});
