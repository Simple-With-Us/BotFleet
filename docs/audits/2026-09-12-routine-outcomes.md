# Routine Outcome Remediation

## Rechecked History

After the single-owner Mac adoption at ae8abe7d, a read-only 24-hour sample contained 527 retained receipts, including 507 marked completed.  Of those, 221 were combined deliveries settled immediately at dispatch.  Those 221 records do not prove successful execution; the older format does not retain a parent run ID from which to recover the result.  A preceding nearby sample had 14 failures: four explicit restart interruptions, three stopped bots, and seven without a stable classified cause.  These samples are dated observations, not current failure rates or evidence that every historical cause remains present.

## Result

Combined deliveries now retain their owning run ID and remain active until that execution finishes.  Completion, failure, cancellation, restart, engine/model identity, and capability denial propagate to every receipt in that execution; billing and failure callbacks count once.  Cancelling a combined receipt cancels the shared execution.  No automatic retries or history rewriting were added.

New run records retain safe outcome codes and failure phases.  Known watchdog timeouts, dispatch rejection, and provider reconfiguration carry explicit causes; unknown upstream errors remain generic execution failures rather than being parsed into arbitrary labels.  The actual event source supplies the engine instance and model when available.  A failure before any engine event leaves that identity unavailable.

Routine details show the latest retained success/failure and a seven-day completion rate.  Terminal outcomes use their completion time; pending work uses its creation time.  Combined receipts, cancellations, denied capabilities, and missed schedules remain visible outside the completed/failed denominator.  Legacy combined receipts are labelled outcome unavailable, and are excluded without changing the underlying history.  Last-result timestamps explicitly use Central Time.

## Validation

Typecheck and 54 focused tests passed, including shared success/failure/cancellation, durable settlement, single billing/failure callback, dispatch rejection, reasonless terminal events, rolling-window boundaries, and preservation of old history.  Peer review found two issues with window membership and reason propagation; both were corrected and covered before the full gate.

The actual renderer was checked in an isolated local harness with a paused synthetic routine, no production data, and no inference requests.  Two completed executions and one failure correctly show 66.7%, with cancellation, denial, and one combined delivery listed separately.  Screenshots are in `docs/screenshots/routine-outcome-summary.png` and `docs/screenshots/routine-outcome-diagnosis.png`.  The temporary preview processes were stopped after capture.  The full `pnpm typecheck && pnpm test` gate passed: 3,561 Vitest tests passed, 19 skipped, followed by all chained suites.  Signed rollout remains pending.

## Remaining Boundary

Follow-up #336 retains active executions, combined receipts and their parents, and results still needed by unsettled run-now confirmation cards.  The separate terminal tail is bounded at 2,000 records and pruned by completion time; once work and cards settle, the history returns to that bound.  Admission limits remain unchanged.  Peer review caught the confirmation-card result dependency, now covered by durable reload/retry coverage alongside active-group retention.  The existing calendar uses local scheduling time while the new result timestamps explicitly use Central Time; a unified calendar timezone conversion requires coordinated scheduling and date-input tests.

The #336 retention follow-up passed peer review and the complete local gate: 3,588 Vitest tests, 19 skipped, plus every chained suite.  Durable reload tests prove that an unsettled confirmation replays its original result after more than 2,000 newer terminal runs, then releases that result when the card settles.
