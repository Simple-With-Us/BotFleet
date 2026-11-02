// The Mac side of the shared release version and build number.
//
// One rule for both platforms (owner directive Oct 29 2026, Zulip #Policy
// 636105695):  the marketing version is 0.1.0 and the build number is the
// Central Time merge-to-main timestamp of the commit being built, written
// YYYYMMDDHHMM with no dots and no counter.  A merge at 2:25 PM on Oct 29 is
// 202610291425.  The iOS ship already plans that build through
// scripts/ios-fleet/shared-build.mjs; this module is the Mac side of the SAME
// rule, not a second numbering scheme, and it says so in the code.
//
// What makes the two platforms agree is one rule inside the shared planner:
// the merge stamp is the authority for a commit's FIRST build on each
// platform.  A build equal to the stamp is that commit's own build on the
// OTHER platform, so it must not push this platform's plan up, or the iOS
// ship of a commit would move the inventory under the Mac release and the two
// would disagree by one.  Only a REBUILD of the same commit on the SAME
// platform takes the highest-existing-plus-one rule.  See the `platform`
// argument of nextSharedBuild.
//
// The inventory is never invented here.  The CLI below asks the SAME planner
// the iOS plan-build job asks - scripts/ios-fleet/asc-api.mjs
// plan-release-build - so the App Store Connect read is the fully paged,
// fail-closed one that already ships, and the two platforms cannot disagree
// because they ran different code.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { nextSharedBuild } from "./ios-fleet/shared-build.mjs";

/** The marketing version every BotFleet app but Congress.Trade carries. */
export const DEFAULT_MARKETING_VERSION = "0.1.0";

/**
 * The timezone the merge stamp is written in.
 *
 * America/Chicago, not a fixed offset: the offset moves with daylight
 * saving, and a fixed one would drift an hour twice a year, which is exactly
 * the kind of off-by-one that puts two platforms on different build numbers.
 */
export const MERGE_STAMP_TIME_ZONE = "America/Chicago";

/**
 * The commit's merge stamp: YYYYMMDDHHMM in America/Chicago.
 *
 * The input is an ISO instant, so the conversion is the calendar's, not the
 * model's: 2026-10-29T19:25:00Z is 2:25 PM in Chicago that day and plans
 * 202610291425.  In January the same instant lands on CST instead of CDT,
 * which is why the conversion goes through a timezone and not an offset.
 */
export function mergeStampFor(date) {
  // null and undefined are not dates: new Date(null) is the epoch, which
  // would silently plan 197001010000 for a caller that passed nothing.
  if (date === null || date === undefined || date === "") {
    throw new Error(`merge stamp source is not a usable date: ${String(date)}`);
  }
  const when = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(when.getTime())) {
    throw new Error(`merge stamp source is not a usable date: ${String(date)}`);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MERGE_STAMP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const read = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : "";
  };
  // h23 gives "00" for midnight; an ICU that answers "24" would not be a
  // valid stamp, so the check below refuses it rather than planning a build
  // that no platform reads as midnight.
  const stamp = `${read("year")}${read("month")}${read("day")}${read("hour")}${read("minute")}`;
  if (!/^[1-9][0-9]{11}$/.test(stamp)) {
    throw new Error(`merge stamp is not a 12-digit YYYYMMDDHHMM string: ${stamp}`);
  }
  return stamp;
}

/**
 * The committer date of a commit, as an ISO instant.
 *
 * The COMMITTER date, not the author date: the stamp is the time the commit
 * landed, and a commit authored weeks before it was merged must be numbered
 * for the merge.
 */
export function committerDateFor(repoRoot, sha = "HEAD") {
  let out = "";
  try {
    out = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%cI", sha], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `cannot read the committer date of ${sha} in ${repoRoot}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!out) {
    throw new Error(`git reported no committer date for ${sha} in ${repoRoot}`);
  }
  return out;
}

/** The patch component of a three-part version, or null when there is none. */
export function ownPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  return match ? Number(match[3]) : null;
}

/**
 * The Mac release version and build number for one commit.
 *
 * `marketingVersion` is the fixed marketing version ("0.1.0"), and
 * `forcedVersion` and `forcedBuild` are the exact overrides the owner keeps:
 * a forced build is used exactly as given, never rounded, never re-derived.
 *
 * `sharedBuild` is the number the shared planner already produced.  It is
 * what the CLI passes in, because the CLI asks the shipped planner directly;
 * a caller with the inventory in hand can leave it unset and let this
 * function run the same planner itself.
 */
export function planMacReleaseVersion({
  mergeStamp,
  iosBuilds,
  macBuilds,
  extraFloors = [],
  complete,
  sharedBuild,
  marketingVersion = DEFAULT_MARKETING_VERSION,
  forcedVersion = "",
  forcedBuild = "",
} = {}) {
  const version = forcedVersion ? String(forcedVersion) : String(marketingVersion);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release version is not x.y.z: ${version}`);
  }
  if (forcedBuild !== "" && forcedBuild !== null && forcedBuild !== undefined) {
    const build = String(forcedBuild);
    if (!/^[0-9]+$/.test(build)) {
      throw new Error(`forced build is not a build number: ${build}`);
    }
    const patch = ownPatch(version);
    if (patch !== null && build === String(patch)) {
      throw new Error(
        `forced build ${build} equals the patch of ${version}; that is the retired 1.0.N (N) form`,
      );
    }
    return { version, build, source: "forced" };
  }
  let build;
  if (sharedBuild !== undefined && sharedBuild !== null && sharedBuild !== "") {
    build = String(sharedBuild);
    if (!/^[0-9]+$/.test(build)) {
      throw new Error(`the shared planner returned a build that is not a number: ${build}`);
    }
  } else {
    build = nextSharedBuild({
      iosBuilds,
      macBuilds,
      extraFloors,
      complete,
      mergeStamp,
      platform: "macos",
    }).build;
  }
  return { version, build, source: "shared plan" };
}

/**
 * The whole answer for one commit: the marketing version, the build number,
 * and the merge stamp the build was derived from.
 */
export function resolveMacReleaseVersion({
  repoRoot,
  sha = "HEAD",
  mergeStamp,
  sharedBuild,
  marketingVersion = DEFAULT_MARKETING_VERSION,
  forcedVersion = "",
  forcedBuild = "",
  ...inventories
} = {}) {
  const stamp = mergeStamp ?? mergeStampFor(committerDateFor(repoRoot, sha));
  const plan = planMacReleaseVersion({
    mergeStamp: stamp,
    sharedBuild,
    marketingVersion,
    forcedVersion,
    forcedBuild,
    ...inventories,
  });
  return { ...plan, mergeStamp: stamp };
}

/** The fixed marketing version and bundle id of one app in apps.json. */
export function appVersionPolicy(repoRoot, appKey) {
  const path = join(repoRoot, "scripts", "ios-fleet", "apps.json");
  let apps = {};
  try {
    apps = JSON.parse(readFileSync(path, "utf8")).apps ?? {};
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const app = apps[appKey];
  if (!app) {
    throw new Error(`apps.json has no app named ${appKey}`);
  }
  const marketingVersion = String(app.fixedMarketingVersion ?? "").trim();
  if (!marketingVersion) {
    throw new Error(`apps.json has no fixedMarketingVersion for ${appKey}; the fixed version is the policy`);
  }
  const bundleId = String(app.bundleId ?? "").trim();
  if (!bundleId) {
    throw new Error(`apps.json has no bundleId for ${appKey}`);
  }
  return { marketingVersion, bundleId };
}

/**
 * The shared plan for one commit, from the planner the iOS ship already runs.
 *
 * The ASC credential is resolved by asc-api.mjs itself, from the
 * environment; nothing is staged here and nothing is printed but the build.
 */
export function sharedPlanFor(repoRoot, { bundleId, mergeStamp, platform = "macos" }) {
  const planner = join(repoRoot, "scripts", "ios-fleet", "asc-api.mjs");
  let out = "";
  try {
    out = execFileSync(
      process.execPath,
      [planner, "plan-release-build", bundleId, "--merge-stamp", mergeStamp, "--platform", platform],
      { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    const detail = error && error.stderr ? String(error.stderr).trim() : "";
    throw new Error(
      `the shared planner could not plan a build for ${bundleId}: ` +
        `${detail || (error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (!/^[0-9]+$/.test(out)) {
    throw new Error(`the shared planner returned no build number for ${bundleId}: ${out}`);
  }
  return out;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let appKey = "botfleet";
  let sha = "HEAD";
  let forcedVersion = "";
  let forcedBuild = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = () => {
      index += 1;
      return args[index] ?? "";
    };
    if (arg === "--repo-root") repoRoot = take();
    else if (arg === "--app") appKey = take();
    else if (arg === "--sha") sha = take();
    else if (arg === "--version") forcedVersion = take();
    else if (arg === "--build") forcedBuild = take();
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  try {
    const policy = appVersionPolicy(repoRoot, appKey);
    const stamp = mergeStampFor(committerDateFor(repoRoot, sha));
    const sharedBuild =
      forcedBuild === ""
        ? sharedPlanFor(repoRoot, { bundleId: policy.bundleId, mergeStamp: stamp })
        : undefined;
    const plan = planMacReleaseVersion({
      mergeStamp: stamp,
      sharedBuild,
      marketingVersion: policy.marketingVersion,
      forcedVersion,
      forcedBuild,
    });
    console.log(`version=${plan.version}`);
    console.log(`build=${plan.build}`);
    console.log(`merge_stamp=${stamp}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
