// Prove the tracked XcodeGen output matches ios/project.yml (BF-2718).
//
// `xcodegen generate` rewrites the three target Info.plists and the Xcode
// project from ios/project.yml.  CI and the release workflows generate
// before they build, so shipped builds always carry the generated keys,
// but a plain checkout built without generating silently ships whatever
// the tracked copies say.  On 2026-11-27 the tracked Mac plist lacked
// the four Sparkle keys project.yml declares, so such a build's updater
// reported updates unavailable and nothing said the copy was stale.
//
// This check runs AFTER `xcodegen generate` (CI generates in the step
// before) and fails when the working tree differs from HEAD on any
// generated path.  It fails closed: a tree git cannot read is a blocked
// gate, never a clean tree.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every tracked file `xcodegen generate` rewrites from ios/project.yml:
 * each app target's `info.path` and `entitlements.path` that git tracks.
 * A new target with an `info:` or `entitlements:` block must add its
 * tracked files here.  Two kinds of generated output are deliberately
 * absent because git cannot see them drift: the `.xcodeproj` and the
 * iOS App target's `ios/App/Info.plist`, both ignored by ios/.gitignore.
 */
export const GENERATED_PATHS = [
  "ios/App/BotFleet.entitlements",
  "ios/Widgets/Info.plist",
  "ios/Widgets/BotFleetWidgets.entitlements",
  "ios/MacApp/Info.plist",
  "ios/MacApp/BotFleetMac.entitlements",
];

/** The repository root this script lives in (scripts/ is one level down). */
export function repoRoot(moduleUrl = import.meta.url) {
  return dirname(dirname(fileURLToPath(moduleUrl)));
}

/**
 * Generated paths whose working-tree state differs from HEAD, as
 * repo-relative paths.  `git status --porcelain` covers modified,
 * deleted and untracked in one read; a generated file that was never
 * tracked is drift too, because a plain checkout would not have it.
 *
 * Throws when git cannot answer (not a repository, git missing), so
 * callers fail closed instead of reading silence as a clean tree.
 */
export function findDriftedPaths(root, paths = GENERATED_PATHS) {
  const out = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    // Renames print as "old -> new"; the new path is the drifted one.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").pop() : path));
}

export function main(root = repoRoot()) {
  let drifted;
  try {
    drifted = findDriftedPaths(root);
  } catch (error) {
    console.error(
      `check-xcodegen-drift: cannot read the tree at ${root}: ${error.message}`,
    );
    return 1;
  }
  if (drifted.length === 0) {
    console.log("check-xcodegen-drift: tracked XcodeGen output matches ios/project.yml.");
    return 0;
  }
  console.error(
    "check-xcodegen-drift: `xcodegen generate` changed tracked files.  " +
      "The committed copies are stale; run `cd ios && xcodegen generate` and commit the result:",
  );
  for (const path of drifted) console.error(`  ${path}`);
  return 1;
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
