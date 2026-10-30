# Host Inventory Collection

Refs BF-2559 and BF-2601.  This collector records current host capacity and the initial and peak measurements for caller-selected service cgroups or process IDs over an explicit window.  It changes no service, resource limit, or admission setting.

## Authorization And Invocation

The implementation is fixture-tested only; no live host inventory is included with this change.  The owner has not authorized the live Mac or server collection yet.  After that authorization, choose the host, selected units or PIDs, observation window, sample interval and a dedicated output directory, then run from this checkout:

```sh
node scripts/host-inventory.mjs \
  --output-dir /absolute/path/to/new-report-directory \
  --window-seconds 3600 \
  --interval-seconds 10 \
  --root-path / \
  --data-path /absolute/data-volume \
  --unit botfleet-server.service
```

Linux supports explicit systemd `.service` names and resolves only each unit's cgroup path.  macOS supports explicit `--pid PID` selections; it does not inspect launchd definitions.  Repeat `--unit` or `--pid` for each additional selected workload.  The requested output directory is created as one directory if absent; its parent must already exist.  The directory must be owned by the caller and not writable by other users.

Before any host capacity or process/service reads, the collector exclusively reserves both report filenames with private permissions.  If either report already exists, it refuses before sampling and preserves that file.  If a run reports a collection or write error, it closes its opened files and removes only targets whose current regular-file identity still matches the file it created.  The two-file pair is not crash-atomic: termination or power loss can leave an incomplete reserved report, so check both artifacts before using them.

At most 32 unique selected scopes are accepted after duplicate PIDs and unit names are removed.  This is a collector implementation bound to cap per-sample work, not a runtime limit or a numeric resource budget.

On a Mac, pass `--orbstack-reserved-cpu N` and `--orbstack-reserved-memory-mib N` only when those values have been explicitly verified for that host.  The script records them as caller-supplied inputs and does not verify them.  Omitted values remain unknown; do not substitute the plan's historical OrbStack example as a measurement.

## Output And Interpretation

`host-inventory.json` records the source commit when Git can identify it, wall-clock epoch-millisecond boundaries, monotonic duration and observed intervals, capacity, first observed values, observed peaks, counter deltas, sample coverage, units, and limits.  `host-inventory.md` renders the same report with owner-clock start and end times and sample coverage.  Wall-clock boundaries are recorded as observed and can move backwards if system time changes; duration and sample intervals use a monotonic clock.  Linux available memory uses `/proc/meminfo` `MemAvailable`; the Node OS free-memory estimate is separate, and macOS available memory remains unknown.

An absent scope sample makes that scope's interval peaks and counter deltas unknown, even if it appears in later samples.  Counter deltas also remain unknown after a mid-window decrease, invalid reading or PID identity change; identity changes limit peaks to samples matching the known initial process.  Coverage reports observed versus expected samples.  A short interval may miss bursts, and a selected PID does not include child processes.

Capacity is a point-in-time reading of logical CPUs, total memory, swap when readable, and free bytes/inodes for the explicit root and data paths.  Linux available memory comes from `/proc/meminfo` `MemAvailable`; the Node OS free-memory estimate is reported separately.  macOS available memory is unknown in this collector, with the Node OS free-memory estimate shown separately.  Linux service measurements use cgroup v2 counters for the selected unit, which can omit delegated children or external container daemons.  Linux PID sampling reads page size and clock ticks from `getconf` when available; unavailable constants make the corresponding metric unknown.  PID I/O counters may be absent.  macOS process measurements use `ps` PID, RSS, sampled CPU and start time; child processes and per-process I/O are not included.

The report does not determine a safe numeric budget, prove complete host demand, or enforce a limit.  It starts no work and reads no process arguments, environments, credentials, application configuration, or service definitions.  Treat both artifacts as bounded evidence for the measured window and selected scopes, not as a representative peak unless the chosen window and workloads support that conclusion.

After an authorized collection, attach the artifacts to BF-2559 and record their paths in the run's placement evidence.  No measured values or numeric defaults are supplied by this implementation.

## Implementation Verification

The required local gate ran `pnpm typecheck && pnpm test` after the collector was wired into the package test chain.  TypeScript passed; the Vitest floor then reported 36 failures, 12,213 passes, and 26 skips across 723 files, so the remaining `pnpm test` stages did not run.  Failures were confined to `server/env-path.test.ts`, `server/local-vm-gh-credentials.test.ts`, `server/plugin-sandbox.test.ts`, `server/plugin-zulip-dispatch.test.ts`, and `server/plugins.test.ts`; this is not an overall green package suite.  The complete output was retained at `/mnt/fleet-extra/apps/scratch/codex-bf-2601-required-gate.log` for this validation run.

The focused `pnpm test:host-inventory` suite passed all 17 tests, including output preflight and rollback, scope gaps and bounds, a 150,001-sample aggregation fixture, wall-clock backstep handling, a module URL containing spaces, and invocation through a temporary symlink with an assertion that `--help` prints Usage.  The test fixtures use temporary paths, fake clocks and injected sample/write functions; they do not read live process or service data.  `pnpm typecheck` and `git diff --check` passed.  `LINT_BASELINE_REF=origin/codex/bf-2598-host-resources pnpm lint` remains red only on `anti-slop/no-known-value-widening` (+1 versus that reference); scoped Oxlint reports no warnings in the collector or its tests, and this branch is still based on `f76923c7` rather than the resource branch.  No live inventory was collected.
