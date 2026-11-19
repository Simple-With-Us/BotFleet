// The native host package smoke's own tests.
//
// The smoke itself runs on macOS only, because the package can only be built there.  Every rule it
// applies before it builds anything, and every rule it applies to what comes back, is decided here,
// on every host, so the rules are proved where CI can see them.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeHostIdentity } from "./native-host-artifact.mjs";
import {
  IDENTITY_KEYS,
  hostArchitecture,
  identityProblems,
  nativeHostSmokeBuildNumber,
  passLine,
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
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

test("an identity field that is missing on both sides is refused, not accepted", () => {
  // Two sides that both say nothing have not agreed about anything, and the field-for-field claim
  // would be false if this were accepted.  The field is removed from both sides here, because that
  // is the only input the missing-key rule can tell apart from a plain value difference.
  const claimed = clone(IDENTITY);
  const reported = clone(IDENTITY);
  delete claimed.sourceDirty;
  delete reported.sourceDirty;
  const problems = identityProblems(claimed, reported).join("\n");
  assert.match(problems, /identity sourceDirty differs/);
});

test("an identity field that is missing on the executable's side is refused", () => {
  const reported = clone(IDENTITY);
  delete reported.sourceDirty;
  assert.match(identityProblems(clone(IDENTITY), reported).join("\n"), /identity sourceDirty differs/);
});

test("an identity field that is missing on the receipt's side is refused", () => {
  const claimed = clone(IDENTITY);
  delete claimed.build;
  assert.match(identityProblems(claimed, clone(IDENTITY)).join("\n"), /identity build differs/);
});

test("the identity fields are the ones the packager writes", () => {
  // Derived from the packager's own identity construction rather than copied here:  the packager
  // writes the identity through encodeHostIdentity, which accepts exactly its own key set and
  // refuses anything else, so this list cannot drift away from what the product writes.
  const encoded = JSON.parse(encodeHostIdentity(IDENTITY).toString("utf8"));
  assert.deepEqual(IDENTITY_KEYS, Object.keys(encoded));
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

test("the PASS line carries the exact source commit, not a prefix", () => {
  // A run that cannot be tied to an exact commit is not evidence, and the receipt that holds the
  // full SHA is deleted with the temporary directory unless --keep is passed, so the line itself
  // has to carry it.
  const receipt = clone(RECEIPT);
  const line = passLine(receipt);
  assert.match(line, /PASS: BotFleetNativeHost-0\.1\.0-202611181230-UNSIGNED\.zip/);
  assert.match(line, /source [0-9a-f]{40}/);
  assert.match(line, /build 202611181230/);
  assert.match(line, /NOT DISTRIBUTABLE/);
  assert.doesNotMatch(line, /source c{12}[,.]/);
});

test("Node's architecture name is not the Mach-O slice name", () => {
  assert.equal(hostArchitecture("x64"), "x86_64");
  assert.equal(hostArchitecture("arm64"), "arm64");
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

/** A stand-in for the product's packager, the archive it writes and the executable inside it. */
function fakePackager({ source, build, identity, archiveBytes, binaryBytes, receiptOverrides = {} }) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (args[0] === "--identity") return JSON.stringify(identity);
    if (command === "git") return `${source}\n`;
    if (command === "/usr/bin/ditto") {
      const unpacked = args[3];
      mkdirSync(join(unpacked, "payload", "bin"), { recursive: true });
      writeFileSync(join(unpacked, "payload", "bin", "BotFleetNativeHost"), binaryBytes);
      return "";
    }
    // The packager itself:  it writes the receipt and the archive it names.
    const output = args[args.indexOf("--output") + 1];
    mkdirSync(output, { recursive: true });
    const name = `BotFleetNativeHost-0.1.0-${build}-UNSIGNED.zip`;
    writeFileSync(join(output, name), archiveBytes);
    const receipt = {
      artifact: name,
      artifactSha256: digest(archiveBytes),
      binarySha256: digest(binaryBytes),
      architectures: ["arm64", "x86_64"],
      distributable: false,
      notice: "NOT DISTRIBUTABLE",
      signatureVerified: false,
      identity,
      ...receiptOverrides,
    };
    writeFileSync(join(output, "artifact.json"), JSON.stringify(receipt));
    return `NOT DISTRIBUTABLE: ${name}\n`;
  };
  return { run, calls };
}

test("the macOS branch packages the checkout, opens the archive and asks the executable who it is", () => {
  const source = "e".repeat(40);
  const build = "202611181230";
  const identity = { ...IDENTITY, sourceCommit: source, build };
  const archiveBytes = Buffer.from("archive-bytes");
  const binaryBytes = Buffer.from("executable-bytes");
  const { run, calls } = fakePackager({ source, build, identity, archiveBytes, binaryBytes });

  const report = runNativeHostPackageSmoke({ platform: "darwin", run, build });

  assert.deepEqual(report.problems, []);
  assert.equal(report.status, "passed");
  assert.equal(report.receipt.identity.build, build);

  // The packager is the product's own CLI, with the flags it accepts.
  const packaged = calls.find((call) => call.args.includes("--unsigned-dev"));
  assert.ok(packaged, "the packager was not called");
  assert.equal(packaged.args[packaged.args.indexOf("--repo-root") + 1], process.cwd());
  assert.equal(packaged.args[packaged.args.indexOf("--build") + 1], build);
  assert.ok(packaged.args[packaged.args.indexOf("--output") + 1].endsWith("package"));

  // The archive is opened again, and the executable inside it is asked for its own identity.
  const extracted = calls.find((call) => call.command === "/usr/bin/ditto");
  assert.ok(extracted, "the archive was not opened");
  assert.deepEqual(extracted.args.slice(0, 3), ["-x", "-k", extracted.args[2]]);
  assert.ok(calls.some((call) => call.args[0] === "--identity"), "the executable was not asked who it is");
});

test("a receipt that names another build fails the macOS branch", () => {
  const source = "e".repeat(40);
  const identity = { ...IDENTITY, sourceCommit: source, build: "202611181230" };
  const { run } = fakePackager({
    source,
    build: "202611181230",
    identity,
    archiveBytes: Buffer.from("archive-bytes"),
    binaryBytes: Buffer.from("executable-bytes"),
    receiptOverrides: { identity: { ...identity, build: "202601010000" } },
  });

  const report = runNativeHostPackageSmoke({ platform: "darwin", run, build: "202611181230" });

  assert.equal(report.status, "failed");
  assert.match(report.problems.join("\n"), /the receipt says build 202601010000/);
});

test("an archive whose bytes are not the ones the receipt names fails the macOS branch", () => {
  const source = "e".repeat(40);
  const identity = { ...IDENTITY, sourceCommit: source, build: "202611181230" };
  const { run } = fakePackager({
    source,
    build: "202611181230",
    identity,
    archiveBytes: Buffer.from("archive-bytes"),
    binaryBytes: Buffer.from("executable-bytes"),
    receiptOverrides: { artifactSha256: "f".repeat(64) },
  });

  const report = runNativeHostPackageSmoke({ platform: "darwin", run, build: "202611181230" });

  assert.equal(report.status, "failed");
  assert.match(report.problems.join("\n"), /the archive hashes to/);
});

test("the packaged executable is not run when its bytes are not the bytes the receipt names", () => {
  // The proof comes before the use:  a substituted binary is never executed, so it can never
  // report an identity that the smoke would believe.
  const source = "e".repeat(40);
  const identity = { ...IDENTITY, sourceCommit: source, build: "202611181230" };
  const { run, calls } = fakePackager({
    source,
    build: "202611181230",
    identity,
    archiveBytes: Buffer.from("archive-bytes"),
    binaryBytes: Buffer.from("executable-bytes"),
    receiptOverrides: { binarySha256: "f".repeat(64) },
  });

  const report = runNativeHostPackageSmoke({ platform: "darwin", run, build: "202611181230" });

  assert.equal(report.status, "failed");
  assert.match(report.problems.join("\n"), /the unpacked executable hashes to/);
  assert.equal(
    calls.some((call) => call.args[0] === "--identity"),
    false,
    "the executable was run before the receipt was proved against its bytes",
  );
});

test("the native-release chain runs this file, and hosted CI runs the chain", () => {
  // vitest does not collect *.node-test.mjs.  Hosted CI runs `pnpm test`, which only reaches a
  // node:test file that package.json names, so these rules are only proved when both name it.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:native-release"], /scripts\/native-host-package-smoke\.node-test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:native-release/);
});
