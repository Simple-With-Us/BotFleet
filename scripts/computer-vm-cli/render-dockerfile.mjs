#!/usr/bin/env node
// Writes the Local VM image's Dockerfile to <dir>/Dockerfile so `docker build <dir>`
// builds exactly what the app builds.  The app renders the same function at
// provision time; CI and local image checks use this instead of copying the
// text, so a build here cannot drift from the shipped one.
//
//   node scripts/computer-vm-cli/render-dockerfile.mjs <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { managedImageDockerfile } from "../../server/container-computer.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: render-dockerfile.mjs <context-dir>");
  process.exit(2);
}
const context = resolve(dir);
mkdirSync(context, { recursive: true });
writeFileSync(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
console.log(join(context, "Dockerfile"));
