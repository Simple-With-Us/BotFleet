# Native Servers Settings

BF-2603 implements slice 6 of the approved native server plan.  Settings › Servers lists the editable This Mac anchor and saved servers.  Add saves metadata; Test verifies an exact origin and enrolls a fresh token after the complete handshake succeeds.  Rename changes only a display name.  Remove checks the current connection, controller, leases, and saved/applied selections before deleting a token and metadata.

The app starts on This Mac.  Adding or testing a server does not change chat, actions, events, placement, or the current connection.  A saved remote origin cannot be edited in place.  This Mac has an explicit loopback HTTP address edit; the general store operation continues to reject origin changes.

## Isolated Recipe

Run on a Mac with the repository's Swift toolchain:

```sh
swift test --package-path ios --filter 'ServersCoordinatorTests|SavedHostsTests|ServerHandshakeTests|MacPhase3VoiceSystemUITests|MacLocalConnectionBootstrapTests|JobsTests'
```

The fixtures use private temporary host stores, fake credentials and a stub URL protocol.  They never open the real Keychain, start a server, contact the running harness, or change its data.  The coordinator fixtures check pinning, credential failure compensation, partial removal failure, current-connection/controller/lease/selection refusals, and stale handshake completion after rename, removal, cancellation and local edits.  A suspended metadata commit proves that Cancel cannot invalidate an enrollment in its committing phase.  An unrelated suspended settings mutation produces an explicit retest message.

The bootstrap fixtures suspend the initial saved-host load, then disconnect or cancel startup before releasing it.  Neither case connects.  A successful load chooses only the saved This Mac record, even when a remote record appears first, while a failed or anchorless load stays disconnected.

The request fixtures check all read-only handshake routes, exact identity pins, authentication, missing routes, placement wire mismatch, optional capacity values, and rejection of malformed capacity.  Displayed capacity uses reported cores, GB RAM and GB free on the data volume; absent values remain unknown.  Sample timestamps are milliseconds on the wire and use the owner's clock when displayed.

Placement wire version `1` is independent of the health/resources product version.  Swift enrollment and `shared/placement.test.ts` read the same fixture, `ios/Tests/CompanionCoreTests/Fixtures/placement-wire-version.json`, and check their compile-time wire constants against it.  Missing placement routes produce an update-server explanation and never enable a placement mode.

## Persistence And Recovery

`hosts.json` lives in `MacPersistencePolicyStore.dataDir`, with the existing private-file checks and atomic writes.  Tokens live only in the per-user saved-host Keychain namespace, bound to the record UUID, exact origin and optional server identity pin.  Enrollment inserts a token atomically without replacing an existing credential.  An old unpinned credential requires removing the record and adding it again with a fresh token.

If saving a new pin fails, the coordinator deletes only the newly inserted credential.  If that compensation fails, the status explicitly requires removal before reenrollment.  Remove deletes the token first; a token-delete failure leaves the metadata in place.  If metadata deletion then fails, the app says the token was deleted and the saved server remains, so Remove can be retried.  Existing Control host files are not imported.

The native Mac UI is verified by code review and an unsigned `BotFleetMac` build after generating the project from `ios/project.yml`.  No running app or owner screenshot is required.

## Recorded Gate Boundary

The required Linux gate completed before the foundation merge and startup cancellation fix.  Typecheck passed; the full test run exited 1 with 37 failed, 12196 passed and 26 skipped tests across 720 files, taking 2210.37 seconds.  Its complete log is retained as `codex-bf2603-required-gate.log` in the task's external scratch evidence.  Comparing failure headers with `codex-bf2599-test.log` retained all 36 preceding headers and removed none.  The sole added header is `server/index.test.ts > harness HTTP API > holds deferred fallback ownership across targeted and unrelated provider reloads`; its assertion says `instance cleanup writes did not settle within 6000ms`.  This comparison does not establish a cause.

The complete Mac Swift run before the startup fix passed 1029 XCTest cases.  Swift Testing ran 256 cases with one issue: the unchanged `MacCuaDriverTests.swift:174` assertion that active displays must be nonempty returned an empty display list in the validation context.  The full gate is therefore not reported as passing.  After merging the foundation and adding the startup fence, the focused Swift command above passed 91 tests; typecheck, lint baseline and all four placement contract tests also passed.  Unsigned Mac and iOS simulator builds passed against those same Swift sources.  The later peer packaged-owner startup merge changed only its two updater JavaScript files, preserving the Swift source hashes and the telemetry inventory row.  Its scoped updater test file passed all 119 tests after the merge.
