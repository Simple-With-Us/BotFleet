// The version the BotFleet Control bundle carries.
//
// Control used to stamp itself with `git rev-list --count HEAD` of whatever
// checkout built it, with no floor and no shallow-clone guard, so a release
// checkout at depth 1 would stamp 1.0.1 and a non-main commit a number that
// matched nothing else in the bundle (BF-2531).  The app's own version comes
// from scripts/stamp-commit-version.mjs, so Control now takes the same number:
// the one the workflow pinned in BOTFLEET_BUILD_VERSION when there is one, and
// the stamp script's answer otherwise, which refuses a shallow clone instead
// of numbering the build 1.0.1.  BOTFLEET_SKIP_VERSION_STAMP=1, the local
// bypass the stamp script's CLI honours, keeps the package.json version here
// too.  So the two bundles agree on the pinned release and commit-build paths
// and under the skip flag; a plain `pnpm package:mac:local` stamps Control
// from the commit count while electron-builder leaves the app at package.json's
// version, which is the gate builds' known state, not a shipped one.
//
// BF-2588 changed what a PIN means.  The release policy (owner directive, Oct
// 29 2026) is that every app but Congress.Trade carries the marketing version
// 0.1.0 and a build number that is the commit's Central merge-to-main
// timestamp, YYYYMMDDHHMM.  The Electron updater orders releases by semver on
// the app version alone, so the build travels in the patch of the app
// version (scripts/electron-release-version.mjs), and a release pins TWO
// values:
//
//   BOTFLEET_BUILD_VERSION       0.1.202611030100   the app version
//   BOTFLEET_MARKETING_VERSION   0.1.0              the version a person sees
//
// The build number is the app version's patch, which is the slot the retired
// 1.0.<commit_count> scheme used, so nothing else has to carry it.
//
// A pin that names no marketing version is the RETIRED shape, and it keeps
// working exactly as it did:  1.0.2222 still means the version 1.0.2222 and
// the build 2222, and the marketing version is the app version because that
// scheme had only one.  That is what keeps an in-flight release or a local
// build on the old scheme from breaking on this change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBuildVersion } from "../scripts/stamp-commit-version.mjs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The version and build number for the Control bundle, and where they came
 * from.
 *
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot: string }} options
 * @returns {{ version: string, build: string, source: string }}
 */
export function controlBuildVersion({ env = process.env, repoRoot }) {
  const pinned = String(env.BOTFLEET_BUILD_VERSION ?? "").trim();
  const marketing = String(env.BOTFLEET_MARKETING_VERSION ?? "").trim();
  if (pinned !== "") {
    if (marketing !== "") {
      // The policy shape:  the app version carries the build in its patch and
      // the marketing version says what a person sees.
      const app = SEMVER.exec(pinned);
      if (!app) {
        throw new Error(`BOTFLEET_BUILD_VERSION is not an x.y.z app version: ${pinned}`);
      }
      const shown = SEMVER.exec(marketing);
      if (!shown) {
        throw new Error(`BOTFLEET_MARKETING_VERSION is not an x.y.z version: ${marketing}`);
      }
      if (app[1] !== shown[1] || app[2] !== shown[2]) {
        throw new Error(
          `the app version ${pinned} and the marketing version ${marketing} disagree: ` +
            `the app version takes its major and minor from the marketing version, ` +
            `and the build travels in the patch`,
        );
      }
      return {
        version: pinned,
        build: String(app[3]),
        source: "BOTFLEET_BUILD_VERSION",
      };
    }
    // The retired 1.0.<count> shape, unchanged.
    const match = /^1\.0\.(\d+)$/.exec(pinned);
    if (!match) {
      throw new Error(
        `BOTFLEET_BUILD_VERSION is neither an x.y.z app version nor a 1.0.<count> build version: ${pinned}`,
      );
    }
    const build = String(Number(match[1]));
    return { version: `1.0.${build}`, build, source: "BOTFLEET_BUILD_VERSION" };
  }
  if (String(env.BOTFLEET_SKIP_VERSION_STAMP ?? "").trim() === "1") {
    const version = String(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "").trim();
    // The local bypass still lives in the retired scheme, so the build it
    // carries is the patch of a 1.0.<count> version.  A version that does not
    // have that shape is refused rather than stamped with a build of 0.
    const match = /^1\.0\.(\d+)$/.exec(version);
    if (!match) {
      throw new Error(`package.json version is not a 1.0.<count> build version, so the stamp cannot be skipped: ${version}`);
    }
    const build = String(Number(match[1]));
    return { version, build, source: "package.json (stamp skipped)" };
  }
  const plan = resolveBuildVersion(repoRoot);
  return { version: plan.version, build: plan.build, source: plan.floored ? "package.json floor" : "commit count" };
}
