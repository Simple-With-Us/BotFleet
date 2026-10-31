# Native Host Automatic Start And Private Control

Refs BF-2605, BF-2602, BF-2531 and BF-2597.

## Behavior

Existing `NativeHeadlessHost.start` callers retain explicit Start behavior.  The new typed launch intent returns `stoppedByOwner` for automatic startup when a canonical private stop marker exists; it acquires the lifetime owner lease and validates that marker before opening the database, recovering waits or starting polling.  Unsafe marker files fail closed.

The foreground executable accepts `--automatic` after the explicit service-data argument and exits successfully when deliberately stopped.  Explicit startup clears a validated marker after successful runtime recovery.

A private `control.sock` inside the already-private service root accepts one bounded newline-delimited `status` or `stop` request per connection.  Production authorization uses kernel `getpeereid` and permits only UID 0; there is no executable authentication override.  Four connections, 32 request bytes, a two-second monotonic request deadline and a bounded reply deadline limit resource use.

Stop acknowledges success only after the existing deliberate shutdown drains work, checkpoints/closes SQLite, publishes the stop marker and releases the owner lease.  A failed stop reports `shutdownFailed`, retains the owner lease and leaves status available.  CLI signal and checked-control completion share an asynchronous completion stream.

Socket startup rejects non-socket, foreign, public or active entries.  It recovers only a matching private service-owned socket that refuses connections; cleanup compares socket device/inode identity and cannot intentionally unlink a replacement entry.  As with the owner lease, a private service root and installer-controlled parents are the contract; this does not sandbox a privileged installer replacing parent directories.

## Verification

Focused Mac host, wait and private-control tests, unsigned Mac/iOS source builds, and one frozen required Node gate are pending.  Fixtures use temporary service roots, a production subprocess with an explicit environment allowlist, synthetic children through the production runner, and injected peer observations only inside the test target.

## Delivery Boundary

This slice adds no account provisioning, launchd registration, package installer, signing, GUI attachment, provider credential bootstrap or live activation.  Credentials remain unavailable by default, desktop work remains held, and existing accepted or uncertain outcomes are never automatically replayed.
