// BF-1991: the packaged-server smoke gate must run the runtime production
// runs, and must SAY which runtime it ran.
//
// The bug this locks down: the gate booted the staged server with
// process.execPath -- the runner's own Node -- while production runs the
// packaged Electron binary under ELECTRON_RUN_AS_NODE=1.  A build could pass
// the gate and still die under the runtime it ships on.
//
// Every differential test here carries a CONTROL: the same fixture with the
// opposite input must produce the opposite outcome, so a test that never
// exercised the decision cannot pass by accident.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertRuntimeExecutable,
  BUNDLE_KIND,
  BUNDLE_LABEL,
  BUNDLE_MODE,
  normalizeArch,
  packagedBinaryPath,
  parseLipoArchs,
  resolveRuntime,
  resolveSmokeRuntime,
  RUNTIME_KIND,
  RUNTIME_LABEL,
  RUNTIME_MODE,
} from "./smoke-runtime-mode.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = join(ROOT, "scripts", "smoke-packaged-server.mjs");
const MODE = join(ROOT, "scripts", "smoke-runtime-mode.mjs");

/** A scratch directory that cleans itself up. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omb-smoke-mode-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A tiny executable shell script with the given exit code. */
function executable(dir, name, code) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("lipo and node disagree about Intel, so the arch names are normalized", () => {
  assert.equal(normalizeArch("x86_64"), "x64");
  assert.equal(normalizeArch("x64"), "x64");
  assert.equal(normalizeArch("amd64"), "x64");
  assert.equal(normalizeArch("arm64"), "arm64");
  assert.equal(normalizeArch("aarch64"), "arm64");
  assert.deepEqual(parseLipoArchs("arm64 x86_64\n"), ["arm64", "x64"]);
  assert.deepEqual(parseLipoArchs("  arm64  "), ["arm64"]);
  assert.deepEqual(parseLipoArchs(""), []);
});

test("the packaged binary is the one the shipped app runs", () => {
  assert.equal(
    packagedBinaryPath("/build/BotFleet.app"),
    "/build/BotFleet.app/Contents/MacOS/BotFleet",
  );
});

test("the app's architecture decides the mode, and the control flips it", () => {
  const appPath = "/build/BotFleet.app";
  const matching = resolveSmokeRuntime({ appPath, appArches: ["arm64"], hostArch: "arm64" });
  assert.equal(matching.mode, RUNTIME_MODE);
  assert.equal(matching.label, RUNTIME_LABEL);
  assert.equal(matching.kind, RUNTIME_KIND);
  assert.equal(matching.runtime, packagedBinaryPath(appPath));
  assert.equal(matching.command, packagedBinaryPath(appPath));
  assert.equal(matching.env.ELECTRON_RUN_AS_NODE, "1");

  // The CONTROL: the same app on the same host, with a binary this host
  // cannot exec.  If the decision did not depend on the architecture, this
  // would still claim a runtime pass and the gate would be a no-op.
  const control = resolveSmokeRuntime({ appPath, appArches: ["x64"], hostArch: "arm64" });
  assert.equal(control.mode, BUNDLE_MODE);
  assert.equal(control.label, BUNDLE_LABEL);
  assert.equal(control.kind, BUNDLE_KIND);
  assert.equal(control.runtime, null);
  assert.equal(control.command, process.execPath);
  assert.deepEqual(control.env, {});
});

test("an unreadable architecture is a bundle check, never a runtime pass", () => {
  const plan = resolveSmokeRuntime({ appPath: "/build/BotFleet.app", appArches: [], hostArch: "arm64" });
  assert.equal(plan.mode, BUNDLE_MODE);
  assert.match(plan.reason, /could not be read/);
});

test("a required runtime fails closed instead of degrading to a bundle check", () => {
  assert.throws(
    () => resolveSmokeRuntime({ appPath: "/build/BotFleet.app", appArches: ["x64"], hostArch: "arm64", requireRuntime: true }),
    /runtime pass was required/,
  );
  // The control: the same call with a matching arch is allowed through.
  const allowed = resolveSmokeRuntime({
    appPath: "/build/BotFleet.app",
    appArches: ["arm64"],
    hostArch: "arm64",
    requireRuntime: true,
  });
  assert.equal(allowed.mode, RUNTIME_MODE);
});

test("an unnamed runtime is a labelled bundle check", () => {
  const plan = resolveRuntime("");
  assert.equal(plan.mode, BUNDLE_MODE);
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.env, {});
  assert.equal(plan.kind, BUNDLE_KIND);
});

test("a named runtime that cannot be executed throws instead of falling back", () => {
  const { dir, cleanup } = scratch();
  try {
    // Missing entirely.
    assert.throws(() => resolveRuntime(join(dir, "not-here")), /does not exist/);

    // Present, but not executable.
    const plain = join(dir, "plain.txt");
    writeFileSync(plain, "not a program\n");
    chmodSync(plain, 0o644);
    assert.throws(() => resolveRuntime(plain), /is not executable/);

    // Present and executable: the control, which must NOT throw.
    const good = executable(dir, "good.sh", 0);
    const plan = resolveRuntime(good);
    assert.equal(plan.mode, RUNTIME_MODE);
    assert.equal(plan.command, good);
    assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(plan.kind, RUNTIME_KIND);
  } finally {
    cleanup();
  }
});

test("the runtime preflight execs the binary and the control proves it", () => {
  const { dir, cleanup } = scratch();
  try {
    assert.equal(assertRuntimeExecutable(executable(dir, "ok.sh", 0)), true);

    // The control: the same call against a program that exits non-zero must
    // fail, so a preflight that never ran anything cannot look green.
    assert.throws(() => assertRuntimeExecutable(executable(dir, "bad.sh", 3)), /exited 3/);

    // And a path that is not a program at all must fail too.
    assert.throws(() => assertRuntimeExecutable(join(dir, "missing")), /could not be executed/);
  } finally {
    cleanup();
  }
});

test("the smoke gate refuses to run on a named runtime it cannot execute", () => {
  const { dir, cleanup } = scratch();
  try {
    const missing = join(dir, "not-here");
    const failed = spawnSync(process.execPath, [SMOKE], {
      env: { ...process.env, OMB_SMOKE_RUNTIME: missing, OMB_SMOKE_DIST: join(dir, "no-dist") },
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Refusing to fall back to the runner's Node/);

    // The CONTROL: with no runtime named, the same script reports a bundle
    // check and never takes the fail-closed path.  Without this, the test
    // above would pass against a gate that failed for any reason at all.
    const unnamed = spawnSync(process.execPath, [SMOKE], {
      env: { ...process.env, OMB_SMOKE_RUNTIME: "", OMB_SMOKE_DIST: join(dir, "no-dist") },
      encoding: "utf8",
    });
    assert.doesNotMatch(unnamed.stderr, /Refusing to fall back/);
    assert.match(unnamed.stdout, /smoke mode: bundle \(bundle check\)/);
    assert.match(unnamed.stdout, /NOT a runtime pass/);
  } finally {
    cleanup();
  }
});

test("the mode report names both kinds, so a log line is never ambiguous", () => {
  const { dir, cleanup } = scratch();
  try {
    // A bundle whose binary lipo cannot read: the plan is a bundle check.
    const app = join(dir, "BotFleet.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "BotFleet"), "not a real binary\n");
    const plan = spawnSync(process.execPath, [MODE, "plan", "--app", app], { encoding: "utf8" });
    assert.equal(plan.status, 0);
    assert.match(plan.stdout, /smoke mode: bundle \(bundle check\)/);
    assert.match(plan.stdout, /bundle check -- this is NOT a runtime pass/);

    // The control: the same report for a runtime pass names the other kind.
    const runtimePlan = resolveSmokeRuntime({
      appPath: app,
      appArches: [normalizeArch(process.arch)],
      hostArch: process.arch,
    });
    assert.equal(runtimePlan.kind, RUNTIME_KIND);
    assert.match(runtimePlan.kind, /runtime pass -- this is NOT a bundle check/);
  } finally {
    cleanup();
  }
});
