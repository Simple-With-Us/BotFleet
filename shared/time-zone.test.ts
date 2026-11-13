import { describe, expect, it } from "vitest";

import {
  CENTRAL_TIME_ZONE,
  canonicalTimeZone,
  addDaysInTimeZone,
  calendarDate,
  epochForZonedDateTime,
  epochFromInputDateTime,
  inputDateTimeInTimeZone,
  nextWholeHourInTimeZone,
  nextZonedOccurrence,
  startOfDayInTimeZone,
  startOfWeekInTimeZone,
  zonedDateTime,
} from "./time-zone";

describe("canonicalTimeZone", () => {
  it("persists the IANA spelling iOS TimeZone(identifier:) accepts", () => {
    expect(canonicalTimeZone("america/chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
  });
});

describe("IANA wall-clock conversion", () => {
  it("keeps Central calendar dates stable across a UTC and local-midnight boundary", () => {
    const lateSaturday = Date.parse("2026-09-13T04:30:00.000Z");
    expect(calendarDate(lateSaturday, CENTRAL_TIME_ZONE)).toEqual({ year: 2026, month: 9, day: 12 });
    expect(startOfDayInTimeZone(lateSaturday, CENTRAL_TIME_ZONE)).toBe(Date.parse("2026-09-12T05:00:00.000Z"));
    expect(startOfWeekInTimeZone(lateSaturday, CENTRAL_TIME_ZONE)).toBe(Date.parse("2026-09-07T05:00:00.000Z"));
    expect(addDaysInTimeZone(startOfDayInTimeZone(lateSaturday, CENTRAL_TIME_ZONE), 1, CENTRAL_TIME_ZONE))
      .toBe(Date.parse("2026-09-13T05:00:00.000Z"));
  });

  it("normalizes a spring gap and chooses the first occurrence of a fall fold", () => {
    const gap = epochForZonedDateTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, CENTRAL_TIME_ZONE);
    expect(gap).toBe(Date.parse("2026-03-08T08:30:00.000Z"));
    expect(zonedDateTime(gap, CENTRAL_TIME_ZONE)).toMatchObject({ hour: 3, minute: 30 });

    const fold = epochForZonedDateTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, CENTRAL_TIME_ZONE);
    expect(fold).toBe(Date.parse("2026-11-01T06:30:00.000Z"));
    expect(zonedDateTime(fold, CENTRAL_TIME_ZONE)).toMatchObject({ hour: 1, minute: 30 });
  });

  it("round-trips a datetime-local value in Central Time without using the browser zone", () => {
    const at = Date.parse("2026-12-05T21:45:00.000Z");
    const input = inputDateTimeInTimeZone(at, CENTRAL_TIME_ZONE);
    expect(input).toBe("2026-12-05T15:45");
    expect(epochFromInputDateTime(input, CENTRAL_TIME_ZONE)).toBe(at);
    expect(() => epochFromInputDateTime("2026-02-30T09:00", CENTRAL_TIME_ZONE))
      .toThrow("Choose a valid date and time");
  });

  it("rounds a new one-time default in Central rather than a fractional-offset browser zone", () => {
    // 19:00 in Kolkata is 08:30 in Chicago.  The next Central wall-clock hour
    // must be 09:00, never the browser-rounded 08:30.
    const now = Date.parse("2026-09-12T13:30:37.123Z");
    const next = nextWholeHourInTimeZone(now, CENTRAL_TIME_ZONE);
    expect(inputDateTimeInTimeZone(next, CENTRAL_TIME_ZONE)).toBe("2026-09-12T09:00");
    expect(next).toBe(Date.parse("2026-09-12T14:00:00.000Z"));
  });
});

describe("nextZonedOccurrence", () => {
  it("uses the recurrence timezone across DST while keeping the saved wall-clock time", () => {
    const afterGapEve = Date.parse("2026-03-08T06:00:00.000Z");
    expect(nextZonedOccurrence({ time: "02:30", weekdays: [0] }, afterGapEve, CENTRAL_TIME_ZONE))
      .toBe(Date.parse("2026-03-08T08:30:00.000Z"));

    const afterFoldEve = Date.parse("2026-11-01T05:00:00.000Z");
    expect(nextZonedOccurrence({ time: "01:30", weekdays: [0] }, afterFoldEve, CENTRAL_TIME_ZONE))
      .toBe(Date.parse("2026-11-01T06:30:00.000Z"));
  });
});
