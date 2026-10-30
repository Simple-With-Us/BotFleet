# Native Headless Host First Composition

Refs BF-2602, BF-2531, and BF-2597.

This implements a foreground native host that recovers durable event waits and can execute their follow-ups through the production Claude stream runner, POSIX process supervisor, coordinator, and SQLite message store.  It is the first composition slice for the approved optional dedicated service identity, with separate app-owned data.

## Runtime Boundary

`NativeHeadlessHost.start(serviceData:credentials:pollIntervalSeconds:)` requires an explicit absolute service root whose final parent already exists.  The root, service home, temporary directory, and bot workspaces must be private directories owned by the executing identity.

A stable `owner.lock` inode holds a nonblocking lifetime file lock before database creation, recovery, schema changes, or polling.  Opened and listed device/inode identity and single-link ownership are checked before and after acquisition, so a swapped directory entry cannot publish an owner of an orphaned inode.

A second owner reports `ownerAlreadyRunning` even if the first owner is waiting or shutting down.  Provisioned parent directories are installer-controlled; replacement of those parents by a privileged installer is outside this runtime contract and is not a filesystem sandbox.

The host refuses interactive roots containing `config.json` or `harness-owner.json`, symlink lock/store/workspace paths, and unexpected file ownership.  It creates a separate `host.sqlite`; it does not migrate the interactive app's data or copy a login home.

Trusted local composition can register a typed bot with one native Claude executable, model, service-owned workspace, and desktop requirement.  Registrations persist in the native store and cannot change while the graph is running.

The thin `BotFleetNativeHost --service-data /absolute/private/service-root` executable opens this actual graph, recovers existing registrations and waits, polls predicates, and shuts down cooperatively on SIGINT or SIGTERM.  Signal handlers install before opening the graph, buffering a startup signal until checked shutdown can run.

It opens no network listener and provides no network registration, credential grant, or attachment endpoint.

## Capabilities And Credentials

The default service credential source always reports unavailable.  It never reads the GUI Keychain, Infisical bootstrap material, process-owner credentials, or ambient authentication environment.

Resolver failures become typed credential holds without persisting their error descriptions.  A host-specific task-local guard refuses a credential callback that tries to await the shutdown responsible for draining that callback's own dispatch.

The production supervisor starts with an empty inherited environment.  Only the explicit service credential context, fixed system PATH, private service HOME/TMPDIR, and runner containment settings reach the child.

Work that explicitly requires a desktop is held as `waitingForLogin`; credential-dependent turns are held as `credentialsUnavailable` before durable dispatch acceptance.  This slice has no desktop attachment grant API, so desktop work stays held.

Before credentials or desktop attachment, the graph still performs durable recovery, confined file predicates, registered bot-idle predicates, known owned-process completion checks, expiry, and capability holds.  Once an approved credential source is injected, the same graph can execute CLI turns and persist their messages without NSWorkspace or desktop permission.

The host's process ledger recognizes only children it launched, matched by bot and kernel process start time.  Unknown processes, discarded bounded history, and previous host generations do not satisfy process-completion predicates.

## Acceptance And Recovery

Execution context resolves before `claimNativeEventWaitDispatch`; the queue checks lifecycle fencing again after awaited preparation.  A typed capability hold has no accepted ledger entry.

`refreshCapabilities()` can resume only typed, unclaimed holds.  Startup also resumes those holds for reevaluation, while accepted, legacy-held, and uncertain shutdown/restart outcomes remain held without automatic replay.

The optional `admissionHold` snapshot field preserves decoding of existing waits.  Schema backfill and snapshot reconciliation keep legacy held outcomes fenced while allowing a newer, ledger-checked transition from capability-held to pending.

## Checked Shutdown

The host fences new local operations and execution context, stops polling, waits for in-flight operations, cancels and drains owned turns and children, and awaits wait persistence.  Native turns opt into required message persistence; a failed write cannot produce a successful checked shutdown.

After draining, the host flushes pending native writes, checks SQLite WAL checkpoint completion, and explicitly closes the connection.  A requested deliberate-stop marker is written only afterward, and the owner lease is released last.

An incomplete shutdown reports `shutdownFailed`, retains the owner lease while the process lives, and writes no successful stop marker.  Concurrent shutdown requests share one completion and its failure, and cancellation of a waiter does not abandon that completion.

An explicit stop upgrades an ordinary shutdown already in progress.  A later explicit stop after successful shutdown reacquires the lifetime lease before publishing a marker, so an old host cannot mark a newer active owner stopped.

Marker permissions and file flush are checked before atomic publication.  A marker-write failure retains the lease and is shared with subsequent stop waiters.

Successful startup clears a prior deliberate-stop marker before polling.  The foreground signal path performs cooperative shutdown without creating a deliberate-stop marker for a future supervisor.

The older companion shutdown route retains its existing behavior for current default-off UI callers.  The new host does not expose or use that route as its stop contract.

## Isolated Verification

The fixture CLI is a temporary protocol-speaking shell executable running through `ClaudeStreamRunner` and the production POSIX supervisor.  Its environment is an explicit synthetic allowlist; no signed package, live app, account, credential store, network service, or user workspace is used.

Tests cover durable user/assistant messages and restart without replay; real workspace predicates; missing credentials and later capability restoration; resolver error redaction and reentrant shutdown refusal; desktop holds; accepted-outcome recovery; competing ownership before database creation; stable and swapped lock inodes; symlink and interactive-root refusal; suspended admission racing shutdown; cancelled and mixed-intent stop waiters; late explicit-stop fencing; active child termination; busy WAL checkpoint refusal; marker-write failure; and explicit database close.

Initial Mac source provenance was base `97b2b35a4a228232468a3d06d4c41dfc86eb7371`, the three published BF-2595 listener files from `de66a913d`, and the BF-2602 source/test overlay.  Validation uses the separate `codex-bf-2602-native-host-validation` lane with two Swift jobs.

The full Swift snapshot before the final resolver/lifecycle refinements passed 988 XCTest cases and 280 Swift Testing cases, including the first 13 host tests.  The final scoped host suite passed all 19 tests after those refinements.

Commands were `/usr/bin/swift test --package-path ios --jobs 2` and `/usr/bin/swift test --package-path ios --jobs 2 --filter NativeHeadlessHostTests`.  Evidence is in `codex-bf2602-full-swift.log` and `codex-bf2602-host-final-19.log` beside the owned Mac validation lane.

The initial scoped pass does not replace the earlier full-snapshot qualification.  The subsequent integration checks and their exact boundaries follow below; publication review and protected CI remain with the primary delivery task.

## Delivery Verification After Main Integration

The single BF-2602 implementation commit was rebased onto main `1db79ba5d93b90570d9e93b4421439a8ff6ab123`, producing frozen code head `2749233561954c6c5428e06f70d9c650d112475a` for the required Linux gate.  Source remained unchanged throughout both attempts.

The first attempt ended without a final summary or recorded exit status after 39 completed file reports, last reporting `server/transcript-retention.test.ts`.  The recorded process chain and all remaining lane workers were verified absent through process metadata before one clean replacement run; the termination cause was not established.

The exact partial log and metadata are preserved as `codex-bf2602-required-gate-partial.log` and `codex-bf2602-required-gate-partial-evidence.json`.  The partial log SHA-256 is `506a2c9bf68f139fa8be79dd5c741ec483feee7a5f3463b2be6f7b9df0fc2e1c`; it is not counted as a completed gate.

The replacement command was `VITEST=true pnpm typecheck && VITEST=true pnpm test`.  Typecheck passed; the test command exited 1 at the full Vitest stage, with 36 failed, 12,197 passed, and 26 skipped tests across 720 files: 5 failed, 714 passed, and 1 skipped.

All 36 failure headers exactly match `codex-bf2599-test.log`, with no added or removed failure names.  The file counts are 20 in `server/plugin-sandbox.test.ts`, 8 in `server/plugins.test.ts`, 5 in `server/plugin-zulip-dispatch.test.ts`, 2 in `server/local-vm-gh-credentials.test.ts`, and 1 in `server/env-path.test.ts`.

The final log, separately recorded exit status, and exact baseline comparison are `codex-bf2602-required-gate.log`, `codex-bf2602-required-gate-exit-status.log`, and `codex-bf2602-required-gate-comparison.json`.  Since the chained test command stopped at Vitest, its later script stages did not execute in that full attempt.

The combined Mac full run on that source compiled successfully and passed 988 XCTest cases.  Swift Testing ran 298 tests with one issue: `MacCuaDriverTests.swift:174` received an empty display list; the 19 host tests and 12 pairing-contract tests passed, and no cause for the display assertion was inferred.

After the frozen run settled, the implementation was rebased coherently onto main `8152ade4c3b7c4c3839204a87db8585b4565d933`, producing code head `c1f999af4310530fba5dd4ce9a661155dd77476a`.  This incorporated placement contracts, Claude-call telemetry proof, and packaged Mac owner startup changes without repeating the full suite.

Scoped verification on the integrated source passed:

- Typecheck and eight changed Vitest files: 279 passed and 1 skipped.
- Decommission, placement-evidence, and Mac updater/startup script tests: 156 passed.
- Mac Jobs XCTest cases: 27 passed.
- Native host and pairing Swift Testing cases: 31 passed, comprising 19 host and 12 pairing tests.
- Unsigned generic iOS Simulator build with signing disabled: `BUILD SUCCEEDED`.

The project was generated with XcodeGen for the initial unsigned build; its project definition was unchanged by the later main integration, which received another unsigned build.  No additional Mac full test run was used to replace or obscure the earlier display assertion.

Integration evidence is retained in `codex-bf2602-main-integration-scoped.log`, `codex-bf2602-main-full-swift.log`, `codex-bf2602-final-main-scoped-swift.log`, and `codex-bf2602-final-main-unsigned-ios.log`.  The complete Node gate remains failed with the baseline-matching failures above; the scoped passes do not establish an all-green full gate on the final rebased head.

## Remaining Delivery Boundary

There is no launchd registration, daemon installation, service-account creation, signing change, credential issuance/bootstrap, GUI attachment, or reboot acceptance in this slice.  General cron execution, the Node Jobs system, additional CLI engine composition, and network ingress remain separate work.

The selected dedicated identity and separate-data architecture require no new owner decision for this code.  Account provisioning, scoped service-accessible Infisical bootstrap, installer authorization, and live before-login acceptance still require their later reviewed implementation and approval.
