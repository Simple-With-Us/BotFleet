#!/usr/bin/env python3
"""
sentry-ci-report.py — reports CI workflow outcomes to the shared fleet-infra
Sentry project (org simple-with-us), via raw envelope HTTP (no sentry-sdk
dependency, no GitHub Actions marketplace action).

Invoked by .github/workflows/sentry-ci-report.yml, which listens for
`workflow_run: types: [completed]` across every other workflow in this repo
and sets the env vars this script reads.  This script itself does not know
about GitHub Actions beyond reading those env vars — all the wiring lives in
the workflow file.

Two independent signals are sent per completed run:
  1. If the run's conclusion warrants an alert (failure / timed_out /
     startup_failure — see ALERT_CONCLUSIONS): a Sentry error event tagged with
     {app, workflow, branch, actor}, carrying the run URL, fingerprinted on
     [ci-failure, app, workflow] so every failure of one workflow groups into
     ONE Sentry issue instead of paging separately every time.
  2. If the run was schedule-triggered (event == "schedule"): a Sentry Crons
     check-in (status "ok" on success, "error" otherwise) with an upsert
     monitor_config whose schedule mirrors that workflow's own cron
     expression (see CRON_SCHEDULES below) so a nightly/weekly job that
     silently STOPS running raises a missed-check-in alert.

The branch is deliberately NOT part of the fingerprint (it was until
2026-08-12).  Branch names are unbounded and short-lived, so including one
minted a brand-new, permanent Sentry issue for every (workflow, branch) pair —
~85 of this fleet's 200+ unresolved fleet-infra issues came from that single
line, each one a dead feature branch nobody will ever look at again.  The
branch is still carried as a per-event TAG (searchable, and visible on every
event), which is where unbounded-cardinality data belongs.

The `app` tag + fingerprint component are required: fleet-infra is shared
across repos, and this repo may share workflow names ("CI", "Security",
"Effort Issues Sync") with peer apps, so without `app` a "CI" failure here
would dedup into the same Sentry issue as one there.  Per AGENT-SYNC.md
"Observability", every event is tagged with `app:<repo>`.

Secrets: SENTRY_FLEET_DSN is read only from the environment (set by the
workflow from the repo secret) and is NEVER printed or logged in any form,
including in exception messages.

Gold copy: Usage-Monitor origin/main (PR #1394).  Adapted for BotFleet
(APP = "botfleet").
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

# This repo's identity in the shared fleet-infra project.  Tags every event and
# participates in the fingerprint so cross-repo CI failures never collapse into
# one Sentry issue.
APP = "botfleet"

# Keyed by the workflow's DISPLAY NAME (its `name:`), mirroring each
# schedule-triggered workflow's own `schedule:` block so a missed check-in
# raises a Sentry Crons alert instead of going unnoticed.  `ios-ship.yml`
# ("iOS TestFlight ship (GitHub-hosted macOS)") runs twice hourly.  `ci.yml`
# also runs its full matrix weekly so documentation-only fast paths cannot
# conceal dependency or runner drift between code changes.
CRON_SCHEDULES = {
    "CI": "17 9 * * 1",
    "iOS TestFlight ship (GitHub-hosted macOS)": "18,48 * * * *",
}

# checkin_margin (minutes): how long after the scheduled trigger time Sentry
# waits before flagging a missed check-in.  This reporter only ever reports
# on workflow_run COMPLETION -- it never sends an "in_progress" check-in when
# the observed workflow starts -- so the margin must cover that workflow's
# own worst-case run time (its job's `timeout-minutes:`) plus GH Actions
# queueing delay and this reporter job's own overhead, or a legitimately
# slow-but-successful run reads as a missed check-in before Sentry ever
# hears from it.  15 is a safe default for a workflow that normally finishes
# in a couple of minutes; override per-workflow below for anything slower.
DEFAULT_CHECKIN_MARGIN_MINUTES = 15
CRON_CHECKIN_MARGIN_OVERRIDES = {
    # ci.yml's longest job has timeout-minutes: 25; +20 for queueing, the
    # classifier, and this reporter's own dispatch/run time.
    "CI": 45,
    # ios-ship.yml's job sets `timeout-minutes: 90`; +15 for queueing and
    # this reporter's own dispatch/run time.
    "iOS TestFlight ship (GitHub-hosted macOS)": 105,
}
_CRON_CHECKIN_MARGIN_FOLDED = {
    name.casefold(): margin for name, margin in CRON_CHECKIN_MARGIN_OVERRIDES.items()
}

# This map is keyed by a workflow's DISPLAY NAME, which is exactly the kind of
# string that drifts out from under you: shared-package-pin-check.yml was
# renamed "Shared package pin check" -> "Shared Package Pin Check" in d849720c
# (2026-07-27) and this map kept the old casing, so that workflow's weekly
# Sentry Crons check-in silently never fired again — the monitor simply was
# never upserted, and the only complaint was a ::warning:: annotation inside a
# reporter job nobody reads.  Two guards make that class of drift non-silent:
#   1. Lookups go through this case-folded index, so a pure casing change can
#      never break the mapping again.
#   2. find_cron_schedule_drift() checks every key against the real `name:` of
#      the workflow files in this repo, and main() reports a mismatch to Sentry
#      (a real issue in fleet-infra), not just to the job log.
_CRON_SCHEDULES_FOLDED = {name.casefold(): expr for name, expr in CRON_SCHEDULES.items()}

# Where the observed workflows live, resolved from this file rather than the
# process CWD so the guard works regardless of how the script is invoked.
WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / ".github" / "workflows"

# Terminal workflow_run conclusions that should raise a Sentry error event.
# Beyond a plain "failure", a run GitHub kills counts as broken: "timed_out"
# (hung past its limit) and "startup_failure" (the run never started) would
# otherwise slip through silently.  Deliberately EXCLUDES "cancelled" / "skipped"
# / "neutral" / "stale" / "action_required" — those are normally intentional and
# alerting on them would just be pager noise.
ALERT_CONCLUSIONS = frozenset({"failure", "timed_out", "startup_failure"})

# Sentry rejects a Crons monitor_slug over 50 characters with an HTTP 400 —
# and send_envelope() deliberately treats any HTTP error as fail-open (a
# ::warning:: only, never a red CI job; see its docstring), so an oversized
# slug fails SILENTLY: no monitor is ever created and the missed-schedule
# coverage it was meant to add simply never exists.  monitor_slug() below
# truncates to this bound so a long workflow `name:` can never hit that path.
MONITOR_SLUG_MAX_LEN = 50


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return slug


def monitor_slug(app: str, workflow_name: str) -> str:
    """The Sentry Crons monitor slug for a workflow, guaranteed <= 50 chars."""
    slug = f"ci-{app}-{slugify(workflow_name)}"
    return slug[:MONITOR_SLUG_MAX_LEN].rstrip("-")


def discover_workflow_names(workflows_dir: Path = WORKFLOWS_DIR) -> set[str] | None:
    """Return the `name:` of every workflow under .github/workflows.

    Returns None — meaning "cannot tell", so the caller must not report drift —
    when that directory is absent (the script running outside a checkout).  A
    deliberately dumb line scan rather than a YAML parse: this must not add a
    PyYAML dependency to a script whose whole point is having none, and the
    top-level `name:` of a GitHub workflow is always a plain unindented scalar.
    """
    if not workflows_dir.is_dir():
        return None
    names: set[str] = set()
    for path in sorted(workflows_dir.glob("*.y*ml")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = re.match(r"^name:\s*(.+?)\s*$", line)
            if m:
                names.add(m.group(1).strip().strip("\"'"))
                break
    return names


def find_cron_schedule_drift(known_names: set[str] | None) -> list[str]:
    """CRON_SCHEDULES keys that match no real workflow `name:`, case-insensitively.

    Empty when the workflow set is unknown (None) or empty — "I could not read
    the workflows" must never masquerade as "every key is stale".
    """
    if not known_names:
        return []
    folded = {name.casefold() for name in known_names}
    return sorted(key for key in CRON_SCHEDULES if key.casefold() not in folded)


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    """Parse a Sentry DSN into (public_key, host, project_id).  Raises ValueError
    without ever including the raw DSN in the message."""
    m = re.match(r"^https://([^@]+)@([^/]+)/(.+)$", dsn.strip())
    if not m:
        raise ValueError("SENTRY_FLEET_DSN is not in the expected https://<key>@<host>/<project> shape")
    return m.group(1), m.group(2), m.group(3)


def send_envelope(envelope_url: str, auth_header: str, item_type: str, item_payload: dict) -> None:
    item_body = json.dumps(item_payload).encode("utf-8")
    envelope_header = json.dumps({"sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}).encode("utf-8")
    item_header = json.dumps({"type": item_type, "length": len(item_body)}).encode("utf-8")
    body = envelope_header + b"\n" + item_header + b"\n" + item_body + b"\n"

    req = urllib.request.Request(
        envelope_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": auth_header,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"Sentry envelope POST ({item_type}) -> HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        # Never fail the reporter job over a Sentry-side hiccup; print details for debugging.
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"::warning::Sentry envelope POST ({item_type}) failed: HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        print(f"::warning::Sentry envelope POST ({item_type}) failed: {exc.reason}")
    except Exception as exc:  # noqa: BLE001 — fail open on ANY transient network error
        # Broad by design: a raw ConnectionResetError/OSError (e.g. the peer resets
        # the connection before returning any HTTP response) is NOT wrapped in
        # URLError, and must never red-X the observed workflow.  Print only the
        # exception TYPE — never str(exc), which could echo the URL/auth header/DSN.
        print(f"::warning::Sentry envelope POST ({item_type}) failed: {type(exc).__name__}")


def send_config_drift_event(
    envelope_url: str,
    auth_header: str,
    kind: str,
    message: str,
    fingerprint: list[str],
    extra: dict,
) -> None:
    """Raise a Sentry issue about THIS reporter being misconfigured.

    Config drift used to surface only as a ::warning:: inside a job whose logs
    are never opened, which is how a dead cron monitor went unnoticed for
    months.  Fingerprints are bounded by workflow count (not branch count), so
    this cannot repeat the issue-explosion the branch fingerprint caused.
    """
    payload = {
        "event_id": uuid.uuid4().hex,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platform": "other",
        "level": "warning",
        "environment": "fleet-ci",
        "message": message,
        "tags": {"app": APP, "drift": kind},
        "extra": extra,
        "fingerprint": fingerprint,
    }
    send_envelope(envelope_url, auth_header, "event", payload)


def main() -> int:
    dsn = os.environ.get("SENTRY_FLEET_DSN", "").strip()
    workflow_name = os.environ.get("WORKFLOW_NAME", "unknown")
    conclusion = os.environ.get("WORKFLOW_CONCLUSION", "unknown")
    event = os.environ.get("WORKFLOW_EVENT", "unknown")
    branch = os.environ.get("WORKFLOW_BRANCH", "unknown")
    actor = os.environ.get("WORKFLOW_ACTOR", "unknown")
    run_url = os.environ.get("WORKFLOW_RUN_URL", "")
    run_id = os.environ.get("WORKFLOW_RUN_ID", "")

    if not dsn:
        print("::warning::SENTRY_FLEET_DSN secret is not set; skipping Sentry report for this run.")
        return 0

    try:
        public_key, host, project_id = parse_dsn(dsn)
    except ValueError as exc:
        # Fail-safe: a malformed (but present) DSN is an operator/config problem, not a
        # real CI failure.  Surface it loudly as an error annotation, but exit 0 so this
        # additive reporter never red-Xes the observed workflow's Actions history over an
        # observability misconfig — the same "never break CI" invariant the empty-DSN
        # branch above honors.  (parse_dsn never puts the raw DSN in the message.)
        print(f"::error::{exc}")
        return 0

    envelope_url = f"https://{host}/api/{project_id}/envelope/"
    auth_header = (
        f"Sentry sentry_version=7, sentry_client=sentry-ci-report/1.0, sentry_key={public_key}"
    )

    # ── 0. Config-drift guard for CRON_SCHEDULES ────────────────────────────
    stale_keys = find_cron_schedule_drift(discover_workflow_names())
    if stale_keys:
        joined = ", ".join(repr(key) for key in stale_keys)
        print(
            f"::error::CRON_SCHEDULES key(s) {joined} match no workflow `name:` under "
            ".github/workflows/ — those cron check-ins are not being sent.  "
            "Re-key CRON_SCHEDULES in scripts/sentry-ci-report.py to the current name."
        )
        send_config_drift_event(
            envelope_url,
            auth_header,
            "stale-cron-key",
            f"sentry-ci-report CRON_SCHEDULES has stale workflow name(s): {joined} [{APP}]",
            ["ci-report-config-drift", APP, "stale-cron-key"],
            {"stale_keys": stale_keys, "run_url": run_url},
        )

    # ── 1. Failure event ────────────────────────────────────────────────────
    if conclusion in ALERT_CONCLUSIONS:
        event_payload = {
            "event_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "platform": "other",
            "level": "error",
            "environment": "fleet-ci",
            "message": f"CI workflow {conclusion}: {workflow_name} [{APP}]",
            # Branch/actor stay as TAGS (searchable, per-event) but must never
            # enter the fingerprint — see the module docstring.
            "tags": {"app": APP, "workflow": workflow_name, "branch": branch, "actor": actor},
            "extra": {"run_url": run_url, "run_id": run_id, "branch": branch},
            "fingerprint": ["ci-failure", APP, workflow_name],
        }
        send_envelope(envelope_url, auth_header, "event", event_payload)
        print(f"Sent Sentry {conclusion} event for workflow '{workflow_name}' on branch '{branch}'.")
    else:
        print(f"Workflow '{workflow_name}' concluded '{conclusion}' (no alert); no error event sent.")

    # ── 2. Cron check-in (only for schedule-triggered runs) ─────────────────
    if event == "schedule":
        # Case-folded lookup: a workflow rename that only changes capitalisation
        # must never again silently detach a job from its Crons monitor.
        cron_expr = _CRON_SCHEDULES_FOLDED.get(workflow_name.casefold())
        if not cron_expr:
            print(
                f"::warning::Schedule-triggered run for '{workflow_name}' has no known cron "
                "expression mapped in CRON_SCHEDULES; skipping check-in."
            )
            send_config_drift_event(
                envelope_url,
                auth_header,
                "unmapped-schedule",
                f"sentry-ci-report has no CRON_SCHEDULES entry for scheduled workflow "
                f"'{workflow_name}' [{APP}]",
                ["ci-report-config-drift", APP, "unmapped-schedule", workflow_name],
                {"workflow": workflow_name, "run_url": run_url, "run_id": run_id},
            )
        else:
            checkin_status = "ok" if conclusion == "success" else "error"
            slug = monitor_slug(APP, workflow_name)
            checkin_margin = _CRON_CHECKIN_MARGIN_FOLDED.get(
                workflow_name.casefold(), DEFAULT_CHECKIN_MARGIN_MINUTES
            )
            checkin_payload = {
                "check_in_id": uuid.uuid4().hex,
                "monitor_slug": slug,
                "status": checkin_status,
                "monitor_config": {
                    "schedule": {"type": "crontab", "value": cron_expr},
                    "checkin_margin": checkin_margin,
                    "max_runtime": 60,
                    "timezone": "UTC",
                },
            }
            send_envelope(envelope_url, auth_header, "check_in", checkin_payload)
            print(f"Sent Sentry Crons check-in '{checkin_status}' for monitor '{slug}' (workflow '{workflow_name}').")
    else:
        print(f"Workflow '{workflow_name}' was triggered by '{event}' (not schedule); no cron check-in sent.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
