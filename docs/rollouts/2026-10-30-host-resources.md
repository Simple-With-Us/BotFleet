# Host Resource Report Rollout

Refs BF-2559.  Implements BF-2598, slice 2 of [Native Server Mode](../plans/2026-10-29-native-server-mode.md), on the placement foundation in BF-2596.

## Behavior

`GET /api/host/resources` reports the stable local host id, installed version, platform capabilities, current capacity sample, effective existing swap/disk admission thresholds and per-resource enforcement.  The report shares the job registry's existing admission probe, including its swap cache and filesystem disk readings.  It adds filesystem totals/inodes, Linux memory availability, data-volume identity and root-disk free; it starts no extra timer or shell probe.

Both booting and ready `/api/health` responses gain `hostId` and `version` while retaining app, pid, static, ownership proof and readiness.  The host id is established after the data ownership fence and before the listener opens, so both phases name the same identity.

The report is available through the existing local-owner loopback boundary and Linux authenticated owner gate.  The gate validates its own credential and strips it before forwarding.  Companion forwarding is refused at the harness even if its allowlist is widened later, and a Companion pairing token alone grants no access.  Requests with named-tunnel edge markers are also refused; that path has no host-owner credential.

## What Enforcement Means

Linux read-back resolves this process's unified cgroup from `/proc/self/cgroup` and the cgroup v2 mount root from `/proc/self/mountinfo`.  It reads only that cgroup's CPU, memory, swap, task and I/O files.  Finite `cpu.max`, `memory.max` and `memory.swap.max` can earn `kernelCap`; a nonzero I/O rate must name the sampled data volume's device.  Unlimited, missing or malformed limits, `memory.high` alone and I/O weights do not earn a cap badge.  Desired config, unit text and drop-in contents are never evidence.

The report names whole-server memory risk, external-daemon containers and unmeasured ancestor/per-job limits.  Disk remains an admission gate, and no inode gate is introduced.  Mac CPU remains background priority with full speed allowed; Mac aggregate RAM never claims a kernel cap.  Unknown readings remain null.  An unreadable swap or disk probe reads `notApplied` with its reason while the existing admit-on-unknown behavior is preserved.  Hosts without a swap check or a kernel RAM cap explicitly name that gap.

Memory pressure and Mac available-memory semantics remain unknown until their later sampler slice; free pages are not relabeled as available memory.  The existing numeric admission settings are reported unchanged.  No new budget, placement behavior, route credential class or resource enforcement is enabled.

## Verification

From an owned lane:

```sh
pnpm typecheck
pnpm exec vitest run server/host-resources.test.ts server/jobs/probes.test.ts server/resource-triggers.test.ts server/boot-gate.test.ts companion/test/routes.test.ts
node --test deploy/linux-server/owner-gate.node-test.mjs
node scripts/audit-node-decommission.mjs
git diff --check
```

Pure report tests inject cgroup files and every capacity probe, including failures, unlimited limits, mount roots and aliases.  The real boot fixture checks stable additive health fields and refuses Companion/edge resource requests before any cgroup read.  The existing owner-gate fixture checks credential validation and forwarding.  No live cgroup or systemd probe, write, inventory, resource change or deployment is part of this rollout.

The full local `pnpm test` run failed: 37 failed, 12,212 passed and 26 skipped tests across 723 files (six failed files).  The controlled env-path, credential and plugin recheck reproduced the same 36 baseline failures by file.  The remaining deferred-fallback cleanup failure was reproduced against the byte-identical test on unchanged Node baseline `9ea0d4af2`; after restoring the resource source, its focused clean recheck passed.  This is not a green full-suite result, and later stages after the failing Vitest gate did not run.

Parent validation passed 138 boot/resource-focused tests, 36 owner-gate tests and the built-server bundle checks with Node 24.  Those results establish the tested bundle path, not standalone runtime parity or live server acceptance.  The resource slice is rebased onto the published BF-2596 foundation before its integration-focused typecheck and tests; no complete suite is repeated for that source integration.

The full sixteen placement assertions remain false.  This report is only the harness half of recipe 1; the native host handshake, queue, leases, enforcement and authorized hand runs remain later slices.  The parent task records the required full-suite and Apple verification boundaries before publication.

## Update And Rollback

Use the existing reviewed delivery path and preserve the data directory including `host-id`.  The report and health fields are additive.  Older clients ignore the new health fields; rolling code back removes the report without changing mode, admission settings or job routing.
