#!/usr/bin/env node
/** Bundle gifuct-js for static TV-Face demo pages (pinned 2.1.2). */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "..", "public", "tv-face", "vendor", "gifuct-js@2.1.2.mjs");

await esbuild.build({
  entryPoints: [path.join(root, "tv-face-gif-decoder-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: out,
  legalComments: "none",
});

console.log(`Wrote ${out}`);
