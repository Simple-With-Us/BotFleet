# Placement T9 Activation Scope

Refs BF-2559 and BF-2544.  T9 is the reviewed activation slice of [Placement Transport Slices](2026-11-03-placement-transport-slices.md), and the source design is [Native Server Mode](2026-10-29-native-server-mode.md).  This note says what activation would actually require, so the owner can decide whether to scope it at all.  It is a scope and not an execution plan.  It approves nothing, schedules nothing, changes no production source and promotes no assertion.

It was read from the source on Nov 22, 2026, against main at 513bad957.  Nothing here was run, and "exists" means present in source, not proven working.  All sixteen placement assertions stay false.

## What T9 Would Have To Change

Every slice before T9 proves itself in an isolated fixture.  T9 would be the only slice that changes what production runs, and it would have to:

- Pass a worker transport to the harness, so the worker routes stop answering 503.
- Compose the worker runtime and its runner-backed job adapter in production.
- Wire the durable report spool and the worker's reconnect reconciliation into a running harness.
- Open the SQLite placement authority that #1556 keeps closed behind a UUID marker.
- Install a mode picker that applies a placement mode a person chose.

That list is read off the rows of [Placement Transport Slices](2026-11-03-placement-transport-slices.md), and each item is the opposite of what the source does today.

## Preconditions

1. **The transport source exists and is deliberately inert.**  `server/placement-worker-runtime.ts` holds the heartbeat, the assignment pull, the lease record before spawn, the stop, the report and the restart reconciliation.  `server/placement-worker-jobs.ts` holds the process handling over the real job runner:  spawn, stop of the whole process group, the run limit, adoption of a surviving job by start time, and settlement from the exit file after a restart.  `server/placement-scenarios.test.ts` proves the loop in fixtures.  `server/placement-worker-jobs.test.ts` fails if any production module constructs the adapter or the runtime, so activation has to change that test first and say that it did.
2. **The mode contract is shared, not installed.**  `ios/Sources/CompanionCore/PlacementModeClient.swift` reads and writes `GET` and `PUT /api/placement/mode`.  `ios/Sources/CompanionCore/PlacementModeAvailability.swift` is a pure presentation and availability model with no UI, no network and no placement-activation side effect, and no installed view wires it.  The shared fixture `ios/Tests/CompanionCoreTests/Fixtures/placement-mode-frames.json` is read by the Swift tests and by `server/placement-mode-store.test.ts`, so the wire frames agree on both sides.  A shared frame is not an installed picker.
3. **The rollback bridge is built and retained first.**  #1556 leaves `server/placement-readonly.ts` selecting read-only authority on a UUID marker and constructing no writer, and the SQLite writer in `server/placement-store.ts` stays reachable only through its module interface.  [Placement Rollback Bridge Source Fixture](2026-11-03-placement-rollback-bridge.md) requires a compatible bridge release to be built and retained before activation.  A source fixture never proves that a shipped, signed and retained artifact is compatible;  `scripts/placement-rollback-probe.mjs` run against the actual shipped artifact is what would.
4. **The sixteen recipes have run and a human asserted them.**  `docs/verification/placement-evidence.json` keeps all sixteen assertions false, and `scripts/check-placement-evidence.mjs` requires all sixteen true, both inventory artifact paths and every hand-run record before it passes.
5. **Both host inventories are attached.**  The run's evidence state needs an `inventory.server` path and an `inventory.mac` path.  The server collection ran on Nov 17 and Nov 18, 2026 and its two artifacts are on that host in a private report directory;  the Mac collection has not run and is assigned to a Mac seat.
6. **The hand runs carry their own records.**  `mac-high-cpu-accepted`, `headroom-enforced-mac`, `headroom-enforced-server`, `mount-loss-root-fallback` and `other-apps-unchanged` each need a `handRun` record with the runner, the owner-clock time and the log path.  The three server recipes wait on Jay's explicit go-ahead with Jay present, and the approval reference is recorded in the run log.
7. **The candidate is pinned.**  The 40-character source SHA, the 12-digit shared build number and the 64-character signed artifact SHA-256 are the values the final CLI takes on its command line, and they are the candidate the packet is bound to.

## The Evidence Packet

The packet is the one [Native Final Evidence Bundle](../verification/native-final-evidence.md) describes, and its placement half is [Placement And Ownership Evidence](../verification/placement.md).

- **Candidate binding.**  The source SHA, the shared build number, the signed artifact SHA-256, the placement mode, the distinct Mac and server host identities with their roles, the expected engine inventory and the acceptance owner.
- **The placement receipt.**  The sixteen-recipe manifest, both host inventories and the hand-run logs, every referenced artifact hash-bound and read through the placement artifact validator.
- **The evidence state.**  A copy of `docs/verification/placement-evidence.json` in the run's evidence directory, with `at` in the owner's clock for every hand run.
- **Redaction before hashing.**  `scripts/collect-decommission-evidence.mjs` hashes the bytes it packages, so redaction has to happen before the hashes are issued.
- **The final CLI.**  `scripts/check-decommission-gates.mjs` with `--source-sha`, `--build` and `--artifact-sha256`, over a state file and a bundle in the same private packet.

An exit zero from that CLI means only that the packet is internally consistent.  It does not authenticate the runner, it does not prove a recipe passed, and it does not grant the live action.

## The Owner's Decision Points

1. **Whether to activate at all, and on which candidate.**  Nothing before this list is a reason to say yes.
2. **Which modes ship first, and whether the Mac becomes a worker.**  This Mac Only keeps refusing past its running cap, and that ruling is the recommendation.
3. **The numeric headroom defaults, taken from the two inventories.**  The collector sets nothing and chooses no number.
4. **The server's apply path for headroom.**  The root drop-in first, then `systemctl set-property` with a polkit rule, or `Delegate=yes` with per-job cgroups.
5. **Whether the server's probe fails closed on an unknown reading.**
6. **Who enrolls workers and writes the authorization records.**  #1565 reads them and does not issue them.
7. **Each server hand run's go-ahead, with Jay present.**
8. **The owner's own acceptance.**  The collector cannot synthesize it.

## What Stays Unwired Until Then

- `server/index.ts` passes no worker transport, so the worker routes keep answering 503.
- `server/index.ts` constructs no `PlacementWorkerRuntime` and no `PlacementWorkerJobs`, and the registry's optional `placementWorkerRuntime` dependency stays unset.
- No production module constructs `PlacementWorkerClient`;  `server/placement-report-spool.ts` imports the class for a type only.
- The legacy JSON epoch store stays the production authority, and the SQLite placement store stays unreachable outside its module interface.
- No installed mode picker wires `PlacementModeAvailability`.
- All sixteen placement assertions stay false, and `placement-evidence` keeps blocking the decommission state.
- The Mac Node harness stays in place.  No decommission, no deletion and no retirement is in scope here.

## Open Questions Carried Forward

- **Question 10:**  whether the server's probe fails closed on an unknown reading.  T4 kept today's behaviour, so an unknown reading still admits.
- **Question 6:**  which server apply path for caps is acceptable.
- **Credential custody:**  who enrolls workers and writes the authorization records.

## What This Note Does Not Do

It approves no activation, schedules no work, changes no production source and promotes no assertion.  Every claim above names the file it was read from, and a reader who wants a fact checked against the source has the path.
