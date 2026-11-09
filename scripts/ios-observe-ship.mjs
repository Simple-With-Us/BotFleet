#!/usr/bin/env node
/**
 * Wrap ios-ship-testflight.sh so Actions can gate post-sync recheck on a real upload.
 * Skipped ships (rate/same-HEAD gate) must not look like uploaded == true.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uploadedRe =
  /upload path succeeded via xcodebuild export \(destination=upload\)|build .+ submitted for |upload submitted; watch TestFlight processing/;
const skippedRe =
  /ship-gate: exiting 0 before any build number is consumed \(sequence untouched\)/;

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error("usage: ios-observe-ship.mjs <command> [args...]");
  process.exit(2);
}

const outputs = process.env.GITHUB_OUTPUT?.trim();
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: ["inherit", "pipe", "pipe"],
  shell: false,
});

let stdoutBuf = "";
let stderrBuf = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdoutBuf += text;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderrBuf += text;
  process.stderr.write(chunk);
});

const exitPromise = new Promise((resolve) => {
  child.on("close", (code, signal) => {
    resolve({ code: code ?? (signal ? 1 : 0), signal });
  });
});

const { code } = await exitPromise;

const combined = stdoutBuf + stderrBuf;
const uploaded = uploadedRe.test(combined);
const skipped = skippedRe.test(combined);

let observed = "none";
if (uploaded) {
  observed = "uploaded";
} else if (skipped) {
  observed = "skipped";
} else if (code === 0) {
  observed = "unknown_success";
}

if (outputs) {
  fs.appendFileSync(outputs, `uploaded=${uploaded ? "true" : "false"}\n`);
  fs.appendFileSync(outputs, `ship_observed=${observed}\n`);
}

process.exit(code);
