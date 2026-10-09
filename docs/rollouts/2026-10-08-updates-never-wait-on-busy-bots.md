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

## What Ships

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

## Verification

- `scripts/update-botfleet-hold.node-test.mjs`: grace, pause, rooms, wait-for-idle,
  signals, lost answers, the old-harness path, preflight retry, the flags, and the
  wrapper's up-to-date shortcut, all on a fake clock.
- `server/update-drain.test.ts`, `server/steer-queue.test.ts`: the hold's lease,
  what counts as in flight, and the carrier.
- `server/index.test.ts`: a live harness holding a message across release, across
  the fence, and across a forced fence with a busy bot; a release that arrives
  while a forced quiesce settles; a rolled-back attempt that keeps its paused work
  paused and is not interrupted again; the fence lease; and a held room round.
- `server/update-held-boot.test.ts`: two boots, the carrier read at boot, and two
  carried messages for one bot run once each, in order.

### Review Fixes (head 1666ec28b, DO NOT MERGE)

The PR body maps each finding to its commit and test.  In short: a release
mid-settle is deferred (1); the installed harness's fence is only used once its
work count is zero (2); carried sends go through the steer queue after jobs settle
(3, 8, 9); rollback fences at once (4); foreign database holders are waited out at
preflight and after the fence (5); signals cover the whole fence step and the
fence has a lease (6, 11); room rounds are held and carried (7); work is paused at
most once per update (10).
