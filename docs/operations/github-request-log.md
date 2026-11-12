# GitHub request-log operations (draft, not installed)

The log is not yet qualified for deployment.  The owner approved one dedicated signing secret on October 24; verify the current entry, scoped reader and runtime path before provisioning or creating hooks.  Do not request the same approval again solely because this document used to say it was pending.  Secret provisioning is Infisical-only.  Use a stable non-secret endpoint and X-Hub-Signature-256; never use a secret-bearing URL.

GitHub does not automatically redeliver failed deliveries.  Its recent delivery history covers three days.  Reconciliation uses GET-only delivery detail payloads and must never request redelivery of existing dispatching hooks.

Sources:
- https://docs.github.com/en/rest/orgs/webhooks
- https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks

Reconciliation now follows Link cursor pagination, scans the complete retained window (bounded by maxPages), persists retryable detail failures, fsyncs appends and atomic checkpoints, and deduplicates against the full log rather than a 64KB tail.  Pagination failure leaves the checkpoint unchanged.  A corrupt checkpoint fails visibly and is not replaced.  History outside three days is a potential gap with unknown count, not an invented count of proven lost events.

Operational requirements still open:
- Live org/repo delivery-list and payload-read permission tests with the eventual hook IDs.
- Installed Mac launchd cadence, startup catch-up and a separate durable failure/staleness monitor.  Proposed cadence is 10 minutes; not installed or enabled here.
- Both writers use the same short Markdown commit lock (log path + .lock) and fsynced writes. The reconciler uses a separate cursor lock across GETs, never the Markdown lock. Dispatch first fsyncs an immutable mode-600 record under the spool path plus `.pending`, then attempts a flush; lock contention leaves a durable inbox receipt for the next flush or startup replay. Legacy spool recovery remains supported. The server caches delivery IDs, reads only appended Markdown bytes after its initial scan, and resets the cache when the file is replaced or shrinks.  A crash-held lock fails visibly and is never stolen automatically.  Stale-lock recovery still needs a verified writer-liveness procedure.
- Spool malformed-record recovery/quarantine.  The current fix preserves the entire spool and cursor on malformed data, reports an error, and refuses silent truncation.  Operator recovery is still needed.
- Independent current-head review and full CI, plus real org and personal event proofs.
- Internal schedule/manual routine receipts are now observed from the existing RoutineManager event channel; ordinary chat turns are not routine receipts and remain outside this coverage.

Do not call the log lossless or operational while these requirements remain open.

## Prepared runner and monitor (not installed)

`node scripts/github-request-log-runner.mjs /absolute/path/config.json` runs configured org/personal hook reconciliation and saves a mode-600, fsynced atomic status file containing checkedAt, lastSuccess, consecutiveFailures and per-hook outcomes.  It exits nonzero on any failed hook.  Error text is fixed, not provider/credential output.

Config shape (identifiers and paths only, never credentials):

```
{"statusPath":"/absolute/path/reconcile-status.json","hooks":[{"org":"Simple-With-Us","hook":"ACTUAL_HOOK_ID","log":"/absolute/path/github-request-log.md","cursor":"/absolute/path/org-reconcile.json"}]}
```

Use `node scripts/github-request-log-runner.mjs /absolute/path/config.json --check-status` from the independent health monitor.  It fails when the last run failed, no successful run exists, or success is older than 30 minutes.  A nonzero exit alone is not an alert: deployment must connect this check to an existing verified notification path and prove a simulated failure is reported before claiming monitoring active.

Proposed launchd settings: RunAtLoad=true and StartInterval=600 for the runner; independent health check every 15 minutes.  Do not load either job until real IDs, scoped gh authentication, dry-run evidence and the approved runtime change are verified.  This source change does not install or enable them.

## Review qualification at the corrective head

Legacy WebhookManager attempts are rate/cap limited (ignored and rejected receipts), so its subscriber does not promise every non-GitHub attempt.  The new dedicated GitHub route must receive the approved org/personal subscriptions and reconcile directly from retained deliveries; existing limited receipt history is not a substitute.  This guarantee is still pending real hook proof.

Authenticated malformed JSON now records a metadata-only invalid_json receipt before returning 400.  Oversized bodies still return 413 before authentication and recording; no unverified oversized payload metadata is trusted.  A delivery detail with null/malformed payload stays pending in reconciliation; it is never called recovered without a usable payload.  Exact live detail availability for those cases remains unverified, so no completeness guarantee is made yet.

The server formatter now strips newlines, control characters and parentheses from every interpolated field so payload metadata cannot forge another delivery marker.  It logs before broadcasting, emits an attempt copy rather than the manager's stored object, and uses stable webhook IDs instead of a closure over the later-created manager.

## Review and test evidence

Independent source review: 74add33cb5c0147784400c22d48b83abbea97138, followed by delta review at 43caf41cfa22b4dff7e52e1f432c5103a0f0607c.  Reviewer did not execute tests.  Delta review accepted log-before-broadcast, copied attempts, removal of the later-manager closure, and all-field marker sanitization.  F1 (legacy attempt suppression versus dedicated-hook completeness), F4 (bad_json/413 recovery), and operational proof remain open.

Executor tests at the 43caf41 delta: 44/44 server Vitest tests on Mac.  Prior reconciliation tests: 8/8; runner status tests: 2/2.  These results are scoped tests, not installed runtime proof.

## Conservative lock recovery checklist

A held mkdir lock is not proof a writer is dead.  Do not remove or rename it based solely on age, an absent remembered PID, or a completed report.  Before any recovery:
1.  Stop new admissions to both actual installed writer entry points using their supported service controls, under existing deployment authority.  Inventory launchd labels, executable paths and all writer processes.  If either entry point cannot be identified or stopped, hold recovery.
2.  Verify no server flush or reconcile process can still own the lock, including child processes.  Repeat the liveness check after the stop acknowledgement.  Do not rely on PID reuse alone.
3.  Preserve a private copy of the spool, cursor/checkpoint and log.  Never truncate or discard malformed data.  Inspect only metadata, never HMAC credentials or webhook payload prose.
4.  Only with exclusive ownership established, move the stale lock aside atomically, run recovery once, verify retained records and dedupe, then remove only the empty stale directory if deletion is authorized.
5.  Restart only the approved writer configuration, prove one normal cycle and one simulated failure is reported by the independent monitor, and document what was replayed or remains unrecovered.

This checklist is preparation, not permission to stop the live BotFleet server.  Recovery remains blocked until installed writer controls and authority are verified.

The plist under request-log-templates is intentionally non-installable with explicit placeholders.  Resolve actual paths and hook IDs, verify an authenticated dry run and failure notification, and obtain any required runtime authority before substituting values or loading it.  No credential goes in the plist or config.


## Corrective source pass, October 29

This source is not a deployment receipt.  The dedicated route now returns 503 when no fsynced spool record exists, rather than falsely acknowledging a lost event.  A later Markdown flush failure may still return success because the fsynced spool retains the delivery; it must raise the existing error channel and be drained after recovery.  Replay reports unreadable spools rather than silently treating every read failure as an empty spool.  Missing delivery IDs are rejected rather than replaced with untraceable random IDs.  HMAC comparison checks byte lengths before constant-time comparison.

`GITHUB_REQUEST_LOG_WEBHOOK_SECRET` is mapped to `githubRequestLog.webhookSecret` in the existing credential map, with vault precedence, write-through and child-process environment stripping.  This adds a reader schema, not a new secret or grant.  Resolve the approved canonical entry first; do not create rotating copies across projects.  The status check rejects timestamps in the future as well as stale or invalid timestamps.

### Finish plan and release evidence

1.  Confirm the supported installed BotFleet receiver and its normal service controls.  BotFleetControl is a service controller, not evidence that a native receiver runs.  Node server, native CompanionCore webhook actors and a control app are distinct.  Do not reanimate an intentionally retired Node server; if the native harness is the canonical receiver, port the non-dispatching log there before landing this Node implementation as complete.
2.  Verify the one canonical signing entry and the supported read-only runtime identity.  Confirm org hook and personal repository coverage using current supported permissions.  Listing hooks is not proof of create permission, and GitHub personal-account coverage requires a repository scope inventory, not an invented account-wide hook.
3.  Publish reviewed source under the owner's PR route, request the intended manual Kody review, address findings and pass required checks at the actual final head.  Update the PR body from stale draft language to this exact remaining checklist.  Green CI alone does not settle the release steps.
4.  Install only the verified pinned service, reconciliation configuration and separate status monitor, with backup and rollback.  Prove normal receipt, reconciliation after missed delivery, duplicate suppression, malformed-spool preservation and exclusive stale-lock recovery.  Simulate a failure and show the existing notification path actually reports it.
5.  Prove one real org delivery and one supported personal-repository delivery land in the Markdown file, with actor attribution and no payload prose or secrets.  Report the real openable log path.  Record unsupported scope explicitly.

The output is an event metadata ledger, not semantic detection or a copy of request text.  It can show who commented and the issue/PR but does not show what they asked.  The existing RoutineManager event channel now logs schedule/manual routine lifecycle states and catches up retained receipts after restart.  It never copies prompts or outputs.  Ordinary chat turns outside RoutineManager remain outside this coverage.  Do not hide these limits behind the phrase bot-request log or merge solely to clear the open PR.

Original GitHub comment/review permalinks are retained as clickthrough metadata when they are strict github.com issue/PR/discussion content URLs, without query strings or credentials.  Requests are not semantically classified: Jay can open the original comment to read its words.  GET-only reconciliation preserves the same link.  Internal routine states use a separate hashed run/status delivery ID namespace, so repeated lifecycle emissions do not duplicate a state or suppress GitHub delivery records.  Startup catch-up covers the retained RoutineManager receipts, not deleted history.


### BF1393 review corrections

Expired pending details receive one durable potential-gap marker, leave the retry queue, and no longer keep health red forever. A marked delivery remains unverified, not recovered. Non-expired transient failures remain retryable. Network reads occur outside the shared log lock; commit re-reads delivery IDs under the lock to catch concurrent writes. The cursor lock still serializes reconciliations of the same hook. Existing crash-held lock recovery rules apply to both locks.

Both formatters replace NEL, LS and PS as well as C0/DEL. Reconciliation drops malformed non-string metadata rather than coercing it to text. The authenticated dedicated route now requires a JSON object at the boundary, accepts unknown vendor fields, and still decodes individual metadata through its existing Zod schema. Arrays/primitives receive a metadata-only invalid_payload receipt and HTTP400; malformed JSON retains invalid_json handling. No payload prose is logged.

The pending inbox is part of recovery and backup scope, alongside the legacy spool, cursor and Markdown. A `.tmp` record from an interrupted pre-acknowledgement write must be preserved for manual inspection, not treated as an acknowledged delivery or deleted automatically. Completed `.json` inbox records are removed only after fsynced Markdown and cursor writes. These changes do not install, start or enable a receiver or monitor.
