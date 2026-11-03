# Private Pending Command Recovery

BF-2604 records the owner's approval to retain a bounded private command spool for restart recovery, superseding the earlier memory-only rule for accepted local waiting commands.

The spool lives in the job directory's `pending-commands` subdirectory with mode `0700`, and payload files are exclusively published with mode `0600` after their contents are synced.

The existing command length ceiling bounds serialized payload bytes, the existing record cap bounds payload count, and `jobs.queueWaitMinutes` bounds retention independently of the execution timeout with a default of 1440 minutes and an owner-configurable range of 1 through 10080 minutes.

Each payload binds its command to the job's identifier, bot, conversation, turn, origin, working directory, enqueue time, execution timeout, and local host identities through a SHA-256 digest.

Public job records retain their existing redacted display labels and gain only an internal ownership marker; full command payloads never enter job snapshots, configuration, diagnostic messages, or the public record file.

Recovery accepts only unexpired local queued records with matching private regular files, validated ownership, permissions, inode identity, size, and job binding.

Restored waiters retain their admission caps and original FIFO order, while legacy or foreign controller-owned waiting records remain outside local execution ownership.

Before invoking the executor, the registry claims a command by removing its payload and syncing the spool directory, so a crash after that fence marks the still-queued record lost instead of replaying a command whose launch outcome is uncertain.

This intentionally permits loss after a successful claim but before spawn in exchange for preventing duplicate execution.

Stop and expiry remove the private payload, and boot removes orphan or incomplete publications without following links or descending into unexpected directories.

Windows background jobs retain their existing unconditional refusal, and the private spool also fails closed when POSIX ownership checks are unavailable.

Verification uses temporary directories and fake executors in `server/jobs/pending-spool.test.ts`, including both crash windows, recovery ordering, cancellation, expiry, private permissions, identity mismatch, malformed and oversized files, symlinks, directory replacement, and the existing record cap.

The recovery and private-filesystem fixtures run on POSIX platforms, while the actual native strip-only module import regression runs on every platform.

## Validation

Linux validation passed `pnpm typecheck`, `pnpm lint` at the unchanged warning baseline, the native Node strip-only import, and 121 affected tests across the spool, placement queue, registry, knob resolution, and knob write-through suites.

The corrected broad Vitest run passed 745 files and 12672 tests, with one skipped file and 22 skipped tests, and its 12694 registered tests passed the suite-count floor.

The subsequent broker suite passed 17 tests, and the isolated credential-sync fixture passed four tests using refusing container executables.

The complete `pnpm test` chain stopped at the packaged-server smoke readiness deadline after the bundle built and began booting, so package-smoke verification and the remaining script stages are still required before claiming the full gate passed.

## Follow-Up Segmented Validation

After isolating packaged smoke from host CLI discovery with a private shadow instance, `VITEST=true pnpm test:packaged-server` passed its **bundle-check** mode: the packaged server started without reachable `node_modules`, all 14 proxy paths resolved inside the bundle, and the packaged MCP stdio server reached the API and flushed its final frames.  The output explicitly says this is not a runtime pass; no packaged-runtime pass is claimed.

The remaining chain from `pnpm test:ios-ship` through the final HTML sentence-gap and iOS screenshot Node fixtures completed with exit 0: 444 tests passed, zero failed, zero skipped.  The credential-sync stage passed all four fixtures, including the refused-copy case.  The earlier 45-second and 60-second packaged-readiness failures remain preserved as failed runtime-readiness attempts; the bundle-check result does not explain or erase them.

`pnpm lint` passed in the lane with 4,867 warnings, equal to the existing baseline of 4,867.
