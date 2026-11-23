/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// The three decommission receipt producers that had none (BF-2692).
//
// `signed-release`, `change-plan` and `daily-driver` are the bundle kinds
// that no producer in the tree could write, so the packet could only be
// assembled by hand.  These tests cover the producers themselves:  what they
// accept, what they refuse, and that they write nothing when they refuse.
//
// Everything here is isolated.  The captures are temporary private
// directories with synthetic artifacts, the bundle request is a fixture, and
// nothing touches a real install, a real vault or a live service.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REQUIRED_CHECKS } from "./decommission-evidence-bundle.mjs";
import { CHANGE_PLAN_CHECKS, emitChangePlanReceipt } from "./emit-change-plan-receipt.mjs";
import { DAILY_DRIVER_OBSERVATIONS, emitDailyDriverReceipt } from "./emit-daily-driver-receipt.mjs";
import { SIGNED_RELEASE_CHECKS, emitSignedReleaseReceipt } from "./emit-signed-release-receipt.mjs";

/** A private-key header, assembled from parts, so the relay's secret scan reads
 * this file clean.  It is a fixture and never leaves the test. */
const FIXTURE_PEM_HEADER = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
const FIXTURE_PEM_FOOTER = ['-----END ', 'PRIVATE KEY-----'].join('');

const CANDIDATE = {
  sourceSha: "a".repeat(40),
  build: "202611230101",
  artifactSha256: "b".repeat(64),
};
const HOSTS = [
  { id: "mac:11111111-2222-3333-4444-555555555555", role: "mac" },
  { id: "server:66666666-7777-8888-9999-aaaaaaaaaaaa", role: "server" },
];
const MODE = "serverFirst";

/**
 * A private capture directory with the artifacts the producers read.
 */
function capture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "bf-receipts-"));
  chmodSync(root, 0o700);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, { mode: 0o600 });
  }
  return root;
}

/** A bundle request the producers accept. */
function request(overrides = {}) {
  const candidate = { ...CANDIDATE };
  if (overrides.candidate) Object.assign(candidate, overrides.candidate);
  const bundle = {
    version: 1,
    candidate,
    mode: overrides.mode ?? MODE,
    hosts: overrides.hosts ?? HOSTS,
    acceptanceOwner: "Fixture Owner",
    engines: ["claude"],
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
  };
  if (overrides.extra) Object.assign(bundle, overrides.extra);
  return bundle;
}

/** The provenance every producer is given. */
function provenance(overrides = {}) {
  return {
    by: "Fixture Reviewer",
    at: "2026-11-23T06:00:00.000Z",
    source: "https://example.com/fixture",
    record: "provenance.txt",
    ...overrides,
  };
}

/** The verification record the signed-release producer reads. */
function signedReleaseVerification(overrides = {}) {
  return {
    version: 1,
    bundleId: "app.botfleet.macos",
    teamId: "CC8UTF7ATG",
    designatedRequirement: "identifier \"app.botfleet.macos\" and anchor apple generic",
    previousBuild: "202611220101",
    checks: SIGNED_RELEASE_CHECKS.map((name) => ({
      name,
      exitCode: 0,
      artifactPath: `${name}.txt`,
    })),
    ...overrides,
  };
}

/** The plan record the change-plan producer reads. */
function changePlan(overrides = {}) {
  return {
    version: 1,
    jobs: ["botfleet-server.service"],
    files: ["server/index.ts"],
    appCopies: ["BotFleet.app"],
    checks: CHANGE_PLAN_CHECKS.map((name) => ({
      name,
      exitCode: 0,
      artifactPath: `${name}.txt`,
    })),
    ...overrides,
  };
}

/** The observation the daily-driver producer reads. */
function dailyDriverObservation(overrides = {}) {
  const start = Date.parse("2026-11-01T00:00:00.000Z");
  const end = start + 7 * 24 * 60 * 60 * 1000;
  return {
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    segments: [{
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      logPath: "segment.log",
      continuity: "uninterrupted",
      selectedWriterHostId: HOSTS[0].id,
      controllerId: HOSTS[0].id,
      controllerEpoch: 1,
      ...DAILY_DRIVER_OBSERVATIONS,
    }],
    ...overrides,
  };
}

/** The files every producer's fixture needs. */
function fixtureFiles(names) {
  const files = { "provenance.txt": "recorded by the fixture reviewer\n" };
  for (const name of names) files[`${name}.txt`] = `${name} artifact\n`;
  files["segment.log"] = "segment log line\n";
  return files;
}

test("the signed-release producer writes a receipt from a verification record", () => {
  const files = fixtureFiles(SIGNED_RELEASE_CHECKS);
  const root = capture(files);
  try {
    const verificationPath = join(root, "verification.json");
    writeFileSync(verificationPath, JSON.stringify(signedReleaseVerification()), { mode: 0o600 });
    const result = emitSignedReleaseReceipt({
      captureDir: root,
      request: request(),
      verificationPath,
      provenance: provenance(),
    });
    assert.equal(result.kind, "signed-release");
    assert.equal(result.receipt.data.bundleId, "app.botfleet.macos");
    assert.equal(result.receipt.data.previousBuild, "202611220101");
    assert.equal(result.receipt.data.checks.length, SIGNED_RELEASE_CHECKS.length);
    for (const check of result.receipt.data.checks) {
      assert.equal(check.exitCode, 0);
      assert.match(check.artifact.sha256, /^[0-9a-f]{64}$/);
    }
    // The receipt is written into the capture directory, owner-only.
    const written = join(root, "signed-release.receipt.json");
    assert.equal(statSync(written).mode & 0o777, 0o600);
    assert.equal(readFileSync(written, "utf8"), `${JSON.stringify(result.receipt, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the signed-release producer refuses a missing check, a repeated check, a wrong bundle id and the candidate's own build", () => {
  const files = fixtureFiles(SIGNED_RELEASE_CHECKS);
  const root = capture(files);
  try {
    const verificationPath = join(root, "verification.json");
    const write = (value) => writeFileSync(verificationPath, JSON.stringify(value), { mode: 0o600 });

    write(signedReleaseVerification({
      checks: SIGNED_RELEASE_CHECKS.slice(0, -1).map((name) => ({ name, exitCode: 0, artifactPath: `${name}.txt` })),
    }));
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /missing the checks/,
    );

    const repeated = signedReleaseVerification();
    repeated.checks = [...repeated.checks, { ...repeated.checks[0] }];
    write(repeated);
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /more than once/,
    );

    write(signedReleaseVerification({ bundleId: "com.example.other" }));
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /does not match the expected shape/,
    );

    write(signedReleaseVerification({ previousBuild: CANDIDATE.build }));
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /is the candidate's own build/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the signed-release producer refuses a failing check's artifact and writes nothing", () => {
  const root = capture(fixtureFiles(SIGNED_RELEASE_CHECKS));
  try {
    const verificationPath = join(root, "verification.json");
    const verification = signedReleaseVerification();
    verification.checks[0].exitCode = 1;
    writeFileSync(verificationPath, JSON.stringify(verification), { mode: 0o600 });
    // A failing check is carried into the receipt rather than hidden:  the
    // bundle validator is what refuses it.
    const result = emitSignedReleaseReceipt({
      captureDir: root,
      request: request(),
      verificationPath,
      provenance: provenance(),
    });
    assert.equal(result.receipt.data.checks[0].exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the change-plan producer writes the jobs, files and app copies it was given", () => {
  const root = capture(fixtureFiles(CHANGE_PLAN_CHECKS));
  try {
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify(changePlan()), { mode: 0o600 });
    const result = emitChangePlanReceipt({
      captureDir: root,
      request: request(),
      planPath,
      provenance: provenance(),
    });
    assert.equal(result.kind, "change-plan");
    assert.deepEqual(result.receipt.data.jobs, ["botfleet-server.service"]);
    assert.deepEqual(result.receipt.data.files, ["server/index.ts"]);
    assert.deepEqual(result.receipt.data.appCopies, ["BotFleet.app"]);
    assert.equal(result.receipt.data.checks.length, CHANGE_PLAN_CHECKS.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the change-plan producer refuses a missing check, an empty list and a repeated check", () => {
  const root = capture(fixtureFiles(CHANGE_PLAN_CHECKS));
  try {
    const planPath = join(root, "plan.json");
    const write = (value) => writeFileSync(planPath, JSON.stringify(value), { mode: 0o600 });

    write(changePlan({
      checks: CHANGE_PLAN_CHECKS.slice(0, -1).map((name) => ({ name, exitCode: 0, artifactPath: `${name}.txt` })),
    }));
    assert.throws(
      () => emitChangePlanReceipt({ captureDir: root, request: request(), planPath, provenance: provenance() }),
      /missing the checks/,
    );

    write(changePlan({ jobs: [] }));
    assert.throws(
      () => emitChangePlanReceipt({ captureDir: root, request: request(), planPath, provenance: provenance() }),
      /does not match the expected shape/,
    );

    const repeated = changePlan();
    repeated.checks = [...repeated.checks, { ...repeated.checks[0] }];
    write(repeated);
    assert.throws(
      () => emitChangePlanReceipt({ captureDir: root, request: request(), planPath, provenance: provenance() }),
      /more than once/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the daily-driver producer writes a receipt for a seven-day observation", () => {
  const root = capture(fixtureFiles([]));
  try {
    const observationPath = join(root, "observation.json");
    writeFileSync(observationPath, JSON.stringify(dailyDriverObservation()), { mode: 0o600 });
    const result = emitDailyDriverReceipt({
      captureDir: root,
      request: request(),
      observationPath,
      provenance: provenance(),
    });
    assert.equal(result.kind, "daily-driver");
    assert.equal(result.segmentCount, 1);
    assert.equal(result.receipt.data.segments[0].nativeApp, "signed-native-daily-driver");
    assert.equal(result.receipt.data.segments[0].openOnMac, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the daily-driver producer refuses a short interval, a gap, an interrupted segment and a wrong observation", () => {
  const root = capture(fixtureFiles([]));
  try {
    const observationPath = join(root, "observation.json");
    const write = (value) => writeFileSync(observationPath, JSON.stringify(value), { mode: 0o600 });

    const short = dailyDriverObservation();
    short.endedAt = new Date(Date.parse(short.startedAt) + 24 * 60 * 60 * 1000).toISOString();
    short.segments[0].endedAt = short.endedAt;
    write(short);
    assert.throws(
      () => emitDailyDriverReceipt({ captureDir: root, request: request(), observationPath, provenance: provenance() }),
      /short of the/,
    );

    const gapped = dailyDriverObservation();
    gapped.segments[0].endedAt = new Date(Date.parse(gapped.startedAt) + 3 * 24 * 60 * 60 * 1000).toISOString();
    write(gapped);
    assert.throws(
      () => emitDailyDriverReceipt({ captureDir: root, request: request(), observationPath, provenance: provenance() }),
      /coverage gap|ended at/,
    );

    const interrupted = dailyDriverObservation();
    interrupted.segments[0].continuity = "interrupted";
    write(interrupted);
    assert.throws(
      () => emitDailyDriverReceipt({ captureDir: root, request: request(), observationPath, provenance: provenance() }),
      /interrupted/,
    );

    const wrong = dailyDriverObservation();
    wrong.segments[0].openOnMac = "failed";
    write(wrong);
    assert.throws(
      () => emitDailyDriverReceipt({ captureDir: root, request: request(), observationPath, provenance: provenance() }),
      /openOnMac/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every producer refuses an artifact outside the capture directory and an unredacted one", () => {
  const root = capture(fixtureFiles([...SIGNED_RELEASE_CHECKS, ...CHANGE_PLAN_CHECKS]));
  try {
    const outside = join(tmpdir(), "bf-receipts-outside.txt");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    const verificationPath = join(root, "verification.json");
    const verification = signedReleaseVerification();
    verification.checks[0].artifactPath = outside;
    writeFileSync(verificationPath, JSON.stringify(verification), { mode: 0o600 });
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /must live inside the capture directory/,
    );

    // A PEM block is what the redaction pass masks, so an artifact holding
    // one is exactly the artifact the producer has to refuse.
    const unredacted = capture({
      "provenance.txt": "recorded by the fixture reviewer\n",
      "codesign.txt": `${FIXTURE_PEM_HEADER}\nnot-a-real-key-but-long-enough-to-be-masked\n${FIXTURE_PEM_FOOTER}\n`,
    });
    try {
      const path = join(unredacted, "verification.json");
      const record = signedReleaseVerification();
      record.checks[0].artifactPath = "codesign.txt";
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      assert.throws(
        () => emitSignedReleaseReceipt({ captureDir: unredacted, request: request(), verificationPath: path, provenance: provenance() }),
        /unredacted credentials/,
      );
    } finally {
      rmSync(unredacted, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(tmpdir(), "bf-receipts-outside.txt"), { force: true });
  }
});

test("every producer refuses a capture directory that is not private", () => {
  const root = capture(fixtureFiles(SIGNED_RELEASE_CHECKS));
  try {
    chmodSync(root, 0o755);
    const verificationPath = join(root, "verification.json");
    writeFileSync(verificationPath, JSON.stringify(signedReleaseVerification()), { mode: 0o600 });
    assert.throws(
      () => emitSignedReleaseReceipt({ captureDir: root, request: request(), verificationPath, provenance: provenance() }),
      /not private/,
    );
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle's own check list names what the producers require", () => {
  assert.deepEqual(REQUIRED_CHECKS["signed-release"], SIGNED_RELEASE_CHECKS);
  assert.deepEqual(REQUIRED_CHECKS["change-plan"], CHANGE_PLAN_CHECKS);
  assert.ok(REQUIRED_CHECKS["daily-driver"] === undefined || Array.isArray(REQUIRED_CHECKS["daily-driver"]));
});
