import type { Routine, RoutineRun, RoutineSchedule } from "./routines";
import {
  CENTRAL_TIME_ZONE,
  calendarDate,
  calendarWeekday,
  nextZonedOccurrence,
  shortTimeZoneName,
  startOfDayInTimeZone,
  zonedDateTime,
} from "../../shared/time-zone";

export { CENTRAL_TIME_ZONE };

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type CalendarItem = {
  id: string;
  at: number;
  routine: Routine | null;
  run: RoutineRun | null;
};

export function niceCalendarDate(at: number, includeWeekday = true): string {
  const nowYear = calendarDate(Date.now(), CENTRAL_TIME_ZONE).year;
  const atYear = calendarDate(at, CENTRAL_TIME_ZONE).year;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: CENTRAL_TIME_ZONE,
    weekday: includeWeekday ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: atYear !== nowYear ? "numeric" : undefined,
  }).format(at);
}

export function niceCalendarTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: CENTRAL_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

export function nextCalendarRunLabel(at: number | null, now = Date.now()): string {
  if (at == null) return "Paused";
  const sameDay = startOfDayInTimeZone(at, CENTRAL_TIME_ZONE) === startOfDayInTimeZone(now, CENTRAL_TIME_ZONE);
  const date = sameDay ? "Today" : niceCalendarDate(at, false);
  return `${date}, ${niceCalendarTime(at)} ${shortTimeZoneName(at, CENTRAL_TIME_ZONE)}`;
}

export function calendarMinuteOfDay(at: number): number {
  const parts = zonedDateTime(at, CENTRAL_TIME_ZONE);
  return parts.hour * 60 + parts.minute;
}

export function scheduleTimeZone(routine: Routine): string {
  return routine.schedule.type === "daily"
    ? routine.schedule.timeZone ?? CENTRAL_TIME_ZONE
    : CENTRAL_TIME_ZONE;
}

export function editedDailySchedule(
  routine: Routine | undefined,
  time: string,
  weekdays: number[],
  timeZone: string,
): RoutineSchedule {
  return {
    type: "daily",
    time,
    weekdays,
    ...(routine?.scheduleTimeZoneSource === "host" ? {} : { timeZone }),
  };
}

export function timeZoneLabel(timeZone: string, at = Date.now()): string {
  const short = shortTimeZoneName(at, timeZone);
  return timeZone === CENTRAL_TIME_ZONE ? `Central Time (${short})` : `${timeZone} (${short})`;
}

function wallTimeLabel(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(Date.UTC(2000, 0, 1, hour, minute));
}

export function routineScheduleLabel(routine: Routine): string {
  if (routine.schedule.type === "once") {
    return `${niceCalendarDate(routine.schedule.at)}, ${niceCalendarTime(routine.schedule.at)} ${shortTimeZoneName(routine.schedule.at, CENTRAL_TIME_ZONE)}`;
  }
  const days = routine.schedule.weekdays;
  const dayLabel = days.length === 7
    ? "Every day"
    : days.join(",") === "1,2,3,4,5"
      ? "Weekdays"
      : days.map((day) => DAY_NAMES[day]).join(", ");
  const zone = scheduleTimeZone(routine);
  return `${dayLabel} at ${wallTimeLabel(routine.schedule.time)} ${shortTimeZoneName(routine.nextRunAt ?? Date.now(), zone)}`;
}

export function projectedRoutineItems(
  routines: Routine[],
  runs: RoutineRun[],
  from: number,
  to: number,
): CalendarItem[] {
  const items: CalendarItem[] = runs
    .filter((run) => run.scheduledFor >= from && run.scheduledFor < to)
    .map((run) => ({
      id: `run-${run.id}`,
      at: run.scheduledFor,
      routine: routines.find((routine) => routine.id === run.routineId) ?? null,
      run,
    }));

  const hasReceipt = (routineId: string, at: number) =>
    runs.some((run) => run.routineId === routineId && Math.abs(run.scheduledFor - at) < 60_000);

  for (const routine of routines) {
    if (!routine.enabled) continue;
    if (routine.schedule.type === "once") {
      const at = routine.schedule.at;
      if (at >= from && at < to && !hasReceipt(routine.id, at)) {
        items.push({ id: `next-${routine.id}-${at}`, at, routine, run: null });
      }
      continue;
    }

    const zone = scheduleTimeZone(routine);
    let cursor = from - 1;
    for (;;) {
      const at = nextZonedOccurrence(routine.schedule, cursor, zone);
      if (at === null || at >= to) break;
      if (at >= routine.createdAt && !hasReceipt(routine.id, at)) {
        items.push({ id: `next-${routine.id}-${at}`, at, routine, run: null });
      }
      cursor = at;
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

export function calendarDayLabel(at: number): { weekday: string; day: number } {
  const date = calendarDate(at, CENTRAL_TIME_ZONE);
  return { weekday: DAY_NAMES[calendarWeekday(date)], day: date.day };
}

/** Start-of-day epochs (in `timeZone`) that `schedule` fires on within
 * [from, to) — the same occurrence enumeration `projectedRoutineItems`
 * uses, without the run-receipt/routine-list bookkeeping, for a
 * lightweight calendar preview (MiniMonth) to highlight. */
export function scheduleFireDays(schedule: RoutineSchedule, timeZone: string, from: number, to: number): Set<number> {
  const days = new Set<number>();
  if (schedule.type === "once") {
    if (schedule.at >= from && schedule.at < to) days.add(startOfDayInTimeZone(schedule.at, timeZone));
    return days;
  }
  let cursor = from - 1;
  for (;;) {
    const at = nextZonedOccurrence(schedule, cursor, timeZone);
    if (at === null || at >= to) break;
    days.add(startOfDayInTimeZone(at, timeZone));
    cursor = at;
  }
  return days;
}
