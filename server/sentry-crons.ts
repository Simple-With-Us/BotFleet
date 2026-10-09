// Sentry Crons check-ins for BotFleet's own scheduled routines (the report
// named Housekeeper and Monitor, but this covers every "daily" routine any
// bot has — see server/routines.ts).  A "once" routine has nothing
// recurring for Sentry to watch, so it gets no monitor.  The monitor's
// schedule config is upserted from the routine's OWN definition on every
// real firing, so an owner who edits a routine's time in the UI needs no
// separate Sentry setup step — the next check-in carries the new schedule.
//
// routines.ts stays Sentry-agnostic (RoutineManagerOptions calls back into
// this module rather than importing @sentry/node itself) so its extensive
// unit tests never have to stand up or stub the SDK.
import type { Routine, RoutineRun } from "./routines.ts";
import { getSentry, isSentryActive, type SentryNode } from "./sentry.ts";

// Derived rather than imported from @sentry/core, the same way sentry-ai.ts
// derives its span options type: @sentry/node is loaded lazily so vitest
// never pays the Node SDK tax, and a top-level type import here would undo
// that for one field.
type MonitorConfig = NonNullable<Parameters<NonNullable<ReturnType<typeof getSentry>>["captureCheckIn"]>[1]>;
type CheckIn = Parameters<NonNullable<ReturnType<typeof getSentry>>["captureCheckIn"]>[0];

/** `a b c` -> `a-b-c`, ASCII-lowercase, no leading/trailing/doubled hyphens. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable per-routine monitor slug.  Reads off the RUN's own routineId/
 *  routineName snapshot (present on every RoutineRun, not just the live
 *  Routine) so the start and finish check-in for the same run always
 *  compute the identical slug, even if the routine was renamed or deleted
 *  in between.  The id suffix keeps two routines named "Monitor" on two
 *  different bots from colliding on one Sentry monitor. */
export function routineMonitorSlug(run: Pick<RoutineRun, "routineId" | "routineName">): string {
  const name = slugify(run.routineName) || "routine";
  const shortId = run.routineId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "0";
  return `botfleet-${name}-${shortId}`.slice(0, 50);
}

/** The cron/interval config Sentry needs to know when a run is late or
 *  missed, computed from the routine's own recurrence — never hand-entered
 *  in the Sentry UI.  `undefined` for a one-off ("once") routine: nothing
 *  recurs for a Crons monitor to watch. */
export function routineMonitorConfig(routine: Pick<Routine, "schedule" | "durationMinutes">): MonitorConfig | undefined {
  if (routine.schedule.type !== "daily") return undefined;
  const [hourStr, minuteStr] = routine.schedule.time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  const days = [...new Set(routine.schedule.weekdays)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  // Every day (or an unset/invalid list — routines.ts's own cleanDays falls
  // back to every day) is the crontab wildcard; a subset is the explicit
  // cron day-of-week list, same 0=Sunday..6=Saturday convention routines.ts
  // already uses for `weekdays`.
  const dayField = days.length === 0 || days.length === 7 ? "*" : days.join(",");
  const timezone = routine.schedule.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    schedule: { type: "crontab", value: `${minute} ${hour} * * ${dayField}` },
    timezone,
    // A routine can run long (subagent chains, tool loops) — give it slack
    // before Sentry calls a late check-in missed, rather than paging on
    // every run that starts a few minutes into a busy bot's queue.
    checkinMargin: 30,
    maxRuntime: Math.max(routine.durationMinutes || 30, 60),
  };
}

/** Open a Sentry Crons check-in for a routine that just started running.
 *  Returns the check-in id to close later, or `undefined` when there is
 *  nothing to check in (Sentry is off, or this is a one-off routine).
 *  Never throws — a Sentry outage must not stop the bot's actual work. */
export function checkInRoutineStart(run: RoutineRun, routine: Routine): string | undefined {
  if (!isSentryActive()) return undefined;
  const sdk = getSentry();
  if (!sdk) return undefined;
  const monitorConfig = routineMonitorConfig(routine);
  if (!monitorConfig) return undefined;
  try {
    const checkInId = sdk.captureCheckIn(
      { monitorSlug: routineMonitorSlug(run), status: "in_progress" },
      monitorConfig,
    );
    // The SDK fabricates a uuid when the client is missing or closed; never
    // store that as a real Crons check-in id on the run record.
    if (!checkInId || !isSentryActive()) return undefined;
    return checkInId;
  } catch {
    return undefined;
  }
}

/** How long one `sdk.flush` may spend draining the transport before the close
 *  counts as undelivered.  Sentry's own swap budget for a client shutdown is
 *  the same order of magnitude, and the run this belongs to has already
 *  finished by then. */
const CHECK_IN_CLOSE_FLUSH_MS = 10_000;
/** Wait before retry 1, retry 2 and retry 3 of a close the transport never
 *  accepted.  Bounded: the longest a close is retried is 2m35s after the run
 *  ended, which is still inside the monitor's `checkinMargin`. */
const CHECK_IN_CLOSE_RETRY_BACKOFF_MS = [5_000, 30_000, 120_000] as const;

/** Detached close deliveries still waiting on a flush or a backoff.  The run
 *  never awaits this map; it exists so tests (and a future shutdown path)
 *  can settle the in-flight work deterministically. */
const pendingCheckInCloses = new Set<Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd: a routine finishing must not be what holds the harness open.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Did the transport actually take the close?  `false` from `sdk.flush` means
 *  the envelope was still buffered when the budget ran out — which is the
 *  exact state that leaves a monitor stuck `in_progress` until Sentry's cron
 *  monitor calls it an error.  An SDK with no `flush` has already handed the
 *  event over synchronously, so there is nothing to wait for. */
async function flushCheckInClose(sdk: SentryNode): Promise<boolean> {
  try {
    if (typeof sdk.flush !== "function") return true;
    return await sdk.flush(CHECK_IN_CLOSE_FLUSH_MS);
  } catch {
    return false;
  }
}

/** Confirm the close left the process, and re-send it while it has not.
 *
 *  `captureCheckIn` only enqueues: it returns before the envelope reaches
 *  Sentry, so on a saturated host (the failure this exists for was a run that
 *  finished while the box was at load 19-89 per core with 91-94% swap) the
 *  buffered event is simply dropped at process exit and the monitor stays
 *  `in_progress` until the cron check times it out as an error.  Re-sending
 *  the same `checkInId` is idempotent on Sentry's side, so a close that
 *  actually landed is harmless to repeat. */
async function deliverCheckInClose(sdk: SentryNode, checkIn: CheckIn, runId: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCheckInClose(sdk)) return;
    const backoff = CHECK_IN_CLOSE_RETRY_BACKOFF_MS[attempt];
    if (backoff === undefined) {
      console.warn(`[sentry-crons] check-in close failed slug=${checkIn.monitorSlug} run=${runId}`);
      return;
    }
    await sleep(backoff);
    try {
      sdk.captureCheckIn(checkIn);
    } catch {
      /* the flush below is the arbiter; a throw here is not the end of it */
    }
  }
}

/** Close a check-in `checkInRoutineStart` opened.  No-op if that call
 *  returned nothing (Sentry off, or a one-off routine never got a
 *  monitor).  Returns as soon as the close is queued — confirming it left
 *  the process is detached, so a slow or dead Sentry cannot delay or fail the
 *  run that just finished. */
export function checkInRoutineFinish(run: RoutineRun, checkInId: string, ok: boolean): void {
  if (!isSentryActive()) return;
  const sdk = getSentry();
  if (!sdk) return;
  const checkIn: CheckIn = {
    monitorSlug: routineMonitorSlug(run),
    status: ok ? "ok" : "error",
    checkInId,
  };
  try {
    sdk.captureCheckIn(checkIn);
  } catch {
    /* check-in reporting must never take down a run */
    return;
  }
  const delivery = deliverCheckInClose(sdk, checkIn, run.id);
  pendingCheckInCloses.add(delivery);
  void delivery.finally(() => pendingCheckInCloses.delete(delivery));
}

/** Resolves once every detached close has settled — after its final retry, or
 *  after the one log line that says it never left.  Never awaited on the
 *  run's completion path; tests use it instead of racing timers. */
export async function awaitPendingCheckInCloses(): Promise<void> {
  await Promise.all(pendingCheckInCloses);
}

/** Drop in-flight close deliveries so a failed test cannot stall the next
 *  `awaitPendingCheckInCloses()` under real timers. */
export function resetSentryCronsForTests(): void {
  pendingCheckInCloses.clear();
}
