# 2026-10-05 — ACP CLI Process-Group Ownership Tracking

PR #831 (`ag/fix-acp-wedged-lock`).  Close the recycled-pgid kill window when an ACP turn's force-kill timer fires after the CLI leader has already exited, while still reaping SIGTERM-ignoring MCP descendants that hold a session lock.

## Pre-work Claim

- `AGENT-SYNC.md` (`/Users/jay/apps/AGENT-SYNC.md`) was read before claiming this work.
- The #agent-sync claim was posted to `#agent-sync` (`C0BEZDJDNKV`) with `repo: BotFleet` as its first body field.  Seat `BF-FIXER`, claimed Mon, Oct 5, 2026, state WIP.
- Claim reference:  ts `1791237243.397089`, permalink https://simple-with-us.slack.com/archives/C0BEZDJDNKV/p1791237243397089
- Claimed scope:  `ag/fix-acp-wedged-lock` `server/procs.ts` `server/procs-group.test.ts` `server/drivers/acp/**` (PR #831 at tip `26acb0b7`).

## Context & Objective

ACP `stop()` used to arm a 2 s process-group `SIGKILL` against the raw `-pid` captured at stop time.  Once the leader exited, that pid/pgid could be recycled by the OS before the timer fired, so the callback could signal an unrelated group (another turn's CLI, or the deployer's children).  A liveness re-check on the *leader* closed the recycle window but also made the timer a no-op exactly when a SIGTERM-ignoring MCP descendant outlived the leader on a normal completion — the wedge this PR exists to reap.  The fix is ownership of the process group itself: signal only while `-pid` can still be shown to name this CLI's group.

Extra-ship no.  Same branch only.  Never the Mac.

## Changes Made

- `server/procs.ts` — added `trackCliGroup` / `CliGroup` / `CLI_GROUP_WATCH_MS`.  Ownership is continuity: the id is ours while the leader is unreaped; on `exit`, the group is probed in the same tick; an empty group disowns for good; a group with members left stays owned and is re-probed every 50 ms; `signal` re-probes before every send and disowns on `ESRCH`/`EPERM`.  Windows: `owned` is false and `signal` never sends (`killCliTree` still uses taskkill /T).
- `server/drivers/acp/core.ts` — `stop()` and `stopAndWaitForExit` arm the force-kill on `group.owned` via `trackCliGroup`, not on leader `exitCode`/`signalCode`.  Normal completion still SIGTERMs while the leader is alive; a lingering descendant still gets SIGKILL after `FORCE_EXIT_AFTER_MS` while the group remains owned.
- `server/procs-group.test.ts` — POSIX unit coverage for own / empty-group disown / SIGTERM-ignoring descendant keep-then-release.  Ready handshake (pid file + readiness write after `process.on('SIGTERM', …)`) so the group SIGTERM cannot land mid-boot under the default disposition.
- `server/drivers/acp/acp.test.ts` / `server/testing/fake-acp-cli.ts` — regression coverage for the lingering-descendant and stale-pgid paths; fake CLI spawns the descendant from the `session/prompt` path only, with the same ready handshake.

## Decisions & Trade-offs

- Gate the force kill on group ownership rather than leader liveness.  That is the only shape that both refuses a recycled pgid and still reaps a SIGTERM-ignoring descendant after a normal `settle()` → `stop()`.
- Do not retain-and-clear the force-kill timer on leader exit.  `group.signal` already no-ops once the group is empty / disowned, and the timer is `unref`-ed, so holding a mutable handle adds state without changing the failure mode.
- Remaining ownership-reuse limitation (documented in `trackCliGroup`): a group that empties AND has its id recycled into a new group inside a single `CLI_GROUP_WATCH_MS` (50 ms) interval.  That needs the whole pid space to wrap in 50 ms.  The previous timer-without-ownership shape left that gap open for the whole grace period; this shrinks it to one watch tick.

## Verification State

Commands run on the Linux tip-fix box (America/Chicago), in the repo's mandated order using its `package.json` scripts (pnpm; `pnpm typecheck` is this repo's `tsc` step, `tsc -b && tsc -p tsconfig.server.json`, in place of `npx tsc --noEmit`).  Exit statuses are recorded exactly as observed.  Box Node is v22.23.3 / pnpm 9.15.9; `package.json` wants Node >=24 and pnpm 10 (engine warning only).  No Mac / Xcode / iOS build was run for this tip.

```
1. pnpm lint        # exit 1 — lint baseline exceeded (4697 warnings vs baseline 4654)
2. pnpm typecheck   # exit 0
3. pnpm test        # exit 1 — vitest: 3 files / 15 tests failed, 8135 passed, 9 skipped (8159 counted)
4. pnpm build       # exit 0
```

- `pnpm lint` exit 1 is not introduced by this tip or this PR's diff on this box: the PR head before this tip (`f0b3ec55`) reports the identical 4697-vs-4654 count, and `origin/main` itself fails the same check here (4858 vs 4852).  CI lints the PR merge commit with the pinned toolchain; treat lint as unverified locally until the CI `lint` job reports.
- `pnpm test` exit 1: all 15 failures are in `server/tools/computer.test.ts`, `server/tools/host.test.ts` and `server/tools/process-group.test.ts` (none touched by this PR), failing with `Could not start the shell: spawn /bin/zsh ENOENT` — this box has no `/bin/zsh`.  Environmental, not a regression.  The files this PR touches passed in that same run: `server/procs-group.test.ts` (3/3) and `server/drivers/acp/acp.test.ts` (97/97).
- Because `pnpm test` chains its sub-suites with `&&`, the post-vitest sub-suites (`broker:test`, `test:updater`, `test:mac-updater`, ... `test:server-start`) did not run on this box.  Those are unverified here, not PASS.
- Windows CI paths for `procs-group` remain `skipIf(win32)` (no process groups).  No Mac app rebuild, no `xcodebuild`, no iOS `swift test` on this tip.

## Next Steps & Blockers

- No further code change planned on this branch for the 50 ms empty-and-recycle gap; treat it as an accepted residual unless production evidence shows otherwise.
- Live Mac harness rebuild / `update-botfleet.sh` is out of scope for this tip-fix.  Ask before any bounce.
- Windows still relies on `taskkill /T` via `killCliTree`; no `trackCliGroup` signals there.

## Zero-Code Findings

The ownership-reuse residual above is already encoded in the `trackCliGroup` comment and restated under Decisions so the handoff does not invent a follow-up that needs no code yet.

Recall closeout: BF-FIXER contributed the process-group ownership lesson via fleet-recall (category `lesson`, app `botfleet`) — retain group ownership until an empty-group probe disowns it, re-probe before every delayed signal, document residual PID-reuse windows, and never treat a pid file's existence alone as ready (parse to a positive safe integer before any cleanup kill).  Result: `status: ok`, `id: 460c350c-fd9e-5bd8-b803-4f794bf4ee83`, `doc_id: contrib/BF-FIXER/2026-10-05/7eee4629`.
