# Linux Storage And Resource Scaffold

Refs BF-2559.  Implements BF-2600, slice 3, on the BF-2596 foundation and BF-2598 host report.  This is source and isolated-fixture work; no installer, service, mount, resource setting or live host is changed by this rollout.

## Storage Boundary

The unit requires the dedicated volume and checks that it is a mount point.  Its explicit volume bind and `MountFlags=private` keep that filesystem pinned inside the service namespace instead of following a host unmount into the root-directory fallback.  `/tmp` and `/var/tmp` are unit-specific binds from the runtime volume; no tmpfs byte budget is invented.  Existing HOME, TMPDIR, XDG and npm-cache paths stay on the volume.

Maintenance tradeoff: each service keeps the volume mounted and busy until it stops.  Stop both the harness and owner gate before unmounting or replacing their volume.  This follows the installed `systemd.exec(5)` manual's `BindPaths` and `MountFlags` semantics, also documented in the [primary systemd manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#MountFlags=).  The usual warning against private propagation is intentional here; recipe 12 must still verify the actual rendered unit before anyone asserts live isolation.

The all-writer fence is the unit's filesystem namespace, not the admission probe.  A source process started outside that unit has no claim to the same filesystem protection.  `/dev/shm`, `/run`, container daemons and any other paths outside the volume remain explicitly unverified by this fixture work.  No cgroup delegation, quota feature, polkit rule or new privilege is introduced.

The owner-gate unit receives the same mount/private-volume/temporary-path scaffold and preflight.  New gate logs go to `journalctl -u botfleet-owner-gate.service`; historical `owner-gate.log` files are retained unchanged.  The journal is host-managed and can consume root-disk space; this change establishes no per-app journal quota or disk budget and makes no zero-root-log-consumption claim.

## Checks Before Writes

Installer path checks resolve symlinks, refuse traversal/unsafe unit characters and require a mounted device different from root before creating runtime files.  The unit's `ExecStartPre` checks data versus root device identity.  `start.sh` checks again before opening `server.log`; preflight errors go to the service journal rather than opening an append file on a root fallback.  The harness's explicit `--require-data-volume` mode checks before its ownership fence creates data files and exits with `STORAGE_OFFLINE_EXIT_CODE` (78) on failure.

Only the deployed Linux unit opts in.  Ordinary local source execution, Mac-only installs and test harnesses retain their prior behavior.  The opted-in probe rechecks the boot device on each admission/resource sample, refuses new jobs with "Server storage offline" on loss or replacement, and suppresses unsafe data-disk readings while still reading root disk separately.  Active work is neither migrated nor requeued.  A nonterminal queue is a later slice, so unsafe new work is refused in this slice.

The optional `jobs.admission.minFreeInodes` knob maps to `BOTFLEET_JOBS_MIN_FREE_INODES`, including normal Infisical resolution and write-through.  It has no default.  With a configured floor and a known reading, new work is refused below the floor with "short on inodes".  Unknown readings preserve the current admit-on-unknown policy and read `notApplied`; unknown-server queue behavior remains a later mode/admission slice.

## Explicit Resource And Log Inputs

The installer calls the strict resource renderer only in its reviewed installation path.  With no resource inputs it creates no drop-in and says "no resource limits set; run the inventory recipe".  It preserves existing limits when input is absent, preserves unspecified fields in an existing managed drop-in when another field changes, and refuses to overwrite an unmanaged or malformed file.

Existing managed files are opened without following the final symlink and read through that descriptor after single-link device/inode verification; the listed inode is checked again after reading.  Unit text is fully rendered and validated before the atomic sibling-temp/fsync/rename writer replaces a destination, so a rendering failure preserves the previous unit.  An explicit install-only option sets the staged inode to the previous installer's `0644` mode before publication, even under a restrictive umask; other atomic-store callers retain their existing umask behavior.  These installer operations assume root-controlled system directories and are not a directory-tree sandbox against concurrent privileged parent replacement.

Accepted inputs are `BF_CPU_QUOTA`, `BF_MEMORY_HIGH`, `BF_MEMORY_MAX`, `BF_MEMORY_SWAP_MAX`, `BF_TASKS_MAX`, `BF_IO_WEIGHT`, `BF_IO_READ_BANDWIDTH_MAX`, `BF_IO_WRITE_BANDWIDTH_MAX`, `BF_IO_READ_IOPS_MAX` and `BF_IO_WRITE_IOPS_MAX`.  Sizes use canonical bytes or K/M/G/T/P/E suffixes; CPU quota uses percent; I/O rate inputs name a `/dev/` device and a rate.  Unknown keys, unit/shell newlines, traversal and malformed values are refused.  No values or drop-in are shipped by default, and no desired value is treated as enforcement proof.

Provide reviewed non-secret inputs from the enrolled server's Infisical configuration during an authorized installation.  The renderer does not fetch a vault, create credentials or establish a second configuration source.

Log rotation likewise waits on explicit `BF_LOG_ROTATE_SIZE` and `BF_LOG_ROTATE_COUNT` together.  The generated rule uses `copytruncate` because the running harness holds an append descriptor; copy/truncate has a small concurrent-write loss window and does not prove lossless log capture.  Unset inputs preserve existing policy, and an unmanaged policy is not overwritten.  This keeps log size and history choices visible for inventory/review instead of inventing them.

The current `update.sh` rebuilds/restarts code and does not reinstall units or drop-ins.  Deploying this unit scaffold therefore needs the separate reviewed installation step; publishing source or running a normal code update does not prove these protections are active.  No such installation is authorized or performed here.

The installer currently uses `enable --now`, which does not restart an already-running service.  Existing services therefore also need a deliberate, reviewed drain/restart before the new namespace can be active; unit files on disk are not proof that running processes use them.

Startup and device-check helpers are installed self-contained under `BF_ROOT/bin`, outside the code checkout.  A code-only rollback therefore retains the unit's startup/preflight entrypoints and filesystem fence even when the older checkout has none of the new helper files.  The Node source imports the same device-check implementation.  Keep the installed helper pair with the runtime data through updates and rollback; replacing unit/bootstrap artifacts is a separate reviewed installation action.

## Verification And Remaining Evidence

```sh
pnpm typecheck
pnpm exec vitest run server/storage-device.test.ts server/host-resources.test.ts server/jobs/probes.test.ts server/jobs/registry.test.ts server/knob-map.test.ts server/knob-write-through.test.ts server/config.test.ts
node --test deploy/linux-server/render-resources.node-test.mjs deploy/linux-server/owner-gate.node-test.mjs
bash -n deploy/linux-server/common.sh deploy/linux-server/install.sh
sh -n deploy/linux-server/start.sh
node scripts/audit-node-decommission.mjs
node scripts/check-lint-baseline.mjs --baseline-ref origin/codex/bf-2598-host-resources
git diff --check
```

Device tests inject root/data identities, missing paths and replacement; the wrapper uses a rejecting fake Node executable so it cannot start a harness or touch production ports.  Renderer tests import pure functions and inspect unit text; they never run the installer, mount a filesystem or write `/etc`.  Inode tests cover unset defaults, a zero reading below an explicit floor, vault resolution and write-through.  The resource report still reports only observed enforcement.

The frozen local gate at `dad321b09` passed typecheck and failed `pnpm test` with 36 failed, 12,225 passed and 26 skipped tests across 725 files (five failed files).  The failures are the known env-path, credential-runner and plugin groups previously reproduced on the unchanged baseline; the deferred-fallback cleanup failure from the resource slice did not recur.  Later pipeline stages stopped at the failing Vitest gate, so this is not a green full-suite result.  The frozen commit is preserved at `codex/bf-2600-frozen-gate-dad321b09`; only the storage and renderer commits are integrated onto the corrected resource parent, with focused checks repeated on that base and no complete-suite repeat.

Integration onto resource parent `736a9e71` passed typecheck, 267 focused Vitest tests, 45 Node tests, shell syntax and the tracked-path inventory audit.  The parent-ref lint check exposed new boundary-validation, conditional-spread and comment-whitespace warnings; schema parsing, explicit optional-field assignment and a single-sentence comment removed them without changing the baseline.  Final affected rechecks passed typecheck, 65 Vitest tests and 45 Node tests; lint passed with 4,864 warnings against the parent's 4,884-rule total and no per-rule increase.

The final source integration uses resource parent `6ee378d0`.  Conflicts were resolved to one resource responder retaining the bounded snapshot, null limit keys, storage-state probe and optional inode gate.  On that source, typecheck, 77 affected Vitest tests, 45 Node tests and the parent-ref lint gate passed (4,865 warnings, no per-rule increase).  The frozen complete-run record above remains the full-suite boundary; no live unit was installed or started.

Recipe 12's live mount/unmount and write attempts remain false, as do recipes 11 and 13 and every other complete placement assertion.  A deployed unit, its actual namespace behavior, log rotation and other-app responsiveness require the plan's separately authorized hand runs and reviewed output.
