# BotFleet Seer Autofix

Designer 2026-09-04 update: **ENABLE Seer Autofix for BotFleet only.**
Hold Autofix on every other Sentry project.

## Project settings (live)

Org `simple-with-us`, project `botfleet`:

| Flag | Value |
|---|---|
| `autofixAutomationTuning` | `always` |
| `seerScannerAutomation` | `true` |

Set via Sentry project PUT
`/api/0/projects/simple-with-us/botfleet/`.  RCA / Slack `rca_completed`
and `pr_ready_for_review` on workflow `3930668` stay.  Do not mint extra
Seer user seats for bot GitHub accounts.

## Billing

Sponsored org with owner $5k credit / positive balance.  The PUT returned
HTTP 200; no billing blocker on this enable.
