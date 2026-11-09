#!/usr/bin/env node
/**
 * Wrap ios-ship-testflight.sh so Actions can gate post-sync recheck on a real upload.
 * Skipped ships (rate/same-HEAD gate) must not look like uploaded == true.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const uploadedRe =
  /upload path succeeded via xcodebuild export \(destination=upload\)|build .+ submitted for |upload submitted; watch TestFlight processing/;
const skippedRe =
  /ship-gate: exiting 0 before any build number is consumed \(sequence untouched\)/;

const MAX_TAIL = 8192;

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error("usage: ios-observe-ship.mjs <command> [args...]");
  process.exit(2);
}

const outputs = process.env.GITHUB_OUTPUT?.trim();

let uploadedSeen = false;
let skippedSeen = false;
let spawnErrored = false;
let tail = "";

/** @param {string} text */
function feedLog(text) {
  const window = tail + text;
  if (!uploadedSeen && uploadedRe.test(window)) {
    uploadedSeen = true;
  }
  if (!skippedSeen && skippedRe.test(window)) {
    skippedSeen = true;
  }
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    if (!uploadedSeen && uploadedRe.test(line)) {
      uploadedSeen = true;
    }
    if (!skippedSeen && skippedRe.test(line)) {
      skippedSeen = true;
    }
  }
  tail = window.slice(-MAX_TAIL);
}

/** @param {{ uploaded: boolean; observed: string; exitCode: number }} arg */
function writeShipOutputs({ uploaded, observed, exitCode }) {
  if (!outputs) {
    return;
  }
  fs.appendFileSync(outputs, `uploaded=${uploaded ? "true" : "false"}\n`);
  fs.appendFileSync(outputs, `ship_observed=${observed}\n`);
  fs.appendFileSync(outputs, `ship_exit_code=${exitCode}\n`);
}

const child = spawn(cmd[0], cmd.slice(1), {
  stdio: ["inherit", "pipe", "pipe"],
  shell: false,
});

child.stdout.on("data", (chunk) => {
  feedLog(chunk.toString());
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  feedLog(chunk.toString());
  process.stderr.write(chunk);
});

const exitPromise = new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(result);
  };
  child.on("error", (err) => {
    spawnErrored = true;
    const msg = `ios-observe-ship: spawn error: ${err?.message ?? err}\n`;
    process.stderr.write(msg);
    feedLog(msg);
    finish({ code: 1, signal: null });
  });
  child.on("close", (code, signal) => {
    finish({ code: code ?? (signal ? 1 : 0), signal });
  });
});

const { code } = await exitPromise;

const uploaded = uploadedSeen;
const skipped = skippedSeen;

let observed = "none";
if (spawnErrored) {
  observed = "spawn_error";
} else if (uploaded) {
  observed = "uploaded";
} else if (skipped) {
  observed = "skipped";
} else if (code === 0) {
  observed = "unknown_success";
}

writeShipOutputs({ uploaded, observed, exitCode: code });
process.exit(code);
