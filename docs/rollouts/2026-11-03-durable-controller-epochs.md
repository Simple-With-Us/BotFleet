# Durable Placement Controller Epochs

Refs BF-2623.

## Behavior

Clean controller release and forced takeover persist the next controller id and epoch in the existing private `placement-controller.json` before acknowledging success.  The existing atomic writer syncs the staged file, and the controller store syncs the containing directory after publication on Linux and macOS.  Restart reads the last persisted pair, and `/api/placement/identity` reads the active lease service rather than its startup snapshot.

Transitions compare both fields against the stored pair under an exclusive `placement-controller.lock` directory.  A stale writer cannot replace a newer pair, an equal or lower epoch cannot be committed, and release refuses integer exhaustion.  Each fenced message and identity read refreshes the authoritative pair; seeing a higher persisted epoch marks held jobs for reconciliation.  A lower persisted epoch, corrupt state, or missing state in an already-open store blocks use instead of resetting the fence.

Write failures refuse the transition before changing the service controller, reconciliation state, or jobs.  If publication succeeds but the subsequent directory sync fails, the acknowledgement is refused even though the complete higher pair may already be visible on disk.  Later reads converge to that pair; the service never rolls the file backward to manufacture a successful retry.  This conservative uncertain-acknowledgement case can advance the fence without a successful reply.

The queue, worker registrations, reconciliation flag, lease book and orphan job flags remain in memory.  This slice proves durable controller epochs only; it does not prove restart recovery of those books, two-host placement acceptance, worker transport, authentication migration or production deployment.

## Verification

From the owned task lane with existing dependencies:

```sh
node node_modules/vitest/vitest.mjs run server/placement-controller-epochs.test.ts server/placement-identity.test.ts server/placement-leases.test.ts
node node_modules/typescript/lib/tsc.js -b
node node_modules/typescript/lib/tsc.js -p tsconfig.server.json
git diff --check
```

The isolated fixtures cover release and takeover across restart, persistence-before-acknowledgement, write failure without memory or disk changes, a held writer lock, stale services, a competing transition between validation and commit, two concurrent writer processes, invalid and exhausted epochs, corrupt/missing/regressed state, and the real HTTP identity route across release, takeover and a harness restart.  Every data directory is temporary, harness ports are probed free, provider instances use an unknown fixture driver, and container runtimes are disabled by the existing test harness helpers.  No fixture uses user data or port 8799.

## Rollout And Recovery

Preserve the complete existing data directory, including `host-id` and `placement-controller.json`, through updates and epoch-aware rollback.  First startup initializes epoch zero only when the controller file is absent; corrupt or unreadable state is preserved and blocks startup.  Do not restore an older epoch backup over a running service.

The writer lock is short lived and never stolen automatically.  A process exit between lock acquisition and cleanup leaves it in place, deliberately blocking startup and further transitions.  Recovery requires stopping all writers for that data directory, preserving and inspecting the complete controller file, confirming the stored fence, and removing only the abandoned empty lock directory before restarting.  Never remove another live writer's lock or reset the controller file to bypass it.

This change adds no process, installation, setting, worker endpoint or live-host action.  Linux and macOS retain the existing owner/authenticated-server placement boundary; Windows placement identity remains unsupported.

## Segmented Gate Follow-Up

After isolating packaged smoke from host CLI discovery with a private shadow instance, `VITEST=true pnpm test:packaged-server` passed the **bundle-check** path: the packaged server started without reachable `node_modules`, all 14 proxy paths resolved inside the bundle, and the packaged MCP stdio server reached the API and flushed its final frames.  The script explicitly labels this as not a runtime pass; no packaged-runtime pass is claimed.

The remaining chain from `pnpm test:ios-ship` through the final HTML sentence-gap and iOS screenshot Node fixtures completed with exit 0: 444 tests passed, zero failed, zero skipped.  Credential-sync passed all four fixtures, including the refused-copy case.  Earlier 45-second and 60-second packaged-readiness failures remain preserved as failed runtime-readiness attempts; the bundle-check result does not explain or erase them.

`pnpm lint` passed in the lane with 4,867 warnings, equal to the existing baseline of 4,867.

## Review Follow-Up

Identity authorization now precedes the lazy durable-controller read.  Unauthorized callers and unsupported platforms never invoke that reader; an authorized read failure returns a generic 503 without private parser details.  Placement mutations similarly return their existing structured refusal shape when a fence read fails, including missing, corrupt and regressed state, preserving the last verified pair only as refusal context.  No mutation proceeds using it.

The affected 35 fixtures, frontend and server typechecks, unchanged 4,867-warning lint ceiling and diff check passed.  The HTTP fixture now parses its fetched controller pair with a host-id and safe nonnegative epoch schema.  An initial follow-up run preserved a failed claim-response expectation and a shared Clutch export preparation failure; the corrected run used a private compiled Clutch copy and verified the shared export hash was unchanged by that preparation.

The suggested timed fence cache is declined: another process can commit a takeover between two messages, and accepting the cached pair until a timer fires would allow stale mutations.  Existing independent-service and competing-writer fixtures require immediate convergence.  This slice retains one fresh durable read per fenced message; transactional indexed persistence is a separate follow-up and does not justify weakening this fence.
