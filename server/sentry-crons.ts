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
import {
  RETIRED_MONITOR_CRONTAB,
  isRoutineMonitorSlug,
  routineMonitorSlug,
} from "./routine-monitor-slug.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import { getSentry, isSentryActive, type SentryNode } from "./sentry.ts";

export {
  RETIRED_MONITOR_CRONTAB,
  isRoutineMonitorSlug,
  legacyRoutineMonitorSlug,
  routineMonitorSlug,
  stableRoutineMonitorSlug,
} from "./routine-monitor-slug.ts";

// Derived rather than imported from @sentry/core, the same way sentry-ai.ts
// derives its span options type: @sentry/node is loaded lazily so vitest
// never pays the Node SDK tax, and a top-level type import here would undo
// that for one field.
type MonitorConfig = NonNullable<Parameters<NonNullable<ReturnType<typeof getSentry>>["captureCheckIn"]>[1]>;
type CheckIn = Parameters<NonNullable<ReturnType<typeof getSentry>>["captureCheckIn"]>[0];

interface SentryEnvelopeItemPayload {
  check_in_id?: string;
  checkInId?: string;
}

interface SentryEnvelopeItemHeader {
  type?: string;
}

type SentryEnvelopeItem = [SentryEnvelopeItemHeader, SentryEnvelopeItemPayload];

interface SentryEnvelopeHeader {
  event_id?: string;
}

type SentryEnvelope = [SentryEnvelopeHeader, SentryEnvelopeItem[]];

interface SentryClientWithEvents {
  on: (event: string, cb: (envelope: SentryEnvelope) => void) => () => void;
}

/** Slugs currently retired by this process.  A slug leaves the set again
 *  when a real check-in opens on it (checkInRoutineStart), so a routine that
 *  is resumed, runs, and is paused again is retired a second time. */
const releasedMonitorSlugs = new Set<string>();

/** Tell Sentry a slug is no longer a live schedule.
 *
 *  A renamed, paused, or deleted routine used to leave its old monitor on
 *  the previous crontab, and that monitor then reported a missed check-in
 *  every day for a job that no longer runs under that name.  The DSN
 *  check-in API cannot disable a monitor, so the slug is upserted onto a
 *  once-a-year crontab and closed `ok`.  That `ok` means "this slug is
 *  retired", not "today's job succeeded".  A resumed routine's next real
 *  firing upserts its own schedule onto the same slug.  Never throws. */
export function releaseRoutineMonitor(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  if (!isRoutineMonitorSlug(normalized) || releasedMonitorSlugs.has(normalized)) return false;
  if (!isSentryActive()) return false;
  const sdk = getSentry();
  if (!sdk) return false;
  releasedMonitorSlugs.add(normalized);
  try {
    sdk.captureCheckIn(
      { monitorSlug: normalized, status: "ok" },
      {
        schedule: { type: "crontab", value: RETIRED_MONITOR_CRONTAB },
        timezone: "UTC",
        checkinMargin: 1440,
        maxRuntime: 1,
      },
    );
  } catch {
    releasedMonitorSlugs.delete(normalized);
    return false;
  }
  return true;
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
    const monitorSlug = routineMonitorSlug(run);
    const checkInId = sdk.captureCheckIn(
      { monitorSlug, status: "in_progress" },
      monitorConfig,
    );
    // The check-in just upserted this routine's live schedule onto the slug,
    // so an earlier retirement no longer holds and a later pause or delete
    // must be allowed to retire it again.  Only the routine's frozen slug is
    // cleared: a run slug that differs from it names an obsolete monitor
    // that must stay retired.
    if (monitorSlug === routine.sentryMonitorSlug) releasedMonitorSlugs.delete(monitorSlug);
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

export type CheckInCloseSettledCallback = (delivered: boolean) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd: a routine finishing must not be what holds the harness open.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function matchesCheckInEnvelope(envelope: SentryEnvelope, checkInId: string): boolean {
  if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return false;
  for (const item of envelope[1]) {
    if (Array.isArray(item) && item[1] instanceof Object) {
      // SAFETY: item[1] is a verified Object within the envelope items list.
      const payload = item[1] as SentryEnvelopeItemPayload;
      if (payload.check_in_id === checkInId || payload.checkInId === checkInId) {
        return true;
      }
    }
  }
  return false;
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

/** Confirm the close was accepted by Sentry, and re-send it while it has not.
 *
 *  `captureCheckIn` only enqueues: it returns before the envelope reaches
 *  Sentry.  `sdk.flush()` alone only confirms that internal queue promises
 *  settled; if the transport encountered a network drop or rejected the
 *  send, the envelope is lost while flush still returns true.  We therefore
 *  hook the client's `afterEnvelope` event (when available) to confirm that
 *  the envelope containing this check-in was actually accepted by the
 *  transport.
 *
 *  Re-sending the same `checkInId` is idempotent on Sentry's side, so a close
 *  that actually landed is harmless to repeat. */
async function deliverCheckInClose(
  sdk: SentryNode,
  checkIn: CheckIn,
  runId: string,
  onSettled?: CheckInCloseSettledCallback,
  initialAttempt?: { state: { confirmed: boolean }; unhook?: () => void },
): Promise<void> {
  const targetId = "checkInId" in checkIn ? checkIn.checkInId : undefined;

  for (let attempt = 0; ; attempt += 1) {
    let delivered = false;
    if (attempt === 0 && initialAttempt) {
      const flushed = await flushCheckInClose(sdk);
      initialAttempt.unhook?.();
      delivered = initialAttempt.unhook !== undefined ? (initialAttempt.state.confirmed && flushed) : flushed;
    } else {
      const attemptState = { confirmed: false };
      let unhook: (() => void) | undefined;
      try {
        const client = "getClient" in sdk && sdk.getClient ? sdk.getClient() : undefined;
        if (client && "on" in client && Boolean(client.on) && targetId) {
          // SAFETY: client.on is a verified event-subscription method on the Sentry client.
          unhook = (client as SentryClientWithEvents).on(
            "afterEnvelope",
            (envelope: SentryEnvelope) => {
              if (matchesCheckInEnvelope(envelope, targetId)) {
                attemptState.confirmed = true;
              }
            },
          );
        }
      } catch {
        /* fallback to flush if client hooking throws */
      }

      try {
        sdk.captureCheckIn(checkIn);
      } catch {
        /* the flush below is the arbiter; a throw here is not the end of it */
      }

      const flushed = await flushCheckInClose(sdk);
      unhook?.();
      delivered = unhook !== undefined ? (attemptState.confirmed && flushed) : flushed;
    }

    if (delivered) {
      onSettled?.(true);
      return;
    }

    const backoff = CHECK_IN_CLOSE_RETRY_BACKOFF_MS[attempt];
    if (backoff === undefined) {
      console.warn(`[sentry-crons] check-in close failed slug=${checkIn.monitorSlug} run=${runId}`);
      onSettled?.(false);
      return;
    }
    await sleep(backoff);
  }
}

/** Close a check-in `checkInRoutineStart` opened.  No-op if that call
 *  returned nothing (Sentry off, or a one-off routine never got a
 *  monitor).  Returns as soon as the close is queued — confirming it left
 *  the process is detached, so a slow or dead Sentry cannot delay or fail the
 *  run that just finished. */
export function checkInRoutineFinish(
  run: RoutineRun,
  checkInId: string,
  ok: boolean,
  onSettled?: CheckInCloseSettledCallback,
): void {
  if (!isSentryActive()) {
    onSettled?.(false);
    return;
  }
  const sdk = getSentry();
  if (!sdk) {
    onSettled?.(false);
    return;
  }
  const duration =
    run.finishedAt && run.startedAt && run.finishedAt >= run.startedAt
      ? Math.round((run.finishedAt - run.startedAt) / 1000)
      : undefined;
  const checkIn: CheckIn = {
    monitorSlug: routineMonitorSlug(run),
    status: ok ? "ok" : "error",
    checkInId,
  };
  if (duration !== undefined) {
    checkIn.duration = duration;
  }

  const initialAttemptState = { confirmed: false };
  let unhook: (() => void) | undefined;
  try {
    const client = "getClient" in sdk && sdk.getClient ? sdk.getClient() : undefined;
    if (client && "on" in client && Boolean(client.on)) {
      // SAFETY: client.on is a verified event-subscription method on the Sentry client.
      unhook = (client as SentryClientWithEvents).on(
        "afterEnvelope",
        (envelope: SentryEnvelope) => {
          if (matchesCheckInEnvelope(envelope, checkInId)) {
            initialAttemptState.confirmed = true;
          }
        },
      );
    }
  } catch {
    /* fallback to flush if client hooking throws */
  }

  try {
    sdk.captureCheckIn(checkIn);
  } catch {
    /* check-in reporting must never take down a run; fall through so deliverCheckInClose retries */
  }
  const delivery = deliverCheckInClose(sdk, checkIn, run.id, onSettled, { state: initialAttemptState, unhook });
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
  releasedMonitorSlugs.clear();
}
