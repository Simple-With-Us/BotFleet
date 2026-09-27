// The rules one thread's snooze is made of.
//
// Everything here is pure, and it is shared on purpose: the harness, the
// sidebar and the phone all answer "is this asleep?" from this module, so
// a disagreement between three surfaces is a failure in one file rather
// than a bug someone notices on a Tuesday.
import { describe, expect, it } from "vitest";

import {
  isSnoozeExpired,
  isThreadSnoozed,
  nextSnoozeExpiry,
  orderedThreadRows,
  resolveCustomSnooze,
  resolveSnoozePreset,
  SNOOZE_MORNING_HOUR,
  SNOOZE_PRESET_LABELS,
  SNOOZE_PRESETS,
  SNOOZE_UNTIL_ACTIVITY,
  snoozeLabel,
  threadRecency,
} from "./thread-snooze.ts";

const NOW = new Date("2026-09-25T14:30:00").getTime();

describe("is a thread asleep", () => {
  it("treats absent as awake and 0 as the until-activity sentinel, not as an empty value", () => {
    expect(isThreadSnoozed(undefined, NOW)).toBe(false);
    expect(isThreadSnoozed(SNOOZE_UNTIL_ACTIVITY, NOW)).toBe(true);
    // A year later it is still asleep: the sentinel is not a time.
    expect(isThreadSnoozed(SNOOZE_UNTIL_ACTIVITY, NOW + 365 * 86_400_000)).toBe(true);
  });

  it("sleeps until a deadline passes, and is awake on the tick it passes", () => {
    expect(isThreadSnoozed(NOW + 1, NOW)).toBe(true);
    expect(isThreadSnoozed(NOW, NOW)).toBe(false);
    expect(isThreadSnoozed(NOW - 1, NOW)).toBe(false);
  });

  it("calls a deadline expired only once it is past, and never the sentinel", () => {
    expect(isSnoozeExpired(undefined, NOW)).toBe(false);
    expect(isSnoozeExpired(SNOOZE_UNTIL_ACTIVITY, NOW)).toBe(false);
    expect(isSnoozeExpired(NOW + 1, NOW)).toBe(false);
    expect(isSnoozeExpired(NOW, NOW)).toBe(true);
  });
});

describe("the next deadline a clock has to wait for", () => {
  it("picks the soonest still-future deadline and ignores sentinels and the past", () => {
    expect(
      nextSnoozeExpiry([undefined, SNOOZE_UNTIL_ACTIVITY, NOW - 5_000, NOW + 9_000, NOW + 3_000], NOW),
    ).toBe(NOW + 3_000);
  });

  it("returns undefined when nothing is scheduled to wake, so no timer is armed", () => {
    expect(nextSnoozeExpiry([], NOW)).toBeUndefined();
    expect(nextSnoozeExpiry([undefined, SNOOZE_UNTIL_ACTIVITY, NOW - 1], NOW)).toBeUndefined();
  });
});

describe("what the presets resolve to", () => {
  it("offers exactly the three the menu names, in that order, in sentence case", () => {
    expect([...SNOOZE_PRESETS]).toEqual(["hour", "tomorrow", "activity"]);
    expect(SNOOZE_PRESETS.map((preset) => SNOOZE_PRESET_LABELS[preset])).toEqual([
      "For 1 hour",
      "Until tomorrow morning",
      "Until activity",
    ]);
  });

  it("resolves an hour from the click, tomorrow morning locally, and activity to the sentinel", () => {
    expect(resolveSnoozePreset("hour", NOW)).toBe(NOW + 3_600_000);
    expect(resolveSnoozePreset("activity", NOW)).toBe(SNOOZE_UNTIL_ACTIVITY);

    const tomorrow = new Date(resolveSnoozePreset("tomorrow", NOW));
    expect(tomorrow.getHours()).toBe(SNOOZE_MORNING_HOUR);
    expect(tomorrow.getMinutes()).toBe(0);
    expect(tomorrow.getDate()).toBe(new Date(NOW).getDate() + 1);
  });

  it("resolves tomorrow morning from the moment of the click, never from when the menu opened", () => {
    // 2 am: "tomorrow morning" is the NEXT day's 8 am, not this morning's,
    // which is the case a menu left open overnight would otherwise hit.
    const smallHours = new Date("2026-09-26T02:00:00").getTime();
    const resolved = resolveSnoozePreset("tomorrow", smallHours);
    expect(resolved).toBeGreaterThan(smallHours);
    expect(new Date(resolved).getDate()).toBe(27);
  });
});

describe("a custom moment", () => {
  it("accepts a future moment and refuses a past one, so no snooze is over before it starts", () => {
    expect(resolveCustomSnooze("2026-09-25T18:00", NOW)).toBe(new Date("2026-09-25T18:00").getTime());
    expect(resolveCustomSnooze("2026-09-25T09:00", NOW)).toBeUndefined();
  });

  it("refuses a string the date parser could not read rather than storing NaN", () => {
    expect(resolveCustomSnooze("", NOW)).toBeUndefined();
    expect(resolveCustomSnooze("not a date", NOW)).toBeUndefined();
  });
});

describe("what a snoozed row says about itself", () => {
  it("says nothing at all when the thread is awake", () => {
    expect(snoozeLabel(undefined, NOW)).toBeNull();
    expect(snoozeLabel(NOW - 1, NOW)).toBeNull();
  });

  it("names the sentinel rather than a time", () => {
    expect(snoozeLabel(SNOOZE_UNTIL_ACTIVITY, NOW)).toBe("until activity");
  });

  it("drops the weekday for today and carries it for a deadline past midnight", () => {
    const tonight = new Date("2026-09-25T18:00:00").getTime();
    expect(snoozeLabel(tonight, NOW)).toMatch(/^until \d/);
    expect(snoozeLabel(tonight, NOW)).not.toMatch(/mon|tue|wed|thu|fri|sat|sun/i);

    const monday = new Date("2026-09-28T08:00:00").getTime();
    expect(snoozeLabel(monday, NOW)).toMatch(/^until Mon /);
  });
});

describe("thread-list order", () => {
  const row = (threadId: string, lastActivity: number, snoozedUntil?: number) => ({
    threadId,
    createdAt: 0,
    lastActivity,
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
  });

  it("falls back to createdAt when a row has no activity stamp, and never to NaN", () => {
    expect(threadRecency({ createdAt: 5 })).toBe(5);
    expect(threadRecency({ createdAt: 5, lastActivity: 9 })).toBe(9);
    expect(threadRecency({ createdAt: Number.NaN })).toBe(0);
  });

  it("sinks snoozed threads below awake ones without dropping them off the list", () => {
    const ordered = orderedThreadRows(
      [row("asleep-new", NOW - 1_000, SNOOZE_UNTIL_ACTIVITY), row("awake-old", NOW - 90_000)],
      NOW,
    );
    expect(ordered.map((task) => task.threadId)).toEqual(["awake-old", "asleep-new"]);
  });

  it("returns a woken thread to plain update order the moment its deadline passes", () => {
    const rows = [row("awake", NOW - 90_000), row("timed", NOW - 1_000, NOW + 1_000)];
    expect(orderedThreadRows(rows, NOW).map((task) => task.threadId)).toEqual(["awake", "timed"]);
    // Nothing had to remember where it used to sit: the position is derived.
    expect(orderedThreadRows(rows, NOW + 2_000).map((task) => task.threadId)).toEqual(["timed", "awake"]);
  });

  it("keeps the thread the person is reading in place, so snoozing it does not yank it away", () => {
    const rows = [row("open", NOW - 1_000, SNOOZE_UNTIL_ACTIVITY), row("other", NOW - 90_000)];
    expect(orderedThreadRows(rows, NOW, new Set(["open"])).map((task) => task.threadId)).toEqual([
      "open",
      "other",
    ]);
  });

  it("is stable within a tier, so equal stamps keep the order they arrived in", () => {
    const rows = [row("a", NOW), row("b", NOW), row("c", NOW)];
    expect(orderedThreadRows(rows, NOW).map((task) => task.threadId)).toEqual(["a", "b", "c"]);
  });
});
