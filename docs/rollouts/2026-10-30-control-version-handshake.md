# Control Version Handshake And Explicit Update

BF-2531 implements the owner's Oct 30 Decision 2 ruling: “Version handshake with an explicit Update Control action (recommended)”.  Decision 1's product/fleet split remains the boundary, and optional pre-login support is the separate BF-2597 task.

## Version Contract

`GET /api/system/control` adds optional `serverBuild` metadata with `version`, `build` and `sourceCommit`.  The route keeps its existing loopback and companion-replay gates, and contains no new secret, download URL or executable path.  Control reads its own version and build from its bundle and its source commit from the bundled identity.

Build components are compared numerically, with absent trailing components treated as zero.  The build is the shared planner's chronology authority across marketing versions, including the transition to 0.1.0.  Equal builds with conflicting marketing versions or known source commits report different identities with unknown order.  Missing or malformed metadata stays unknown; older status responses still decode, and the existing too-old server stop path stays available.

The runtime manifest accepts an optional `build` without rejecting older manifests.  The Control builder stamps its exact version and build into its own identity.  The current server bundle does not supply a release build yet: BF-2588 must pass the shared planner's existing `{build}` output into `readSourceBuildIdentity` when it adopts that planner.  Until then, the handshake can identify differing versions or known commits but does not infer which build is newer.

## Explicit Update Transaction

Control's `Update Control…` validates the installed BotFleet app and its bundled Control package's update-handler protocol before launching the app with the fixed `--update-control` argument.  A second instance delivers that argument to a running Electron app; a Control-only launch exits after the transaction without entering ordinary server startup, clearing stop markers or migrating account credentials.

The owning app compares the bundled and installed version/build metadata, asks for the explicit `Update Control` selection, requests a normal Control quit and observes exit before reusing the existing staged-copy/rename installer.  A busy Control app can refuse to quit; it is never forcibly killed or overwritten while observed running.  The installer rechecks before replacing, rejects release drift after consent, and retains its rollback on rename failure.  Cancellation changes nothing, and the transaction never reads or rewrites saved hosts or remote tokens.

An older, equal, unknown or unavailable replacement is refused.  A native-only BotFleet installation currently has no bundled Control replacement or handler; the action reports that precise missing delivery capability and performs no install.  No server-provided path, download source, native lifecycle replacement or daemon is added here.

## Verification

The Node fixtures use temporary application directories and injected quit, process-probe, dialog, sleep and open handlers.  They cover cancellation, explicit selection, normal exit, a refused quit, a restart during the transaction, unsuitable package identities and release drift.  Runtime identity tests preserve old manifests and accept the shared timestamp unchanged.  Swift tests cover numeric build order, timestamp migration, unknown metadata, source mismatch, real status decoding and a supported package handoff through a stub command runner.

```sh
node --test electron/server-controls.node-test.mjs electron/runtime-identity.node-test.mjs electron/control-build-version.node-test.mjs
pnpm typecheck
VITEST=true pnpm exec vitest run server/index.test.ts -t 'native server controls expose VM state without configuration secrets'
swift test --package-path mac-control --jobs 2
```

All 31 targeted Node tests, `pnpm typecheck`, the lint baseline, the focused server fixture and `git diff --check` passed locally.  The server fixture ran one selected test against its temporary home and randomized loopback ports, with the other 311 tests skipped.  Swift validation and native menu review require the primary agent's Mac route.  No live Mac application or process was launched, quit or installed during implementation.
