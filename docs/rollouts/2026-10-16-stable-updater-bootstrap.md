# BF-2445: stable updater bootstrap

`~/apps/update-botfleet.sh` becomes a protocol-v1 loader, not a copy of transaction policy. It fetches main, resolves its exact commit, verifies ancestry, and reads the self-contained bootstrap driver from that commit. The driver writes a complete transitive local-import graph plus a SHA-256 manifest, verifies it, then publishes the helper-version receipt with an atomic rename. A valid current generation is reused. Source files come from immutable git objects, not the working tree. Manifest hashes detect damaged copies; they do not replace main ancestry or the app's signature gate.

The versioned `scripts/update-botfleet-policy.sh` retains newest-green hosted-build selection, explicit-target/stage semantics, and all existing transaction safety checks. Once it selects a candidate, the driver assembles that candidate's complete updater graph from the same verified commit. New transitive imports no longer require edits to an installed shell list.

Early errors are recorded in a managed run's progress file. The launchd shell exits zero after reporting a failed child, so `launchctl submit` cannot retry a deterministic import error forever. A controller reading an older helper's no-progress run also includes its error log in the settled failure.

## Rollout boundary

This PR does not replace any live machine helper, run an update, or restart bots. A pre-v1 machine helper cannot fix itself: it still needs a separately authorized one-time replacement with the new entrypoint after merge. A source-only merge is not deployment. After that migration, the fixed entrypoint can load future helper policy without another manual copy.

## Checks

- Old installed protocol-v1 entrypoint against a newer updater with new transitive imports.
- Manifest corruption, missing module, unmerged source, and atomic receipt preservation.
- Import failure before progress exists, terminal failure reporting, and clean one-shot managed exit.
- Controller log fallback and launchd label removal for an old no-progress run.
- Existing newest-green selection and transaction suites.
