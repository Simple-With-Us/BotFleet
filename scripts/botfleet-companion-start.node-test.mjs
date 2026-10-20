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
    env: {
      ...process.env,
      HOME: home,
      BOTFLEET_COMPANION_PORT: String(port),
      BOTFLEET_COMPANION_CONTROL_PORT: String(port + 1),
      BOTFLEET_HARNESS_PORT: String(port + 2),
      BOTFLEET_NODE: node,
    },
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
