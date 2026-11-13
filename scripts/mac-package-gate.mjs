// Should this pull request pay for a pre-merge Mac packaging check?
//
// Why this exists: the "Mac Commit Build" workflow runs on push to main and is
// deliberately not a required check, so it is the *last* place a packaging break
// can surface.  Renovate #919 merged with every required check green and broke
// Mac packaging two ways in one dependency bump -- @trycua/cua-driver 0.20.0 ->
// 0.32.0 had no pinned asset in scripts/prepare-cua.mjs, and the
// @xmldom/xmldom override moved to a version electron-builder's plist parser
// cannot use.  Because the Mac updater installs from the hosted build of main's
// tip, that blocked every Mac update until it was fixed after the fact.
//
// The cost is deliberately small.  Real Mac Commit Build runs on this repo
// finish in two to eight minutes, most of that the runner's own setup, so a
// pre-merge gate costs minutes rather than the hours the post-merge discovery
// cost.
//
// Decision shape mirrors scripts/ci-change-scope.mjs on purpose: this is the
// same "did anything that can break packaging change?" question that already
// gates the Linux package job, so the two classifiers stay in one place instead
// of drifting apart.

import { realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isMacPackagingPath } from "./ci-change-scope.mjs";

// Renovate opens pull requests as a GitHub App, so the actor is not reliably
// "renovate[bot]".  PR #919's author was `app/renovate` and its head ref was
// `renovate/non-major-dependencies`, so match either shape and let the caller
// pass every identity it can see.
function isRenovateActor(actor) {
  return typeof actor === "string" && actor.toLowerCase().includes("renovate");
}

// Match the FIRST path segment only, not the whole string.  A substring match
// anywhere would fire on a human branch like `minimax/renovate-notes`, and a
// false positive here costs a macOS runner.  Renovate puts its marker in the
// branch prefix (`renovate/non-major-dependencies` on PR #919), so requiring it
// in segment one still catches a renamed `branchPrefix`.
function isRenovateRef(ref) {
  if (typeof ref !== "string") return false;
  const firstSegment = ref.split("/")[0] ?? "";
  return firstSegment.toLowerCase().includes("renovate");
}

/**
 * @param {{changedPaths?: string[], actors?: string[], headRef?: string}} input
 * @returns {{run: boolean, reason: string}}
 */
export function shouldRunMacPackageGate(input = {}) {
  const changedPaths = (input.changedPaths ?? []).filter(Boolean);
  const actors = input.actors ?? [];

  // Fail-closed, exactly like classifyCIPaths: with no changed-path
  // information -- an empty list, which is also the fallback for a missing
  // base SHA or a manual dispatch -- run the gate rather than silently skip
  // it.  A skipped gate is the exact failure this whole change exists to stop.
  if (changedPaths.length === 0) {
    return { run: true, reason: "no-changed-path-information" };
  }

  // Always on for Renovate.  A dependency bump that happens not to touch a
  // packaged path can still move a transitive dependency that packaging
  // resolves at runtime, which is precisely how the xmldom break arrived:
  // through an override in package.json rather than a version range.
  if (actors.some(isRenovateActor) || isRenovateRef(input.headRef)) {
    return { run: true, reason: "renovate" };
  }

  if (changedPaths.some(isMacPackagingPath)) {
    return { run: true, reason: "mac-packaging-path" };
  }

  return { run: false, reason: "unrelated-paths" };
}

function main() {
  const changedPaths = readFileSync(0)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  // Actors are matched by substring only, so a hostile actor string cannot
  // inject a newline into GITHUB_OUTPUT.  Head refs are compared against a
  // fixed prefix the same way for the same reason.
  const actors = (process.env.GATE_ACTORS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const headRef = process.env.GATE_HEAD_REF ?? "";
  const result = shouldRunMacPackageGate({ changedPaths, actors, headRef });

  // Never echo a changed filename here: pull requests control those bytes.
  // `reason` is drawn only from the fixed strings above.
  process.stdout.write(`run=${result.run}\nreason=${result.reason}\n`);
}

function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  main();
}