#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");

const [baselinePath, actualPath] = process.argv.slice(2);
if (!baselinePath || !actualPath) {
  console.error("usage: ios-tvface-screenshot-verify.mjs <baseline.png> <actual.png>");
  process.exit(2);
}

const baseline = PNG.sync.read(readFileSync(baselinePath));
const actual = PNG.sync.read(readFileSync(actualPath));

if (baseline.width !== actual.width || baseline.height !== actual.height) {
  console.error(
    `dimension mismatch: baseline ${baseline.width}x${baseline.height}, actual ${actual.width}x${actual.height}`,
  );
  process.exit(1);
}

const diff = new PNG({ width: baseline.width, height: baseline.height });
const mismatched = pixelmatch(
  baseline.data,
  actual.data,
  diff.data,
  baseline.width,
  baseline.height,
  { threshold: 0.2 },
);
const ratio = mismatched / (baseline.width * baseline.height);
const maxRatio = 0.03;

if (ratio > maxRatio) {
  console.error(`pixel diff ${(ratio * 100).toFixed(2)}% exceeds ${maxRatio * 100}%`);
  process.exit(1);
}

console.log(`ios tv-face screenshot ok (${(ratio * 100).toFixed(3)}% pixels differ)`);
