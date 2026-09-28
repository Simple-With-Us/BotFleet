import { describe, expect, it } from "vitest";

import type { RoutineRun } from "@/lib/routines";
import {
  attentionRuns,
  attentionSourcesTooltip,
  attentionWindowLabel,
  needsAttention,
  relativeRunTime,
  summarizeAttention,
} from "./routine-attention";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function run(overrides: Partial<RoutineRun> & { id: string }): RoutineRun {
  return {
    routineId: "routine-1",
    routineName: "Nightly Tidy",
    botId: "bot-1",
    runOn: "bot",
    scheduledFor: NOW - HOUR,
    status: "failed",
    manual: false,
    createdAt: NOW - HOUR,
    ...overrides,
  };
}

describe("needsAttention", () => {
  it("counts a failed or missed run that was never acknowledged", () => {
    expect(needsAttention(run({ id: "a", status: "failed" }))).toBe(true);
    expect(needsAttention(run({ id: "b", status: "missed" }))).toBe(true);
  });

  it("stops counting an acknowledged run", () => {
    expect(needsAttention(run({ id: "a", seenAt: NOW }))).toBe(false);
  });

  it("leaves deliberate outcomes alone", () => {
    expect(needsAttention(run({ id: "a", status: "completed" }))).toBe(false);
    expect(needsAttention(run({ id: "b", status: "cancelled" }))).toBe(false);
  });
});

describe("attentionRuns", () => {
  it("returns only the backlog, newest first", () => {
    const runs = [
      run({ id: "old", finishedAt: NOW - 5 * HOUR, createdAt: NOW - 6 * HOUR }),
      run({ id: "new", finishedAt: NOW - 1_000, createdAt: NOW - 2_000 }),
      run({ id: "done", status: "completed" }),
      run({ id: "seen", seenAt: NOW }),
    ];
    expect(attentionRuns(runs).map((candidate) => candidate.id)).toEqual(["new", "old"]);
  });
});

describe("summarizeAttention", () => {
  it("separates a historic backlog from what is actually breaking now", () => {
    const summary = summarizeAttention(
      [
        run({ id: "a", finishedAt: NOW - 10 * 60_000, createdAt: NOW - 10 * 60_000 }),
        run({ id: "b", finishedAt: NOW - 3 * HOUR, createdAt: NOW - 3 * HOUR }),
        run({ id: "c", finishedAt: NOW - 30 * HOUR, createdAt: NOW - 30 * HOUR }),
        run({ id: "d", status: "completed", finishedAt: NOW - 60_000, createdAt: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(summary.total).toBe(3);
    expect(summary.lastHour).toBe(1);
    expect(summary.lastDay).toBe(2);
    expect(summary.oldestAt).toBe(NOW - 30 * HOUR);
    expect(summary.newestAt).toBe(NOW - 10 * 60_000);
  });

  it("uses createdAt when a run never finished", () => {
    const summary = summarizeAttention([run({ id: "a", createdAt: NOW - 2 * 60_000, finishedAt: undefined })], NOW);
    expect(summary.lastHour).toBe(1);
  });

  it("ignores a clock-skewed run dated in the future", () => {
    const summary = summarizeAttention([run({ id: "a", finishedAt: NOW + 5 * HOUR, createdAt: NOW + 5 * HOUR })], NOW);
    expect(summary.total).toBe(0);
  });

  it("groups repeat failures from one trigger into a single line, biggest first", () => {
    const summary = summarizeAttention(
      [
        run({ id: "a", routineName: "GitHub UI Pass", triggerSource: "webhook", finishedAt: NOW - HOUR }),
        run({ id: "b", routineName: "GitHub UI Pass", triggerSource: "webhook", finishedAt: NOW - 2 * HOUR }),
        run({ id: "c", routineName: "Disk Watch", triggerSource: "resource", finishedAt: NOW - 3 * HOUR }),
      ],
      NOW,
    );
    expect(summary.sources).toHaveLength(2);
    expect(summary.sources[0]).toMatchObject({ name: "GitHub UI Pass", label: "Webhook", count: 2 });
    expect(summary.sources[1]).toMatchObject({ name: "Disk Watch", label: "Resource trigger", count: 1 });
  });

  it("keeps same-named routines apart when they fire from different triggers", () => {
    const summary = summarizeAttention(
      [
        run({ id: "a", routineName: "Daily Brief", triggerSource: "schedule", finishedAt: NOW - HOUR }),
        run({ id: "b", routineName: "Daily Brief", triggerSource: "webhook", finishedAt: NOW - 2 * HOUR }),
      ],
      NOW,
    );
    expect(summary.sources.map((source) => source.label).sort()).toEqual(["Routine", "Webhook"]);
  });

  it("reports nothing for a clean history", () => {
    const summary = summarizeAttention([run({ id: "a", status: "completed" })], NOW);
    expect(summary.total).toBe(0);
    expect(summary.sources).toEqual([]);
  });
});

describe("attentionSourcesTooltip", () => {
  it("names each trigger feeding the number", () => {
    const summary = summarizeAttention(
      [
        run({ id: "a", routineName: "GitHub UI Pass", triggerSource: "webhook", finishedAt: NOW - HOUR }),
        run({ id: "b", routineName: "Disk Watch", triggerSource: "resource", finishedAt: NOW - 2 * HOUR }),
      ],
      NOW,
    );
    expect(attentionSourcesTooltip(summary)).toBe("GitHub UI Pass (Webhook) — 1\nDisk Watch (Resource trigger) — 1");
  });

  it("caps the list and counts the rest", () => {
    const runs = Array.from({ length: 9 }, (_, index) =>
      run({ id: `r${index}`, routineName: `Trigger ${index}`, triggerSource: "webhook", finishedAt: NOW - index * 1000 }),
    );
    const tooltip = attentionSourcesTooltip(summarizeAttention(runs, NOW), 6);
    expect(tooltip.split("\n")).toHaveLength(7);
    expect(tooltip.split("\n")[6]).toBe("and 3 more");
  });

  it("is empty when nothing needs attention", () => {
    expect(attentionSourcesTooltip(summarizeAttention([], NOW))).toBe("");
  });
});

describe("attentionWindowLabel", () => {
  it("puts the recent counts next to the backlog", () => {
    const summary = summarizeAttention(
      [run({ id: "a", finishedAt: NOW - 30 * 60_000 }), run({ id: "b", finishedAt: NOW - 4 * HOUR })],
      NOW,
    );
    expect(attentionWindowLabel(summary)).toBe("1 in the past hour · 2 in the past 24 hours");
  });
});

describe("relativeRunTime", () => {
  it("reads as a duration, then falls back to a date", () => {
    expect(relativeRunTime(NOW - 5_000, NOW)).toBe("Just now");
    expect(relativeRunTime(NOW - 9 * 60_000, NOW)).toBe("9m ago");
    expect(relativeRunTime(NOW - 5 * HOUR, NOW)).toBe("5h ago");
    expect(relativeRunTime(NOW - 50 * HOUR, NOW)).toBe(new Date(NOW - 50 * HOUR).toLocaleDateString([], { month: "short", day: "numeric" }));
  });
});
