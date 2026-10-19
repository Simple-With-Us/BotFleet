// Stamp 1.0.<commit_count> into package.json, the same scheme the iOS client
// ships under, so one number identifies a build on either platform.
//
// Why this runs instead of a hand-edited version: a build number is only
// useful if it cannot collide and cannot go backwards.  A human-typed semver
// can do both.  `git rev-list --count <sha>` cannot — it is a pure function of
// the commit, so every build of the same commit is identical and every later
// commit is strictly greater.
//
// The floor is the important part.  This is applied to a checkout that may
// already carry a higher number (a release branch, a cherry-pick, a rerun of
// an older commit), and a build that reports a *lower* number than something
// already shipped teaches every updater on every Mac that it is out of date.
// So the stamped number is max(commit_count, current patch), and a floor hit is
// reported rather than silently swallowed.
//
// THE TRAP THIS SCRIPT EXISTS TO AVOID:  `actions/checkout` defaults to
// fetch-depth 1.  On a shallow clone `git rev-list --count HEAD` returns 1, not
// the real history length — so a missing fetch-depth: 0 would stamp every
// single Mac build as 1.0.1, and the scheme would look fine in CI while
// meaning nothing.  A shallow clone is therefore a hard failure, not a warning.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Why a stamp was refused, or what it stamped. */
export function planVersion({ commitCount, currentVersion }) {
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    throw new Error(`commit count is not a usable build number: ${commitCount}`);
  }
  const next = `1.0.${commitCount}`;
  const current = String(currentVersion ?? "").trim();
  // Only compare against a plain x.y.z.  A prerelease or a hand-set version we
  // cannot parse is left alone: inventing a floor from half a version string
  // is how a build ends up numbered below something already published.
  const currentPatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)?.[3];
  if (currentPatch !== undefined) {
    const patch = Number(currentPatch);
    if (Number.isInteger(patch) && patch > commitCount) {
      return { version: `1.0.${patch}`, floored: true, commitCount, current };
    }
  }
  return { version: next, floored: false, commitCount, current };
}

/** The commit's position in history, refusing a clone too shallow to know it. */
export function commitCountFor(repoRoot, sha) {
  if (existsSync(join(repoRoot, ".git", "shallow"))) {
    throw new Error(
      `${repoRoot} is a shallow clone, so its history length is not the real commit count. ` +
        `Checkout with fetch-depth: 0 before stamping.`,
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

/** Stamp package.json in place.  Returns what happened, for the caller to log. */
export function stampCommitVersion(repoRoot, { sha = "HEAD", versionPath = "package.json" } = {}) {
  const file = join(repoRoot, versionPath);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const commitCount = commitCountFor(repoRoot, sha);
  const plan = planVersion({ commitCount, currentVersion: manifest.version });
  if (plan.version !== manifest.version) {
    // Two-space indent + trailing newline: the same shape npm and pnpm write,
    // so a stamped tree does not show as a formatting-only diff next time.
    writeFileSync(file, `${JSON.stringify({ ...manifest, version: plan.version }, null, 2)}\n`);
  }
  return { ...plan, previous: manifest.version, changed: plan.version !== manifest.version };
}

/** Apply a version that was computed upstream, without consulting git at all.
 *
 *  Downstream build jobs take this path rather than re-deriving.  Four jobs in
 *  release.yml re-checkout the same commit independently, and a stamp that each
 *  one recomputes is a stamp four times waiting to disagree — and the artifact
 *  set would ship one version for Mac and another for Windows. */
export function setVersion(repoRoot, version, { versionPath = "package.json" } = {}) {
  const file = join(repoRoot, versionPath);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const previous = manifest.version;
  const next = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(next)) {
    throw new Error(`refusing to stamp an unrecognised version: ${JSON.stringify(version)}`);
  }
  if (next !== previous) {
    writeFileSync(file, `${JSON.stringify({ ...manifest, version: next }, null, 2)}\n`);
  }
  return { version: next, previous, changed: next !== previous };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const repoRoot = process.argv[2] || process.cwd();
  // The local-build bypass the owner requires for every Mac build path: an
  // unstamped local build is a legitimate thing to want while iterating, and
  // the release workflows simply never set this.
  if (process.env.BOTFLEET_SKIP_VERSION_STAMP === "1") {
    console.log("version stamp skipped (BOTFLEET_SKIP_VERSION_STAMP=1)");
    process.exit(0);
  }
  const setIndex = process.argv.indexOf("--set");
  try {
    const result =
      setIndex !== -1
        ? setVersion(repoRoot, process.argv[setIndex + 1])
        : stampCommitVersion(repoRoot);
    const floor = result.floored
      ? ` (floored: ${result.current} is higher than commit ${result.commitCount})`
      : "";
    console.log(`version ${result.previous} -> ${result.version}${floor}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}