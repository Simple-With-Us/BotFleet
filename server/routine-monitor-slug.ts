/** Sentry rejects a monitor slug longer than this. */
export const MONITOR_SLUG_MAX = 50;

/** `a b c` -> `a-b-c`, ASCII-lowercase, no leading/trailing/doubled hyphens. */
export function slugifyMonitorName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The slug formula upserted before monitor identity was frozen.
 *
 *  The display name is part of the slug, and the whole string is sliced to
 *  50 characters, so a long name drops the routine id and a rename (including
 *  writing a clock time into the title) mints a second monitor.  The previous
 *  monitor keeps its crontab and reports a missed check-in forever.  This
 *  formula stays so a monitor already watching it, and a run already opened
 *  under it, still close the same slug. */
export function legacyRoutineMonitorSlug(run: { routineId: string; routineName: string }): string {
  const name = slugifyMonitorName(run.routineName) || "routine";
  const shortId = run.routineId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "0";
  return `botfleet-${name}-${shortId}`.slice(0, MONITOR_SLUG_MAX);
}

/** One monitor per routine id.  The display name is not part of the slug,
 *  so a rename cannot mint a second monitor, and the id is never sliced off. */
export function stableRoutineMonitorSlug(routineId: string): string {
  const id = routineId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 32) || "0";
  return `botfleet-${id}`.slice(0, MONITOR_SLUG_MAX);
}

/** A slug this process is willing to send to Sentry.
 *
 *  A trailing hyphen is allowed on purpose.  The legacy formula slices the
 *  whole string to 50 characters, so a long routine name can end the slug on
 *  a hyphen, and that exact string is the monitor Sentry already holds.
 *  Rejecting it would leave that monitor on its daily crontab forever. */
export function isRoutineMonitorSlug(slug: string): boolean {
  return /^botfleet-[a-z0-9-]{1,41}$/.test(slug) && slug.length <= MONITOR_SLUG_MAX;
}

/** Slug for a check-in.  A slug stored on the run wins, so the start and the
 *  finish of that run stay on one monitor even if the routine is renamed
 *  while it is in flight.  A run that predates the stored slug falls back
 *  to the legacy formula, which is the monitor that run would have opened. */
export function routineMonitorSlug(run: {
  routineId: string;
  routineName: string;
  sentryMonitorSlug?: string;
}): string {
  const stored = run.sentryMonitorSlug?.trim().toLowerCase();
  if (stored && isRoutineMonitorSlug(stored)) return stored;
  return legacyRoutineMonitorSlug(run);
}

/** Crontab for a slug that is no longer a live schedule (renamed away,
 *  paused, or deleted).  Sentry has no disable field on a DSN check-in, so
 *  the slug is left expecting a single January 1 check-in instead of a
 *  daily one.  The next real firing of a resumed routine upserts its own
 *  schedule again. */
export const RETIRED_MONITOR_CRONTAB = "0 0 1 1 *";
