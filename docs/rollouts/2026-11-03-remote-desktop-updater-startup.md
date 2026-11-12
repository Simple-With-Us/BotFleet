# Remote Desktop Updater Startup

Refs BF-2606.

The updater previously treated the remote desktop's forwarded health response as local process evidence, then waited for that desktop to own the local harness.  A remote desktop instead serves its bundled UI locally and forwards API requests to the selected server.

The installed desktop now answers a private per-update startup request after its UI shim or local server starts.  The request binds a random identifier and exact commit; its response also binds the version, API version, UI hash and optional build number.  Both ends validate the owned private directory and single-link regular file through open descriptors, reject symlinks and oversized or malformed data, and keep configuration and credentials out of the receipt.  The updater separately checks the installed executable's exact PID and the kernel's local socket owner before accepting the response.

Remote desktop readiness permits the local watchdog to start independently.  Final success still requires the authenticated local harness to report the prepared identity and sole database ownership; remote readiness alone cannot complete the transaction.  A local desktop must also prove authenticated local runtime readiness and a UI socket owned by the desktop or that runtime.

Local health probes now require agreement between the kernel listener, private local owner record and health PID.  A forwarded PID contributes no local runtime identity, including when its number happens to match a local process.  Authentication, fencing and rollback do not send local owner credentials through an unverified listener.

The packaged build advertises startup protocol 1.  A candidate lacking that protocol is refused before apply changes live files when the desktop is requested; server-only and no-open paths retain their existing behavior.  The stable loader includes the helper through its immutable import graph.  Direct legacy bootstrap includes it only when the selected historical commit contains it.

## Validation

The isolated Mac-updater suite initially passed 359 tests with eight platform skips.  After review fixes it passed 362 tests with eight skips, including torn-receipt polling, bounded failure and effective HTTP port 80.  Historical targets without the helper and a current target importing it both remain covered.  Typecheck and the lint baseline passed without changing the baseline counts.

The required full command passed all 12,658 Vitest tests with 22 skips, then the probe, broker and subsequent Node stages through server-boot-probe.  It exited 1 at the packaged-server smoke's unchanged 45-second readiness boundary; the isolated harness logged ready near that boundary, but the cause of the failed observation is not established.  The smoke also failed at a 60-second allowance before fixture isolation; both failed receipts are preserved.  The fixture now uses a private HOME with a synthetic instance that suppresses unrelated host CLI discovery, while retaining real bundled imports, SDK startup, HTTP identity, all 14 proxy paths and MCP flushing.  This bundle check and the remaining Node tail then passed in separate preserved segments; this is not a single green full-command result or packaged-runtime acceptance.  The gate's original production source was frozen at 1eaca7fa; the reviewed credential fixture was adopted before its later Node phase, and the two receipt review fixes have their own complete updater-suite result.

Review findings 4454229381 and 4454229926 are addressed: normalized default-port origins retain their effective port instead of becoming zero, and polling retries unreadable intermediate receipts without weakening full validation or exposing parser input.  An unreadable receipt stays unsafe until the finite deadline.

An initial wider updater run exposed two unchanged release-store fixture assumptions under the server's private umask, plus three source-contract assertions needing the new explicit data directory and conditional archive argument.  After fixing the affected assertions, the suite passed with a process-local 022 umask; private receipt modes remain explicit 0600/0700.  No production permissions were broadened.

PR #1539 separately addresses source-release provenance.  This startup change preserves that separate dependency and does not establish an installed update, before-login acceptance or a native service cutover.  The separate credential-sync test hazard found in BF-2605's required tail is addressed by shared PR #1544; its bounded audit proved the live .gitconfig bind was not overwritten and recorded one .config permission change without a prior mode baseline.  No BotFleet live process, user database, remote server, credential, launchd registration or installed bundle was changed by this updater validation.
