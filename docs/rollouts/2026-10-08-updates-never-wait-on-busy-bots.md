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
   that was paused, so that bot's own turn resumes first.
4. **Never refuse for work.**  The one exception is room work.  A live room turn,
   or a room round queued behind a busy member, still refuses the forced quiesce,
   because a room turn cannot be resumed without repeating its prompt.  The
   updater waits up to 5 more minutes for rooms (`BOTFLEET_UPDATE_ROOM_WAIT_MS`),
   then lets everything go and ends `refused` with a sentence naming the room.  A
   room whose bots keep answering each other can therefore still turn an attempt
   away; it is bounded at about 6 minutes per attempt.

`--wait-for-idle [MINUTES]` is the opt-in that never interrupts: hold, wait up to
20 minutes, and if bots are still busy, release everything and stop without
changing anything.  `--force` skips the grace.

The harness owns the hold's lifetime: it lets go by itself two minutes past the
updater's window, so a killed updater cannot leave automations waiting.  The
updater releases on every exit that is not a fence, including SIGINT and SIGTERM.

The preflight retries a slow harness with backoff for up to 60 seconds
(`BOTFLEET_PREFLIGHT_RETRY_MS`) and waits 10 seconds per answer instead of 3.  A
forced answer that times out is watched until the harness says the fence settled
(`fencing` in `/api/runtime`), instead of being misread as a refusal.

## The First Update Carrying This

The updater that runs is the one at `origin/main`; the harness answering it is the
one installed now, which has never heard of a drain.  That harness reads
`?drain=1` as a plain quiesce: fenced when idle, 409 when busy, with no `draining`
field.  The new updater sees the missing field and retries the plain fence for the
60-second grace, then sends the forced quiesce the old harness already supports.
Nothing is held during that one transition run, so it behaves like today's
`--force` after a minute.  Every update after it gets the full hold.

## Recovery

- A hold that outlived its updater releases itself at its deadline.  To release
  it at once: `update-botfleet.sh unquiesce`, which now also lifts a hold.
- `update-held-sends.json` in the data directory is read and removed at boot.  A
  rollback boots the previous build, which never reads it; the next build that
  does runs anything under an hour old and writes the rest into its thread with a
  note saying it was not run.

## Verification

- `scripts/update-botfleet-hold.node-test.mjs`: grace, pause, rooms, wait-for-idle,
  signals, lost answers, the old-harness path, preflight retry, the flags, and the
  wrapper's up-to-date shortcut, all on a fake clock.
- `server/update-drain.test.ts`, `server/steer-queue.test.ts`: the hold's lease,
  what counts as in flight, and the carrier.
- `server/index.test.ts`: a live harness holding a message across release, across
  the fence, and across a forced fence with a busy bot.
