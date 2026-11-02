// The Electron desktop release's version triple (BF-2588).
//
// The shared release policy (owner directive, Oct 29 2026, Zulip #Policy
// 636105695):  every app but Congress.Trade carries the marketing version
// 0.1.0, and the build number is the Central Time merge-to-main timestamp of
// the commit being built, written YYYYMMDDHHMM with no dots and no counter.
// A merge at 2:25 PM on Oct 29 is 202610291425.  An app's iOS and Mac builds
// of the same commit carry the same version and the same build number.
//
// scripts/mac-release-version.mjs is the Mac side of that rule: it answers the
// marketing version and the build number for a commit, by asking the SAME
// planner the iOS ship asks, so the two platforms cannot disagree because
// they ran different code.  This module adds the one value the Electron
// release needs on top of them, and it says why in the only place that can
// explain it.
//
// Why a third value.  The Electron updater orders releases by semver on the
// app version and by nothing else.  The vendored updater parses the
// installed app's version with semver and compares it against the feed's
// version field (electron/vendor/electron-updater.cjs: the AppUpdater
// constructor and isUpdateAvailable).  There is no build field in that feed,
// the comparison never looks at one, and the updater never reads
// build-identity.json.  So a fixed marketing version of 0.1.0 is not usable
// as the app version: two releases of 0.1.0 compare equal, isUpdateAvailable
// answers false, and the app is never told an update exists.
//
// The build therefore travels in the patch of the app version, which is the
// slot it has always occupied:  the retired scheme was 1.0.<commit_count>.
// What the policy changes is what fills that slot - the merge stamp instead
// of the commit count - and the version prefix, which is the marketing
// version.  The three values are:
//
//   marketing version   0.1.0             CFBundleShortVersionString
//   build number        202611030100      CFBundleVersion
//   app version         0.1.202611030100  package.json, the feed, the assets
//
// The app version is what an installed app compares, so it has to carry the
// build for two releases to order at all.  The marketing version stays 0.1.0
// on every surface that reports a version to a person:  Finder, the settings
// panel, and the Control bundle's own Info.plist.
//
// One more consequence, and it is the reason the app version is not the
// marketing version:  the app version is also what the artifact names and the
// release tag carry (BotFleet-<app version>-arm64.zip), so it has to be
// unique per build.  The retired scheme's names carried the commit count for
// exactly that reason, and the electron-updater cache is keyed by artifact
// file name:  two releases sharing a name could serve one release's bytes to
// the other.

import { pathToFileURL } from "node:url";

import {
  appVersionPolicy,
  committerDateFor,
  mergeStampFor,
  planMacReleaseVersion,
  sharedPlanFor,
} from "./mac-release-version.mjs";

/**
 * The app version the Electron updater orders releases by.
 *
 * The marketing version supplies the major and minor parts and the build
 * number fills the patch, so the result is a plain three-part version that
 * sorts correctly:  0.1.202611030100 < 0.1.202611030101 < 0.1.202611040000.
 *
 * It also sorts ABOVE the retired scheme's releases, which is what keeps an
 * installed 0.1.38 (the last published desktop release) updatable:  the feed
 * version has to be greater than the installed one or electron-updater
 * answers "no update available" and the install never happens.
 */
export function orderingVersion({ version, build }) {
  const marketing = String(version ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(marketing);
  if (!match) {
    throw new Error(`the marketing version is not x.y.z: ${marketing}`);
  }
  const number = String(build ?? "").trim();
  if (!/^[0-9]+$/.test(number)) {
    throw new Error(`the build number is not a number: ${build}`);
  }
  return `${match[1]}.${match[2]}.${number}`;
}

/**
 * The three values one Electron release carries.
 *
 * `version` is the marketing version, `build` the build number, and
 * `appVersion` the version the updater orders by and the artifacts carry.
 */
export function planElectronReleaseVersion({ version, build }) {
  const marketing = String(version ?? "").trim();
  const number = String(build ?? "").trim();
  return {
    version: marketing,
    build: number,
    appVersion: orderingVersion({ version: marketing, build: number }),
  };
}

/**
 * The whole answer for one commit:  the marketing version, the build number,
 * the app version, and the merge stamp the build was derived from.
 *
 * The inventory is never invented here.  The build comes from the SAME
 * planner the iOS ship and the native Mac release ask, so the iOS and Mac
 * builds of one commit carry the same number.
 */
export function resolveElectronReleaseVersion({
  repoRoot,
  sha = "HEAD",
  appKey = "botfleet",
  forcedVersion = "",
  forcedBuild = "",
} = {}) {
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
  return { ...planElectronReleaseVersion({ version: plan.version, build: plan.build }), mergeStamp: stamp };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

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
    const plan = resolveElectronReleaseVersion({ repoRoot, sha, appKey, forcedVersion, forcedBuild });
    console.log(`version=${plan.version}`);
    console.log(`build=${plan.build}`);
    console.log(`app_version=${plan.appVersion}`);
    console.log(`merge_stamp=${plan.mergeStamp}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
