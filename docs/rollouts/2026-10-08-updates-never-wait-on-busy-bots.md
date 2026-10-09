# 2026-10-08 — Updates Never Wait On Busy Bots

Board row `ef645faf`.  Branch `claude/updater-drain`.

Owner, 2026-10-08: "every time an update tries to go, is it stopped when a bot
starts working?  please fix that somehow", and then: "I have been ready to scream
like 200 times over the past week over waiting for updates and never once cared at
all if a task got interrupted."

## What Was Wrong

`apply` took one active-work reading and refused when anything was running.  On
the owner's Mac (Sentry webhooks, routines, busy bots) an apply retried every three
minutes saw 3, 5, 6, 7, 10 and 11 operations and rarely caught an idle moment, so
an update could wait for hours unless someone passed `--force`.  New work kept
arriving while the updater waited, so the count never had a reason to fall.  The
in-app **Install Update** button sent `force: true`, but the phone and every
scheduled `ubf` did not.  Separately, a single slow `/api/runtime` answer under a
load average around 480 aborted a whole apply ("Authenticated runtime readiness
could not be verified").

## Changes Made

- `server/update-drain.ts`: the hold (`UpdateDrain`, its lease, what counts as in
  flight) and the carrier `update-held-sends.json` (sends, uncommitted queue
  entries, room rounds), parsed with zod.
- `server/index.ts`: the hold on the quiesce route (`drain=1`), with its input
  checked by a strict zod schema; held sends, job wakes, routine receipts and
  room rounds; the forced path's `fencing` flag, its release-when-settled, its
  merged and parked resume snapshot; the fence lease (`leaseMs`, `renew=1`);
  restoring carried work after `jobRegistry.adopt()` and boot recovery.
- `server/steer-queue.ts`: committed batches that drain alone, one batch per
  bot per pass, `drainEveryReadyBatch` (no pass cap), carry and restore.
- `server/room-queue.ts`: take, restore and re-date held room rounds.
- `server/routines.ts`: `requeueRun` requeues only cancelled runs.
- `server/update-control.ts`: busy is never a refusal, the progress `detail`,
  and the progress record parsed through a zod schema.
- `scripts/update-botfleet-mac.mjs`: hold, grace, pause; `--wait-for-idle`;
  the fence predicate; the settle-aware release; the signal watcher and lease
  renewal; rollback's immediate fence; the foreign-holder wait at preflight and
  after the fence; preflight retry.
- `scripts/mac-update-transaction.mjs`: `ensureRunning` before the first check
  and after every failure, held signals past the interruption boundary, and the
  leftover sweep at the start of every apply.
- `scripts/update-botfleet-mac.mjs` (2026-10-09 overnight): `ensureBotFleetRunning`,
  `waitForBotFleetExit` for slow exits, the rollback deferral rule, and the
  `sweepLeftovers` op.
- `scripts/update-botfleet.sh`, `scripts/update-progress.mjs`: the new flags,
  the progress `detail`, and the two new step names.
- `src/lib/update-control.ts`, `src/components/UpdateBanner.tsx`,
  `src/components/SettingsModal.tsx`, `src/components/Sidebar.tsx`,
  `companion/src/routes.ts`: no `force: true`, busy copy, and `detail` shown.
- `apps/docs/content/docs/self-hosting/updating-this-mac.mdx`: the owner page.
- Tests: `scripts/update-botfleet-hold.node-test.mjs`,
  `server/update-held-boot.test.ts`, `server/update-drain.test.ts`,
  `server/steer-queue.test.ts`, `server/room-queue.test.ts`,
  `server/routines.test.ts`, `server/index.test.ts`,
  `server/update-control.test.ts`, `src/lib/update-control.test.ts`,
  `scripts/update-progress.test.mjs`, `server/bot-off-wiring.test.ts`,
  `server/bot-power.test.ts`.

### How An Update Runs Now

The default `update` and `apply`, the in-app button and the phone all do the same
thing now:

1. **Hold new work** (`POST /api/runtime/quiesce?drain=1`, `server/update-drain.ts`).
   Nothing new starts, nothing is refused, and every route stays open.  Routine,
   webhook and resource runs stay `queued` in `routines.json`.  A job wake puts its
   notice back.  A person's message to an idle bot waits in the steer queue.
2. **Grace.**  Work in flight gets 60 seconds to finish on its own (`--grace
   SECONDS`, `BOTFLEET_UPDATE_GRACE_MS`).  If it does, the drain converts to the
   ordinary fence and nothing is interrupted.
3. **Pause and resume.**  Otherwise the forced quiesce runs exactly as `--force`
   always has: interrupt, save to `pending-update-resume.json`, resume after the
   restart.  Held messages ride `update-held-sends.json`: committed to their thread
   when their bot was idle, or carried uncommitted when they waited behind a bot
   that was paused, so that bot's own turn resumes first.  Work is paused at most
   once per update: an attempt that rolls back under the hold keeps what it paused
   paused and saved, the next attempt adds to the same snapshot, and only letting
   go of the hold (or the restart) resumes it.
4. **Never refuse for work.**  The one exception is a live room turn, which
   still refuses the forced quiesce because a room turn cannot be resumed without
   repeating its prompt.  Room rounds are held like other work (they wait in the
   room queue and ride the carrier), so a busy room goes quiet after the turn it is
   on, and the updater's room wait (up to 5 minutes, `BOTFLEET_UPDATE_ROOM_WAIT_MS`)
   is one turn long.  If that turn outlasts it, the updater lets everything go and
   ends `refused` with a sentence naming the room.

`--wait-for-idle [MINUTES]` is the opt-in that never interrupts: hold, wait up to
20 minutes, and if bots are still busy, release everything and stop without
changing anything.  `--force` skips the grace.

The harness owns the hold's lifetime: it lets go by itself two minutes past the
updater's window, so a killed updater cannot leave automations waiting.  The fence
has a lease too: the updater asks for one when it takes the fence and renews it
every 20 seconds until the harness has stopped, and a fence nobody renews releases
itself after three minutes.  It cannot fire mid-install, because the harness
cancels it the moment the updater's bootout or SIGTERM reaches it.  SIGINT and
SIGTERM are watched for the whole fence step, including a request in flight that
then fences and the checks after the fence: the updater lets go of whatever it
holds and resumes whatever it paused.

A release never lands mid-settle.  The updater waits for a forced quiesce still
interrupting and saving work (`fencing`) before it asks, and a release that
arrives anyway is kept by the harness and honoured the moment the forced quiesce
settles.  Rollback takes the fence on the replacement at once (the forced quiesce,
or one plain ask under `--wait-for-idle`), never the hold and grace.

The preflight retries a slow harness with backoff for up to 60 seconds
(`BOTFLEET_PREFLIGHT_RETRY_MS`) and waits 10 seconds per answer instead of 3.  A
forced answer that times out is watched until the fence is settled, instead of
being misread as a refusal: the harness says so (`fencing: false` in
`/api/runtime`), or, for the installed harness that predates `fencing` and raises
its fence before it interrupts anything, nothing is left in flight.

### A Foreign Process Holding BotFleet State Is Waited Out

At 9:08pm the same evening `apply --force` refused with "Process 59135 owns
BotFleet state but does not match an expected BotFleet executable", and the
process was gone seconds later: a bot's own `sqlite3`, `node` or `curl` holding
the database or a port for a moment.  Capture, quiesce, the preflight and the
database check after the fence now re-resolve what holds BotFleet state every two
seconds for up to 90 seconds (`BOTFLEET_UNKNOWN_HOLDER_WAIT_MS`) before refusing,
and the refusal names the
process's executable.  An unrecognised process is never signalled, and quiesce
identifies every survivor before it signals any, so a refusal never leaves
BotFleet half-stopped.

### Never Left Stopped (2026-10-09 Overnight)

Between about 12:13am and 3:20am the forced updater, at target `db3403f11`, left
the owner's Mac with no BotFleet: the app's own processes were slow to quit at a
load average of 50 to 500 per core ("BotFleet process 11736 still runs from
inside /Applications/BotFleet.app after graceful shutdown"), the rollback
deferred although no harness answered ("Replacement may own active work"),
nothing started BotFleet again, and every later run refused on "BotFleet harness
(pid 43837) is not running" until the owner relaunched the app at 3:22am.

- Every exit leaves BotFleet running, the new build or the prior one.  A stopped
  BotFleet is started before the first check, and every failure path (refused,
  rolled back, a rollback that failed or was deferred) makes sure one runs.  It
  is a no-op when a harness answers, it waits for an instance still quitting
  before starting, and it starts a mismatched checkout and app anyway, saying so.
- Past the interruption boundary, Ctrl-C and SIGTERM wait for the install or its
  rollback to finish.
- Slow exits are waited for: up to 3 minutes, re-checked every 2 seconds, with
  progress, one verified SIGTERM after 20 seconds, never SIGKILL.  SIGTERM's own
  window is 60 seconds.  Fixed and generous rather than load-aware: the wait ends
  at once on a quiet Mac.
- A rollback is deferred only when a live harness answers and refuses.  With no
  harness answering, the rollback waits the processes out and restores.
- Candidate bundles and dependency trees an earlier run left (named after an
  updater that is gone) are swept at the start of every apply.  A deferred
  rollback's `pending-recovery.json` is reported; nothing reads it, so it never
  blocks an update.

## The First Update Carrying This

The updater that runs is the one at `origin/main`; the harness answering it is the
one installed now, which has never heard of a drain.  That harness reads
`?drain=1` as a plain quiesce: fenced when idle, 409 when busy, with no `draining`
field.  The new updater sees the missing field and retries the plain fence for the
60-second grace, then sends the forced quiesce the old harness already supports.
Nothing is held during that one transition run, so it behaves like today's
`--force` after a minute.  That harness also raises its fence before it starts
interrupting and never reports `fencing`, so a forced answer lost against it is
only taken for a fence once it reports nothing left in flight, and a release
against it waits (bounded) while it still counts work under its fence.  It has
no fence lease, so the updater never sends it a renewal.  Every update after it
gets the full hold.

## Recovery

- A hold that outlived its updater releases itself at its deadline.  To release
  it at once: `update-botfleet.sh unquiesce`, which now also lifts a hold.
- `update-held-sends.json` in the data directory is read and removed at boot,
  after the jobs registry has settled and boot recovery has decided about each
  interrupted turn.  Every carried message goes back in its bot's queue and runs
  when that bot is free, one at a time and in the order it was held; carried room
  rounds go back in the room queue.  A rollback boots the previous build, which
  never reads it; the next build that does runs anything under an hour old and
  writes the rest into its thread with a note saying it was not run.
- A fence whose updater stopped renewing its lease releases itself after three
  minutes; `update-botfleet.sh unquiesce` releases it at once, waiting for a forced
  quiesce that is still settling.

## Verification State

Run on this Mac (a linked worktree, load average 130 to 950 during the runs)
and on CI.  Exact commands, with `DOCKER_HOST=unix:///nonexistent.sock`:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass (4802 warnings, baseline 4890) |
| `git diff --check origin/main...HEAD` | pass |
| `node --test scripts/update-botfleet-hold.node-test.mjs` | pass (39 of 39) |
| `node --test scripts/mac-update-transaction.node-test.mjs` | pass (27 of 27), including the overnight replay |
| `pnpm test:mac-updater` | 253 pass, 2 fail: "the stable wrapper detects a linked worktree checkout" and "the up-to-date shortcut only swallows a plain update to origin/main", which fail the same way with the base updater (A/B), because this checkout is a linked worktree |
| `npx vitest run server/index.test.ts -t "<the update tests>"` | pass: the hold, the forced fence, a release while settling, a rolled-back attempt that keeps work paused, the fence lease, a held room round, and malformed quiesce input |
| `npx vitest run server/update-held-boot.test.ts` | pass (two boots); fails against the base harness with one of two carried sends run (A/B) |
| `npx vitest run server/steer-queue.test.ts server/update-drain.test.ts server/room-queue.test.ts server/routines.test.ts server/update-control.test.ts server/bot-off-wiring.test.ts server/bot-power.test.ts` | pass |
| `pnpm test` (each step run separately) | `node scripts/test-floor.mjs` failed at load ~950 (55 of 9135 in 22 files, mostly harness-boot timeouts); rerun of those files at lower load: 6 fail, in `unattended`, `http-lane-e2e`, `decision-log-wiring` and `env-path`, which fail identically on `origin/main` here (A/B) and pass on CI.  `test:packaged-server` timed out booting at load ~950 and passed on rerun.  Every other step passes. |
| CI `typecheck + test` (ubuntu, macos, windows) on `f5ffc1432` | failed only `bot-off-wiring.test.ts` (all three) and a POSIX mode check in `update-drain.test.ts` (windows); both fixed in `082a74c4a` |

### What The Tests Cover

- `scripts/update-botfleet-hold.node-test.mjs`: grace, pause, rooms, wait-for-idle,
  signals (including mid-request and after the fence), lost answers, the installed
  harness's response shape, settle-aware release, the fence lease, rollback's
  immediate fence, foreign database holders, preflight retry, the flags, and the
  wrapper's up-to-date shortcut, all on a fake clock.
- `server/update-drain.test.ts`, `server/steer-queue.test.ts`,
  `server/room-queue.test.ts`: the hold's lease, what counts as in flight, the
  carrier, committed batches, the uncapped commit, and held room rounds.
- `server/index.test.ts`: a live harness holding a message across release, across
  the fence, and across a forced fence with a busy bot; a release that arrives
  while a forced quiesce settles; a rolled-back attempt that keeps its paused work
  paused and is not interrupted again; the fence lease; a held room round and a
  live room turn; malformed quiesce input.
- `server/update-held-boot.test.ts`: two boots, the carrier read at boot, and two
  carried messages for one bot run once each, in order.
- `scripts/mac-update-transaction.node-test.mjs`: the overnight sequence (slow
  exit, deferred rollback, restart, the next run proceeds), every failure path
  ending with BotFleet running, a failed restart reported, signals held past the
  boundary, and a failing leftover sweep.

## Review Fixes

The PR body maps each finding to its commit and test.  In short: a release
mid-settle is deferred (1); the installed harness's fence is only used once its
work count is zero (2); carried sends go through the steer queue after jobs settle
(3, 8, 9); rollback fences at once (4); foreign database holders are waited out at
preflight and after the fence (5); signals cover the whole fence step and the
fence has a lease (6, 11); room rounds are held and carried, while a live room turn
is still waited for (7); work is paused at most once per update (10).  The
2026-10-09 overnight failures: a slow harness is asked again (preflight retry); a
slow exit is waited out; BotFleet is never left stopped; leftovers are swept.
