import assert from "node:assert/strict";
import test from "node:test";

import { flag } from "./harness-release.mjs";

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
