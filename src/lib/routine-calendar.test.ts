import { describe, expect, it } from "vitest";

import type { Routine } from "./routines";
import {
  calendarDayLabel,
  calendarMinuteOfDay,
  editedDailySchedule,
  nextCalendarRunLabel,
  projectedRoutineItems,
  routineScheduleLabel,
  scheduleFireDays,
  timeZoneLabel,
} from "./routine-calendar";
import { startOfDayInTimeZone } from "../../shared/time-zone";

function routine(schedule: Routine["schedule"]): Routine {
  return {
    id: "routine",
    name: "Fixture",
    prompt: "Check",
    botId: "bot",
    runOn: "bot",
    enabled: true,
    schedule,
    durationMinutes: 30,
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("routine calendar timezone", () => {
  it("places an explicit recurrence by its own weekday and the resulting Central instant", () => {
    const from = Date.parse("2026-09-13T05:00:00.000Z");
    const to = Date.parse("2026-09-14T05:00:00.000Z");
    const items = projectedRoutineItems([
      routine({ type: "daily", time: "00:30", weekdays: [1], timeZone: "Asia/Tokyo" }),
    ], [], from, to);

    expect(items.map((item) => item.at)).toEqual([Date.parse("2026-09-13T15:30:00.000Z")]);
    expect(calendarDayLabel(items[0].at)).toEqual({ weekday: "Sun", day: 13 });
    expect(calendarMinuteOfDay(items[0].at)).toBe(10 * 60 + 30);
  });

  it("does not project a second card when a run receipt already owns the occurrence", () => {
    const scheduledFor = Date.parse("2026-09-14T14:00:00.000Z");
    const definition = routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "America/Chicago" });
    const runs = [{
      id: "run",
      routineId: definition.id,
      routineName: definition.name,
      botId: definition.botId,
      runOn: definition.runOn,
      scheduledFor,
      status: "completed" as const,
      manual: false,
      createdAt: scheduledFor,
    }];
    const items = projectedRoutineItems([definition], runs, Date.parse("2026-09-14T05:00:00.000Z"), Date.parse("2026-09-15T05:00:00.000Z"));
    expect(items.map((item) => item.id)).toEqual(["run-run"]);
  });

  it("names both the Central calendar policy and a preserved legacy host zone", () => {
    expect(timeZoneLabel("America/Chicago", Date.parse("2026-07-01T12:00:00Z"))).toBe("Central Time (CDT)");
    const legacy = routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "Europe/Athens" });
    expect(routineScheduleLabel(legacy)).toMatch(/^Mon at 9:00 AM (GMT\+3|EEST)$/);
  });

  it("omits a display-only host zone when an existing legacy recurrence is edited", () => {
    const legacy = {
      ...routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "Europe/Athens" }),
      scheduleTimeZoneSource: "host" as const,
    };
    const explicit = { ...legacy, scheduleTimeZoneSource: "stored" as const };

    expect(editedDailySchedule(legacy, "10:00", [2], "Europe/Athens")).toEqual({
      type: "daily",
      time: "10:00",
      weekdays: [2],
    });
    expect(editedDailySchedule(explicit, "10:00", [2], "Europe/Athens")).toEqual({
      type: "daily",
      time: "10:00",
      weekdays: [2],
      timeZone: "Europe/Athens",
    });
  });

  it("labels the next run by the Central calendar date instead of the browser date", () => {
    const now = Date.parse("2026-09-13T04:45:00.000Z");
    const at = Date.parse("2026-09-13T04:55:00.000Z");
    expect(nextCalendarRunLabel(at, now)).toBe("Today, 11:55 PM CDT");
  });
});

describe("scheduleFireDays", () => {
  const zone = "America/Chicago";
  // 2026-09-01..2026-10-01, both bounds expressed as Chicago midnights so a
  // fixture change never has to hand-recompute UTC offsets.
  const septStart = Date.parse("2026-09-01T05:00:00.000Z");
  const octStart = Date.parse("2026-10-01T05:00:00.000Z");

  it("marks the single day a one-shot schedule fires on, in range", () => {
    const at = Date.parse("2026-09-14T14:00:00.000Z"); // Mon Sep 14, 9am Central
    const days = scheduleFireDays({ type: "once", at }, zone, septStart, octStart);
    expect(days).toEqual(new Set([startOfDayInTimeZone(at, zone)]));
  });

  it("omits a one-shot day outside the requested range", () => {
    const at = Date.parse("2026-11-02T14:00:00.000Z");
    expect(scheduleFireDays({ type: "once", at }, zone, septStart, octStart).size).toBe(0);
  });

  it("marks every Monday in September 2026 for a weekly recurrence, and only Mondays", () => {
    const days = scheduleFireDays({ type: "daily", time: "09:00", weekdays: [1], timeZone: zone }, zone, septStart, octStart);
    expect(days.size).toBe(4); // Sep 2026 has exactly four Mondays: 7, 14, 21, 28
    for (const day of days) {
      expect(calendarDayLabel(day).weekday).toBe("Mon");
    }
  });

  it("never loops on a recurrence with no weekdays selected", () => {
    const days = scheduleFireDays({ type: "daily", time: "09:00", weekdays: [], timeZone: zone }, zone, septStart, octStart);
    expect(days.size).toBe(0);
  });

  it("keys days by the schedule's own zone, not UTC or the host's", () => {
    // 00:30 Monday in Tokyo is still Sunday everywhere west of it — the
    // returned day must be the Tokyo calendar day, matching
    // projectedRoutineItems' own occurrence (see the timezone test above).
    const days = scheduleFireDays(
      { type: "daily", time: "00:30", weekdays: [1], timeZone: "Asia/Tokyo" },
      "Asia/Tokyo",
      Date.parse("2026-09-13T05:00:00.000Z"),
      Date.parse("2026-09-14T05:00:00.000Z"),
    );
    expect(days).toEqual(new Set([startOfDayInTimeZone(Date.parse("2026-09-13T15:30:00.000Z"), "Asia/Tokyo")]));
  });
});
