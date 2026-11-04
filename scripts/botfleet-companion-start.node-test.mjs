// The companion sidecar's runtime root.
//
// The sidecar used to run out of a linked worktree of the human tree, and
// the harness used to run out of one too.  Both now run from immutable
// releases behind their own pointers, and the point of these cases is
// that the two pointers are SEPARATE: the sidecar and the harness version
// independently, so swapping one release must never change what the other
// runs.
//
// A shared pointer was a real mistake once: with both programs reading
// ~/.botfleet/current, promoting a new harness release silently replaced
// the sidecar's code, and there was no way to roll one back without the
// other.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/botfleet-companion-start.sh");

/**
 * A fake node that records the directory it ran in, by writing a marker
 * file into its own working directory.  Where the marker LANDS is the
 * answer, whatever path dialect the shell used to say so.
 */
function fakeNodeScript(markerName) {
  return `#!/bin/bash\ntouch "$PWD/${markerName}"\necho fake\n`;
}

function releaseTree(root, commit) {
  const dir = join(root, "releases", commit);
  mkdirSync(join(dir, "electron"), { recursive: true });
  writeFileSync(join(dir, "electron", "managed-companion-supervisor.mjs"), "// fake supervisor\n");
  return dir;
}

/**
 * The environment a fixture run gets.
 *
 * The script resolves the park marker as
 * `${BOTFLEET_SHUTDOWN_MARKER:-${OMB_DATA_DIR:-$HOME/.botfleet}/stopped.marker}`,
 * so an inherited `BOTFLEET_SHUTDOWN_MARKER` or an inherited `OMB_DATA_DIR`
 * points the gate at some other file,  and the parked cases then stop
 * exercising the marker they wrote:  the gate reads a path that holds no
 * marker,  the companion starts,  and the case fails for a reason that has
 * nothing to do with the behaviour it is about.  The marker path is pinned to
 * this fixture's home and the inherited data directory is dropped,  so the
 * only marker the gate can see is the one the fixture wrote.
 */
function fixtureEnv(home, { port, node }) {
  const env = {
    ...process.env,
    HOME: home,
    BOTFLEET_SHUTDOWN_MARKER: join(home, ".botfleet", "stopped.marker"),
    BOTFLEET_COMPANION_PORT: String(port),
    BOTFLEET_COMPANION_CONTROL_PORT: String(port + 1),
    BOTFLEET_HARNESS_PORT: String(port + 2),
    BOTFLEET_NODE: node,
  };
  delete env.OMB_DATA_DIR;
  return env;
}

test("the sidecar runs from its own store, not the harness's", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-store-"));
  const home = join(dir, "home");

  // Two stores, two pointers, two releases: the harness's under
  // ~/.botfleet, the sidecar's under ~/.botfleet-companion.
  const harnessRelease = releaseTree(join(home, ".botfleet"), "h".repeat(40));
  const companionRelease = releaseTree(join(home, ".botfleet-companion"), "c".repeat(40));
  symlinkSync(harnessRelease, join(home, ".botfleet", "current"));
  symlinkSync(companionRelease, join(home, ".botfleet-companion", "current"));

  const node = join(dir, "fake-node");
  writeFileSync(node, fakeNodeScript("ran-here.txt"));
  chmodSync(node, 0o755);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: fixtureEnv(home, { port, node }),
  });
  // The sidecar's own release is where the marker must land.  Landing in
  // the harness's release would mean the two programs share a pointer, and
  // promoting a harness release would silently replace the sidecar's code.
  assert.ok(
    existsSync(join(companionRelease, "ran-here.txt")),
    `the sidecar must run from its own release; stderr: ${result.stderr}`,
  );
  assert.equal(
    existsSync(join(harnessRelease, "ran-here.txt")),
    false,
    "the sidecar must not run from the harness's release",
  );
});

function runStart(home, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-park-"));
  const release = releaseTree(join(home, ".botfleet-companion"), "c".repeat(40));
  symlinkSync(release, join(home, ".botfleet-companion", "current"));

  const node = join(dir, "fake-node");
  writeFileSync(node, fakeNodeScript("ran-here.txt"));
  chmodSync(node, 0o755);

  const port = 20000 + Math.floor(Math.random() * 20000);
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...fixtureEnv(home, { port, node }), ...extraEnv },
  });
}

test("a parked fleet does not start a companion, and the marker is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-parked-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".botfleet"), { recursive: true });
  const marker = join(home, ".botfleet", "stopped.marker");
  writeFileSync(marker, "stopped on purpose\n");

  const result = runStart(home);
  // Exit 0, not 1:  the companion's launchd job has KeepAlive,  and a
  // non-zero exit would be a failed start to restart-loop against.
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /stopped\.marker present/);
  // The gate must have read THIS fixture's marker,  not one the environment
  // pointed it at:  the log line names the path it looked at,  so the path in
  // the output is the proof that the parked case tested the parked behaviour.
  assert.ok(
    result.stdout.includes(marker),
    `the gate must read the fixture's own marker; stdout: ${result.stdout}`,
  );
  // The companion must not run at all while the fleet is parked.
  const release = join(home, ".botfleet-companion", "releases", "c".repeat(40));
  assert.equal(
    existsSync(join(release, "ran-here.txt")),
    false,
    "a parked fleet must not start a companion supervisor",
  );
  // The marker is the harness's park signal.  The companion never clears it.
  assert.ok(existsSync(marker), "the companion must never delete the harness's park marker");
});

test("an unparked fleet starts the companion as before", () => {  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-unparked-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".botfleet"), { recursive: true });

  const result = runStart(home);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const release = join(home, ".botfleet-companion", "releases", "c".repeat(40));
  assert.ok(
    existsSync(join(release, "ran-here.txt")),
    "without a park marker the companion must still start",
  );
});

test("an inherited marker override cannot move the gate off the fixture's marker", () => {
  // The script prefers BOTFLEET_SHUTDOWN_MARKER over the home it was given,
  // so a case that inherited one would look at a file it never wrote:  the
  // gate would find no marker there,  start the companion,  and the parked
  // behaviour would never be exercised at all.  The fixture pins the path,  so
  // this case holds even with an override in the environment.
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-inherited-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".botfleet"), { recursive: true });
  const marker = join(home, ".botfleet", "stopped.marker");
  writeFileSync(marker, "stopped on purpose\n");

  const previous = process.env.BOTFLEET_SHUTDOWN_MARKER;
  process.env.BOTFLEET_SHUTDOWN_MARKER = join(dir, "elsewhere.marker");
  try {
    const result = runStart(home);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(marker),
      `the gate must read the fixture's own marker; stdout: ${result.stdout}`,
    );
    const release = join(home, ".botfleet-companion", "releases", "c".repeat(40));
    assert.equal(
      existsSync(join(release, "ran-here.txt")),
      false,
      "a parked fleet must not start a companion supervisor",
    );
  } finally {
    if (previous === undefined) delete process.env.BOTFLEET_SHUTDOWN_MARKER;
    else process.env.BOTFLEET_SHUTDOWN_MARKER = previous;
  }
});

test("--stop still works while the fleet is parked", () => {
  // The gate must not swallow the stop path:  --stop removes the published
  // runtime claim,  and that has to work whether or not the fleet is parked.
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-parked-stop-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".botfleet"), { recursive: true });
  writeFileSync(join(home, ".botfleet", "stopped.marker"), "stopped on purpose\n");
  const claim = claimPath(home);
  mkdirSync(dirname(claim), { recursive: true });
  writeFileSync(claim, "{\"version\":1}\n");

  const result = runStop(home);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(existsSync(claim), false, "--stop must remove the runtime claim while parked");
  assert.ok(
    existsSync(join(home, ".botfleet", "stopped.marker")),
    "--stop must not delete the harness's park marker either",
  );
});

function runStop(home) {
  return spawnSync("bash", [SCRIPT, "--stop"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function claimPath(home) {
  return join(home, ".botfleet-companion", "runtime", "supervisor.json");
}

test("--stop removes the published runtime claim and does not start", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-stop-"));
  const home = join(dir, "home");
  const claim = claimPath(home);
  mkdirSync(dirname(claim), { recursive: true });
  writeFileSync(claim, "{\"version\":1}\n");

  const result = runStop(home);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(existsSync(claim), false, "--stop must remove ~/.botfleet-companion/runtime/supervisor.json");
  assert.match(result.stdout, /removed the published runtime claim/);
});

test("--stop is a no-op when no runtime claim is published", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-stop-absent-"));
  const home = join(dir, "home");

  const first = runStop(home);
  const second = runStop(home);
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);
  assert.equal(second.status, 0, `stderr: ${second.stderr}`);
  assert.equal(existsSync(claimPath(home)), false);
});

test("--stop leaves a symlink at the claim path alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-stop-symlink-"));
  const home = join(dir, "home");
  const claim = claimPath(home);
  const target = join(dir, "elsewhere.json");
  mkdirSync(dirname(claim), { recursive: true });
  writeFileSync(target, "not a claim\n");
  symlinkSync(target, claim);

  const result = runStop(home);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(existsSync(claim), "a symlink is not the regular file the supervisor publishes");
  assert.ok(existsSync(target), "--stop must never follow the claim path to another file");
});

test("the sidecar still runs from the legacy checkout path when it has no store", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-companion-legacy-"));
  const legacy = join(dir, "botfleet-companion");
  mkdirSync(join(legacy, "electron"), { recursive: true });
  writeFileSync(join(legacy, "electron", "managed-companion-supervisor.mjs"), "// fake supervisor\n");

  const node = join(dir, "fake-node");
  writeFileSync(node, fakeNodeScript("ran-here.txt"));
  chmodSync(node, 0o755);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      BOTFLEET_COMPANION_ROOT: legacy,
      BOTFLEET_COMPANION_PORT: String(port),
      BOTFLEET_COMPANION_CONTROL_PORT: String(port + 1),
      BOTFLEET_HARNESS_PORT: String(port + 2),
      BOTFLEET_NODE: node,
    },
  });
  assert.ok(
    existsSync(join(legacy, "ran-here.txt")),
    `the sidecar must still run from the legacy checkout path; stderr: ${result.stderr}`,
  );
});
