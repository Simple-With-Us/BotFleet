// The optional native headless host is an independent artifact path.
//
// BF-2635: the optional host must never be able to block the standard signed
// GUI release.  The release workflow archives the app, signs it, notarizes it,
// staples it and packages the ZIP and the DMG; it does not build the host.  A
// step that packaged the host inside that job would turn a host build failure
// into a GUI release failure, so this file holds the separation in place.
//
// The host keeps a path of its own: its own packager, its own receipt and its
// own opt-in smoke command.  The identity proof over synthetic binaries stays
// in the standard test chain, because a fixture costs nothing and says
// nothing about a shipped artifact.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");
const pkg = JSON.parse(read("package.json"));

test("the standard signed GUI release workflow never packages the optional host", () => {
  const workflow = read(".github/workflows/native-mac-release.yml");
  assert.ok(!workflow.includes("package-native-host"), "the GUI release workflow invokes the optional host packager");
  assert.ok(!workflow.includes("native-host-package-smoke"), "the GUI release workflow invokes the optional host smoke");
  // The workflow still does the GUI release, so the two assertions above are
  // about the optional host and not about a workflow that lost its job.
  const steps = parseYaml(workflow).jobs["mac-native"].steps.map((step) => String(step.name));
  assert.ok(steps.includes("Archive BotFleetMac"));
  assert.ok(steps.some((name) => name.includes("Notarize")));
  assert.ok(steps.some((name) => name.includes("Package the final ZIP and DMG")));
});

test("the optional host is produced by its own opt-in command, with its own receipt", () => {
  assert.equal(pkg.scripts["smoke:native-host-package"], "node scripts/native-host-package-smoke.mjs");
  const packager = read("scripts/package-native-host.mjs");
  assert.ok(packager.includes("artifact.json"), "the packager writes no receipt of its own");
  assert.ok(packager.includes('"wx"'), "the packager may overwrite a receipt it already wrote");
});

test("the standard test chain proves the host identity without building the host artifact", () => {
  assert.ok(pkg.scripts["test:native-release"].includes("scripts/native-host-artifact.node-test.mjs"));
  assert.ok(pkg.scripts.test.includes("pnpm test:native-release"));
  // The real packaging smoke builds the host for both slices, so it stays out
  // of the chain every pull request runs: a host build failure must not fail
  // CI for a change that never touches the host.
  assert.ok(!pkg.scripts.test.includes("smoke:native-host-package"));
});
