import { readFileSync } from "node:fs";
import { classifyCIPaths, isIosPath } from "./ci-change-scope.mjs";

function parseBool(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

function main() {
  const docsOnly = parseBool("DOCS_ONLY", process.env.DOCS_ONLY);
  const iosChanged = parseBool("IOS_CHANGED", process.env.IOS_CHANGED);
  const iosBuildResult = process.env.IOS_BUILD_RESULT ?? "";
  const eventName = process.env.EVENT_NAME ?? "";

  const paths = readFileSync(0)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  const classified = classifyCIPaths(paths);
  const iosRelevantPaths = paths.filter(isIosPath);

  const lines = [
    "=== Swift tests + iOS build (required gate) ===",
    `event: ${eventName || "(unset)"}`,
    `classifier docs_only: ${docsOnly}`,
    `classifier ios_changed: ${iosChanged}`,
    `recomputed docs_only: ${classified.docsOnly}`,
    `recomputed ios_changed: ${classified.iosChanged}`,
    `changed_path_count: ${paths.length}`,
    `ios_relevant_path_count: ${iosRelevantPaths.length}`,
  ];

  if (paths.length > 0) {
    lines.push("changed_paths:");
    for (const path of paths) {
      lines.push(`  - ${path}`);
    }
  }
  if (iosRelevantPaths.length > 0) {
    lines.push("ios_relevant_paths:");
    for (const path of iosRelevantPaths) {
      lines.push(`  - ${path}`);
    }
  }

  if (classified.docsOnly !== docsOnly || classified.iosChanged !== iosChanged) {
    lines.push(
      "ERROR: Classify CI scope outputs from the changes job do not match a fresh diff replay.",
    );
    console.error(lines.join("\n"));
    process.exit(1);
  }

  const buildRequired = !docsOnly && iosChanged;
  let verdict;
  if (docsOnly) {
    verdict = "skipped_docs_only";
  } else if (!iosChanged) {
    verdict = "skipped_no_ios_relevant_paths";
  } else {
    verdict = "build_required";
  }
  lines.push(`gate_verdict: ${verdict}`);
  lines.push(`ios_build_job_result: ${iosBuildResult || "(unset)"}`);

  console.log(lines.join("\n"));

  if (buildRequired) {
    if (iosBuildResult !== "success") {
      console.error(
        `ERROR: iOS-relevant changes require a successful ios-build job (got ${iosBuildResult || "unset"}).`,
      );
      process.exit(1);
    }
    console.log("outcome: swift_tests_and_ios_build_ran");
    return;
  }

  if (iosBuildResult === "success") {
    console.error(
      "ERROR: ios-build succeeded but the classifier reported no iOS-relevant work was required.",
    );
    process.exit(1);
  }
  if (iosBuildResult === "failure") {
    console.error("ERROR: ios-build failed on a change that should have skipped the build.");
    process.exit(1);
  }
  if (iosBuildResult !== "skipped") {
    console.error(
      `ERROR: Expected ios-build to be skipped when docs_only=${docsOnly} and ios_changed=${iosChanged} (got ${iosBuildResult || "unset"}).`,
    );
    process.exit(1);
  }

  console.log(`outcome: ${verdict}`);
}

main();
