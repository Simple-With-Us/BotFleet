# BF-2445: stable updater bootstrap

The installed updater entrypoint (`scripts/update-botfleet.sh` in this repo) becomes a protocol-v1 loader, not a copy of transaction policy. It fetches main, resolves its exact commit, verifies ancestry, and reads the self-contained bootstrap driver from that commit. The driver writes a complete transitive local-import graph plus a SHA-256 manifest, verifies it, then publishes the helper-version receipt with an atomic rename. A valid current generation is reused. Source files come from immutable git objects, not the working tree. Manifest hashes detect damaged copies; they do not replace main ancestry or the app's signature gate.

The versioned `scripts/update-botfleet-policy.sh` retains newest-green hosted-build selection, explicit-target/stage semantics, and all existing transaction safety checks. Once it selects a candidate, the driver assembles that candidate's complete updater graph from the same verified commit. New transitive imports no longer require edits to an installed shell list.

Early errors are recorded in a managed run's progress file. The launchd shell exits zero after reporting a failed child, so `launchctl submit` cannot retry a deterministic import error forever. A controller reading an older helper's no-progress run also includes its error log in the settled failure.

## Rollout boundary

This PR does not replace any live machine helper, run an update, or restart bots. A pre-v1 machine helper cannot fix itself: it still needs a separately authorized one-time replacement with the new entrypoint after merge. A source-only merge is not deployment. After that migration, the fixed entrypoint can load future helper policy without another manual copy.

## Verification (recorded 2026-10-16, branch head 353cb040f plus the template-guard fix)

- `node --test scripts/update-botfleet-bootstrap.node-test.mjs` -> ok (6 pass, 0 fail). Covers the old protocol-v1 entrypoint loading a newer updater with new transitive imports, manifest corruption, missing module, unmerged source, atomic receipt preservation, import failure before progress exists, terminal failure reporting, and clean one-shot managed exit.
- Full updater-related node suites (`test:mac-updater`: bootstrap, harness-release-store, effort-log-integrity, mac-update-transaction, update-botfleet-mac, update-botfleet-hold, mac-update-rollback-placement, mac-update-rollback-hardening, update-botfleet-arch, ci-build-resolver) -> ok (324 pass, 0 fail). Covers newest-green selection, transaction safety, rollback placement, and controller log fallback behavior.
- `bash -n scripts/update-botfleet-policy.sh scripts/update-botfleet.sh` -> ok (both parse clean).
- `shellcheck scripts/update-botfleet.sh` -> ok (no findings).
- `shellcheck scripts/update-botfleet-policy.sh` -> warnings only, no errors (SC2140 on the continued PATH string, SC2155 export-and-assign, SC2012 ls-for-versions, SC1091 unfollowed nvm.sh). Parse is clean and every behavior above is test-pinned; the style warnings are left as-is.
- Manual scenario: pre-v1 machine helper cannot self-migrate (noted under Rollout boundary) -> expected, unchanged by this PR.
