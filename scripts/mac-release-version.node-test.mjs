import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MARKETING_VERSION,
  MERGE_STAMP_TIME_ZONE,
  appVersionPolicy,
  mergeStampFor,
  ownPatch,
  planMacReleaseVersion,
} from "./mac-release-version.mjs";

// The owner's own example: a merge at 2:25 PM on Oct 29 is 202610291425.
// 19:25Z is 2:25 PM in Chicago that day, which is CDT (UTC-5).
const STAMP = "202610291425";

test("the merge stamp is the commit's Chicago time", () => {
  assert.equal(mergeStampFor("2026-10-29T19:25:00Z"), STAMP);
  assert.equal(mergeStampFor(new Date("2026-10-29T19:25:00Z")), STAMP);
});

test("the stamp follows daylight saving instead of a fixed offset", () => {
  // January is CST (UTC-6), so the same wall-clock hour is an hour later
  // in the UTC instant than in October.  A fixed offset would plan 202601150305.
  assert.equal(mergeStampFor("2026-01-15T08:05:00Z"), "202601150205");
  assert.equal(mergeStampFor("2026-10-29T19:25:00Z"), "202610291425");
  assert.equal(MERGE_STAMP_TIME_ZONE, "America/Chicago");
});

test("midnight is hour zero, not hour twenty-four", () => {
  assert.equal(mergeStampFor("2026-01-15T06:00:00Z"), "202601150000");
});

test("an unusable date is refused", () => {
  for (const bad of ["", "not a date", NaN, undefined, null]) {
    assert.throws(() => mergeStampFor(bad), /not a usable date/);
  }
});

test("a fresh commit plans the merge stamp itself", () => {
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: [],
    macBuilds: [],
    complete: true,
  });
  assert.deepEqual(plan, { version: DEFAULT_MARKETING_VERSION, build: STAMP, source: "shared plan" });
  assert.equal(plan.version, "0.1.0");
});

test("the iOS build of the same commit does not push the Mac plan up", () => {
  // This is the whole point of the platform rule: the iOS ship of this
  // commit published 202610291425, so the inventory moved.  The Mac build of
  // the SAME commit still carries 202610291425, or the two platforms would
  // disagree by one.
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: [STAMP],
    macBuilds: [],
    complete: true,
  });
  assert.equal(plan.build, STAMP);
});

test("a rebuild of the same commit on the Mac takes the highest plus one", () => {
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: [STAMP],
    macBuilds: [STAMP],
    complete: true,
  });
  assert.equal(plan.build, "202610291426");
});

test("a newer build anywhere holds the floor up", () => {
  // The Mac release of a commit that is behind main must not ship a build
  // number that a later release already used.
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: ["202611010000"],
    macBuilds: [],
    complete: true,
  });
  assert.equal(plan.build, "202611010001");
});

test("an extra floor joins the max", () => {
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: [],
    macBuilds: [],
    extraFloors: ["202610291400"],
    complete: true,
  });
  assert.equal(plan.build, STAMP);
});

test("an incomplete inventory refuses instead of planning a guess", () => {
  assert.throws(
    () =>
      planMacReleaseVersion({
        mergeStamp: STAMP,
        iosBuilds: [],
        macBuilds: [],
        complete: false,
      }),
    /complete build inventory required/,
  );
});

test("the exact overrides are honoured exactly", () => {
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    iosBuilds: [],
    macBuilds: [],
    complete: true,
    forcedVersion: "1.2.3",
    forcedBuild: "999888777",
  });
  assert.deepEqual(plan, { version: "1.2.3", build: "999888777", source: "forced" });
});

test("a forced build that recreates the retired 1.0.N (N) form is refused", () => {
  assert.throws(
    () =>
      planMacReleaseVersion({
        mergeStamp: STAMP,
        complete: true,
        forcedVersion: "1.0.5",
        forcedBuild: "5",
      }),
    /retired 1\.0\.N \(N\) form/,
  );
});

test("a release version that is not x.y.z is refused", () => {
  assert.throws(
    () =>
      planMacReleaseVersion({
        mergeStamp: STAMP,
        complete: true,
        marketingVersion: "0.1",
      }),
    /not x\.y\.z/,
  );
});

test("a shared build the planner already produced is used as it stands", () => {
  const plan = planMacReleaseVersion({
    mergeStamp: STAMP,
    sharedBuild: "202610291425",
    complete: true,
  });
  assert.equal(plan.build, "202610291425");
  assert.throws(
    () => planMacReleaseVersion({ mergeStamp: STAMP, sharedBuild: "not-a-number", complete: true }),
    /not a number/,
  );
});

test("ownPatch reads the patch of a three-part version only", () => {
  assert.equal(ownPatch("0.1.0"), 0);
  assert.equal(ownPatch("1.0.2358"), 2358);
  assert.equal(ownPatch("1.0"), null);
  assert.equal(ownPatch(null), null);
});

test("the fixed marketing version comes from apps.json", () => {
  const policy = appVersionPolicy(process.cwd(), "botfleet");
  assert.equal(policy.marketingVersion, "0.1.0");
  assert.equal(policy.bundleId, "app.botfleet.ios");
  assert.throws(() => appVersionPolicy(process.cwd(), "no-such-app"), /no app named/);
});
