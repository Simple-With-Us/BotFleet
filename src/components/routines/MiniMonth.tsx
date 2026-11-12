import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { RoutineSchedule } from "@/lib/routines";
import { scheduleFireDays } from "@/lib/routine-calendar";
import {
  addDaysInTimeZone,
  calendarDate,
  calendarWeekday,
  epochForZonedDateTime,
  startOfDayInTimeZone,
} from "../../../shared/time-zone";

const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const GRID_DAYS = 42;

/** Start of the zoned calendar month `at` falls in. */
export function startOfMonthInZone(at: number, timeZone: string): number {
  const { year, month } = calendarDate(at, timeZone);
  return epochForZonedDateTime({ year, month, day: 1, hour: 0, minute: 0 }, timeZone);
}

/** Start of the zoned calendar month `offset` months away from the one
 * `monthStart` falls in.  The year rolls over in both directions, so
 * December + 1 is next January and January - 1 is last December — never
 * month 13 or 0, which `epochForZonedDateTime` rejects with a RangeError. */
export function shiftMonthInZone(monthStart: number, offset: number, timeZone: string): number {
  const { year, month } = calendarDate(monthStart, timeZone);
  const monthIndex = year * 12 + (month - 1) + offset;
  const nextYear = Math.floor(monthIndex / 12);
  const nextMonth = monthIndex - nextYear * 12 + 1;
  return epochForZonedDateTime({ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0 }, timeZone);
}

/** The Monday-first 42-day grid (6 full weeks) covering `monthStart`'s
 * month, expressed as start-of-zoned-day epochs so every cell lines up
 * exactly with what `scheduleFireDays`/`nextZonedOccurrence` compute. */
export function monthGrid(monthStart: number, timeZone: string): number[] {
  const mondayOffset = (calendarWeekday(calendarDate(monthStart, timeZone)) + 6) % 7;
  const gridStart = addDaysInTimeZone(monthStart, -mondayOffset, timeZone);
  return Array.from({ length: GRID_DAYS }, (_, index) => addDaysInTimeZone(gridStart, index, timeZone));
}

export interface MiniMonthProps {
  /** Any instant in the month to open on; further nav is local state. */
  anchor: number;
  /** The routine schedule being previewed. */
  schedule: RoutineSchedule;
  /** The schedule's own zone (Central Time by default — see CENTRAL_TIME_ZONE). */
  timeZone: string;
}

/** A compact, Monday-first month preview for a routine's schedule.
 *
 * Ported from upstream's calendar-sidebar date picker
 * (`src/components/routines/MiniMonth.tsx`) and adapted from a PICKER into
 * a read-only PREVIEW: no `onSelect`, no single "selected" day — every day
 * the schedule fires lights up instead. The grid is built in the
 * schedule's own IANA zone (`shared/time-zone.ts`) rather than the
 * browser's local time, matching every other date this page shows
 * (`routine-calendar.ts`'s `niceCalendarDate`/`niceCalendarTime` do the
 * same) and keeping a highlighted cell exactly in step with
 * `nextZonedOccurrence`, the function that actually schedules the run —
 * never exposing that function's cron-like inputs directly (RoutinesPage
 * deliberately has "No cron syntax required"). */
export function MiniMonth({ anchor, schedule, timeZone }: MiniMonthProps) {
  const [visibleMonthStart, setVisibleMonthStart] = useState(() => startOfMonthInZone(anchor, timeZone));

  useEffect(() => {
    setVisibleMonthStart(startOfMonthInZone(anchor, timeZone));
  }, [anchor, timeZone]);

  const days = useMemo(() => monthGrid(visibleMonthStart, timeZone), [visibleMonthStart, timeZone]);
  const highlighted = useMemo(
    () => scheduleFireDays(schedule, timeZone, days[0], addDaysInTimeZone(days[days.length - 1], 1, timeZone)),
    [schedule, timeZone, days],
  );
  const today = startOfDayInTimeZone(Date.now(), timeZone);
  const visibleMonth = calendarDate(visibleMonthStart, timeZone).month;
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone }).format(
    visibleMonthStart,
  );

  const moveMonth = (offset: number) =>
    setVisibleMonthStart((current) => shiftMonthInZone(current, offset, timeZone));

  return (
    <section aria-label="Schedule preview" className="select-none px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="text-[12.5px] font-semibold text-ink">{monthLabel}</div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => moveMonth(-1)}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Previous month"
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => moveMonth(1)}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Next month"
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAY_LABELS.map((label, index) => (
          <div
            key={`${label}-${index}`}
            className="flex h-6 items-center justify-center text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-secondary/75"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {days.map((day) => {
          const { day: dayOfMonth, month: cellMonth } = calendarDate(day, timeZone);
          const isHighlighted = highlighted.has(day);
          const isToday = day === today;
          const isOutsideMonth = cellMonth !== visibleMonth;
          const label = new Intl.DateTimeFormat(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone,
          }).format(day);

          return (
            <div key={day} className="flex h-7 items-center justify-center" title={isHighlighted ? `${label} — routine runs` : label}>
              <span
                aria-label={isHighlighted ? `${label}, routine runs` : label}
                className={`flex size-6 items-center justify-center rounded-full text-[10.5px] transition-colors ${
                  isHighlighted
                    ? "bg-accent font-semibold text-white shadow-sm"
                    : isToday
                      ? "font-semibold text-accent ring-1 ring-inset ring-accent/40"
                      : isOutsideMonth
                        ? "text-ink-secondary/35"
                        : "text-ink-secondary"
                }`}
              >
                {dayOfMonth}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
