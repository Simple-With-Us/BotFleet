import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gateWiringProblems, optInProblems } from "./gate-wiring.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;

const PROVENANCE = "scripts/release-provenance.node-test.mjs";
const RELEASE = "scripts/harness-release.node-test.mjs";
const INSTALL = "scripts/release-provenance-install.node-test.mjs";
const OPT_IN = "BF_PROVENANCE_INSTALL=1";

const wired = (updater, chain = "node scripts/test-floor.mjs && pnpm test:mac-updater && pnpm test:ci-scope") =>
  gateWiringProblems({ test: chain, "test:mac-updater": updater }, "test:mac-updater", [PROVENANCE, RELEASE]);

test("a plain node --test run that pnpm test chains is wired", () => {
  assert.deepEqual(wired(`node --test scripts/other.node-test.mjs ${PROVENANCE} ${RELEASE}`), []);
});

test("a suite is wired only by its whole path", () => {
  assert.match(wired(`node --test ${RELEASE}`).join("\n"), /does not name scripts\/release-provenance\.node-test\.mjs/);
  assert.match(wired(`node --test ${PROVENANCE}`).join("\n"), /does not name scripts\/harness-release\.node-test\.mjs/);
  // A suffixed, prefixed or sibling path is a different file, not a near miss.
  assert.match(wired(`node --test ${PROVENANCE}.off ${RELEASE}`).join("\n"), /does not name scripts\/release-provenance\.node-test\.mjs/);
  assert.match(wired(`node --test ./${PROVENANCE} ${RELEASE}`).join("\n"), /does not name scripts\/release-provenance\.node-test\.mjs/);
  assert.match(wired(`node --test ${INSTALL} ${RELEASE}`).join("\n"), /does not name scripts\/release-provenance\.node-test\.mjs/);
});

test("a flag, a shell operator or a glob in the script is refused even when both suites are named", () => {
  // Each of these names both suites and would still run none, some or
  // unnamed files, or could no longer fail.
  assert.match(wired(`node --test --test-name-pattern flag ${PROVENANCE} ${RELEASE}`).join("\n"), /carries `--test-name-pattern`/);
  assert.match(wired(`node --test ${PROVENANCE} ${RELEASE} || true`).join("\n"), /carries `\|\|`/);
  assert.match(wired(`node --test ${PROVENANCE} ${RELEASE} scripts/release-provenance*.node-test.mjs`).join("\n"), /carries `scripts\/release-provenance\*\.node-test\.mjs`/);
  assert.match(wired(`vitest run ${PROVENANCE} ${RELEASE}`).join("\n"), /does not start with `node --test`/);
  assert.match(wired(`node ${PROVENANCE} ${RELEASE}`).join("\n"), /does not start with `node --test`/);
});

test("pnpm test must chain the script as its own unmasked step", () => {
  const plain = `node --test ${PROVENANCE} ${RELEASE}`;
  assert.match(wired(plain, "node scripts/test-floor.mjs && pnpm test:ci-scope").join("\n"), /does not chain `pnpm test:mac-updater`/);
  assert.match(wired(plain, "pnpm test:mac-updater || true && pnpm test:ci-scope").join("\n"), /does not chain `pnpm test:mac-updater`/);
  assert.match(wired(plain, "pnpm test:mac-updater-old && pnpm test:ci-scope").join("\n"), /does not chain `pnpm test:mac-updater`/);
  assert.deepEqual(gateWiringProblems({ "test:mac-updater": plain }, "test:mac-updater", [PROVENANCE]), [
    "`pnpm test` does not chain `pnpm test:mac-updater` as its own step, so hosted CI never runs it",
  ]);
  assert.deepEqual(gateWiringProblems({ test: "pnpm test:mac-updater" }, "test:mac-updater", [PROVENANCE]), [
    "package.json has no test:mac-updater script",
  ]);
});

test("an opt-in file is refused in any step that reaches it without the switch", () => {
  const reaches = (command) => optInProblems({ probe: command }, INSTALL, OPT_IN);
  const refusal = [`probe reaches ${INSTALL} without ${OPT_IN}, so it would only report a skip`];
  assert.deepEqual(reaches(`node --test ${INSTALL}`), refusal);
  assert.deepEqual(reaches(`node --test ./${INSTALL}`), refusal, "a ./ prefix names the same file");
  assert.deepEqual(reaches(`node ${INSTALL}`), refusal, "a node:test file also runs when executed directly");
  assert.deepEqual(reaches("node --test scripts/release-provenance*.node-test.mjs"), refusal, "a glob that covers it");
  assert.deepEqual(reaches('node --test "scripts/*.node-test.mjs"'), refusal, "a quoted glob that covers it");
  assert.deepEqual(reaches("node --test **/*.mjs"), refusal);
  // The switch belongs to the step that runs the file, not to a neighbour.
  assert.deepEqual(reaches(`${OPT_IN} node --version && node --test ${INSTALL}`), refusal);
  assert.deepEqual(reaches(`${OPT_IN}0 node --test ${INSTALL}`), refusal, "the switch is a whole token");
  assert.deepEqual(reaches(`${OPT_IN} node --test ${INSTALL}`), []);
  assert.deepEqual(reaches(`node --test ${PROVENANCE} ${RELEASE}`), []);
  assert.deepEqual(reaches("node --test scripts/update-*.node-test.mjs"), [], "a glob that cannot cover it");
  assert.deepEqual(reaches("node --test electron/*.node-test.mjs"), []);
  assert.deepEqual(reaches("oxlint scripts/**/*.mjs"), [], "a glob outside a test run does not run the file");
});

// The two release-store provenance suites sat outside `pnpm test` from the day
// PR #1539 added them.  This file is named by test:ci-scope, not by
// test:mac-updater, so losing the tail of that long line fails here; the
// matching case in scripts/harness-release.node-test.mjs watches this file's
// own wiring from inside test:mac-updater.
test("the repo gate runs the release-store provenance suites", () => {
  assert.deepEqual(gateWiringProblems(SCRIPTS, "test:mac-updater", [PROVENANCE, RELEASE]), []);
});

// The real-install qualification needs the network and the pinned pnpm, so it
// stays opt-in and out of every default script.
test("no script reaches the opt-in install qualification without its switch", () => {
  assert.deepEqual(optInProblems(SCRIPTS, INSTALL, OPT_IN), []);
});
