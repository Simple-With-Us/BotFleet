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
//   BOTFLEET_BUILD_VERSION       1.0.202611030100   the app version
//   BOTFLEET_MARKETING_VERSION   0.1.0              the version a person sees
//
// The build number is the app version's patch, which is the slot the retired
// 1.0.<commit_count> scheme used, so nothing else has to carry it.  The app
// version sits on the ORDERING line (1.0) rather than the marketing line
// (0.1), because the updater orders releases by the app version alone and the
// installed fleet is already on 1.0.x:  a 0.1.<build> feed would read as a
// downgrade to every install and be refused (scripts/electron-release-version.mjs).
//
// A pin that names no marketing version is the RETIRED shape, and it keeps
// working exactly as it did:  1.0.2222 still means the version 1.0.2222 and
// the build 2222, and the marketing version is the app version because that
// scheme had only one.  That is what keeps an in-flight release or a local
// build on the old scheme from breaking on this change.  The marketing
// version never enters the answer, so a stale one left in the environment
// cannot change what a pin resolves to.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORDERING_VERSION_PREFIX } from "../scripts/electron-release-version.mjs";
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
    const app = SEMVER.exec(pinned);
    if (!app) {
      throw new Error(
        `BOTFLEET_BUILD_VERSION is neither an x.y.z app version nor a 1.0.<count> build version: ${pinned}`,
      );
    }
    if (marketing !== "" && !SEMVER.exec(marketing)) {
      throw new Error(`BOTFLEET_MARKETING_VERSION is not an x.y.z version: ${marketing}`);
    }
    // The app version the updater orders by sits on the ordering line, and the
    // build travels in its patch.  The check is against the ORDERING LINE and
    // not against the marketing version's major and minor, because the two are
    // deliberately on different lines:  the marketing version is 0.1.0 for
    // every release, and the app version is 1.0.<build>.
    if (`${app[1]}.${app[2]}` !== ORDERING_VERSION_PREFIX) {
      throw new Error(
        `the app version ${pinned} is not on the ${ORDERING_VERSION_PREFIX} ordering line: ` +
          `the app version the updater orders by carries the build in its patch on that line`,
      );
    }
    const build = String(Number(app[3]));
    if (build === "0") {
      // The app version carries the build in its patch, so an app version
      // whose patch is 0 carries no build at all.  Stamping that as the build
      // would number the bundle 0 and read as the oldest build in every
      // comparison, so it is refused instead.
      throw new Error(
        `the app version ${pinned} carries no build: ` +
          `the app version puts the build number in its patch, and a patch of 0 is not one`,
      );
    }
    // A pin with no marketing version is the RETIRED 1.0.<count> shape, and it
    // resolves to the same answer:  the retired scheme had only one version,
    // so the app version is the marketing version and the build is the count.
    // A retired pin read while a stale marketing version sits in the
    // environment resolves the same way too, because the marketing version
    // never enters the answer.
    return { version: `${ORDERING_VERSION_PREFIX}.${build}`, build, source: "BOTFLEET_BUILD_VERSION" };
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
