# Routines and webhooks

The routines fixture verifies scheduled task execution, webhook delivery, and routine state persistence in an isolated test server.

## Setup

```sh
pnpm test -- server/routines.test.ts
```

This test suite:

1. Starts an isolated BotFleet server
2. Creates a test bot with routine scheduling enabled
3. Seeds fake system time to control when routines run
4. Delivers webhooks to a mock endpoint
5. Verifies the run log and state changes

## Steps

```sh
# 1. Run the routine tests
pnpm test -- server/routines.test.ts

# 2. Expected assertions:
# - Routine creates successfully with name, schedule, and actions
# - Manual runs execute immediately and log in the run history
# - Scheduled runs trigger at the correct time
# - Webhook delivery includes the routine ID and turn count
# - Run state persists across server restart
# - Canceling a running routine stops it mid-execution
```

## Expected Evidence

A passing run shows:

- **Test output:** All routine creation, scheduling, execution, and state tests pass
- **Webhook logs:** Server logs show `POST` to the webhook endpoint with the correct routine payload
- **State persistence:** Restarting the fixture and querying the routine shows the same run count and status
- **Cancellation:** A running routine stops immediately when canceled and does not retry

## Key Behaviors Verified

- **Confirmed proposals:** Routines start only after explicit confirmation (not auto-approval)
- **Manual and scheduled runs:** Both paths record in the central run log with status
- **Central run logs:** List/Calendar views show all historical runs
- **Bot-scoped routines:** Routines stay visible only to their owning bot's members
- **Merged-pull-requests-only webhooks:** A webhook with `mergedPullRequestsOnly` runs only for a GitHub `pull_request` delivery whose action is `closed` and whose pull request merged.  Every other delivery (a pull request closed without merging, any other action, a `check_run`) answers `202` with `ignored: true`, creates no run, and adds one to the webhook's `ignoredCount`.  Turn it on or off with `PATCH /api/webhooks/<id>` and `{"mergedPullRequestsOnly": true}`.  Covered by `server/webhooks.test.ts`, `server/webhook-ingress.test.ts` and `server/webhook-payload.test.ts`: `pnpm vitest run server/webhooks.test.ts server/webhook-ingress.test.ts server/webhook-payload.test.ts`

## Per-Trigger Ingress Filters

Every filter below is optional and is configured on the trigger itself, with `PATCH /api/webhooks/<id>`.  A trigger without a filter behaves exactly as it did before.  A delivery a filter rejects is answered `202` with `ignored: true`, creates no run, adds one to `ignoredCount`, and appears in the webhook attempts list with the reason the filter gave (for example `Action “synchronize” is not enabled`).

| Filter | Applies to | Rules |
|---|---|---|
| `actions` | any sender | The payload's action must be listed.  The action is read as the GitHub/Sentry top-level `action`, the PagerDuty v3 `event.event_type` (for example `incident.triggered`), or a top-level `event`/`type` string.  A missing action is ignored. |
| `requiredLabels` | GitHub | A pull request or issue must carry at least one of these labels (case-insensitive).  A delivery with no pull request or issue, and any non-GitHub delivery, is ignored. |
| `conclusions` | GitHub | A `workflow_run`, `check_run`, `check_suite` or `workflow_job` must be `completed` with a listed conclusion.  Other events are unaffected. |
| `defaultBranchOnly` | GitHub | The delivery must be on the repository's default branch (`workflow_run.head_branch`, `check_suite.head_branch`, `check_run.check_suite.head_branch`, a push `ref`, or a pull request's `base.ref`).  Missing data is ignored. |
| `minSentryLevel` | Sentry | The issue or event level must be at or above this level (`debug` < `info` < `warning` < `error` < `fatal`).  An unknown or missing level is ignored. |
| `excludeSentryProjects` | Sentry | The delivery's project slug must not be listed.  This check runs before the fleet-infra reroute, so an excluded project never reaches the bot it would have been rerouted to. |
| `pagerdutyUrgency` | PagerDuty | The incident urgency (`event.data.urgency`, or `event.data.incident.urgency`) must equal this value.  A missing urgency is ignored. |

A list filter is trimmed, de-duplicated and capped at 20 entries of 200 characters.  Setting a list to `[]`, setting `defaultBranchOnly` to `false`, or sending `null` for `minSentryLevel` or `pagerdutyUrgency` clears that filter; every other filter on the trigger survives the edit.

### Fleet Examples

```json
{
  "name": "Deployer",
  "eventTypes": ["pull_request"],
  "actions": ["opened", "reopened", "ready_for_review", "labeled"],
  "requiredLabels": ["deployer", "post-deploy"]
}
```

```json
{
  "name": "Compiler",
  "eventTypes": ["workflow_run"],
  "conclusions": ["failure", "timed_out", "startup_failure"],
  "defaultBranchOnly": true
}
```

```json
{
  "name": "Designer",
  "eventTypes": ["pull_request"],
  "actions": ["opened", "ready_for_review", "review_requested", "labeled"],
  "requiredLabels": ["ui"]
}
```

```json
{
  "name": "Fixer Sentry",
  "actions": ["created", "unresolved", "triggered"],
  "minSentryLevel": "error",
  "excludeSentryProjects": ["fleet-infra"]
}
```

```json
{
  "name": "Fixer PagerDuty",
  "actions": ["incident.triggered", "incident.escalated"],
  "pagerdutyUrgency": "high"
}
```

```json
{
  "name": "Publisher",
  "actions": ["review_queue.entered"]
}
```

### No Run For An Off Bot

A webhook delivery for a bot that is switched Off creates no run at all.  The delivery is filtered at ingress, answered `202` with `ignored: true`, and recorded in the webhook attempts list as ignored with the reason `Bot is Off`.  The check runs on the bot the delivery actually routes to, after the fleet-infra reroute.  Scheduled routines and resource triggers are unchanged: their skipped `bot_off` records stay as they are.

Covered by `server/webhook-filters.test.ts`, `server/webhooks.test.ts`, `server/webhook-ingress.test.ts` and `server/bot-off.test.ts`: `pnpm exec vitest run server/webhook-filters.test.ts server/webhooks.test.ts server/webhook-ingress.test.ts server/bot-off.test.ts`

## Cleanup

The test suite cleans up automatically.  No manual cleanup is needed.
