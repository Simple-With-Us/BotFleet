import { describe, expect, it } from "vitest";

import {
  helperCardModel,
  helperSnapshotForWire,
  helperStatsLine,
  helperToolFidelity,
  isHelperRow,
  isHelperToolName,
  runningHelperCount,
  workPillLabel,
  type HelperTranscript,
} from "./helpers";

const running: HelperTranscript = {
  fidelity: "typed",
  depth: 1,
  label: "Survey files",
  lastActivity: "Read notes.md",
  toolCount: 2,
  tokens: 1098,
  status: "running",
  startedAt: 1_000,
  endedAt: null,
};

describe("helper snapshots on the wire", () => {
  it("drops an activity line that redacts to nothing", () => {
    const snapshot = {
      id: "task-1",
      threadId: "t1",
      parentItemId: "task-1",
      depth: 1,
      fidelity: "typed" as const,
      label: "Survey files",
      lastActivity: "secret-value",
      toolCount: 1,
      startedAt: 1,
      endedAt: null,
      status: "running" as const,
    };
    const wired = helperSnapshotForWire(snapshot, (text) => (text === "secret-value" ? "" : text));
    expect(wired.label).toBe("Survey files");
    expect(wired.lastActivity).toBeUndefined();
    expect("lastActivity" in wired).toBe(false);
  });
});

describe("helper tool names", () => {
  it("recognises the engines' helper tools and ignores a name that only contains one", () => {
    expect(helperToolFidelity("Task")).toBe("typed");
    expect(helperToolFidelity("spawn_agent")).toBe("typed");
    expect(helperToolFidelity("invoke_subagent")).toBe("named");
    expect(helperToolFidelity("spawn-subagent")).toBe("named");
    expect(isHelperToolName("task_list")).toBe(false);
    expect(isHelperToolName("Bash")).toBe(false);
    expect(isHelperToolName(undefined)).toBe(false);
  });
});

describe("helper cards", () => {
  it("draws a card from the tool name before the harness has patched the row", () => {
    const card = helperCardModel({ kind: "activity", at: 5_000, tool: { name: "Task", target: "Survey files" } }, 8_000);
    expect(card).toMatchObject({ label: "Survey files", status: "running", fidelity: "typed", toolCount: 0 });
    expect(helperStatsLine(card!, 8_000)).toBe("3s");
  });

  it("uses the patched snapshot once the harness has one", () => {
    const card = helperCardModel({ kind: "activity", at: 1_000, helper: running, tool: { name: "Task", ok: true } }, 4_000);
    expect(card).toMatchObject({ label: "Survey files", status: "running", toolCount: 2, tokens: 1098, lastActivity: "Read notes.md" });
    expect(helperStatsLine(card!, 4_000)).toBe("2 tools · 1,098 tokens · 3s");
  });

  it("does not treat a helper's own step as a helper", () => {
    expect(isHelperRow({ kind: "activity", tool: { name: "Read", parentItemId: "task-1", ok: true } })).toBe(false);
    expect(helperCardModel({ kind: "activity", tool: { name: "Read", parentItemId: "task-1" } }, 0)).toBeNull();
  });
});

describe("the header count", () => {
  it("counts running helpers and leaves finished ones and ordinary steps out", () => {
    expect(runningHelperCount([
      { kind: "activity", helper: running, tool: { name: "Task" } },
      { kind: "activity", helper: { ...running, status: "completed", endedAt: 2_000 }, tool: { name: "Agent", ok: true } },
      { kind: "activity", tool: { name: "Read", parentItemId: "task-1", ok: true } },
      { kind: "activity", tool: { name: "spawn_agent" } },
    ])).toBe(2);
    expect(workPillLabel(2, 1)).toBe("2 Jobs · 1 Helper");
    expect(workPillLabel(1, 0)).toBe("1 Job");
    expect(workPillLabel(0, 2)).toBe("2 Helpers");
  });
});
