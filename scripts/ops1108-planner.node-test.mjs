// The OPS-1108 planner tests:  the shared commit-derived Mac and iOS plan,
// the disabled build path, and the synthetic receipt that shows both.
//
// Every case runs offline. No test here reads the store, contacts
// App Store Connect, or needs a clock: the merge stamp is named, the
// inventory is synthetic, and the receipt is produced from the same helpers
// the release planner uses.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nextSharedBuild } from "./ios-fleet/shared-build.mjs";
import { planMacReleaseVersion } from "./mac-release-version.mjs";
import {
  FIXTURE_COMMIT,
  FIXTURE_INVENTORY,
  FIXTURE_MERGE_STAMP,
  PLANNER_CREDENTIALS,
  REDACTED_VALUE,
  inputsFor,
  parseArgs,
  planReceipt,
} from "./ops1108-planner-receipt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCER = join(ROOT, "scripts", "ops1108-planner-receipt.mjs");
const FIXTURE_FILE = join(ROOT, "scripts", "ops1108-planner-receipt.fixture.json");

/** Read a repo source file as text. */
const read = (path) => readFileSync(path, "utf8");

/** The one plan both platforms must agree on, over the synthetic inventory. */
function sharedPlan(platform) {
  return nextSharedBuild({
    iosBuilds: FIXTURE_INVENTORY.iosBuilds,
    macBuilds: FIXTURE_INVENTORY.macBuilds,
    extraFloors: FIXTURE_INVENTORY.extraFloors,
    complete: true,
    mergeStamp: FIXTURE_MERGE_STAMP,
    platform,
  });
}

test("the iOS plan and the Mac plan of one commit carry the same build number", () => {
  const ios = sharedPlan("ios");
  const macos = sharedPlan("macos");
  assert.equal(ios.build, macos.build);
  assert.equal(ios.build, FIXTURE_MERGE_STAMP);
  // The Mac release planner asks the shared planner for the same commit, so
  // its own answer is the same number and not a second numbering scheme.
  const mac = planMacReleaseVersion({
    mergeStamp: FIXTURE_MERGE_STAMP,
    iosBuilds: FIXTURE_INVENTORY.iosBuilds,
    macBuilds: FIXTURE_INVENTORY.macBuilds,
    extraFloors: FIXTURE_INVENTORY.extraFloors,
    complete: true,
  });
  assert.equal(mac.build, ios.build);
  assert.equal(mac.version, "0.1.0");
});

test("the receipt names the same build on both platforms of one commit", () => {
  const receipt = planReceipt({
    commit: FIXTURE_COMMIT,
    mergeStamp: FIXTURE_MERGE_STAMP,
    ...FIXTURE_INVENTORY,
  });
  assert.equal(receipt.plans.ios.build, receipt.plans.macos.build);
  assert.equal(receipt.sharedBuild, receipt.plans.ios.build);
  assert.equal(receipt.mergeStamp, FIXTURE_MERGE_STAMP);
});

test("the checked-in fixture is the receipt the producer writes", () => {
  const fixture = JSON.parse(read(FIXTURE_FILE));
  const receipt = planReceipt({
    commit: FIXTURE_COMMIT,
    mergeStamp: FIXTURE_MERGE_STAMP,
    ...FIXTURE_INVENTORY,
  });
  assert.deepEqual(receipt, fixture);
});

test("the receipt is labelled a fixture and not hosted proof", () => {
  const receipt = JSON.parse(read(FIXTURE_FILE));
  assert.equal(receipt.fixture, true);
  assert.equal(receipt.hostedProof, false);
  assert.match(receipt.notice, /not proof that a hosted job ran/);
  assert.equal(receipt.inventory.kind, "synthetic");
});

test("the receipt carries no secret value and no environment value", () => {
  const sentinels = [
    "ops1108-sentinel-key-id",
    "ops1108-sentinel-dsn",
    "ops1108-sentinel-token",
  ];
  const dir = mkdtempSync(join(tmpdir(), "ops1108-receipt-"));
  try {
    const out = join(dir, "receipt.json");
    execFileSync(process.execPath, [PRODUCER, "--out", out], {
      encoding: "utf8",
      env: {
        ...process.env,
        ASC_KEY_ID: sentinels[0],
        SENTRY_DSN: sentinels[1],
        INFISICAL_TOKEN: sentinels[2],
      },
    });
    const text = read(out);
    for (const sentinel of sentinels) {
      assert.equal(text.includes(sentinel), false, `the receipt must not carry ${sentinel}`);
    }
    const receipt = JSON.parse(text);
    assert.equal(receipt.credentials.length, PLANNER_CREDENTIALS.length);
    for (const row of receipt.credentials) {
      assert.equal(row.value, REDACTED_VALUE);
      assert.equal(row.scope, "read");
      assert.ok(row.store.length > 0);
      assert.ok(row.grant.length > 0);
    }
    // A private key, a DSN or an auth token in the receipt would be the very
    // thing the fixture must not carry.
    assert.equal(text.includes("BEGIN "), false);
    assert.equal(text.includes("ingest.sentry.io"), false);
    assert.equal(/sntry[su]_/.test(text), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the receipt producer reads no environment value at all", () => {
  const source = read(PRODUCER);
  assert.equal(source.includes("process.env"), false);
});

test("the receipt producer performs no secret lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops1108-reader-"));
  try {
    // A reader seam that leaves a mark when it is asked for anything:  the
    // producer must not ask it for anything, because a receipt needs no
    // secret to be produced.
    const mark = join(dir, "the-reader-was-called");
    const reader = join(dir, "reader.sh");
    writeFileSync(reader, `#!/usr/bin/env bash\ntouch "${mark}"\nexit 3\n`);
    chmodSync(reader, 0o755);
    const out = join(dir, "receipt.json");
    execFileSync(process.execPath, [PRODUCER, "--out", out], {
      encoding: "utf8",
      env: { ...process.env, FLEET_INFISICAL_READER: reader },
    });
    assert.ok(existsSync(out), "the producer must still write its receipt");
    assert.equal(existsSync(mark), false, "the producer must not read a secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the disabled native build resolves no notarization credential", () => {
  const source = read(join(ROOT, "scripts", "mac-package.sh"));
  const lines = source.split("\n");
  const call = lines.findIndex((line) => line.trim() === "resolve_notary_credentials");
  assert.ok(call > -1, "mac-package.sh must resolve the notarization credentials");
  // The call sits inside the guard, so the skip-notarize build never reads
  // the API key or the notarytool profile.
  assert.equal(lines[call - 1].trim(), 'if [ "$SKIP_NOTARIZE" -eq 0 ]; then');
  assert.equal(lines[call + 1].trim(), "fi");
  // The reads live in the function the guard covers.
  const body = source.slice(source.indexOf("resolve_notary_credentials() {"));
  const bodyEnd = body.indexOf("\n}\n");
  const reads = body.slice(0, bodyEnd);
  assert.match(reads, /fleet_secret_get ASC_KEY_P8/);
  assert.match(reads, /fleet_secret_get NOTARY_PROFILE/);
});

test("the iOS ship path asks the shared planner for its own platform", () => {
  const source = read(join(ROOT, "scripts", "ios-fleet", "ship-testflight.sh"));
  // Without the platform the plan falls back to the legacy max + 1 rule and
  // the iOS and the Mac build of one commit can differ by one.
  assert.match(source, /plan-release-build[^\n]*--platform/);
  assert.match(source, /plan_platform="ios"/);
});

test("a flag with no value is refused instead of eating the next flag", () => {
  // `--out --sha` must not store the flag as the output path, because that
  // would shift every later option with no error at all.
  assert.throws(() => parseArgs(["--out", "--sha", "HEAD"]), /missing value for --out/);
  assert.throws(() => parseArgs(["--sha"]), /missing value for --sha/);
  assert.throws(() => parseArgs(["--repo-root", "--stamp", "202610290000"]), /missing value for --repo-root/);
});

test("a named SHA with no checkout is refused rather than answered with the fixture", () => {
  // The receipt must not describe a commit nobody asked about: a lone --sha
  // used to fall through to the synthetic fixture identity.
  assert.throws(() => inputsFor(parseArgs(["--sha", "abc123"])), /--sha requires --repo-root/);
  // The default still names the synthetic commit, and it says so.
  const synthetic = inputsFor(parseArgs([]));
  assert.equal(synthetic.commit, FIXTURE_COMMIT);
  assert.equal(synthetic.commitKind, "synthetic");
});

test("a flag that takes a value keeps its own value", () => {
  const args = parseArgs(["--out", "/tmp/receipt.json", "--stamp", "202610290000"]);
  assert.equal(args.out, "/tmp/receipt.json");
  assert.equal(args.stamp, "202610290000");
});
