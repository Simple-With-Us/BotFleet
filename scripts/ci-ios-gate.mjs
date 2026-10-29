import { appendFileSync, readFileSync } from "node:fs";

import { classifyCIPaths, isIosPath } from "./ci-change-scope.mjs";

function parseBool(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

function sanitizePath(path) {
  return path.replace(/[\r\n]/g, " ");
}

function readPaths() {
  return readFileSync(0)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${lines.join("\n")}\n`);
}

const NOTICES = {
  skipped_docs_only:
    "No iOS build ran.  The diff replay proved this change is documentation only.",
  skipped_no_ios_relevant_paths:
    "No iOS build ran.  The diff replay proved no iOS paths changed.",
  build_required: "Swift package tests and the unsigned iOS build succeeded.",
};

function main() {
  const docsOnly = parseBool("DOCS_ONLY", process.env.DOCS_ONLY);
  const iosChanged = parseBool("IOS_CHANGED", process.env.IOS_CHANGED);
  const iosBuildResult = process.env.IOS_BUILD_RESULT ?? "";
  const eventName = process.env.EVENT_NAME ?? "";

  const paths = readPaths();
  const classified = classifyCIPaths(paths);
  const iosRelevantPaths = paths.filter(isIosPath);

  const lines = [
    "required_context: Swift tests + iOS build",
    `event: ${eventName || "(unset)"}`,
    `classifier_docs_only: ${docsOnly}`,
    `classifier_ios_changed: ${iosChanged}`,
    `recomputed_docs_only: ${classified.docsOnly}`,
    `recomputed_ios_changed: ${classified.iosChanged}`,
    `changed_path_count: ${paths.length}`,
    `ios_relevant_path_count: ${iosRelevantPaths.length}`,
  ];

  if (classified.docsOnly !== docsOnly || classified.iosChanged !== iosChanged) {
    lines.push("gate_verdict: classifier_mismatch");
    lines.push(`ios_build_job_result: ${iosBuildResult || "(unset)"}`);
    console.log(lines.join("\n"));
    console.error(
      "ERROR: Classify CI scope outputs do not match a fresh diff replay.",
    );
    console.log("::error::Classify CI scope outputs do not match a fresh diff replay.");
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

  const summary = [
    "### Swift tests + iOS build",
    "",
    NOTICES[verdict],
    "",
    `Changed paths: ${paths.length}.  iOS paths: ${iosRelevantPaths.length}.  Build job: ${iosBuildResult || "(unset)"}.`,
  ];
  if (paths.length > 0) {
    summary.push("", "Changed paths:");
    for (const path of paths) summary.push(`- ${sanitizePath(path)}`);
  }
  writeSummary(summary);

  if (buildRequired) {
    if (iosBuildResult !== "success") {
      console.error(
        `ERROR: iOS-relevant changes require a successful ios-build job (got ${iosBuildResult || "unset"}).`,
      );
      console.log("::error::iOS-relevant changes require a successful ios-build job.");
      process.exit(1);
    }
    console.log("outcome: swift_tests_and_ios_build_ran");
    console.log(`::notice title=iOS scope gate::${NOTICES.build_required}`);
    return;
  }

  if (iosBuildResult === "success") {
    console.error(
      "ERROR: ios-build succeeded but the classifier reported no iOS-relevant work was required.",
    );
    console.log("::error::ios-build ran when the classifier reported no iOS work.");
    process.exit(1);
  }
  if (iosBuildResult === "failure" || iosBuildResult === "cancelled") {
    console.error("ERROR: ios-build did not succeed on a change that should have skipped the build.");
    console.log("::error::ios-build did not succeed on a change that should have skipped the build.");
    process.exit(1);
  }
  if (iosBuildResult !== "skipped") {
    console.error(
      `ERROR: Expected ios-build to be skipped when docs_only=${docsOnly} and ios_changed=${iosChanged} (got ${iosBuildResult || "unset"}).`,
    );
    console.log("::error::Expected ios-build to be skipped.");
    process.exit(1);
  }

  console.log(`outcome: ${verdict}`);
  console.log(`::notice title=iOS scope gate::${NOTICES[verdict]}`);
}

main();
