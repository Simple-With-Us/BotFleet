# Native Listener Failure Reporting

BF-2595 follows the native listener lifecycle wiring in BF-2590.  A Network.framework listener that became ready could later fail while Settings continued to report it as listening.

## Behavior

Each backend start now receives its own failure callback.  A later `.waiting` or `.failed` event clears that listener's current socket and reaches `CompanionListenerController`, which records `.failed(reason:)` and publishes the change through the existing MacSession mirror.  Settings uses the phase-neutral text `Listener failed: <reason>` for both startup and running failures.

The controller checks the start generation before accepting a failure.  A queued event from an older listener cannot overwrite a newer listener, an explicit stop or a disabled setting.  A failure arriving after socket readiness but before the start call returns also survives that return.  Startup across shared runtime activation is fenced so an intervening stop or replacement cannot be followed by the older start opening a socket.

An intentional socket cancellation does not send a failure callback.  Enabling again after a genuine failure retries the listener.  The setting remains off by default, and MacSession retains its loopback-only options with no Bonjour advertisement.

## Isolated Verification

Five new tests in `CompanionListenerControllerTests` exercise a running failure and the state mirror, failure before a start returns, a stale listener failure after restart, a stale start error after retry, and intentional stop or disable with queued failures.  The fixture stores callbacks and uses checked continuations; these tests open no sockets and perform no desktop input.  Existing loopback listener tests remain the socket-level recipe.

Run on a Mac with the repository's Swift 6.4 toolchain:

```sh
swift test --package-path ios --filter CompanionListenerControllerTests
```

The isolated Mac validation checkout passed the full iOS package: 988 XCTest tests and 273 Swift Testing tests, including these five new races.  An unsigned iOS Xcode build and `git diff --check` also passed.  This validation checkout combined the pairing-contract and listener-failure changes; it did not install or launch the app against live user data.
