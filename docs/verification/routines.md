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

## Cleanup

The test suite cleans up automatically.  No manual cleanup is needed.
