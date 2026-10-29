// Compute the build version for a Mac/Windows/Linux build: 1.0.<commit_count>,
// the desktop release scheme.  (The iOS/TestFlight ship numbering is separate
// and lives in scripts/ios-fleet/version-plan.mjs:  the marketing version is
// the next patch on the App Store Connect train, the build number is the
// commit count.)
//
// Why a computed number rather than a hand-edited one: a build number is only
// useful if it cannot collide and cannot go backwards.  A human-typed semver can
// do both.  `git rev-list --count <sha>` cannot -- it is a pure function of the
// commit, so the same commit always yields the same build and every later commit
// is strictly greater.
//
// This script PRINTS the version.  It deliberately never writes package.json.
// The build passes the value on instead -- to electron-builder as
// extraMetadata, and to the server bundler as BOTFLEET_BUILD_VERSION -- because
// the provenance gate requires a pristine checkout: a version edited into the
// source file would make every build report sourceDirty and fail the very gate
// that proves the build came from a committed tree.
//
// THE TRAP THIS SCRIPT EXISTS TO AVOID:  `actions/checkout` defaults to
// fetch-depth 1.  On a shallow clone `git rev-list --count HEAD` returns 1, not
// the real history length -- so a missing fetch-depth: 0 would number every Mac
// build 1.0.1, and the scheme would look fine in CI while meaning nothing.  A
// shallow clone is therefore a hard failure, not a warning.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Why a version was chosen, or that it was refused. */
export function planVersion({ commitCount, floorVersion }) {
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    throw new Error(`commit count is not a usable build number: ${commitCount}`);
  }
  // Only compare against a plain x.y.z.  A prerelease, or a floor we cannot
  // parse, is left alone: inventing a floor from half a version string is how a
  // build ends up numbered below something already published.
  const floorPatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(floorVersion ?? "").trim())?.[3];
  if (floorPatch !== undefined && Number(floorPatch) > commitCount) {
    return { version: `1.0.${Number(floorPatch)}`, floored: true, commitCount, floor: floorVersion };
  }
  return { version: `1.0.${commitCount}`, floored: false, commitCount, floor: floorVersion ?? null };
}

/** The commit's position in history, refusing a clone too shallow to know it. */
export function commitCountFor(repoRoot, sha) {
  if (existsSync(join(repoRoot, ".git", "shallow"))) {
    throw new Error(
      `${repoRoot} is a shallow clone, so its history length is not the real commit count. ` +
        `Checkout with fetch-depth: 0 before resolving a build version.`,
    );
  }
  const out = execFileSync("git", ["-C", repoRoot, "rev-list", "--count", sha], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const count = Number(out);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`git rev-list --count ${sha} returned ${out}, which is not a build number`);
  }
  return count;
}

/** The version this build should carry, without touching the working tree. */
export function resolveBuildVersion(repoRoot, { sha = "HEAD", versionPath = "package.json" } = {}) {
  let floorVersion = null;
  try {
    floorVersion = JSON.parse(readFileSync(join(repoRoot, versionPath), "utf8")).version;
  } catch {
    // A build that cannot read the floor still gets a version; the floor only
    // exists to stop a regression, and refusing outright would be worse.
  }
  return planVersion({ commitCount: commitCountFor(repoRoot, sha), floorVersion });
}

// `file://${process.argv[1]}` looks correct and is not: on Windows argv[1] is
// `D:\repo\scripts\stamp-commit-version.mjs` while import.meta.url is
// `file:///D:/repo/scripts/stamp-commit-version.mjs`.  The comparison silently
// fails there, the CLI body never runs, and the script exits 0 having resolved
// nothing -- so the Windows artifact would keep the un-stamped version while
// macOS got the right one, and the release would disagree with itself.
// pathToFileURL is the only form that is right on both.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const repoRoot = process.argv[2] || process.cwd();
  // The local-build bypass the owner requires for every Mac build path: an
  // unstamped local build is a legitimate thing to want while iterating, and
  // the release workflows simply never set this.
  if (process.env.BOTFLEET_SKIP_VERSION_STAMP === "1") {
    console.error("version stamp skipped (BOTFLEET_SKIP_VERSION_STAMP=1)");
    process.exit(0);
  }
  try {
    const plan = resolveBuildVersion(repoRoot);
    if (plan.floored) {
      console.error(
        `floored: package.json version ${plan.floor} is higher than commit ${plan.commitCount}, ` +
          `so this build keeps ${plan.version}`,
      );
    }
    // stdout is the value; every human-readable note goes to stderr so a
    // workflow can capture the version without stripping anything.
    console.log(plan.version);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}