# Native Host Automatic Start And Private Control

Refs BF-2605, BF-2602, BF-2531 and BF-2597.

## Behavior

Existing `NativeHeadlessHost.start` callers retain explicit Start behavior.  The new typed launch intent returns `stoppedByOwner` for automatic startup when a canonical private stop marker exists; it acquires the lifetime owner lease and validates that marker before opening the database, recovering waits or starting polling.  Unsafe marker files fail closed.

The foreground executable accepts `--automatic` after the explicit service-data argument and exits successfully when deliberately stopped.  Explicit startup clears a validated marker after successful runtime recovery.

The installer renders that automatic intent for `RunAtLoad`, upgrades older managed definitions in place, and shares the executable's argument parser with a fixture that launches the actual host from the rendered arguments without recovering a stopped database.

The explicit `start` wrapper preserves the current injectable native tool stack when forwarding into the new launch path.

A private `control.sock` inside the already-private service root accepts one bounded newline-delimited `status` or `stop` request per connection.  Production authorization uses kernel `getpeereid` and permits only UID 0; there is no executable authentication override.  Four connections, 32 request bytes, a two-second monotonic request deadline and a bounded reply deadline limit resource use.

Stop acknowledges success only after the existing deliberate shutdown drains work, checkpoints/closes SQLite, publishes the stop marker and releases the owner lease.  A failed stop reports `shutdownFailed`, retains the owner lease and leaves status available.  CLI signal and checked-control completion share an asynchronous completion stream.

Socket startup rejects non-socket, foreign, public or active entries.  It recovers only a matching private service-owned socket that refuses connections; cleanup compares socket device/inode identity and cannot intentionally unlink a replacement entry.  As with the owner lease, a private service root and installer-controlled parents are the contract; this does not sandbox a privileged installer replacing parent directories.

## Verification

The resumed source was reconciled onto main `c410e6f7` without changes to the Mac app composition or Control surface.

- Typecheck passed with `VITEST=true pnpm typecheck`.
- The native-release workflow, placement-evidence and decommission Node fixture suites passed all 60 tests.
- The foreground `BotFleetNativeHost` SwiftPM product built successfully with two jobs.
- The affected host, private-control, installer, runtime, event-wait and routine-admission Swift suites passed all 73 tests across six suites, including the final fixture refinements.
- Unsigned universal Mac and generic iOS Simulator Xcode builds both passed with signing disabled in an owned validation lane.

The original frozen `VITEST=true pnpm typecheck && VITEST=true pnpm test` run at `8dd5e4a0` completed normally with exit 1 after passing typecheck, all 12,658 Vitest tests across 744 files, and the probe, broker and updater stages; 22 tests and one file were skipped.

Its next stage failed two unchanged release-store permission fixtures because the inherited process umask was `0077`, which masked the modes those fixtures requested when creating files.

The exact package-script tail was resumed at `test:mac-updater` with process-local umask `022` and `VITEST=true`, passing 329 tests with eight skips in that stage and every subsequent stage through `test:board-audit`, before the credential-sync fixture exposed an unsupported assumption that Docker and podman were unavailable on the host.

The separate test-only isolation fix supplies rejecting private Docker/podman executables and asserts that only inspect probes occur, with no container exec attempt; all three credential-sync tests passed after that correction.

The exact remaining package-script tail from `test:server-start` through the final screenshot/sentence-gap fixtures then passed with exit 0 under the same process-local verification environment.

This is segmented completion of the required checks, preserving both earlier exit-1 receipts rather than claiming a single green full command.

The original non-isolated credential-sync run was reported separately for host audit and is not evidence of live service acceptance.

The pre-review complete Swift run passed all 1,169 XCTest cases and ran 368 Swift Testing cases with one issue in the unchanged `EngineRunnerAndSupervisorTests.swift:352` assertion that SIGKILL recovery finishes in less than two seconds.

The affected host, installer and control suites passed in that complete run, while that complete Swift command remained red and no cause for its deadline failure was established.

Earlier complete runs exposed two control-test observation problems: a fixed 450 ms sleep before status recovery and an inline POSIX `errno` read inside an assertion macro; the fixtures now await observed status recovery within a finite deadline and capture the signal result and error before assertion instrumentation.

The pre-review production Swift files were byte-identical across the frozen Node gate, the final pre-review Swift checks and both initial unsigned builds; the later pre-review commits refined fixtures and recorded evidence only.

Evidence is retained in the `codex-bf2605-resume-*` full-gate, tail-gate, credential-isolation and remaining-tail logs and exit artifacts, and the Mac validation lane's final focused/full Swift and unsigned Mac/iOS build logs.

## Review Follow-Up

Kody finding `4454409364` on PR #1546 identified bounded socket `poll` and `write` calls running inside the Swift task that handled actor-derived control replies.

Code commit `76b44c4e` moves those three output attempts to a utility GCD queue and awaits their continuation before the accepted descriptor can be closed or the connection slot released.

The GCD closure performs the synchronous output directly and resumes only after it finishes, so task cancellation cannot release or reuse the descriptor while an output attempt still holds it.

Authentication and request-error replies already run on GCD and retain that path, while root-only peer authorization, deadlines, connection limits, socket identity checks and checked-shutdown ordering are unchanged.

The foreground executable rebuilt successfully, and all 73 affected host, installer, private-control, runtime, wait and routine-admission fixtures passed across six suites.

One new complete Swift run then passed all 1,169 XCTest cases and all 368 Swift Testing cases across 32 suites with exit 0, preserving the earlier failed receipt without claiming its cause is resolved.

Unsigned universal Mac and generic iOS Simulator builds both passed on the changed Swift source with two build jobs and signing disabled.

The existing tests exercise complete status replies, bounded concurrent clients, checked stop before acknowledgement, failure reporting, descriptor cleanup and socket replacement; no implementation-only test or additional broad Node run was added for this Swift-only change.

Review follow-up evidence is retained in the Mac validation lane's `codex-bf-2605-review-host-build.log`, `codex-bf-2605-review-focused-swift.log`, `codex-bf-2605-review-full-swift.log`, `codex-bf-2605-review-unsigned-mac.log` and `codex-bf-2605-review-unsigned-ios.log` artifacts.

Fixtures use temporary service roots, a production subprocess with an explicit environment allowlist, synthetic children through the production runner, and injected peer observations only inside the test target.

## Shared Fixture Integration

The final source adopts the merged credential-sync isolation and failed-copy guard from PR #1544, plus the shared packaged-smoke fixture.  All four credential-sync fixtures passed, and the packaged bundle check passed with private HOME and synthetic instance configuration that suppresses unrelated host CLI discovery.  The smoke retains bundled imports, real SDK startup, HTTP identity, all 14 proxy paths and MCP flushing.  This is a bundle check, not installed or packaged-runtime acceptance; earlier failed receipts remain preserved.

The Swift production source is unchanged by this shared script integration, so the complete Swift and unsigned build receipts above still apply to those files.

## Delivery Boundary

This slice adds no account provisioning, launchd registration, package installer, signing, GUI attachment, provider credential bootstrap or live activation.  Credentials remain unavailable by default, desktop work remains held, and existing accepted or uncertain outcomes are never automatically replayed.
