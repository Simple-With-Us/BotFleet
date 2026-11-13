import { normalizeRunOn } from "../../shared/run-on.ts";
// Routine-schedule normalisation, shared by both lanes.
//
// Before this file, this logic lived once, inside `agents-proxy.ts`'s
// `normalizeScheduleInput` — reachable from the MCP lane only, because that
// is the only lane `propose_routine` and `propose_routine_action` existed
// on.  Now that PR 7 gives both tools a registry entry, the coercion has to
// run identically wherever the model's arguments land: over the MCP hop, or
// in-process through the turn tool host.  Moved here, verbatim in behaviour,
// so a fix or a new accepted shape lands once.
//
// Coercion first, error second: models routinely stringify nested objects,
// say "daily", or shorten weekday names, and each of those has one obvious
// meaning.
//
// Zero imports, like `registry.ts`: `agents-proxy.ts` loads this inside a
// bare child process before the harness exists.

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const SHORT_WEEKDAYS = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
} as const satisfies Record<string, Weekday>;

export const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, or {"type":"daily","time":"09:00"} for every day.';

/** The outcome of coercing a model-sent schedule: the harness-dialect
 * schedule, or a message telling the model exactly what to send instead. */
export interface NormalizedSchedule {
  schedule?: Record<string, unknown>;
  error?: string;
}

type Json = Record<string, unknown>;

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A schedule as the harness accepts it, or a message telling the model
 * exactly what to send instead.  Reads `args.schedule` — the whole tool
 * call's arguments, not just the schedule value — because a model that
 * stringified the WHOLE object needs the same "must be a JSON object"
 * message a model that omitted `schedule` entirely gets. */
export function normalizeScheduleInput(args: { schedule?: unknown }): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
    // Some models deliver nested objects as JSON strings.
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (!jsonRecord(raw)) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type === "once") {
    if (typeof raw.at !== "string" || !raw.at.trim()) {
      return {
        error:
          'A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.',
      };
    }
    return { schedule: { type: "once", at: raw.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = typeof raw.time === "string" ? raw.time.trim() : "";
    const timeZone = typeof raw.timeZone === "string" ? raw.timeZone.trim() : "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: unknown[];
    if (type === "daily") {
      // daily = weekly on all seven days; an explicit weekdays list narrows it.
      weekdays = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [...WEEKDAYS];
    } else {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return {
          error: `A weekly schedule needs "weekdays", for example ["monday","friday"] — or use {"type":"daily"} to run every day.`,
        };
      }
      weekdays = raw.weekdays;
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = (WEEKDAYS as readonly string[]).includes(lower)
        ? lower
        : Object.hasOwn(SHORT_WEEKDAYS, lower)
          ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
          : undefined;
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    return {
      schedule: {
        type: "weekly",
        time,
        weekdays: normalized,
        ...(timeZone ? { timeZone } : {}),
      },
    };
  }
  if (type === "interval" || type === "cron" || type === "hourly" || type === "minutes") {
    return {
      error: `Routines cannot run on sub-day intervals. ${SUPPORTED_SCHEDULES} Pick the closest daily or weekly time and tell the user about this limit.`,
    };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

/** The routine-field coercion `propose_routine` and `propose_routine_action`
 * (its `changes`) both need: trim the text fields, normalise `schedule`
 * through the function above, and rename the wire's `run_on` /
 * `duration_minutes` to the harness's `runOn` / `durationMinutes`.  One
 * function so the two tools — and the two lanes — cannot drift on it. */
export function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
  if (typeof args.name === "string") fields.name = args.name.trim();
  if (typeof args.instructions === "string") fields.instructions = args.instructions.trim();
  if (args.schedule !== undefined && args.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    fields.schedule = normalized.schedule;
  }
  if (typeof args.run_on === "string") fields.runOn = normalizeRunOn(args.run_on);
  if (typeof args.duration_minutes === "number") fields.durationMinutes = args.duration_minutes;
  return { fields };
}
