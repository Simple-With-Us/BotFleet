# Safe Mac Updater

Issue #319 replaces the machine-only update script with a tracked, tested transaction.  The updater remains an on-demand helper; it does not create a daemon, timer, or background process.

## Transaction

`scripts/update-botfleet.sh` launches `scripts/update-botfleet-mac.mjs` from the detached always-on checkout.  The implementation has three commands:

```sh
# Compose both phases for an ordinary update from current origin/main.
scripts/update-botfleet.sh update

# Build once in an isolated, already-provisioned staging checkout.
scripts/update-botfleet.sh prepare \
  --target <full-main-commit> \
  --source /absolute/path/to/staging-checkout \
  --stage /absolute/path/to/stage

# Import an existing build and dependency tree from that exact clean source.
scripts/update-botfleet.sh prepare \
  --target <full-main-commit> \
  --source /absolute/path/to/staging-checkout \
  --bundle /absolute/path/to/staging-checkout/release/mac-arm64/BotFleet.app \
  --dependencies /absolute/path/to/staging-checkout/node_modules \
  --stage /absolute/path/to/stage

# Apply the immutable stage after reviewing its prepared.json receipt.
scripts/update-botfleet.sh apply --stage /absolute/path/to/stage
```

`prepare` fetches and pins a commit reachable from `origin/main`, requires a private stage and a clean staging checkout distinct from the live checkout, installs the frozen lockfile, and packages with the stable Developer ID identity.  The optional import form avoids rebuilding an existing artifact from that exact source and requires its dependency tree at the same time.  Both forms verify the code signature, Team ID, bundle ID, generated `Contents/Resources/server/build-identity.json`, and dependency fingerprint.  A dirty, mislabeled, symlinked, or publicly writable stage is rejected.  The command persists the signed application and exact staged `node_modules` tree before releasing a disposable worktree.

`apply` verifies the stage again, then checks runtime readiness twice: once before materializing same-volume candidates and again immediately before the interruption boundary.  New runtimes authenticate `/api/runtime` with the private data-owner nonce and must report the staged source commit, version, API version, zero active work, and the same single PID as the health endpoints and SQLite handles.  The first legacy adoption requires two stable idle snapshots across every responding owner, including bots, rooms, delegations, routines, health endpoints, and an exact match with the SQLite holder set.  This permits a proven-idle legacy dual-owner state to stop gracefully while an incomplete or ambiguous snapshot refuses the update.

At the boundary, the helper bootouts the launchd service to suppress KeepAlive, asks the application to quit, waits, and sends `SIGTERM` only to exact BotFleet processes that were verified before the boundary.  It never uses `SIGKILL`, process-name-wide termination, or Finder, Dock, System Settings, or icon-cache cleanup.  It refuses to continue while a process or database holder remains.

The live checkout, application bundle, and dependency tree move only after staging and quiescence succeed.  Same-volume renames retain the prior bundle and dependency tree while the checkout retains the prior commit.  Startup must prove the exact expected runtime and one data owner before the transaction succeeds.  A checkout, copy, launchd, startup, identity, or attachment failure restores the prior bundle, dependency tree, and checkout and restarts only the components that were running before the attempt.

## Rollout Ownership

This source change does not execute the updater or touch `/Applications/BotFleet.app`, `/Users/jay/apps/botfleet-server`, launchd, or a live BotFleet process.  After merge, the Mac rollout owner installs the wrapper at `/Users/jay/apps/update-botfleet.sh`, updates the on-demand helper row in `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`, refreshes the pinned `Background Jobs Master List` Coding note, and performs the staged rollout only after active work is clear.

Signed release/feed acceptance remains separate from this local on-demand update transaction.
