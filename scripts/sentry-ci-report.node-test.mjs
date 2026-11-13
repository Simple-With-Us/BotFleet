import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function checkinStatus(workflowName, event, branch, conclusion) {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, json, pathlib",
        "p = pathlib.Path('scripts/sentry-ci-report.py')",
        "s = importlib.util.spec_from_file_location('sentry_ci_report', p)",
        "m = importlib.util.module_from_spec(s)",
        "s.loader.exec_module(m)",
        "print(json.dumps(m.cron_checkin_status(",
        "  " + JSON.stringify(workflowName) + ",",
        "  " + JSON.stringify(event) + ",",
        "  " + JSON.stringify(branch) + ",",
        "  " + JSON.stringify(conclusion) + ",",
        ")))",
      ].join("\n"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

test("vercel production catch-up checks in for the run that actually finished on main", () => {
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "main", "success"), "ok");
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_dispatch", "main", "success"), "ok");
  assert.equal(checkinStatus("Vercel production catch-up", "schedule", "main", "success"), "ok");
  assert.equal(checkinStatus("Vercel production catch-up", "schedule", "main", "failure"), "error");
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "main", "failure"), "error");
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "main", "timed_out"), "error");
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "main", "cancelled"), null);
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "main", "skipped"), null);
  assert.equal(checkinStatus("Vercel production catch-up", "pull_request", "main", "success"), null);
  assert.equal(checkinStatus("Vercel production catch-up", "workflow_run", "feature", "success"), null);
});

test("weekly and ship crons stay schedule-only so a push cannot mark them ok", () => {
  assert.equal(checkinStatus("CI", "schedule", "main", "success"), "ok");
  assert.equal(checkinStatus("CI", "schedule", "main", "failure"), "error");
  assert.equal(checkinStatus("CI", "schedule", "main", "cancelled"), "error");
  assert.equal(checkinStatus("CI", "push", "main", "success"), null);
  assert.equal(checkinStatus("CI", "workflow_dispatch", "main", "success"), null);
  assert.equal(
    checkinStatus("iOS TestFlight ship (GitHub-hosted macOS)", "schedule", "main", "success"),
    "ok",
  );
  assert.equal(
    checkinStatus("iOS TestFlight ship (GitHub-hosted macOS)", "workflow_run", "main", "success"),
    null,
  );
});

test("the reporter workflow runs for a successful main-branch catch-up", () => {
  const workflow = z
    .object({ jobs: z.object({ report: z.object({ if: z.string() }) }) })
    .parse(parse(readFileSync(join(ROOT, ".github/workflows/sentry-ci-report.yml"), "utf8")));
  const gate = workflow.jobs.report.if;
  assert.match(gate, /workflow_run\.event == 'schedule'/);
  assert.match(gate, /Vercel production catch-up/);
  assert.match(gate, /head_branch == 'main'/);
  assert.match(gate, /conclusion == 'success'/);
  assert.match(gate, /event == 'workflow_run'/);
  assert.match(gate, /event == 'workflow_dispatch'/);
});
