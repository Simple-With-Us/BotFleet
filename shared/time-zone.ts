export const CENTRAL_TIME_ZONE = "America/Chicago";

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface ZonedDateTime extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  // Construction is also the platform's authoritative IANA-zone validation.
  formatter.format(0);
  partsFormatters.set(timeZone, formatter);
  return formatter;
}

export function canonicalTimeZone(timeZone: string): string | null {
  const trimmed = timeZone.trim();
  if (!trimmed) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    formatter.format(0);
    return formatter.resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function validTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) != null;
}

export function zonedDateTime(at: number, timeZone: string): ZonedDateTime {
  const values = Object.fromEntries(
    partsFormatter(timeZone).formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

export function calendarDate(at: number, timeZone: string): CalendarDate {
  const { year, month, day } = zonedDateTime(at, timeZone);
  return { year, month, day };
}

export function calendarWeekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function comparable(parts: ZonedDateTime): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(at: number, timeZone: string): number {
  const rounded = Math.floor(at / 1_000) * 1_000;
  return comparable(zonedDateTime(rounded, timeZone)) - rounded;
}

/** Resolve a wall-clock value in an IANA timezone.
 *
 * A repeated time chooses its first occurrence, matching JavaScript's local
 * Date constructor.  A nonexistent spring-forward time advances by the size
 * of the gap, so 02:30 becomes 03:30 instead of silently becoming 03:00. */
export function epochForZonedDateTime(parts: Omit<ZonedDateTime, "second"> & { second?: number }, timeZone: string): number {
  const requested: ZonedDateTime = { ...parts, second: parts.second ?? 0 };
  const daysInMonth = requested.month >= 1 && requested.month <= 12
    ? new Date(Date.UTC(requested.year, requested.month, 0)).getUTCDate()
    : 0;
  if (
    !Number.isInteger(requested.year) ||
    requested.day < 1 || requested.day > daysInMonth ||
    requested.hour < 0 || requested.hour > 23 ||
    requested.minute < 0 || requested.minute > 59 ||
    requested.second < 0 || requested.second > 59
  ) {
    throw new RangeError("Choose a valid date and time");
  }
  const naive = comparable(requested);
  const sampleHours = [-36, -24, -12, 0, 12, 24, 36];
  const offsets = new Set(sampleHours.map((hours) => offsetAt(naive + hours * 3_600_000, timeZone)));
  const candidates = [...offsets].map((offset) => naive - offset);
  const exact = candidates.filter((candidate) => comparable(zonedDateTime(candidate, timeZone)) === naive);
  if (exact.length > 0) return Math.min(...exact);

  const after = candidates
    .map((candidate) => ({ candidate, delta: comparable(zonedDateTime(candidate, timeZone)) - naive }))
    .filter(({ delta }) => delta > 0)
    .sort((a, b) => a.delta - b.delta || a.candidate - b.candidate);
  if (after.length > 0) return after[0].candidate;
  throw new RangeError(`Cannot resolve wall-clock time in ${timeZone}`);
}

export function startOfDayInTimeZone(at: number, timeZone: string): number {
  return epochForZonedDateTime({ ...calendarDate(at, timeZone), hour: 0, minute: 0 }, timeZone);
}

export function addDaysInTimeZone(at: number, days: number, timeZone: string): number {
  return epochForZonedDateTime({ ...addCalendarDays(calendarDate(at, timeZone), days), hour: 0, minute: 0 }, timeZone);
}

export function startOfWeekInTimeZone(at: number, timeZone: string): number {
  const date = calendarDate(at, timeZone);
  const mondayOffset = (calendarWeekday(date) + 6) % 7;
  return epochForZonedDateTime({ ...addCalendarDays(date, -mondayOffset), hour: 0, minute: 0 }, timeZone);
}

/** The next whole wall-clock hour in an IANA timezone.  Deriving the hour
 * from zoned parts keeps fractional-offset browser timezones out of defaults. */
export function nextWholeHourInTimeZone(after: number, timeZone: string): number {
  const current = zonedDateTime(after, timeZone);
  const nextDate = current.hour === 23
    ? addCalendarDays(current, 1)
    : current;
  return epochForZonedDateTime({
    ...nextDate,
    hour: (current.hour + 1) % 24,
    minute: 0,
    second: 0,
  }, timeZone);
}

export function epochAtWallTime(day: number, time: string, timeZone: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new RangeError("Time must use HH:MM");
  return epochForZonedDateTime({
    ...calendarDate(day, timeZone),
    hour: Number(match[1]),
    minute: Number(match[2]),
  }, timeZone);
}

export function nextZonedOccurrence(
  schedule: { time: string; weekdays: number[] },
  after: number,
  timeZone: string,
): number | null {
  const weekdays = new Set(schedule.weekdays);
  const start = calendarDate(after, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const date = addCalendarDays(start, offset);
    if (!weekdays.has(calendarWeekday(date))) continue;
    const candidate = epochAtWallTime(
      epochForZonedDateTime({ ...date, hour: 0, minute: 0 }, timeZone),
      schedule.time,
      timeZone,
    );
    if (candidate > after) return candidate;
  }
  return null;
}

export function inputDateTimeInTimeZone(at: number, timeZone: string): string {
  const parts = zonedDateTime(at, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function epochFromInputDateTime(value: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Choose a valid date and time");
  return epochForZonedDateTime({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }, timeZone);
}

export function shortTimeZoneName(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}
