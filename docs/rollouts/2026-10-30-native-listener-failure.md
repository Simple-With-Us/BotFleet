# Native Listener Failure Reporting

BF-2595 follows the native listener lifecycle wiring in BF-2590.  A Network.framework listener that became ready could later fail while Settings continued to report it as listening.

## Behavior

Each backend start now receives its own sequenced network-state callback.  A `.waiting` event retains the listener and reaches `CompanionListenerController` as `Waiting for network: <reason>`; a later `.ready` automatically restores its listening state.  A fatal `.failed` event clears that listener's current socket and records `.failed(reason:)` through the existing MacSession mirror.  Settings uses the phase-neutral text `Listener failed: <reason>` for both startup and running failures.  An initial waiting state leaves the start pending until ready, fatal failure or intentional stop.

The controller checks the start generation and each update's sequence before accepting a network state.  A queued event from an older listener cannot overwrite a newer listener, an explicit stop or a disabled setting; an out-of-order event from the same listener also cannot overwrite a newer observation.  A waiting or failed state arriving after socket readiness but before the start call returns survives that return.  Startup across shared runtime activation is fenced so an intervening stop or replacement cannot be followed by the older start opening a socket.

A replacement validates its port, activates the runtime and constructs/configures its new listener while the old listener remains available.  A preparation error leaves the healthy socket in place.  After preparation succeeds, binding a replacement on the same address requires cancelling the old listener before starting the new one; this is a necessary bind handoff, not an atomic ready-to-ready swap.  An old listener's queued failure cannot invalidate a newer start that is still preparing.

An intentional socket cancellation does not send a failure callback.  Enabling again after a genuine failure retries the listener.  The setting remains off by default, and MacSession retains its loopback-only options with no Bonjour advertisement.

## Isolated Verification

The original five tests in `CompanionListenerControllerTests` exercise a running failure and the state mirror, failure before a start returns, a stale listener failure after restart, a stale start error after retry, and intentional stop or disable with queued failures.  Four additional tests cover automatic waiting/ready recovery, waiting before a delayed start returns, stale waiting/ready events after stop or restart, and out-of-order event delivery.  The fixture stores callbacks and uses checked continuations; these tests open no sockets and perform no desktop input.  The existing loopback listener fixture also checks that failed runtime preparation preserves its healthy port and explicitly cancels a conflicting bind that is waiting.

Two further regressions cover a ready callback followed by a fatal start throw, and the settlement helper retaining a reserved fatal error over delayed readiness or cleanup cancellation.  These cover the fatal-completion race found during the primary agent's review before publication.

Run on a Mac with the repository's Swift 6.4 toolchain:

```sh
swift test --package-path ios --filter CompanionListenerControllerTests
```

Before the review corrections, the isolated Mac validation checkout passed the full iOS package: 988 XCTest tests and 273 Swift Testing tests, including the first five races.  An unsigned iOS Xcode build also passed.

The waiting/replacement revision compiled on the Mac and its scoped suite passed all 28 tests.  That combined full package passed 1,004 XCTest tests; its 277 Swift Testing tests reported exactly one failure, `MacCuaDriverTests.testDisplayEnumeration` at line 174, where the display list was empty.  A separate run of only that display test reproduced the failure.  The source returns an empty list when its CoreGraphics query fails or reports no active display, so no login, unlock or permission cause is established by this result.  The full package gate therefore remains failed; the primary agent retains the logs and owns the renewed unsigned Xcode build.

This validation snapshot combined the listener source with pairing commit `ddae4f6b2518aeed30dea6529a70133d977dd218`, the saved-host library and Jobs fixtures already in the shared Mac package.  The listener transfer changed only its server, controller and test files; the subsequent final saved-host hardening is validated separately.  Local `git diff --check` passes.  Validation did not install or launch the app against live user data.

The later fatal-completion correction compiled in the shared Mac package with the final saved-host hardening retained, and all 30 scoped listener/settlement tests passed.  Its evidence is `codex-bf2595-fatal-race-swift.log`.  This last run was scoped to the listener suite; the preceding full-package counts are not a claim that the full gate passed on the final revision.

## Review Corrections

Sentry review `4428337263` correctly identified that a post-ready waiting state is recoverable, while failure is fatal, as [Apple's listener state documentation](https://developer.apple.com/documentation/network/nwlistener/state-swift.enum) distinguishes.  The implementation retains waiting listeners and reports their later recovery.  Kody review `4428353755` correctly identified that early cancellation could destroy a healthy listener before replacement preparation succeeded; preparation now precedes the necessary bind handoff.

The primary review then found that a fatal start continuation could unwind and clear the listener before its fatal update was delivered, leaving a previously reported ready state visible.  Fatal completion now follows update delivery, with the fatal error reserved first so cleanup cancellation cannot replace it.  A current start throw also marks a listening controller failed, and the start's post-bound return checks generation and listener identity again.
