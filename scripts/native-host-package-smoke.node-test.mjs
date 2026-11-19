// The native host package smoke's own tests.
//
// The smoke itself runs on macOS only, because the package can only be built there.  Every rule it
// applies before it builds anything, and every rule it applies to what comes back, is decided here,
// on every host, so the rules are proved where CI can see them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IDENTITY_KEYS,
  identityProblems,
  nativeHostSmokeBuildNumber,
  receiptProblems,
  runNativeHostPackageSmoke,
} from "./native-host-package-smoke.mjs";

const IDENTITY = {
  schemaVersion: 1,
  codeIdentifier: "BotFleetNativeHost",
  sourceCommit: "c".repeat(40),
  build: "202611181230",
  marketingVersion: "0.1.0",
  capabilities: ["identity-v1", "foreground-service-data-v1", "signal-drain-v1"],
  distribution: "unsigned-development",
  sourceDirty: false,
};

const RECEIPT = {
  artifact: "BotFleetNativeHost-0.1.0-202611181230-UNSIGNED.zip",
  artifactSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
  architectures: ["arm64", "x86_64"],
  distributable: false,
  notice: "NOT DISTRIBUTABLE",
  signatureVerified: false,
  identity: IDENTITY,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

test("the build number is the commit's own Central stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-native-host-build-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "stamp.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const date = "2026-11-18T18:30:00+00:00";
    execFileSync(
      "git",
      ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "stamp"],
      { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
    const build = nativeHostSmokeBuildNumber(root);
    // Twelve digits, and the same shape the shared release build carries.
    assert.match(build, /^[1-9][0-9]{11}$/);
    // 6:30 PM UTC is 12:30 PM in America/Chicago, and the stamp is that local time.
    assert.equal(build, "202611181230");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsigned receipt that says the right things has no problems", () => {
  assert.deepEqual(receiptProblems(RECEIPT, { source: IDENTITY.sourceCommit, build: IDENTITY.build }), []);
});

test("a receipt that claims the artifact is distributable is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.distributable = true;
  assert.match(receiptProblems(receipt).join("\n"), /not distributable/);
});

test("a receipt that does not say NOT DISTRIBUTABLE is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.notice = "Notarized container; installation is separate";
  assert.match(receiptProblems(receipt).join("\n"), /NOT DISTRIBUTABLE/);
});

test("a signed artifact where an unsigned one belongs is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.artifact = "BotFleetNativeHost-0.1.0-202611181230.dmg";
  assert.match(receiptProblems(receipt).join("\n"), /unsigned archive/);
});

test("a receipt whose distribution is not the unsigned one is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.identity.distribution = "developer-id";
  assert.match(receiptProblems(receipt).join("\n"), /not unsigned-development/);
});

test("a receipt with no arm64 slice is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.architectures = ["x86_64"];
  assert.match(receiptProblems(receipt).join("\n"), /no arm64 slice/);
});

test("a receipt that says the signature was verified is refused", () => {
  const receipt = clone(RECEIPT);
  receipt.signatureVerified = true;
  assert.match(receiptProblems(receipt).join("\n"), /signature was verified/);
});

test("a receipt whose source or build is not the one asked for is refused", () => {
  const receipt = clone(RECEIPT);
  const problems = receiptProblems(receipt, { source: "d".repeat(40), build: "202611181231" }).join("\n");
  assert.match(problems, /source/);
  assert.match(problems, /build/);
});

test("a missing receipt is a problem, not a crash", () => {
  assert.match(receiptProblems(null).join("\n"), /no receipt/);
});

test("an identity that agrees field for field has no problems", () => {
  assert.deepEqual(identityProblems(IDENTITY, clone(IDENTITY)), []);
});

test("an identity that differs in one field is refused, and the field is named", () => {
  const reported = clone(IDENTITY);
  reported.build = "202601010000";
  const problems = identityProblems(IDENTITY, reported).join("\n");
  assert.match(problems, /identity build differs/);
  assert.doesNotMatch(problems, /identity sourceCommit differs/);
});

test("an identity the packaged executable did not report at all is refused", () => {
  assert.match(identityProblems(IDENTITY, null).join("\n"), /identity schemaVersion differs/);
});

test("the identity fields are the ones the packager writes", () => {
  assert.deepEqual(IDENTITY_KEYS, [
    "schemaVersion",
    "codeIdentifier",
    "sourceCommit",
    "build",
    "marketingVersion",
    "capabilities",
    "distribution",
    "sourceDirty",
  ]);
});

test("a host that is not macOS skips with a reason, and builds nothing", () => {
  const report = runNativeHostPackageSmoke({
    platform: "linux",
    run: () => assert.fail("the smoke ran a command on a host that cannot build the package"),
  });
  assert.equal(report.status, "skipped");
  assert.match(report.reason, /needs macOS/);
  assert.deepEqual(report.problems, []);
});

test("the native-release chain runs this file, and hosted CI runs the chain", () => {
  // vitest does not collect *.node-test.mjs.  Hosted CI runs `pnpm test`, which only reaches a
  // node:test file that package.json names, so these rules are only proved when both name it.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:native-release"], /scripts\/native-host-package-smoke\.node-test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:native-release/);
});
