# Placement And Ownership Evidence

Refs BF-2559, BF-2596, BF-2544, BF-2514 and BF-2515.  The source design is [Native Server Mode](../plans/2026-10-29-native-server-mode.md).  This foundation adds contracts and local identity; Server First routing, queues, leases and the mode picker are later slices.  No recipe below is asserted by the foundation alone.

## Contract Check Available Now

From an owned lane:

```sh
pnpm exec vitest run server/host-id.test.ts shared/placement.test.ts server/jobs/registry.test.ts shared/jobs.test.ts
node --test scripts/placement-evidence.node-test.mjs scripts/decommission-gates.node-test.mjs
swift test --package-path ios --filter JobsTests
```

Expected: passing tests, one stable private `host-id` across concurrent first starts and restarts, both ids recorded before each local spawn, and old jobs decoding with absent placement metadata.  The same `ios/Tests/CompanionCoreTests/Fixtures/jobs-placement.json` bytes pass through the persisted TypeScript schema and snapshots and Swift's SSE decoder.  `queued`, `dispatching` and `worker-unreachable` stay active; legacy local process recovery cannot settle a remote placement record.  A Mac run is required for the Swift command when Swift is unavailable on the working host.

Host identity is `<data dir>/host-id`, mode 0600, `mac:<uuid>` or `server:<uuid>`.  Existing invalid or unreadable identity fails startup rather than minting a replacement.  Preserve this file with the data directory during update and rollback; do not copy one running host's identity to another host.  Old job records remain unchanged until saved and do not acquire invented historical ownership.

## Fixture Rules

Use temporary data directories, free ports, `BOTFLEET_DISABLE_CONTAINER_RUNTIME=1`, fake spawn counters, injected resource probes and an injectable disconnected link.  Never use port 8799 or user data.  Two-host recipes run two isolated harness processes with a controller and worker; a nonce-writing job proves execution counts.  Capture commands, source commit, output and artifact paths with every run.  The cases below are acceptance requirements for later slices, not executable behavior shipped by this contract change.

## Placement Recipes

| Key | Fixture And Action | Required Result |
| --- | --- | --- |
| `fresh-mac-only-install` | Empty Mac store, one harness, no server or vault; complete a nonce-writing job and inspect the native settings model. | `localOnly`, local controller and worker ids, "Running on this Mac", no requests off loopback; both server modes disabled with "Add a server to use this mode." |
| `server-first-placement` | Two harnesses in `serverFirst`; submit automatic, Mac-pinned and `xcodebuild` jobs. | Automatic runs on the server with "preferred server"; pinned runs on Mac with "pinned to this Mac"; `xcodebuild` runs on Mac with "needs xcodebuild"; only the controller has job records. |
| `server-saturation-overflow` | Server reports swap 99 percent or free disk 100 MB; overflow is on. | One Mac start with "server at its memory budget"; zero server starts. |
| `both-hosts-pressure-queue` | Both probes refuse; enqueue several jobs for one bot, then clear one probe. | Both host reasons are shown while queued; oldest starts first; each job has exactly one nonce. |
| `disconnect-no-duplicate` | Cut a running Mac worker's link; finish while disconnected; reconnect and replay the dispatch and report; also lose the dispatch acknowledgement. | Controller shows `worker-unreachable` within the configured window; report spool applies once; same lease acknowledgement is idempotent; a different lease for the same job is refused; one spawn and nonce throughout. |
| `mode-change-fence` | Attempt `serverFirst` with one local active job; finish it and retry; send dispatch and report from a pre-switch worker at epoch N. | First switch refuses with "Finish or stop 1 job running on this Mac first"; successful switch writes N+1 on both hosts; stale messages receive current controller and N+1; zero stale spawns. |
| `forced-takeover-and-return` | Disconnect a `serverFirst` controller with a running job and held routine; explicitly take over on Mac and choose Drop for the held run; reconnect. | Mac writes N+1, `localOnly` and reconciliation flag; server demotes, refuses new admission and reports its old job; post-cut work is visibly identified; flag clears; no rerun of job or dropped routine. |
| `rollback-keeps-epoch` | After takeover and release at N+1, restart older code with the same data; then test below-minimum protocol version and a restored epoch-N data backup. | Same data retains N+1; old protocol fails before acting; restored data converges to N+1 on heartbeat; stale queues spawn nothing on either host. |
| `connect-and-revert-clean` | Complete two local jobs, add and test a server, complete a server-first job, cleanly return to `localOnly`, remove the server. | Old records and logs unchanged; N+1 on Mac; server released; swap/disk gates still refuse correctly; no address outside Settings or requests off loopback. |

The seven remaining keys are specified in [Headroom Evidence](headroom.md).  Together these are the plan's sixteen recipes; none may be replaced by a successful typecheck or a review decision.

## Recording And Checking Evidence

Start from [placement-evidence.json](placement-evidence.json), whose assertions intentionally remain false.  Copy it into a run's evidence directory and add artifact paths relative to that file, or absolute paths.  Set a key true only after its complete recipe passes.  Hand runs require `at` in America/Chicago written as `2026-10-30 3:15 PM`, `by` naming the runner, and `log` naming the captured output.  Machine timestamps within raw logs may remain machine timestamps.

```sh
node scripts/check-placement-evidence.mjs /absolute/run/placement-evidence.json
```

Expected while unfinished: exit 1 with `Placement evidence is BLOCKED` and each unasserted key.  Unknown keys, truthy strings or malformed records produce exit 2.  The checker requires all sixteen true assertions, both inventory artifact paths and every hand-run record; every supplied artifact must be a readable file.  It checks explicit assertions and artifact availability, so the reviewer must still inspect the output and approval for each recipe.

Only after that review may a human assert `placement-evidence` in the decommission state.  The decommission state builder defaults it to false, even when every Linear issue is Done.  Recipes 11, 12 and 13 require Jay's recipe-specific go-ahead on the server with Jay present.  The foundation does not grant that approval, run inventory, choose numeric defaults, install anything or change a live host.
