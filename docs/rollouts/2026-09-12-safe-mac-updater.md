# Safe Mac Updater

Issue #319 replaces the machine-only update script with a tracked, tested transaction.  The updater remains an on-demand helper; it does not create a daemon, timer, or background process.

## Transaction

`scripts/update-botfleet.sh` launches `scripts/update-botfleet-mac.mjs` from the detached always-on checkout.  The implementation has six commands:

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

# Recover admission if an interrupted updater fenced the harness but did not stop it.
scripts/update-botfleet.sh unquiesce

# Show the installed build, any staged update, pending recovery, backups and the last result.
scripts/update-botfleet.sh status

# Restore the newest backup.  A second run does nothing when the install already matches.
scripts/update-botfleet.sh recover
```

`prepare` fetches and pins a commit reachable from `origin/main`, requires a private stage and a clean staging checkout distinct from the live checkout, installs the frozen lockfile, and packages with the stable Developer ID identity.  The optional import form avoids rebuilding an existing artifact from that exact source and requires its dependency tree at the same time.  Both forms verify the code signature, Team ID, bundle ID, generated `Contents/Resources/server/build-identity.json`, and dependency fingerprint.  A dirty, mislabeled, symlinked, or publicly writable stage is rejected.  The command persists the signed application and exact staged `node_modules` tree before releasing a disposable worktree.

`apply` verifies the stage again, then checks runtime readiness twice: once before materializing same-volume candidates and again immediately before the interruption boundary.  The current runtime authenticates `/api/runtime` with the private data-owner nonce and must report its own clean running source commit, zero active work, and the same single PID as the health endpoints and SQLite handles.  It then atomically fences main API mutations, webhook deliveries, direct turns, routines, and resource triggers before shutdown.  Mutations and webhook bodies already in flight hold an admission count, so the fence refuses until they finish; scheduled work is paused without deleting its durable queue.  The updater rechecks the process, port, and SQLite owner while the fence is held.  Any failed post-fence check releases admission automatically; `unquiesce` provides an authenticated recovery action if the updater itself is interrupted.  The replacement must report the staged source commit, version, API version, and UI identity after startup.  A legacy runtime without the complete readiness contract is refused; its one-time adoption remains a manually supervised rollout with separately recorded idle and process evidence.

At the boundary, the helper bootouts the launchd service to suppress KeepAlive, asks the application to quit, waits, and sends `SIGTERM` only to exact BotFleet processes that were verified before the boundary.  It never uses `SIGKILL`, process-name-wide termination, or Finder, Dock, System Settings, or icon-cache cleanup.  It refuses to continue while a process or database holder remains.  After installing the candidate and before starting its detached harness, the helper runs the candidate's metadata-only credential-preparation mode and requires a private receipt bound to the staged commit; a missing marker or receipt triggers rollback before any new provider can dispatch.

## Rollback Placement And Pruning

The prior bundle is renamed into the update's own private stage at `<stage>/rollback/BotFleet.app`, not into the installed application's folder.  A hidden `.BotFleet.rollback-….app` beside `/Applications/BotFleet.app` is still indexed by Spotlight and Launchpad, and macOS binds a running process to the bundle it launched from, so a process that outlives the swap keeps running out of the renamed bundle and shows that name in the Dock and menu bar until it is relaunched.  A rename is atomic only inside one filesystem, so the updater compares the volume of the stage against the installed app and falls back to the adjacent hidden name only when the cache is on another volume; the receipt then records `rollbackPlacement: "adjacent"`, `crossVolume: true`, and the reason.

The receipt keeps its original schema and every key it already carried, and adds `status`, `appPath`, `stageDirectory`, `rollbackPlacement`, `crossVolume`, and the candidate paths.  It is written the moment the prior bundle moves, with `status: "installing"`, and rewritten as `verified` once startup and ownership are proved.  A verified install then keeps exactly one rollback generation per installed app path and deletes the older ones with their receipts.  A generation whose receipt still says `installing`, and a rollback bundle with no receipt at all, are never deleted: the first may be the only way back from an interrupted run, and the second is reported for manual review.  So is a receipt written before placement was recorded, which names no application: the earlier code spelled `.BotFleet.rollback-` literally whatever `BOTFLEET_APP_PATH` pointed at, so two installs sharing a folder produced indistinguishable copies and neither may claim the other's.  Abandoned update candidates whose updater process is gone are removed in the same pass.  A pruning failure is reported but never fails an install that already verified.

Quiescence additionally requires that no process still runs from anywhere inside the installed bundle, and the transaction refuses to reopen the application while any process survives in the rollback bundle, because `open` activates an existing instance of the bundle identifier rather than launching the replacement.

Processes are found by the kernel's open reference rather than by recorded arguments.  `ps` reports the arguments captured at exec and they do not follow a later rename, so an argument match cannot see a process still running out of a bundle this updater has already renamed — which is the case the survivor check exists for.  `lsof` prints the current path of every open `txt` descriptor, so it does.  That also widens the check from the main binary to the whole bundle, which is what the swap actually renames: the embedded computer-use driver at `Contents/Resources/cua-driver` and the `BotFleet Speech.app` and `BotFleet Recorder.app` helpers are expected to be inside it, are terminated with the application, and must all be gone before the rename.  The argument match is kept as a second signal before any rename, where it is still accurate.

Each run's rollback copy goes in its own generation directory, `<stage>/rollback/<stamp>-<commit>/BotFleet.app`, because a stage named with `--stage` can be reused across applies and two runs must not land on one path.  A rollback path that already exists is refused before the interruption boundary rather than at the install step: after the boundary that refusal would run the recovery path, and recovery restores whatever sits at the rollback path — an older generation, not this run's prior bundle.  Recovery is therefore gated on the swap having recorded that this run moved the live copies, and it deletes the install receipt only when the restore actually happened, because otherwise that receipt is the only record of where the prior bundle went.

Discovery covers the stage this run is applying even when `--stage` places it outside the updates root, and pruning refuses outright when the generation just written is not among those discovered.  Each stage's rollback directory is scanned for bundles rather than assumed, so a run killed between the first rename and its receipt leaves a reported orphan; a provisional receipt is written before that first rename so the displaced bundle can be identified at all.  A receipt stranded at `installing` is settled on evidence rather than left forever: if it names as its replacement exactly the build that was installed and health-verified when a later update began, that install plainly succeeded.  Abandoned dependency candidates beside the live checkout are swept alongside the abandoned bundles beside the application, and a candidate whose name does not identify an updater process is reported rather than deleted.

The live checkout, application bundle, and dependency tree move only after staging and quiescence succeed.  Same-volume renames retain the prior bundle and dependency tree while the checkout retains the prior commit.  Startup must prove the exact expected runtime and one data owner before the transaction succeeds.  Before rollback interrupts a failed replacement, the updater re-proves complete authenticated idle state.  If work began during startup verification or readiness is unknown, it leaves the replacement and every prior recovery copy intact, writes `pending-recovery.json` in the private stage, and exits unsuccessfully for supervised recovery after the work drains.  Otherwise, a checkout, copy, launchd, startup, identity, or attachment failure restores the prior bundle, dependency tree, and checkout and restarts only the components that were running before the attempt.

The desktop keeps the local update in `installing` state while its detached process runs.  At two minutes and again after one hour it reports progress without claiming failure or suggesting a concurrent retry; only a child-process error or nonzero exit marks the update failed.

## Resources Guard, Pending Recovery, Status And Recover

Before the installed app bundle is swapped, the updater compares `Contents/Resources` with the code-signature seal.  A file the seal does not name is a leftover.  A sealed file whose bytes or symlink target differ is a modification.  Finder `.DS_Store` files and AppleDouble `._` names are ignored, so opening the bundle in Finder does not block an update.  A helper the seal records with a cdhash is a nested bundle: the files inside it belong to that helper's own signature and are not leftovers.  When anything else differs, the update refuses and names the paths.  `--force` copies those paths under `~/Library/Caches/BotFleet/updates/resource-backups/` and continues.  A seal that cannot be read does not count as drift, and a clean Resources tree takes the same path as before.

A successful update then probes the live harness.  Only a `live-ok` result deletes `pending-recovery.json` markers left by an earlier deferred rollback.  Anything short of that leaves the markers in place.  The update's own success is already recorded before this cleanup, so a cleanup problem does not roll the new build back.

`ubf status` prints the installed version and commit, any staged update whose commit is not the installed one, a running update when the lock is held, pending-recovery markers, backup locations, and the last result.  It does not change the app.

`ubf recover` restores the newest of those backups and leaves the backup where it is.  A rollback bundle is copied back into place when the installed build differs, and only while BotFleet is not running.  A Resources backup is copied back the same way.  A second run finds the installed files already match and does nothing.

## Rollout Ownership

This source change does not execute the updater or touch `/Applications/BotFleet.app`, `/Users/jay/apps/botfleet-server`, launchd, or a live BotFleet process.  After merge, the Mac rollout owner must install the wrapper at `/Users/jay/apps/update-botfleet.sh`, update the on-demand helper row in `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`, and refresh the pinned `Background Jobs Master List` Coding note as one deployment change before the new helper is runnable.  The staged rollout may proceed only after active work is clear.

Signed release/feed acceptance remains separate from this local on-demand update transaction.
