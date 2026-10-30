# Placement Foundation Rollout

Refs BF-2559.  Implements BF-2596: slice 1 and the documentation/checker half of slice 12 in [Native Server Mode](../plans/2026-10-29-native-server-mode.md).

## Behavior

The existing local registry still starts local jobs through the same admission and spawn path.  Each data directory gains one private stable `host-id`, and each new local job records that identity as both `controllerHostId` and `host` before spawning.  Mac jobs say "Running on this Mac"; Linux local jobs say "Running on this server".  No mode picker, routing, lease execution, automatic failover or resource defaults are enabled.

Job persistence, snapshots and SSE accept optional controller/worker identities, lease id, epoch and placement/queue reasons.  Swift decodes the same optional fields and the three new statuses while retaining its unknown-status fallback.  Legacy records without those fields still load.  The legacy local process lifecycle leaves placement states and another host's active records unchanged.

The placement evidence checker and [sixteen recipes](../verification/placement.md) gate later retirement of the Mac-local Node stack.  The state builder never infers `placement-evidence` from completed issues.  Every assertion in the checked-in example remains false, including all live evidence.

## Validation

- `pnpm typecheck` passed.
- Focused Vitest run passed 54 tests across host identity, placement contract and job registry suites.
- Node evidence/decommission run passed 36 tests.
- The TypeScript contract test loads the same fixture bytes used by Swift `JobsTests`.
- Isolated Mac validation passed 989 XCTest tests and 273 Swift Testing tests, including the shared jobs fixture, and an unsigned iOS Xcode build.
- The full local `pnpm test` run failed: 61 failed, 12,171 passed and 33 skipped tests across 722 files.  The recorded env-path, credential and plugin groups account for 36 matching failure headers from the unchanged-base run; additional HTTP-state and ACP timeout failures are being rechecked.  This is not a green full-suite result, and hosted gates remain required.
- No live host probes, inventory, installations, resource settings or deployments were performed.

## Update And Rollback

Ship through the existing reviewed build/update path.  Preserve the complete data directory, including `host-id`, through code updates and rollback.  If identity is unreadable or invalid, startup refuses to replace it; restore the known identity from the data backup before restarting.  Never seed another host with an already-running host's id.

The new job fields are optional; a legacy build's schema may discard them when it saves a job.  Returning to older code is therefore only a local-only rollback before the later placement runtime is enabled.  Once epochs and leases become active, the later epoch-preserving rollback recipe is mandatory; the foundation does not claim that runtime exists.

Next is slice 2: measured host resources and honest enforcement reports.  Inventory, numeric budgets, controller queue, lease runtime and the authorized server hand runs remain later work under BF-2559.
