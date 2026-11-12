// Schedule normalisation used to live only inside `agents-proxy.ts`, reached
// by the MCP lane alone.  These tests pin its behaviour as a pure function so
// both `agents-proxy.ts` (MCP) and `agents.ts` (HTTP, via `routineFields`)
// stay identical — the coverage `agents-proxy.test.ts`'s own schedule
// assertions used to be the only proof of.
import { describe, expect, it } from "vitest";

import { normalizeScheduleInput, routineFields, WEEKDAYS } from "./schedule.ts";

describe("normalizeScheduleInput", () => {
  it("accepts a once schedule with an explicit offset", () => {
    expect(normalizeScheduleInput({ schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" } })).toEqual({
      schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" },
    });
  });

  it("rejects a once schedule with no at", () => {
    const result = normalizeScheduleInput({ schedule: { type: "once" } });
    expect(result.schedule).toBeUndefined();
    expect(result.error).toMatch(/needs "at"/);
  });

  it("accepts a weekly schedule and lower-cases full weekday names", () => {
    expect(
      normalizeScheduleInput({ schedule: { type: "weekly", time: "09:00", weekdays: ["Monday", "FRIDAY"] } }),
    ).toEqual({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] } });
  });

  it("preserves and trims an explicit IANA timezone", () => {
    expect(
      normalizeScheduleInput({
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday"], timeZone: " America/Chicago " },
      }),
    ).toEqual({
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday"], timeZone: "America/Chicago" },
    });
  });

  it("coerces short weekday names to their full spelling", () => {
    expect(
      normalizeScheduleInput({ schedule: { type: "weekly", time: "09:00", weekdays: ["mon", "tues", "thur"] } }),
    ).toEqual({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "thursday"] } });
  });

  it("de-duplicates repeated weekdays", () => {
    const result = normalizeScheduleInput({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "mon"] } });
    expect(result.schedule?.weekdays).toEqual(["monday"]);
  });

  it("rejects an unsupported weekday name", () => {
    const result = normalizeScheduleInput({ schedule: { type: "weekly", time: "09:00", weekdays: ["someday"] } });
    expect(result.error).toMatch(/Unsupported weekday/);
  });

  it("rejects a weekly schedule with no weekdays", () => {
    const result = normalizeScheduleInput({ schedule: { type: "weekly", time: "09:00" } });
    expect(result.error).toMatch(/needs "weekdays"/);
  });

  it("expands daily to weekly on all seven days", () => {
    expect(normalizeScheduleInput({ schedule: { type: "daily", time: "09:00" } })).toEqual({
      schedule: { type: "weekly", time: "09:00", weekdays: [...WEEKDAYS] },
    });
  });

  it("honours an explicit weekdays list on a daily schedule", () => {
    expect(
      normalizeScheduleInput({ schedule: { type: "daily", time: "09:00", weekdays: ["monday"] } }),
    ).toEqual({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } });
  });

  it("rejects daily/weekly with no time", () => {
    expect(normalizeScheduleInput({ schedule: { type: "daily" } }).error).toMatch(/needs "time"/);
  });

  it("parses a stringified schedule object", () => {
    expect(
      normalizeScheduleInput({ schedule: JSON.stringify({ type: "weekly", time: "09:00", weekdays: ["monday"] }) }),
    ).toEqual({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } });
  });

  it("rejects a schedule that is text but not JSON", () => {
    expect(normalizeScheduleInput({ schedule: "next tuesday" }).error).toMatch(/not text/);
  });

  it("rejects a schedule that is not an object at all", () => {
    expect(normalizeScheduleInput({ schedule: 42 }).error).toMatch(/must be a JSON object/);
    expect(normalizeScheduleInput({ schedule: ["once"] }).error).toMatch(/must be a JSON object/);
    expect(normalizeScheduleInput({}).error).toMatch(/must be a JSON object/);
  });

  it("explicitly rejects interval, cron, hourly and minutes", () => {
    for (const type of ["interval", "cron", "hourly", "minutes"]) {
      const result = normalizeScheduleInput({ schedule: { type, time: "09:00" } });
      expect(result.schedule, type).toBeUndefined();
      expect(result.error, type).toMatch(/sub-day intervals/);
    }
  });

  it("rejects an unknown schedule type by name", () => {
    expect(normalizeScheduleInput({ schedule: { type: "fortnightly" } }).error).toMatch(/Unknown schedule type/);
  });
});

describe("routineFields", () => {
  it("trims name and instructions and renames run_on/duration_minutes", () => {
    const { fields, error } = routineFields({
      name: "  Morning brief  ",
      instructions: " Summarize. ",
      run_on: "cloud",
      duration_minutes: 45,
    });
    expect(error).toBeUndefined();
    expect(fields).toEqual({
      name: "Morning brief",
      instructions: "Summarize.",
      runOn: "cloud",
      durationMinutes: 45,
    });
  });

  it("normalises schedule inline when present", () => {
    const { fields, error } = routineFields({
      name: "N",
      instructions: "I",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(error).toBeUndefined();
    expect(fields.schedule).toEqual({ type: "weekly", time: "09:00", weekdays: [...WEEKDAYS] });
  });

  it("surfaces the schedule error and stops there", () => {
    const { fields, error } = routineFields({ name: "N", schedule: { type: "hourly" } });
    expect(error).toMatch(/sub-day intervals/);
    // Fields collected before the schedule error are still returned — the
    // caller decides whether a partial `fields` is useful.
    expect(fields.name).toBe("N");
  });

  it("omits fields the caller did not send, rather than nulling them", () => {
    const { fields } = routineFields({ name: "N" });
    expect(Object.keys(fields)).toEqual(["name"]);
  });
});
