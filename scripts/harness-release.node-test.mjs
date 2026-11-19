import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gateWiringProblems } from "./gate-wiring.mjs";
import { flag } from "./harness-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A flag's value is the next token ONLY when that token is a value: with
// "promote C --version --build X", the string "--build" must never be
// stamped as the release version.
test("flag returns the value only when a real value follows", () => {
  assert.equal(flag(["promote", "C", "--version", "1.2.3", "--build", "202611030400"], "--version"), "1.2.3");
  assert.equal(flag(["promote", "C", "--version", "1.2.3", "--build", "202611030400"], "--build"), "202611030400");
  assert.equal(flag(["promote", "C", "--version", "--build", "X"], "--version"), undefined, "the next flag is not a value");
  assert.equal(flag(["promote", "C", "--version"], "--version"), undefined, "a missing value is undefined");
  assert.equal(flag(["promote", "C"], "--version"), undefined, "an absent flag is undefined");
  assert.equal(flag(["--repo", "--version", "1.0.0"], "--version"), "1.0.0", "a later flag still resolves");
});

// This file cannot guard its own place in test:mac-updater: a test that is
// not run cannot fail.  scripts/gate-wiring.node-test.mjs guards it from
// test:ci-scope, and this case guards that file in return, so dropping either
// script line fails a test in the other.  Dropping both at once, or `pnpm
// test` leaving the workflow, is beyond what two files can see.
test("the gate-wiring pin itself runs in the repo gate", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  assert.deepEqual(gateWiringProblems(scripts, "test:ci-scope", ["scripts/gate-wiring.node-test.mjs"]), []);
});
