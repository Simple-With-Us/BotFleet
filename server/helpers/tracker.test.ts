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

function started(over: Partial<Extract<RuntimeEvent, { type: "item.started" }>>): RuntimeEvent {
  return { ...base, type: "item.started", itemType: "tool", ...over };
}

function updated(over: Partial<Extract<RuntimeEvent, { type: "item.updated" }>>): RuntimeEvent {
  return { ...base, type: "item.updated", itemType: "tool", ...over };
}

function completed(over: Partial<Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>>): RuntimeEvent {
  return { ...base, type: "item.completed", itemType: "tool", ok: true, ...over };
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
    expect(tracker.observe({ ...base, type: "turn.completed", ok: true }, 30)).toEqual([]);
  });

  it("settles a helper the turn ends before its own tool result", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "spawn-1", title: "spawn_agent", target: "list files" }), 0);
    const settled = tracker.observe({ ...base, type: "turn.completed", ok: true }, 50);
    expect(settled.map((row) => row.subagent.status)).toEqual(["completed"]);
    expect(settled[0]!.subagent.endedAt).toBe(50);
  });

  it("treats invoke_subagent as a named helper and ignores an ordinary tool", () => {
    const tracker = new HelperTracker();
    expect(tracker.observe(started({ itemId: "bash-1", title: "Bash", target: "ls" }), 0)).toEqual([]);
    const named = tracker.observe(started({ itemId: "sub-1", title: "invoke_subagent", target: "look around" }), 0);
    expect(named[0]!.subagent).toMatchObject({ fidelity: "named", label: "look around", depth: 1 });
  });

  it("counts inner steps for a named helper that never stamps a parent id", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "sub-1", title: "invoke_subagent", target: "look around" }), 0);
    tracker.observe(started({ itemId: "read-1", title: "Read", target: "notes.md" }), 10);
    const flushed = tracker.due(HELPER_UPDATE_MIN_MS);
    expect(flushed[0]!.subagent).toMatchObject({
      toolCount: 1,
      lastActivity: "Read · notes.md",
      status: "running",
    });
  });

  it("drops a late step when its helper already settled", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "task-1", title: "Task" }), 0);
    tracker.observe(completed({ itemId: "task-1" }), 10);
    expect(
      tracker.observe(
        started({ itemId: "read-late", title: "Read", parentItemId: "task-1", subagentId: "task-1" }),
        20,
      ),
    ).toEqual([]);
  });

  it("replays a step that arrived before its helper opened", () => {
    const tracker = new HelperTracker();
    tracker.observe(
      started({ itemId: "read-1", title: "Read", target: "notes.md", parentItemId: "task-1", subagentId: "task-1" }),
      0,
    );
    const opened = tracker.observe(started({ itemId: "task-1", title: "Task", target: "Survey files" }), 10);
    expect(opened[0]!.subagent).toMatchObject({ toolCount: 1, lastActivity: "Read · notes.md" });
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

  it("leaves a helper from another turn on the same thread running", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "spawn-1", title: "spawn_agent", turnId: "turn-a" }), 0);
    tracker.observe(started({ itemId: "spawn-2", title: "spawn_agent", turnId: "turn-b" }), 0);
    const settled = tracker.observe({ ...base, type: "turn.completed", ok: true, turnId: "turn-a" }, 40);
    expect(settled.map((row) => row.subagent.id)).toEqual(["spawn-1"]);
    const step = tracker.observe(
      started({ itemId: "read-2", title: "Read", target: "notes.md", parentItemId: "spawn-2", subagentId: "spawn-2", turnId: "turn-b" }),
      50,
    );
    expect(step).toEqual([]);
    const flushed = tracker.due(HELPER_UPDATE_MIN_MS);
    expect(flushed.map((row) => row.subagent.id)).toEqual(["spawn-2"]);
    expect(flushed[0]?.subagent).toMatchObject({ status: "running", toolCount: 1, lastActivity: "Read · notes.md" });
  });

  it("an engine exit settles that instance's helpers and leaves another instance's running", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "task-a", title: "Task", providerInstanceId: "inst-a" }), 0);
    tracker.observe(started({ itemId: "task-b", title: "Task", providerInstanceId: "inst-b", turnId: "turn-b" }), 0);
    const settled = tracker.observe({ ...base, type: "session.exited", providerInstanceId: "inst-a" }, 10);
    expect(settled.map((row) => row.subagent.id)).toEqual(["task-a"]);
    expect(settled[0]?.subagent.status).toBe("failed");
    const still = tracker.observe({ ...base, type: "turn.completed", ok: true, turnId: "turn-b", providerInstanceId: "inst-b" }, 20);
    expect(still.map((row) => row.subagent.id)).toEqual(["task-b"]);
  });

  it("keeps the instance id when a later frame leaves it off", () => {
    const tracker = new HelperTracker();
    tracker.observe(started({ itemId: "task-a", title: "Task", providerInstanceId: "inst-a", turnId: "turn-a" }), 0);
    tracker.observe(updated({ itemId: "task-a", subagentId: "task-a", tokens: 10, turnId: "turn-a" }), 5);
    const other = tracker.observe({ ...base, type: "session.exited", providerInstanceId: "inst-b" }, 10);
    expect(other).toEqual([]);
    const own = tracker.observe({ ...base, type: "session.exited", providerInstanceId: "inst-a" }, 20);
    expect(own.map((row) => row.subagent.id)).toEqual(["task-a"]);
  });
});
