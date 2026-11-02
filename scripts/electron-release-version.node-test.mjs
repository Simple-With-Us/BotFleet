import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORDERING_VERSION_PREFIX,
  orderingVersion,
  planElectronReleaseVersion,
  resolveElectronReleaseVersion,
} from "./electron-release-version.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const STAMP = "202610291425";

test("the app version carries the build in the patch", () => {
  // The Electron updater orders releases by semver on the app version alone
  // (electron/vendor/electron-updater.cjs), so the build has to travel inside
  // it.  The patch is the slot the retired 1.0.<commit_count> scheme used.
  assert.equal(orderingVersion({ version: "0.1.0", build: STAMP }), "1.0.202610291425");
  assert.equal(ORDERING_VERSION_PREFIX, "1.0");
});

/**
 * Semver precedence for plain x.y.z versions, the way electron-updater
 * compares them:  the numeric parts, not the strings.  "1.0.202610291425"
 * sorts ABOVE "1.0.2143" as versions and below it as text, and only the first
 * answer is the one the updater uses.
 */
function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

test("the app version orders two releases of the same marketing version", () => {
  const first = orderingVersion({ version: "0.1.0", build: "202610291425" });
  const second = orderingVersion({ version: "0.1.0", build: "202610291426" });
  const later = orderingVersion({ version: "0.1.0", build: "202611040000" });
  assert.ok(compareVersions(first, second) < 0, `${first} must sort below ${second}`);
  assert.ok(compareVersions(second, later) < 0, `${second} must sort below ${later}`);
});

test("the app version sorts above every version the fleet has shipped", () => {
  // The transition, and it has two parts.  The last published release's feed
  // says 0.1.38, and the owner's Mac has 1.0.31 installed (BF-2458).  The
  // updater offers an update only when the feed version is GREATER than the
  // installed one, and it sets no allowDowngrade, so a feed version below
  // either of those would strand every install.
  const appVersion = orderingVersion({ version: "0.1.0", build: STAMP });
  assert.ok(compareVersions(appVersion, "0.1.38") > 0, `${appVersion} must sort above 0.1.38`);
  assert.ok(compareVersions(appVersion, "1.0.31") > 0, `${appVersion} must sort above 1.0.31`);
  assert.ok(compareVersions(appVersion, "1.0.2143") > 0, `${appVersion} must sort above 1.0.2143`);
});

test("the app version does not follow the marketing version's line", () => {
  // A 0.1.<build> app version would be a downgrade against the installed
  // 1.0.31, so the ordering prefix is not the marketing version's prefix.
  assert.notEqual(orderingVersion({ version: "0.1.0", build: STAMP }).split(".")[0], "0");
});

test("a marketing version that is not x.y.z is refused", () => {
  for (const bad of ["0.1", "0.1.0-beta", "", "v0.1.0"]) {
    assert.throws(() => orderingVersion({ version: bad, build: STAMP }), /not x\.y\.z/);
  }
});

test("a build that is not a number is refused", () => {
  for (const bad of ["202610291425.1", "abc", "", "2026-10-29"]) {
    assert.throws(() => orderingVersion({ version: "0.1.0", build: bad }), /not a number/);
  }
});

test("the release carries the marketing version, the build and the app version", () => {
  const plan = planElectronReleaseVersion({ version: "0.1.0", build: STAMP });
  assert.deepEqual(plan, {
    version: "0.1.0",
    build: STAMP,
    appVersion: "1.0.202610291425",
  });
});

test("the resolved plan answers the policy version, the build and the app version", () => {
  // A forced build skips the inventory read, so this exercises the whole
  // path offline:  the merge stamp comes from the commit, the marketing
  // version from apps.json, and the app version from the two.
  const plan = resolveElectronReleaseVersion({ repoRoot, sha: "HEAD", forcedBuild: STAMP });
  assert.equal(plan.version, "0.1.0");
  assert.equal(plan.build, STAMP);
  assert.equal(plan.appVersion, `1.0.${STAMP}`);
  assert.match(plan.mergeStamp, /^[1-9][0-9]{11}$/);
});

test("the CLI prints the three values the release workflow pins", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "electron-release-version.mjs"), "--repo-root", repoRoot, "--sha", "HEAD", "--build", STAMP],
    { encoding: "utf8", cwd: repoRoot },
  );
  const values = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(values.version, "0.1.0");
  assert.equal(values.build, STAMP);
  assert.equal(values.app_version, `1.0.${STAMP}`);
  assert.match(values.merge_stamp, /^[1-9][0-9]{11}$/);
});

test("the CLI refuses an unknown argument instead of guessing", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "electron-release-version.mjs"), "--nonsense"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    /unknown argument/,
  );
});

test("the resolver imports nothing the release plan job does not have", () => {
  // The plan job runs in a workflow that never installs dependencies
  // (release.yml's prepare job has no install step), so an import of a
  // third-party package here would die with ERR_MODULE_NOT_FOUND and the
  // release could not plan a build at all.
  const source = readFileSync(path.join(repoRoot, "scripts", "electron-release-version.mjs"), "utf8");
  for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) {
    assert.ok(
      specifier.startsWith("node:") || specifier.startsWith("./"),
      `the release plan path may not import ${specifier}`,
    );
  }
});
