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
import { getSentry, isSentryActive } from "./sentry.ts";

// Derived rather than imported from @sentry/core, the same way sentry-ai.ts
// derives its span options type: @sentry/node is loaded lazily so vitest
// never pays the Node SDK tax, and a top-level type import here would undo
// that for one field.
type MonitorConfig = NonNullable<Parameters<NonNullable<ReturnType<typeof getSentry>>["captureCheckIn"]>[1]>;

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
    return sdk.captureCheckIn({ monitorSlug: routineMonitorSlug(run), status: "in_progress" }, monitorConfig);
  } catch {
    return undefined;
  }
}

/** Close a check-in `checkInRoutineStart` opened.  No-op if that call
 *  returned nothing (Sentry off, or a one-off routine never got a
 *  monitor). */
export function checkInRoutineFinish(run: RoutineRun, checkInId: string, ok: boolean): void {
  if (!isSentryActive()) return;
  const sdk = getSentry();
  if (!sdk) return;
  try {
    sdk.captureCheckIn({
      monitorSlug: routineMonitorSlug(run),
      status: ok ? "ok" : "error",
      checkInId,
    });
  } catch {
    /* check-in reporting must never take down a run */
  }
}
