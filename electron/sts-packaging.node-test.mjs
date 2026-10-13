// The packaged Electron app must be able to load its own STS minting at
// runtime.  The shipped main process is started by Electron itself (no
// --experimental-strip-types), and Electron's Node cannot parse a `.ts` file
// out of an asar.  This test simulates the exact asar shape that
// electron-builder produces and proves the import resolves without that
// hazard -- a test of the layout the build will hand to the user, not of
// the dev-time import path that "happens to work because Node is forgiving".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "electron");

function pack(t) {
  // The packaging step writes `dist-shared/sts-tokens.{js,d.ts}` and the
  // electron-builder `files:` glob pulls them into the asar.  Stage the
  // same shape under a temp dir and require it from there, so the test
  // fails on the same way the packaged binary would.
  const staging = mkdtempSync(path.join(tmpdir(), "bf-sts-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));
  cpSync(electronDir, path.join(staging, "electron"), { recursive: true, dereference: false });
  // The packaged file glob drops electron's test files and the harness's
  // node_modules tree; the test must not need either.
  for (const testFile of [
    "sts-tokens.test.mjs",
  ]) {
    rmSync(path.join(staging, "electron", testFile), { force: true });
  }
  cpSync(path.join(root, "dist-shared"), path.join(staging, "shared"), { recursive: true });
  // The asar uses `app.asar`; an unpacked test can mirror that as a plain
  // directory, which behaves the same for the import.
  return staging;
}

test("dist-shared/sts-tokens.js is built and ESM-importable from the packaged shape", (t) => {
  const staging = pack(t);
  const result = spawnSyncNode(
    [
      "--input-type=module",
      "-e",
      `import { mintXaiRealtimeToken } from "./shared/sts-tokens.js";
       if (typeof mintXaiRealtimeToken !== "function") throw new Error("not a function");
       console.log("ok");`,
    ],
    { cwd: staging },
  );
  assert.equal(result.status, 0, `expected ok, got:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok/);
});

test("electron/sts-tokens.mjs imports the compiled JS, not the .ts source", (t) => {
  const staging = pack(t);
  // Read the .mjs to assert the import target is the compiled file.  This is
  // the single point of failure: a `.ts` import in here re-introduces the
  // exact regression that broke #1114's package step.
  const source = readFileSync(path.join(staging, "electron", "sts-tokens.mjs"), "utf8");
  const importLine = source.split("\n").find((line) => line.includes("../shared/"));
  assert.ok(importLine, "electron/sts-tokens.mjs is missing the shared import");
  assert.match(
    importLine,
    /from\s+"\.\.\/shared\/sts-tokens\.js"/,
    `electron/sts-tokens.mjs must import the compiled .js; got: ${importLine}`,
  );
  assert.doesNotMatch(importLine, /\.ts"/, "electron/sts-tokens.mjs must not import a .ts file");
});

test("a Node process spawned with no strip-types flag can import the packaged sts-tokens", (t) => {
  // This is the real packaged-runtime contract: the Electron main process
  // is started by Electron, never with --experimental-strip-types, and it
  // must be able to load the file.  A `.ts` import dies with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX or ERR_MODULE_NOT_FOUND here.
  const staging = pack(t);
  const result = spawnSyncNode(
    [
      "--input-type=module",
      "-e",
      `import { mintXaiRealtimeToken, mintGeminiLiveToken, isStsProvider } from "./shared/sts-tokens.js";
       if (typeof mintXaiRealtimeToken !== "function") throw new Error("mintXaiRealtimeToken not a function");
       if (typeof mintGeminiLiveToken !== "function") throw new Error("mintGeminiLiveToken not a function");
       if (isStsProvider("xai") !== true || isStsProvider("nope") !== false) throw new Error("isStsProvider wrong");
       console.log("ok");`,
    ],
    { cwd: staging, env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(result.status, 0, `expected ok, got:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok/);
});

function spawnSyncNode(args, options) {
  // Use spawnSync so a failure in the child doesn't surface as an unhandled
  // promise rejection in the test runner.  `node` is the host's binary --
  // in the packaged case it is Electron's own node; here it is the same
  // version the asar's own bin/ resolves to.
  return spawnSync(process.execPath, args, { ...options, encoding: "utf8" });
}
