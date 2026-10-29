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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBuildVersion } from "../scripts/stamp-commit-version.mjs";

/**
 * The version and build number for the Control bundle, and where they came
 * from.
 *
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot: string }} options
 * @returns {{ version: string, build: string, source: string }}
 */
export function controlBuildVersion({ env = process.env, repoRoot }) {
  const pinned = String(env.BOTFLEET_BUILD_VERSION ?? "").trim();
  if (pinned !== "") {
    const match = /^1\.0\.(\d+)$/.exec(pinned);
    if (!match) {
      throw new Error(`BOTFLEET_BUILD_VERSION is not a 1.0.<count> build version: ${pinned}`);
    }
    const build = String(Number(match[1]));
    return { version: `1.0.${build}`, build, source: "BOTFLEET_BUILD_VERSION" };
  }
  if (String(env.BOTFLEET_SKIP_VERSION_STAMP ?? "").trim() === "1") {
    const version = String(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "").trim();
    const match = /^1\.0\.(\d+)$/.exec(version);
    if (!match) {
      throw new Error(`package.json version is not a 1.0.<count> build version, so the stamp cannot be skipped: ${version}`);
    }
    return { version, build: String(Number(match[1])), source: "package.json (stamp skipped)" };
  }
  const plan = resolveBuildVersion(repoRoot);
  const build = plan.version.split(".")[2];
  return { version: plan.version, build, source: plan.floored ? "package.json floor" : "commit count" };
}
