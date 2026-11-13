# Harness Data Ownership

Issue #264 / audit D1.  Reviewed base: `7d5a7cd8`.  Implementation: `codex/harness-ownership-20260911`.

A slow health endpoint previously counted as a free port, allowing the desktop to fork another harness against the same data directory.  Startup now acquires a process-lifetime ownership record before configuration loading, provider initialization, SQLite, routines, and webhook ingress.  The existing short file lock serializes acquisition; it does not expire the live harness's ownership.  Only a confirmed dead PID permits automatic recovery.

Desktop startup scans every candidate port before spawning and treats timeout, reset, incomplete response, and invalid ownership records as unavailable.  A live ownership record pins discovery to that owner's port, including non-default ports.  A fresh challenge requires proof of the private data-root nonce before attaching to a recorded owner and replaying credentials.  Public health responses do not expose the nonce or data path.

## Verification

- Forty-two focused Node tests pass, including three concurrent processes competing for one data root, crash recovery, aliases, independent roots, malformed records, challenge verification, concurrent first-start migration, and resolver regressions.
- TypeScript checks pass.
- The first full run passed 3,462 tests with 19 skipped and found one engine-deletion test whose hardcoded engine list no longer isolated its premise.  The fixture now disables and restores the actual enabled pool; its focused regression passes.  Final full-gate evidence is recorded in the PR.
- The final local full run passed 3,461 tests with 19 skipped and timed out in two unchanged Cursor process tests while Mac load exceeded 140.  Focused reproduction and downstream checks are recorded in the PR.  The local full suite is not reported as green; hosted checks must pass before merge.
- Read-only live checks before implementation: 8799 and 18799 reported the same PID, consistent with the desktop UI shim attaching to the always-on harness.  This is current topology evidence, not deployment of this change.

## Rollout And Limits

Existing binaries do not participate in the new ownership protocol and the updated desktop refuses to attach to an unproven data root.  On the first rollout, stop existing harness processes through the normal updater lifecycle before starting the updated harness; preserve the application's data.  Do not start a second updated process alongside an older harness simply to test adoption.  Future updated starts coordinate automatically, and app quit never releases ownership before provider shutdown completes.

If an old ownership record's PID has been reused by an unrelated process, startup deliberately refuses takeover.  Inspect process identity and open data handles before any manual recovery; never delete an ownership record solely because a health endpoint is slow.  Corrupt ownership metadata also fails closed.

The process-lifetime guard complements config-file locking.  Electron and the harness remain legitimate independent config writers and still need their existing transactional config updates.  Build/API compatibility with legacy attached harnesses remains issue #265; ownership proof is not an API version contract.
