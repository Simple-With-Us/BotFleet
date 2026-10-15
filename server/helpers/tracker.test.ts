import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { HELPER_UPDATE_MIN_MS } from "../../shared/helpers.ts";
import { HelperTracker } from "./tracker.ts";

const base = {
  eventId: "e",
  provider: "claude",
  threadId: "t1",
  createdAt: "2026-10-15T00:00:00.000Z",
  turnId: "turn-1",
};

function started(over: Record<string, unknown>): RuntimeEvent {
  return { ...base, type: "item.started", itemType: "tool", ...over } as RuntimeEvent;
}

function updated(over: Record<string, unknown>): RuntimeEvent {
  return { ...base, type: "item.updated", itemType: "tool", ...over } as RuntimeEvent;
}

function completed(over: Record<string, unknown>): RuntimeEvent {
  return { ...base, type: "item.completed", itemType: "tool", ok: true, ...over } as RuntimeEvent;
}

describe("HelperTracker", () => {
  it("opens a typed helper on Task, counts its steps, and holds the rest for a second", () => {
    const tracker = new HelperTracker();
    const opened = tracker.observe(started({ itemId: "task-1", title: "Task", target: "Survey files" }), 1_000);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.subagent).toMatchObject({
      id: "task-1",
      parentItemId: "task-1",
      fidelity: "typed",
      depth: 1,
      label: "Survey files",
      status: "running",
      toolCount: 0,
    });

    const step = tracker.observe(
      started({ itemId: "read-1", title: "Read", target: "notes.md", parentItemId: "task-1", subagentId: "task-1" }),
      1_100,
    );
    expect(step).toEqual([]);
    expect(tracker.nextWait(1_100)).toBe(HELPER_UPDATE_MIN_MS - 100);

    const tokens = tracker.observe(updated({ itemId: "task-1", subagentId: "task-1", tokens: 1098 }), 1_200);
    expect(tokens).toEqual([]);

    const flushed = tracker.due(1_000 + HELPER_UPDATE_MIN_MS);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.subagent).toMatchObject({
      toolCount: 1,
      tokens: 1098,
      lastActivity: "Read · notes.md",
      status: "running",
    });
    expect(tracker.due(1_000 + HELPER_UPDATE_MIN_MS)).toEqual([]);
  });

  it("publishes a finish immediately, with the steps that were still held", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "task-1", title: "Agent" }), 0);
    tracker.observe(started({ itemId: "read-1", title: "Read", parentItemId: "task-1" }), 10);
    const done = tracker.observe(completed({ itemId: "task-1", ok: false, detail: "no such file" }), 20);
    expect(done).toHaveLength(1);
    expect(done[0]!.subagent).toMatchObject({ status: "failed", toolCount: 1, endedAt: 20 });
    expect(tracker.observe({ ...base, type: "turn.completed", ok: true } as RuntimeEvent, 30)).toEqual([]);
  });

  it("settles a helper the turn ends before its own tool result", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "spawn-1", title: "spawn_agent", target: "list files" }), 0);
    const settled = tracker.observe({ ...base, type: "turn.completed", ok: true } as RuntimeEvent, 50);
    expect(settled.map((row) => row.subagent.status)).toEqual(["completed"]);
    expect(settled[0]!.subagent.endedAt).toBe(50);
  });

  it("treats invoke_subagent as a named helper and ignores an ordinary tool", () => {
    const tracker = new HelperTracker();
    expect(tracker.observe(started({ itemId: "bash-1", title: "Bash", target: "ls" }), 0)).toEqual([]);
    const named = tracker.observe(started({ itemId: "sub-1", title: "invoke_subagent", target: "look around" }), 0);
    expect(named[0]!.subagent).toMatchObject({ fidelity: "named", label: "look around", depth: 1 });
  });

  it("nests a helper that a helper started", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "task-1", title: "Task" }), 0);
    const nested = tracker.observe(
      started({ itemId: "task-2", title: "Task", target: "inner", parentItemId: "task-1", subagentId: "task-1" }),
      5,
    );
    const inner = nested.find((row) => row.subagent.id === "task-2");
    expect(inner?.subagent).toMatchObject({ depth: 2, fidelity: "typed", label: "inner" });
  });
});
