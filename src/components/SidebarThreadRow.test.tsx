// What a sleeping thread row draws, and where it sits.
//
// Two halves.  The rendered half uses this repo's SSR style (see
// EngineCallout.test.tsx): `renderToStaticMarkup` over the two pieces
// Sidebar.tsx's thread row delegates to, which is as much of that monolith
// as can be mounted without a store.  The ordering half is pure, and pins
// the behaviour the sidebar would otherwise only show by eye — a snoozed
// row sinks, a woken one comes back to plain update order, and the thread
// the person has open stays where it is.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThreadSnoozeBadge, ThreadWakeButton } from "./SidebarThreadRow";
import {
  nextSnoozeExpiry,
  orderedThreadRows,
  resolveSnoozePreset,
  SNOOZE_PRESET_LABELS,
  SNOOZE_PRESETS,
  SNOOZE_UNTIL_ACTIVITY,
} from "@/lib/thread-snooze";

const NOW = new Date("2026-09-25T14:30:00").getTime();

describe("the snoozed badge on a thread row", () => {
  it("draws nothing at all while the thread is awake", () => {
    expect(renderToStaticMarkup(createElement(ThreadSnoozeBadge, { threadId: "t1", now: NOW }))).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(ThreadSnoozeBadge, { threadId: "t1", snoozedUntil: NOW - 1, now: NOW }),
      ),
    ).toBe("");
  });

  it("names the sentinel rather than a time, in sentence case", () => {
    const html = renderToStaticMarkup(
      createElement(ThreadSnoozeBadge, { threadId: "t1", snoozedUntil: SNOOZE_UNTIL_ACTIVITY, now: NOW }),
    );
    expect(html).toContain('data-thread-snoozed="t1"');
    expect(html).toContain("until activity");
    // The moon is decoration; the words carry the meaning.
    expect(html).toContain("aria-hidden");
  });

  it("resolves a deadline into the badge rather than showing a raw timestamp", () => {
    const html = renderToStaticMarkup(
      createElement(ThreadSnoozeBadge, {
        threadId: "t1",
        snoozedUntil: new Date("2026-09-25T18:00:00").getTime(),
        now: NOW,
      }),
    );
    expect(html).toMatch(/until \d{1,2}:00/);
    expect(html).not.toContain("1790");
  });
});

describe("the wake button", () => {
  it("is a button of its own, labelled for a screen reader, that calls back once", () => {
    const onWake = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ThreadWakeButton, { label: "Nightly deploy", onWake }),
    );
    // A button inside a button is neither valid nor reachable, so this piece
    // is rendered beside the row and never inside it.
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-label="Stop snoozing Nightly deploy"');
    expect(html).toContain("Wake Nightly deploy");
  });
});

describe("where a sleeping row sits", () => {
  const row = (threadId: string, lastActivity: number, snoozedUntil?: number) => ({
    threadId,
    createdAt: 0,
    lastActivity,
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
  });

  it("sinks a snoozed thread below every awake one without hiding it", () => {
    const ordered = orderedThreadRows(
      [row("asleep", NOW, SNOOZE_UNTIL_ACTIVITY), row("awake", NOW - 600_000)],
      NOW,
    );
    expect(ordered.map((task) => task.threadId)).toEqual(["awake", "asleep"]);
  });

  it("returns a woken thread to update order without anyone storing its old slot", () => {
    const rows = [row("awake", NOW - 600_000), row("timed", NOW, NOW + 1_000)];
    expect(orderedThreadRows(rows, NOW).map((t) => t.threadId)).toEqual(["awake", "timed"]);
    expect(orderedThreadRows(rows, NOW + 2_000).map((t) => t.threadId)).toEqual(["timed", "awake"]);
  });

  it("keeps the open thread in place, so snoozing what you are reading does not move it", () => {
    const rows = [row("open", NOW, SNOOZE_UNTIL_ACTIVITY), row("other", NOW - 600_000)];
    expect(orderedThreadRows(rows, NOW, new Set(["open"])).map((t) => t.threadId)).toEqual([
      "open",
      "other",
    ]);
  });

  it("arms a re-render on the nearest deadline and nothing at all for the sentinel", () => {
    expect(nextSnoozeExpiry([SNOOZE_UNTIL_ACTIVITY, undefined], NOW)).toBeUndefined();
    expect(nextSnoozeExpiry([NOW + 9_000, SNOOZE_UNTIL_ACTIVITY, NOW + 3_000], NOW)).toBe(NOW + 3_000);
  });
});

describe("the menu the row opens", () => {
  it("offers the four choices the desktop promises, in order", () => {
    expect(SNOOZE_PRESETS.map((preset) => SNOOZE_PRESET_LABELS[preset])).toEqual([
      "For 1 hour",
      "Until tomorrow morning",
      "Until activity",
    ]);
    // Custom is the fourth, and is the person's own moment rather than a
    // preset, so it has no fixed label here.
    expect(resolveSnoozePreset("activity", NOW)).toBe(SNOOZE_UNTIL_ACTIVITY);
    expect(resolveSnoozePreset("hour", NOW)).toBe(NOW + 3_600_000);
  });
});
