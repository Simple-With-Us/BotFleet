# GitHub request-log operations (draft, not installed)

The log is not ready for deployment. New org/personal hooks wait for the owner's Infisical exception. Secret provisioning is Infisical-only. Use a stable non-secret endpoint and X-Hub-Signature-256; never use a secret-bearing URL.

GitHub does not automatically redeliver failed deliveries. Its recent delivery history covers three days. Reconciliation uses GET-only delivery detail payloads and must never request redelivery of existing dispatching hooks.

Sources:
- https://docs.github.com/en/rest/orgs/webhooks
- https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks

Reconciliation now follows Link cursor pagination, scans the complete retained window (bounded by maxPages), persists retryable detail failures, fsyncs appends and atomic checkpoints, and deduplicates against the full log rather than a 64KB tail. Pagination failure leaves the checkpoint unchanged. A corrupt checkpoint fails visibly and is not replaced. History outside three days is a potential gap with unknown count, not an invented count of proven lost events.

Operational requirements still open:
- Live org/repo delivery-list and payload-read permission tests with the eventual hook IDs.
- Installed Mac launchd cadence, startup catch-up and a separate durable failure/staleness monitor. Proposed cadence is 10 minutes; not installed or enabled here.
- Both writers now use the same mkdir lock (log path + .lock), full-log dedupe, and fsynced writes. A crash-held lock fails visibly and is never stolen automatically. Stale-lock recovery still needs a verified writer-liveness procedure.
- Spool malformed-record recovery/quarantine. The current fix preserves the entire spool and cursor on malformed data, reports an error, and refuses silent truncation. Operator recovery is still needed.
- Independent current-head review and full CI, plus real org and personal event proofs.
- Internal bot runs initiated by schedules/UI are not observable through GitHub webhooks and are not claimed covered.

Do not call the log lossless or operational while these requirements remain open.

## Prepared runner and monitor (not installed)

`node scripts/github-request-log-runner.mjs /absolute/path/config.json` runs configured org/personal hook reconciliation and saves a mode-600, fsynced atomic status file containing checkedAt, lastSuccess, consecutiveFailures and per-hook outcomes. It exits nonzero on any failed hook. Error text is fixed, not provider/credential output.

Config shape (identifiers and paths only, never credentials):

```
{"statusPath":"/absolute/path/reconcile-status.json","hooks":[{"org":"Simple-With-Us","hook":"ACTUAL_HOOK_ID","log":"/absolute/path/github-request-log.md","cursor":"/absolute/path/org-reconcile.json"}]}
```

Use `node scripts/github-request-log-runner.mjs /absolute/path/config.json --check-status` from the independent health monitor. It fails when the last run failed, no successful run exists, or success is older than 30 minutes. A nonzero exit alone is not an alert: deployment must connect this check to an existing verified notification path and prove a simulated failure is reported before claiming monitoring active.

Proposed launchd settings: RunAtLoad=true and StartInterval=600 for the runner; independent health check every 15 minutes. Do not load either job until real IDs, scoped gh authentication, dry-run evidence and the approved runtime change are verified. This source change does not install or enable them.
