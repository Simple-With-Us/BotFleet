import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/native-mac-release.yml"), "utf8");
const localScript = readFileSync(join(ROOT, "scripts/mac-package.sh"), "utf8");

test("the native workflow is dispatch-only and never publishes", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /--draft=false/);
  assert.doesNotMatch(workflow, /gh release edit/);
});

test("the version is stamped once from a full-history checkout", () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /stamp-commit-version\.mjs/);
  // The overwrite guard reads the producing job's own output.  Reading
  // needs.prepare.outputs.version inside prepare was the release.yml bug
  // fixed in PR #1315: needs is empty there, so the guard never fired.
  assert.match(workflow, /steps\.pin\.outputs\.version/);
  const prepare = workflow.slice(workflow.indexOf("prepare:"), workflow.indexOf("mac-native:"));
  assert.doesNotMatch(prepare, /needs\.prepare\.outputs/);
});

test("the codesign gate runs before any notarization submission", () => {
  const gate = workflow.indexOf("codesign --verify --deep --strict");
  const submit = workflow.indexOf("notarytool submit");
  assert.ok(gate !== -1 && submit !== -1 && gate < submit);
  const localGate = localScript.indexOf("codesign --verify --deep --strict");
  const localSubmit = localScript.indexOf("notarytool submit");
  assert.ok(localGate !== -1 && (localSubmit === -1 || localGate < localSubmit));
});

test("the appcast is generated after stapling, over the final bytes", () => {
  const staple = workflow.indexOf("stapler staple");
  const appcast = workflow.indexOf("native-appcast.mjs");
  assert.ok(staple !== -1 && appcast > staple);
  assert.match(workflow, /verify-native-release\.mjs/);
});

test("native asset names cannot collide with the Electron feed", () => {
  assert.match(workflow, /BotFleetMac-\$VERSION\.zip/);
  assert.doesNotMatch(workflow, /BotFleet-\$VERSION/);
  assert.match(localScript, /BotFleetMac-\$\{VERSION\}/);
});

test("signing secrets are only ever decoded into files, never printed", () => {
  // The sanctioned shape, copied from release.yml, is
  // `echo "$SECRET" | base64 --decode > file`: the value reaches a file,
  // never the log.  Any other echo of a secret variable is a leak.
  for (const text of [workflow, localScript]) {
    for (const line of text.split("\n")) {
      if (/echo.*\$(MAC_CERT|APPLE_API_KEY_P8|SPARKLE)/.test(line)) {
        assert.match(line, /base64 --decode/, `secret echoed without a decode pipe: ${line.trim()}`);
      }
    }
    assert.doesNotMatch(text, /cat .*\.p12/);
  }
});

test("the local script refuses beta toolchains and labels dev builds", () => {
  assert.match(localScript, /grep -qi beta/);
  assert.match(localScript, /NOT DISTRIBUTABLE/);
  assert.match(localScript, /spctl --assess/);
});
