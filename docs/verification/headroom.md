# Headroom And Storage Evidence

Refs BF-2559, BF-2596 and BF-2544.  These are the seven resource recipes from [Native Server Mode](../plans/2026-10-29-native-server-mode.md), paired with the nine [placement recipes](placement.md).  They define required results for later slices; this foundation provides neither resource routing nor enforced budgets.  No numeric defaults are selected here.

BF-2598 adds the harness's read-only `GET /api/host/resources` report and its injected enforcement/probe tests; see [Host Resource Report Rollout](../rollouts/2026-10-30-host-resources.md).  It does not assert any complete placement recipe or authorize a live host measurement.

BF-2600 and BF-2601 provide the [Linux storage scaffold](../rollouts/2026-10-30-linux-storage-scaffold.md) and [bounded inventory collector](host-inventory.md), with isolated device/inode, rendering and measurement fixtures.  Volume pinning, temporary paths, journal use and log rotation still need the authorized live recipe, and the collector needs authorization for each host measurement.  These source changes set no budgets and change none of the assertions below.

## BF-2604 Independent Knob And Probe Unit

The first part of slice 7a adds absent-default `jobs.admission.reservedCpuCores`, `reservedRamMb` and `minMemoryAvailablePercent` to the sole Infisical knob map, config schema, resolver and write-through.  RAM MB resolves to bytes using 1024 × 1024; explicit values are clamped at resolution.  CPU reservation is reported only in this unit; concurrency sizing belongs to the controller slice and Mac admission retains no load or CPU cutoff.  The existing inode floor is reused.

The Mac reader requests the optional `kern.memorystatus_level` asynchronously with a bounded command and shared cache.  [Apple's XNU fixture](https://github.com/apple-oss-distributions/xnu/blob/main/tests/memorystatus_vm_map_fork.c#L130-L139) identifies it as available-memory percent and notes that macOS may lack it.  Missing, failed and invalid readings remain unknown; they never become zero capacity or an invented warning/critical category.  An explicit available-memory floor gates only a known reading.  An admitted Mac job records unavailable memory/disk checks in `placedReason`; the resources report marks a configured unreadable memory gate `notApplied`.

`jobs.queueWaitMinutes` is a separate waiting-policy knob, bounded from 1 to 10080 minutes.  When absent, resolution uses the existing `DEFAULT_LIMITS.queueMs` policy of 24 hours, independently of execution timeout.  Durable pressure queue activation remains pending the command-retention decision; existing pressure refusals remain in place.  The eventual queue must keep per-thread/per-bot active limits, a separate execution-state host cap and total pending bound, with cancellation on revoked grants or deleted bot/thread.  No command spool or raw-command persistence is implemented in this unit, and the complete BF-2604 task remains open.

The initial isolated knob/probe/report/registry/write-through fixtures passed 115 tests; typecheck and lint baseline passed.  Both Mac readers are injected in fixtures; no live probe or host configuration was used.

```sh
VITEST=true pnpm exec vitest run server/jobs/probes.test.ts server/knob-map.test.ts server/knob-write-through.test.ts server/host-resources.test.ts server/jobs/registry.test.ts
```

The one full required gate ran on frozen `a29673fe17a4a59e09806c3fa3d31bf00cca612d` and settled normally with exit 1: typecheck passed; tests reported 37 failed, 12260 passed and 26 skipped out of 12323 across 726 files, taking 2151.61 seconds.  The unchanged full log and exit artifact are retained as `codex-bf2604-required-gate.log` and `codex-bf2604-required-gate-exit.json` in task scratch evidence.  Exact header comparison retained all 36 preceding baseline failures and added the `server/procs.test.ts` fast-child/soft-deadline case.  Compared with BF-2603's 37 headers, this replaces its deferred-fallback cleanup timeout.  The procs assertion expected no error and received `timedOut: true` with `SIGTERM`; this observation does not establish a cause.

After that gate, corrected resource parent `60d06019` was integrated, retaining its bracketed disk/inode observation and configured-only offline inode report.  Review corrections share one validated Linux available-memory value across byte, percent and report paths; available RAM above known total becomes unknown.  Refusal text now explicitly says that no new job can start; a registry fixture proves that configured pressure leaves no queued record or spawn.  The combined seven-file focused check passed 152 tests and failed one out of 153: the same procs deadline case.  All six affected suites passed their 124 tests; typecheck and lint passed.  The source and test bytes for procs exactly match frozen parent `7fd4590f`, recorded in `codex-bf2604-gate-baseline-comparison.json`.  No second full suite was run, and no full-suite pass is claimed.

## Required Recipes

| Key | Fixture And Action | Required Result |
| --- | --- | --- |
| `mac-high-cpu-accepted` | In `serverFirst`, server refuses on memory; Mac load is four times cores, swap is 50 percent and reserved CPU equals detected cores.  Then set Mac swap to 98 percent with low load, also in `localOnly`. | High CPU still admits on Mac; no refusal path mentions load; unsafe swap queues with "Mac: swap 98%" in both modes.  Mac hand run: three `yes > /dev/null` jobs continue while a reserved-RAM memory hog stops with "stopped: memory budget". |
| `settings-saved-vs-applied` | Stub failed apply; save a reservation at/above detected capacity; test unset and negative values with Swift models and server config tests. | Failed apply retains prior applied state with "Not applied: <reason>"; no-capacity setting is accepted with a waiting explanation; unset shows "Not set" and built-in gates; negative is refused without changing applied state. |
| `headroom-enforced-mac` | Inject aggregate resident-memory samples above budget for a job tree; also run the Mac hand recipe. | Newest over-budget group receives SIGTERM then SIGKILL after grace; `killed`, `killedBy: limit`, "Over the RAM budget (<n> GB of <budget>)"; `stopWhenOver` badge, never `kernelCap`. |
| `headroom-enforced-server` | Linux fixture with systemd/cgroup v2; fork children past per-job `memory.max`; spin past `cpu.max`; then perform the authorized server hand run described below. | `memory.events oom_kill` increments inside the job cgroup, harness survives and job says "memory limit"; CPU throttling is measured.  Runtime API reports cgroup read-back, not saved configuration. |
| `mount-loss-root-fallback` | Check rendered unit mount requirements and no drop-in without configured limits; start with root-device data; inject mount loss and zero inodes; perform the authorized throwaway-unit hand run. | Missing mount prevents start with named cause; root-device check refuses; runtime jobs park with "Server storage offline"; zero inodes refuses with "short on inodes"; write attempts are recorded. |
| `other-apps-unchanged` | Authorized throwaway server service, separate root and saturating job; neighboring HTTP health every second for ten minutes; sample CPU throttling and OOM counters before/during/after. | Neighbor p95 stays within its measured baseline; logs show counter deltas and harness survival.  CI simulation is insufficient. |
| `inventory-recorded` | Authorized read-only inventory on Mac and server, capacity plus other-app baseline and peak demand; attach both artifacts before committing defaults. | Both host outputs carry measurement window, units, source commit and owner-clock run time; Mac output includes OrbStack's reservation and Local VM inside it; numeric defaults remain unset until reviewed. |

## Inventory Before Numbers

The inventory collector is slice 4, after the resources route.  Its absence in the foundation is not permission to substitute guessed capacity.  Once that collector lands, use its documented invocation on each authorized host and capture cores, RAM, swap, volume size, free bytes, inodes, I/O and data-volume mount identity beside root-disk free.  Capture ordinary demand, other services' baseline and the seven-day resource-watch peak, with the chosen sampling window recorded.  The Mac artifact must record existing OrbStack CPU/RAM reservations and that the Local VM uses the same reservation.

Run only after Jay authorizes the read-only inventory on both hosts.  Attach outputs to BF-2559 and record their paths under `inventory.server` and `inventory.mac` in the run's placement evidence.  The checker requires both paths even before a new default is proposed.  A later numeric default or drop-in must cite that inventory and the owner's resulting choice; no inventory run changes settings.

## Mac Hand Runs

Run isolated job processes and temporary data on a Mac with the relevant watchdog slice installed in the fixture.  Record `mac-high-cpu-accepted` and `headroom-enforced-mac` separately, with commands, resident-memory samples, signals, grace interval, final status and the other jobs continuing.  The Mac CPU row remains `priorityOnly`; it never gains a load cutoff.  A memory sampler earns `stopWhenOver` only while active, and never proves a kernel memory cap.

## Server Hand Runs Need Recipe-Specific Approval

Recipes 11, 12 and 13 each wait on Jay's explicit go-ahead, with Jay present.  Record the approval reference in the run log, then record who ran it, the owner-clock time and log path in `handRun`.  Do not run any of these against an unapproved host or as part of ordinary CI.

For `headroom-enforced-server`, wait for the reviewed resource apply path and per-job cgroups.  The plan's hand half runs a grandchild memory hog under a small approved `MemoryMax`, records one OOM event, a surviving harness and "stopped: over the memory cap", and checks `GET /api/resources/<server>` against cgroup contents.  Matching `systemctl show` is only a precondition.  Because an aggregate cap can kill the harness, agree the isolated fixture and rollback with Jay before this run; do not alter the live unit from this recipe document.

For `mount-loss-root-fallback`, create a throwaway unit from the template with a throwaway root-disk directory.  No mount: start is refused; bind mount: start succeeds; unmount: start is refused again.  From the running test unit attempt writes to `/var/lib`, `/home/jay`, `/dev/shm` and `/tmp`, capturing every outcome.  Never use the live unit.  Remove the throwaway unit, mount and fixture files after capturing evidence.

For `other-apps-unchanged`, use `botfleet-fixture.service` and a separate root under the approved scratch volume.  Agree the neighboring health endpoint and baseline first; record the ten-minute per-second probe distribution and `cpu.stat throttled_usec` / `memory.events oom_kill` deltas.  Stop and remove the fixture after the run.  A gate that reads configuration without this measurement cannot assert unchanged responsiveness.

## Enforcement Labels And Completion

Read actual mechanisms, never claim enforcement from a desired setting.  `kernelCap` means read-back from a working kernel mechanism; `stopWhenOver` means an active watcher; `gateOnly` means checked at admission; `priorityOnly` means full CPU speed remains allowed; `unsupported` and `notApplied` must name the reason.  Saved and applied values stay separate.  Docker work outside the unit's cgroup and absent disk quotas must remain explicit gaps.

Run `node scripts/check-placement-evidence.mjs /absolute/run/placement-evidence.json` as described in [Placement And Ownership Evidence](placement.md).  All hand-run assertions and live measurements remain unasserted until these complete results exist.
