import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoutineSchedule } from "@/lib/routines";
import { scheduleFireDays } from "@/lib/routine-calendar";
import { calendarDate, calendarWeekday, addDaysInTimeZone } from "../../../shared/time-zone";
import { MiniMonth, monthGrid, shiftMonthInZone, startOfMonthInZone } from "./MiniMonth";

const ZONE = "America/Chicago";
const SEPTEMBER_INSTANT = Date.parse("2026-09-15T12:00:00.000Z");

describe("MiniMonth month-day computation", () => {
  it("builds a Monday-first 42-day grid whose first day is on/before the 1st and covers the whole month", () => {
    const monthStart = startOfMonthInZone(SEPTEMBER_INSTANT, ZONE);
    expect(calendarDate(monthStart, ZONE)).toEqual({ year: 2026, month: 9, day: 1 });

    const days = monthGrid(monthStart, ZONE);
    expect(days).toHaveLength(42);
    // Monday-first: the grid's own first day is a Monday, and the month's
    // actual first day is one of the 42 cells.
    expect(calendarWeekday(calendarDate(days[0], ZONE))).toBe(1);
    expect(days).toContain(monthStart);
    // Every cell is exactly one zoned day after the previous — no gaps, no
    // repeats, regardless of DST inside the grid's span.
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBe(addDaysInTimeZone(days[i - 1], 1, ZONE));
    }
  });

  it("highlights only the grid days a weekly schedule actually fires on, including spillover from adjacent months", () => {
    const monthStart = startOfMonthInZone(SEPTEMBER_INSTANT, ZONE);
    const days = monthGrid(monthStart, ZONE);
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [1], timeZone: ZONE }; // Mondays
    const highlighted = scheduleFireDays(schedule, ZONE, days[0], addDaysInTimeZone(days[days.length - 1], 1, ZONE));

    expect(highlighted.size).toBeGreaterThan(0);
    for (const day of highlighted) {
      expect(days).toContain(day); // every highlighted day is actually in the visible grid
      expect(calendarWeekday(calendarDate(day, ZONE))).toBe(1); // and it is a Monday
    }
  });

  it("marks a one-shot schedule's single day, wherever it falls in the grid", () => {
    const monthStart = startOfMonthInZone(SEPTEMBER_INSTANT, ZONE);
    const days = monthGrid(monthStart, ZONE);
    const at = Date.parse("2026-09-14T14:00:00.000Z"); // Sep 14, 9am Central
    const schedule: RoutineSchedule = { type: "once", at };
    const highlighted = scheduleFireDays(schedule, ZONE, days[0], addDaysInTimeZone(days[days.length - 1], 1, ZONE));
    expect(highlighted.size).toBe(1);
    expect(days).toContain([...highlighted][0]);
  });
});

describe("MiniMonth month navigation", () => {
  it("rolls the year forward from December and back from January instead of throwing", () => {
    const december = startOfMonthInZone(Date.parse("2026-12-15T18:00:00.000Z"), ZONE);
    expect(calendarDate(shiftMonthInZone(december, 1, ZONE), ZONE)).toEqual({ year: 2027, month: 1, day: 1 });

    const january = startOfMonthInZone(Date.parse("2027-01-15T18:00:00.000Z"), ZONE);
    expect(calendarDate(shiftMonthInZone(january, -1, ZONE), ZONE)).toEqual({ year: 2026, month: 12, day: 1 });
  });

  it("lands on the 1st of each month across a full year in both directions", () => {
    let forward = startOfMonthInZone(SEPTEMBER_INSTANT, ZONE);
    let backward = forward;
    for (let step = 1; step <= 14; step++) {
      forward = shiftMonthInZone(forward, 1, ZONE);
      backward = shiftMonthInZone(backward, -1, ZONE);
      expect(calendarDate(forward, ZONE).day).toBe(1);
      expect(calendarDate(backward, ZONE).day).toBe(1);
    }
    expect(calendarDate(forward, ZONE)).toEqual({ year: 2027, month: 11, day: 1 });
    expect(calendarDate(backward, ZONE)).toEqual({ year: 2025, month: 7, day: 1 });
  });
});

describe("MiniMonth", () => {
  it("renders the month label and nav without crashing, for a daily schedule", () => {
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [1, 3, 5], timeZone: ZONE };
    const html = renderToStaticMarkup(
      createElement(MiniMonth, { anchor: SEPTEMBER_INSTANT, schedule, timeZone: ZONE }),
    );
    expect(html).toContain("September 2026");
    expect(html).toContain("Previous month");
    expect(html).toContain("Next month");
    expect(html).toContain("routine runs");
  });

  it("renders with an empty weekday schedule (no highlighted day) without crashing", () => {
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [], timeZone: ZONE };
    const html = renderToStaticMarkup(
      createElement(MiniMonth, { anchor: SEPTEMBER_INSTANT, schedule, timeZone: ZONE }),
    );
    expect(html).toContain("September 2026");
    expect(html).not.toContain("routine runs");
  });
});
