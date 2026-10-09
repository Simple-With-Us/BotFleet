// The exact scenario two reviewers flagged on PR #251 (board a2a3a586): the
// harness server's saveConfig and the Electron auto-updater's
// recordAutomaticCheck are different OS processes doing whole-file
// read-modify-writes of the same ~/.botfleet/config.json.  Here the server
// side runs in this process while a child process plays the Electron side,
// both as fast as they can against one file.  Every server save adds an
// instance entry, so a single stale snapshot from the other side would drop
// one and the count would come up short; the last Electron record has to
// survive the server's writes the same way.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR, saveConfig } from "./config.ts";

const THROTTLE_URL = new URL("../electron/updater-throttle.mjs", import.meta.url).href;

const IS_WIN = process.platform === "win32";
/** Parent yield between locked saves — long enough for a scheduled child on
 * windows-latest to finish one read-modify-write before this process hits the
 * 5 s acquire timeout. */
const PARENT_PACING_MS = IS_WIN ? 120 : 25;
/** Child yield between locked records — same scheduling story on Windows. */
const CHILD_PACING_MS = IS_WIN ? 30 : 2;

/** Spawn the Electron side: `recordAutomaticCheck` N times with a numbered
 * fingerprint, paced a little so the loop spans the parent's own writes.
 * Resolves `ready` once the module is loaded, `done` on a clean exit. */
function electronSide(configPath: string, n: number): { ready: Promise<void>; done: Promise<void> } {
  const source = `
import { recordAutomaticCheck } from ${JSON.stringify(THROTTLE_URL)};
const cell = new Int32Array(new SharedArrayBuffer(4));
const path = process.env.RACE_CONFIG_PATH;
const n = Number(process.env.RACE_N);
const pacingMs = Number(process.env.RACE_PACING_MS ?? "2");
console.log("ready");
for (let i = 1; i <= n; i += 1) {
  recordAutomaticCheck(path, { fingerprint: "fp-" + i });
  Atomics.wait(cell, 0, 0, pacingMs);
}
console.log("done");
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      RACE_CONFIG_PATH: configPath,
      RACE_N: String(n),
      RACE_PACING_MS: String(CHILD_PACING_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready")) markReady();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`electron-side worker exited ${code}: ${stderr}`));
    });
  });
  return { ready, done };
}

describe("config.json lost-update race between the server and the Electron process", () => {
  it("a run of Settings saves and auto-update records landing together all survive", async () => {
    const configPath = join(DATA_DIR, "config.json");
    const N = 40;
    const other = electronSide(configPath, N);
    await other.ready;
    if (IS_WIN) {
      // Let the child enter its loop before the parent grabs the lock back-to-back.
      await new Promise<void>((resolve) => setTimeout(resolve, PARENT_PACING_MS));
    }
    // Each save stays synchronous, like the real route handler.  Yield after
    // each release so the child can acquire the lock before this process
    // reacquires it; Windows runners can otherwise starve the child for
    // the lock's entire five-second timeout.
    for (let i = 1; i <= N; i += 1) {
      saveConfig({ instances: { [`bot-${i}`]: { driver: "grok" } } });
      if (i < N) await new Promise<void>((resolve) => setTimeout(resolve, PARENT_PACING_MS));
    }
    await other.done;

    const disk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(disk.instances ?? {})).toHaveLength(N);
    expect(disk.autoUpdate?.lastAppFingerprint).toBe(`fp-${N}`);
    expect(typeof disk.autoUpdate?.lastCheckMs).toBe("number");
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  }, IS_WIN ? 90_000 : 30_000);
});
