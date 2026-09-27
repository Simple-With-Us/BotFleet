import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { classifyCIPaths, isControlPlanePath, isIosPath, isPackagingPath } from "./ci-change-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("only the explicit non-executable documentation paths take the fast path", () => {
  assert.deepEqual(classifyCIPaths(["docs/EFFORT-LOG.md", "docs/audits/findings.json"]), {
    changedCount: 2,
    docsOnly: true,
    iosChanged: false,
    packagingChanged: false,
    controlPlaneChanged: false,
  });
  assert.equal(classifyCIPaths(["README.md", "SECURITY.md"]).docsOnly, true);

  for (const path of [
    "src/App.tsx",
    "ios/project.yml",
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "NOTICE",
    "docs/secrets.md",
    ".github/workflows/ci.yml",
    "scripts/release.mjs",
  ]) {
    assert.equal(classifyCIPaths([path]).docsOnly, false, path);
  }

  assert.equal(classifyCIPaths(["docs/EFFORT-LOG.md", "server/index.ts"]).docsOnly, false);
  assert.equal(classifyCIPaths([]).docsOnly, false);
});

test("per-area outputs gate the expensive jobs on the paths that actually affect them", () => {
  assert.deepEqual(
    { ios: isIosPath("ios/App/BotFleetApp.swift"), pkg: isPackagingPath("ios/App/BotFleetApp.swift"), cp: isControlPlanePath("ios/App/BotFleetApp.swift") },
    { ios: true, pkg: false, cp: false },
  );
  assert.equal(isIosPath("scripts/ios-fleet/ship-testflight.sh"), true);
  assert.equal(isIosPath(".github/workflows/ci.yml"), true);
  assert.equal(isIosPath("server/index.ts"), false);

  for (const path of ["electron/main.mjs", "electron-builder.yml", "third_party/cloudflared/README.md",
    "scripts/prepare-cloudflared.mjs", "scripts/package-linux.mjs", "package.json", "pnpm-lock.yaml"]) {
    assert.equal(isPackagingPath(path), true, path);
  }
  assert.equal(isPackagingPath(".github/workflows/ci.yml"), false);
  assert.equal(isPackagingPath("server/index.ts"), false);

  assert.equal(isControlPlanePath("cloudflare/control-plane/wrangler.jsonc"), true);
  assert.equal(isControlPlanePath("server/index.ts"), false);

  // A real diff picks exactly one area, and an unrelated change (like this
  // WP-K PR touching a shell script) leaves the other two areas untouched.
  assert.deepEqual(classifyCIPaths(["server/index.ts"]), {
    changedCount: 1,
    docsOnly: false,
    iosChanged: false,
    packagingChanged: false,
    controlPlaneChanged: false,
  });
  assert.deepEqual(classifyCIPaths(["ios/App/BotFleetApp.swift", "server/index.ts"]), {
    changedCount: 2,
    docsOnly: false,
    iosChanged: true,
    packagingChanged: false,
    controlPlaneChanged: false,
  });

  // No signal (an empty list, the same fallback the workflow's schedule,
  // dispatch, and missing-base-SHA branches use directly) runs every area,
  // matching how docsOnly already fails closed to "not docs only".
  assert.deepEqual(classifyCIPaths([]), {
    changedCount: 0,
    docsOnly: false,
    iosChanged: true,
    packagingChanged: true,
    controlPlaneChanged: true,
  });
});

test("the CLI emits only GitHub outputs for a NUL-delimited path list", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/ci-change-scope.mjs")], {
    cwd: ROOT,
    input: Buffer.from("docs/EFFORT-LOG.md\0README.md\0"),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "docs_only=true\nchanged_count=2\nios_changed=false\npackaging_changed=false\ncontrol_plane_changed=false\n",
  );
});

test("every protected check stays present and takes the same fail-closed scope output", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const requiredJobs = ["test", "control-plane", "package-linux", "ios"];

  assert.equal(Object.hasOwn(workflow.on, "workflow_dispatch"), true);
  assert.equal(Object.hasOwn(workflow.on, "schedule"), true);
  assert.equal(workflow.jobs.changes.outputs.docs_only, "${{ steps.scope.outputs.docs_only }}");

  const classifier = workflow.jobs.changes.steps.find((step) => step.id === "scope");
  assert.match(classifier.run, /EVENT_NAME.*!= "push".*EVENT_NAME.*!= "pull_request"/s);
  assert.match(classifier.run, /echo "docs_only=false"/);
  assert.match(classifier.run, /BASE_SHA.*\^\[0-9a-f\]\{40\}\$/);

  for (const jobId of requiredJobs) {
    const job = workflow.jobs[jobId];
    assert.equal(job.needs, "changes", jobId);
    assert.equal(job.if, "${{ !cancelled() }}", jobId);

    const fastPath = job.steps.find((step) => step.name === "Documentation-only fast path");
    assert.equal(fastPath.if, "needs.changes.outputs.docs_only == 'true'", jobId);

    for (const step of job.steps.filter((candidate) => candidate !== fastPath)) {
      assert.match(step.if, /needs\.changes\.outputs\.docs_only != 'true'/, `${jobId}: ${step.name ?? step.run ?? step.uses}`);
    }
  }

  const source = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(source, /git diff --no-renames --name-only -z/);
  assert.doesNotMatch(source, /paths-ignore:/);
});

test("the three expensive jobs also gate on their own area, the same way docs_only does", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const areaJobs = [
    { jobId: "ios", output: "ios_changed", fastPathName: "iOS-unrelated fast path" },
    { jobId: "package-linux", output: "packaging_changed", fastPathName: "Packaging-unrelated fast path" },
    { jobId: "control-plane", output: "control_plane_changed", fastPathName: "Control-plane-unrelated fast path" },
  ];

  for (const { jobId, output, fastPathName } of areaJobs) {
    const job = workflow.jobs[jobId];
    const docsFastPath = job.steps.find((step) => step.name === "Documentation-only fast path");
    const areaFastPath = job.steps.find((step) => step.name === fastPathName);
    assert.ok(areaFastPath, `${jobId} is missing "${fastPathName}"`);
    assert.equal(
      areaFastPath.if,
      `needs.changes.outputs.docs_only != 'true' && needs.changes.outputs.${output} != 'true'`,
      jobId,
    );

    const expensiveSteps = job.steps.filter((step) => step !== docsFastPath && step !== areaFastPath);
    assert.ok(expensiveSteps.length > 0, jobId);
    for (const step of expensiveSteps) {
      assert.match(
        step.if,
        new RegExp(`needs\\.changes\\.outputs\\.${output} == 'true'`),
        `${jobId}: ${step.name ?? step.run ?? step.uses}`,
      );
    }
  }

  // Neither the docs_only-only "test" job nor the changes job itself gained
  // one of these three gates by accident.
  assert.equal(workflow.jobs.test.steps.some((step) => /_changed/.test(step.if ?? "")), false);

  const classifier = workflow.jobs.changes.steps.find((step) => step.id === "scope");
  for (const output of ["ios_changed", "packaging_changed", "control_plane_changed"]) {
    assert.equal(workflow.jobs.changes.outputs[output], `\${{ steps.scope.outputs.${output} }}`);
    // Scheduled/dispatched runs and an unresolvable base SHA both fall back
    // to the full gate -- every area reported changed, not skipped.
    const occurrences = classifier.run.match(new RegExp(`echo "${output}=true"`, "g")) ?? [];
    assert.equal(occurrences.length, 2, `${output} fallback branches`);
  }
});

test("the weekly full run is registered with the Sentry cron reporter", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const schedule = workflow.on.schedule[0].cron;
  const maxJobTimeout = Math.max(
    ...Object.values(workflow.jobs).map((job) => job["timeout-minutes"] ?? 0),
  );
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util,json,pathlib",
        "p=pathlib.Path('scripts/sentry-ci-report.py')",
        "s=importlib.util.spec_from_file_location('sentry_ci_report', p)",
        "m=importlib.util.module_from_spec(s)",
        "s.loader.exec_module(m)",
        "print(json.dumps({'schedules':m.CRON_SCHEDULES,'margins':m.CRON_CHECKIN_MARGIN_OVERRIDES}))",
      ].join(";"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  assert.equal(probe.status, 0, probe.stderr);
  const reporter = JSON.parse(probe.stdout);
  assert.equal(reporter.schedules.CI, schedule);
  assert.ok(reporter.margins.CI >= maxJobTimeout + 15);
});

test("every host runs the canonical complete test chain without masking failures", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const job = workflow.jobs.test;
  assert.deepEqual(job.strategy.matrix.os, ["macos-latest", "ubuntu-latest", "windows-latest"]);
  assert.notEqual(job["continue-on-error"], true);
  const gates = job.steps.filter((step) => step.run?.trim() === "pnpm test");
  assert.equal(gates.length, 1, "CI must call the package test chain, not a copied subset");
  assert.equal(gates[0].if, "needs.changes.outputs.docs_only != 'true'");
  assert.notEqual(gates[0]["continue-on-error"], true);
});
