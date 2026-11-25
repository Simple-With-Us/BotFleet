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

function monitorConfig(workflowName, cronExpr) {
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
        "print(json.dumps(m.monitor_config_for(" +
          JSON.stringify(workflowName) +
          ", " +
          JSON.stringify(cronExpr) +
          ")))",
      ].join("\n"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

test("the 15-minute auto-merge sweep sends no cron check-in (AFC-626)", () => {
  assert.equal(checkinStatus("Auto-merge PRs", "schedule", "main", "success"), null);
  assert.equal(checkinStatus("Auto-merge PRs", "schedule", "main", "failure"), null);
});

test("sub-hourly monitors need three misses in a row before they turn red (AFC-626)", () => {
  const catchUp = monitorConfig("Vercel production catch-up", "41 * * * *");
  assert.equal(catchUp.failure_issue_threshold, 3);
  assert.equal(catchUp.recovery_threshold, 1);
  assert.equal(catchUp.checkin_margin, 75);
  const ship = monitorConfig("iOS TestFlight ship (GitHub-hosted macOS)", "18,48 * * * *");
  assert.equal(ship.failure_issue_threshold, 3);
  assert.equal(ship.checkin_margin, 105);
  const weekly = monitorConfig("CI", "17 9 * * 1");
  assert.equal(weekly.failure_issue_threshold, undefined);
  assert.equal(weekly.checkin_margin, 55);
});

// Runs Python lines against the loaded reporter module `m` and returns the
// JSON the last line prints.  Anything the reporter prints itself is
// captured, so it cannot corrupt that JSON.
function probeReporter(lines) {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import contextlib, importlib.util, io, json, os, pathlib",
        "from unittest import mock",
        "p = pathlib.Path('scripts/sentry-ci-report.py')",
        "s = importlib.util.spec_from_file_location('sentry_ci_report', p)",
        "m = importlib.util.module_from_spec(s)",
        "s.loader.exec_module(m)",
        ...lines,
      ].join("\n"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

test("an unmonitored name never checks in, even when also mapped (AFC-626)", () => {
  const statuses = probeReporter([
    "m._CRON_SCHEDULES_FOLDED['auto-merge prs'] = '*/15 * * * *'",
    "m._HEARTBEAT_FOLDED.add('auto-merge prs')",
    "print(json.dumps([",
    "  m.cron_checkin_status('Auto-merge PRs', 'schedule', 'main', 'success'),",
    "  m.cron_checkin_status('auto-merge prs', 'schedule', 'main', 'failure'),",
    "  m.cron_checkin_status('Auto-merge PRs', 'workflow_run', 'main', 'success'),",
    "  m.cron_checkin_status('Auto-merge PRs', 'workflow_dispatch', 'main', 'success'),",
    "]))",
  ]);
  assert.deepEqual(statuses, [null, null, null, null]);
});

test("a configured failure threshold of 0 is sent, not dropped (AFC-626)", () => {
  const config = probeReporter([
    "m._CRON_FAILURE_THRESHOLD_FOLDED['ci'] = 0",
    "print(json.dumps(m.monitor_config_for('CI', '17 9 * * 1')))",
  ]);
  assert.equal(config.failure_issue_threshold, 0);
  assert.equal(config.recovery_threshold, 1);
});

test("a stale UNMONITORED_SCHEDULES entry is reported like a stale cron key (AFC-626)", () => {
  const drift = probeReporter([
    "live = set(m.CRON_SCHEDULES)",
    "folded = {n.casefold() for n in live | set(m.UNMONITORED_SCHEDULES)}",
    "print(json.dumps([",
    "  m.find_cron_schedule_drift(live),",
    "  m.find_cron_schedule_drift(folded),",
    "  sorted(m.UNMONITORED_SCHEDULES),",
    "]))",
  ]);
  const [stale, caseFolded, unmonitored] = drift;
  assert.deepEqual(stale, unmonitored);
  assert.deepEqual(caseFolded, []);

  const sent = probeReporter([
    "sent = []",
    "env = {",
    "  'SENTRY_FLEET_DSN': 'https://abc123@o1.ingest.example.test/42',",
    "  'WORKFLOW_NAME': 'CI', 'WORKFLOW_CONCLUSION': 'success', 'WORKFLOW_EVENT': 'push',",
    "  'WORKFLOW_BRANCH': 'main', 'WORKFLOW_ACTOR': 'agent',",
    "  'WORKFLOW_RUN_URL': 'https://example.test/run/1', 'WORKFLOW_RUN_ID': '1',",
    "}",
    "with mock.patch.object(m, 'discover_workflow_names', return_value=set(m.CRON_SCHEDULES)), \\",
    "     mock.patch.object(m, 'send_envelope', lambda u, a, t, pl: sent.append([t, pl])), \\",
    "     mock.patch.dict(os.environ, env, clear=False), \\",
    "     contextlib.redirect_stdout(io.StringIO()):",
    "  rc = m.main()",
    "print(json.dumps({'rc': rc, 'sent': sent}))",
  ]);
  assert.equal(sent.rc, 0);
  assert.deepEqual(sent.sent.map(([type]) => type), ["event"]);
  const payload = sent.sent[0][1];
  assert.deepEqual(payload.fingerprint, ["ci-report-config-drift", "botfleet", "stale-cron-key"]);
  assert.deepEqual(payload.extra.stale_keys, unmonitored);
});
