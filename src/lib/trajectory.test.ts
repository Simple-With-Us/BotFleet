import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../server/contracts.ts";
import {
  axisX,
  buildAxis,
  buildTrajectory,
  clipLine,
  compactArgs,
  compactResult,
  DEFAULT_GAP_MS,
  filterRows,
  formatClock,
  formatGap,
  fitLabels,
  groupByTurn,
  inputsFromMessages,
  MAX_TOOL_ROWS,
  sortCalls,
  toolCalls,
  type Trajectory,
  type TrajectoryInput,
} from "./trajectory.ts";

// ── fixtures ──────────────────────────────────────────────────────────
// Times are seconds from a fixed epoch so a span's expected length reads off
// the fixture.  `ev` builds one event; the rest are the shapes drivers emit.
const T0 = Date.parse("2026-09-29T14:00:00.000Z");
let n = 0;
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const base = (sec: number, turnId: string | undefined = "t1") => ({
  eventId: `e${++n}`,
  provider: "claude" as const,
  threadId: "thread",
  createdAt: iso(sec),
  ...(turnId ? { turnId } : {}),
});
const turnStarted = (sec: number, turnId = "t1"): RuntimeEvent => ({ ...base(sec, turnId), type: "turn.started" });
const turnDone = (sec: number, extra: Partial<Extract<RuntimeEvent, { type: "turn.completed" }>> = {}, turnId = "t1"): RuntimeEvent => ({
  ...base(sec, turnId),
  type: "turn.completed",
  ok: true,
  ...extra,
});
const toolStart = (sec: number, itemId: string, title: string, extra: Record<string, unknown> = {}, turnId = "t1"): RuntimeEvent =>
  ({ ...base(sec, turnId), type: "item.started", itemType: "tool", itemId, title, ...extra }) as RuntimeEvent;
const toolEnd = (sec: number, itemId: string, ok = true, detail?: string, turnId = "t1"): RuntimeEvent =>
  ({ ...base(sec, turnId), type: "item.completed", itemType: "tool", itemId, ok, ...(detail ? { detail } : {}) }) as RuntimeEvent;
const said = (sec: number, text: string, turnId = "t1"): RuntimeEvent => ({ ...base(sec, turnId), type: "item.completed", itemType: "assistant_text", text });
const thinking = (sec: number, tokens: number | null = null, itemId?: string, turnId = "t1"): RuntimeEvent =>
  ({ ...base(sec, turnId), type: "item.updated", itemType: "reasoning", tokens, ...(itemId ? { itemId } : {}) }) as RuntimeEvent;

const ms = (sec: number) => T0 + sec * 1000;
const spanOf = (t: Trajectory, lane: "input" | "model" | "tools") => t.spans[lane].map((s) => [s.kind, (s.start - T0) / 1000, (s.end - T0) / 1000] as const);

// ── one ordinary turn ─────────────────────────────────────────────────
describe("buildTrajectory: an ordinary turn", () => {
  const events = [
    turnStarted(0),
    said(2, "Let me look."),
    toolStart(2.5, "a", "Read", { target: "src/app.ts" }),
    toolEnd(4.5, "a", true, "120 lines"),
    toolStart(5, "b", "Bash", { target: "pnpm test" }),
    toolEnd(15, "b", false, "exit 1"),
    said(18, "Two tests fail."),
    turnDone(20, { usage: { input: 1000, output: 200, cachedInput: 800 }, cost: 0.02, stopReason: "end_turn" }),
  ];
  const t = buildTrajectory(events);

  it("splits the model's time around the tool calls", () => {
    // turn start → first tool; tool end → next tool; last tool → turn end
    expect(spanOf(t, "model")).toEqual([
      ["model", 0, 2.5],
      ["model", 4.5, 5],
      ["model", 15, 20],
    ]);
  });

  it("makes one tool span per call, colored by outcome", () => {
    expect(spanOf(t, "tools")).toEqual([
      ["tool", 2.5, 4.5],
      ["tool", 5, 15],
    ]);
    expect(t.spans.tools.map((s) => s.status)).toEqual(["ok", "error"]);
    expect(t.spans.tools.map((s) => s.label)).toEqual(["Read", "Bash"]);
  });

  it("turns each step into one list row, in order, with the right badge", () => {
    expect(t.rows.map((r) => [r.kind, r.title])).toEqual([
      ["assistant", "Assistant"],
      ["tool", "Read"],
      // the second step went straight to a tool
      ["assistant", "Assistant"],
      ["tool", "Bash"],
      ["assistant", "Assistant"],
    ]);
    const read = t.rows[1]!;
    const bash = t.rows[3]!;
    expect(read).toMatchObject({ args: "src/app.ts", result: "120 lines", status: "ok", durationMs: 2000 });
    expect(bash).toMatchObject({ args: "pnpm test", result: "exit 1", status: "error", durationMs: 10_000 });
  });

  it("names an assistant step that only called tools", () => {
    const only = buildTrajectory([turnStarted(0), toolStart(1, "a", "Read"), toolEnd(2, "a"), turnDone(3)]);
    const assistant = only.rows.find((r) => r.kind === "assistant")!;
    expect(assistant.toolCallOnly).toBe(true);
    expect(assistant.text).toBeUndefined();
    // it precedes the tool it made
    expect(only.rows.map((r) => r.kind)).toEqual(["assistant", "tool"]);
  });

  it("does not call a step tool-call-only when it also said something", () => {
    // "Let me look." came before Read; Bash was reached with nothing said
    expect(t.rows.filter((r) => r.toolCallOnly).map((r) => r.at - T0)).toEqual([5000]);
    expect(t.rows[0]).toMatchObject({ text: "Let me look." });
    expect(t.rows[0]!.toolCallOnly).toBeUndefined();
  });

  it("summarises the turn: duration, tokens, cost, tool time and model time", () => {
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({
      index: 1,
      durationMs: 20_000,
      ok: true,
      stopReason: "end_turn",
      input: 1000,
      output: 200,
      cachedInput: 800,
      costUsd: 0.02,
      toolCalls: 2,
      toolMs: 12_000,
      modelMs: 8000,
      errors: 1,
      running: false,
      cut: false,
    });
  });

  it("is not trimmed and not running", () => {
    expect(t.trimmed).toBe(false);
    expect(t.running).toBe(false);
    expect(t.eventCount).toBe(events.length);
  });

  it("gives the turn an Input tick when nobody typed anything", () => {
    expect(t.spans.input.map((s) => [s.kind, s.start - T0])).toEqual([["turn", 0]]);
  });
});

// ── overlapping tools ─────────────────────────────────────────────────
describe("buildTrajectory: overlapping tool calls", () => {
  const t = buildTrajectory([
    turnStarted(0),
    toolStart(1, "a", "Read"),
    toolStart(1.2, "b", "Grep"),
    toolStart(1.4, "c", "Glob"),
    toolEnd(3, "b"),
    toolEnd(4, "a"),
    toolEnd(5, "c"),
    turnDone(8),
  ]);

  it("stacks calls that ran at once on their own rows", () => {
    expect(t.spans.tools.map((s) => [s.label, s.row])).toEqual([
      ["Read", 0],
      ["Grep", 1],
      ["Glob", 2],
    ]);
    expect(t.toolRows).toBe(3);
  });

  it("reuses a row once its call has ended", () => {
    const seq = buildTrajectory([
      turnStarted(0),
      toolStart(1, "a", "Read"),
      toolEnd(2, "a"),
      toolStart(3, "b", "Grep"),
      toolEnd(4, "b"),
      turnDone(5),
    ]);
    expect(seq.spans.tools.map((s) => s.row)).toEqual([0, 0]);
    expect(seq.toolRows).toBe(1);
  });

  it("gives the model no stretch while any call is running, and one after the last ends", () => {
    // 0→1 before the first call, then only after ALL three finish
    expect(spanOf(t, "model")).toEqual([
      ["model", 0, 1],
      ["model", 5, 8],
    ]);
  });

  it("counts wall time with a tool running, not the sum of their lengths", () => {
    // a 1→4, b 1.2→3, c 1.4→5: covered 1→5 = 4s (the sum would be 9.4s)
    expect(t.turns[0]!.toolMs).toBe(4000);
    expect(t.turns[0]!.toolCalls).toBe(3);
  });

  it("only writes one tool-call-only row for a burst of parallel calls", () => {
    expect(t.rows.filter((r) => r.kind === "assistant")).toHaveLength(1);
  });

  it("caps the stack and lets the overflow share the last row", () => {
    const events: RuntimeEvent[] = [turnStarted(0)];
    for (let i = 0; i < MAX_TOOL_ROWS + 3; i++) events.push(toolStart(1 + i * 0.1, `c${i}`, `T${i}`));
    for (let i = 0; i < MAX_TOOL_ROWS + 3; i++) events.push(toolEnd(20 + i, `c${i}`));
    events.push(turnDone(40));
    const capped = buildTrajectory(events);
    expect(capped.toolRows).toBe(MAX_TOOL_ROWS);
    expect(Math.max(...capped.spans.tools.map((s) => s.row))).toBe(MAX_TOOL_ROWS - 1);
  });
});

// ── reasoning ─────────────────────────────────────────────────────────
describe("buildTrajectory: reasoning", () => {
  const t = buildTrajectory([
    turnStarted(0),
    thinking(1, 100),
    thinking(2, 400),
    said(4, "Answer."),
    turnDone(5),
  ]);

  it("carves a reasoning span out of the model's stretch", () => {
    expect(spanOf(t, "model")).toEqual([
      ["model", 0, 1],
      ["reasoning", 1, 4],
      ["model", 4, 5],
    ]);
  });

  it("writes one REASONING row for the run, with the most tokens seen", () => {
    const rows = t.rows.filter((r) => r.kind === "reasoning");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Reasoning", durationMs: 3000, text: "about 400 tokens" });
  });

  it("counts reasoning as model time", () => {
    expect(t.turns[0]!.modelMs).toBe(5000);
  });

  it("starts a second run when a different reasoning item begins", () => {
    const two = buildTrajectory([turnStarted(0), thinking(1, 1, "r1"), thinking(2, 1, "r2"), said(3, "x"), turnDone(4)]);
    expect(two.rows.filter((r) => r.kind === "reasoning")).toHaveLength(2);
    expect(two.spans.model.filter((s) => s.kind === "reasoning").map((s) => [(s.start - T0) / 1000, (s.end - T0) / 1000])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it("ends a reasoning run when a tool starts", () => {
    const r = buildTrajectory([turnStarted(0), thinking(1), toolStart(3, "a", "Read"), toolEnd(4, "a"), turnDone(5)]);
    expect(spanOf(r, "model")).toEqual([
      ["model", 0, 1],
      ["reasoning", 1, 3],
      ["model", 4, 5],
    ]);
  });

  it("treats streamed reasoning text as reasoning, and ignores streamed assistant text", () => {
    const streamed = buildTrajectory([
      turnStarted(0),
      { ...base(1), type: "content.delta", streamKind: "reasoning_text", delta: "hm" } as RuntimeEvent,
      { ...base(2), type: "content.delta", streamKind: "assistant_text", delta: "hi" } as RuntimeEvent,
      turnDone(3),
    ]);
    expect(streamed.rows.map((r) => r.kind)).toEqual(["reasoning"]);
  });
});

// ── unfinished spans ──────────────────────────────────────────────────
describe("buildTrajectory: steps still in flight", () => {
  const events = [turnStarted(0), said(1, "Working."), toolStart(2, "a", "Bash", { target: "sleep 999" })];

  it("runs an open tool to now while the thread is running", () => {
    const t = buildTrajectory(events, { running: true, now: ms(30) });
    const tool = t.spans.tools[0]!;
    expect(tool).toMatchObject({ status: "running", open: true, cut: false });
    expect(tool.end - T0).toBe(30_000);
    expect(t.running).toBe(true);
    expect(t.turns[0]).toMatchObject({ running: true, durationMs: 30_000 });
    expect(t.rows.find((r) => r.kind === "tool")).toMatchObject({ status: "running", durationMs: 28_000 });
  });

  it("runs the model's stretch to now when nothing is in flight but the turn", () => {
    const t = buildTrajectory([turnStarted(0), said(1, "hi")], { running: true, now: ms(9) });
    expect(t.spans.model).toHaveLength(1);
    expect(t.spans.model[0]).toMatchObject({ open: true, status: "running" });
    expect(t.spans.model[0]!.end - T0).toBe(9000);
  });

  it("does not run an old clock backwards when the client's clock is behind", () => {
    const t = buildTrajectory(events, { running: true, now: ms(-100) });
    expect(t.spans.tools[0]!.end - T0).toBe(2000);
  });

  it("calls a tool with no end 'unknown' when the thread is not running", () => {
    const t = buildTrajectory(events, { running: false, now: ms(500) });
    const tool = t.spans.tools[0]!;
    expect(tool).toMatchObject({ status: "unknown", open: false, cut: true });
    // measured to the last thing seen, never to now
    expect(tool.end - T0).toBe(2000);
    expect(t.turns[0]).toMatchObject({ running: false, cut: true });
    expect(t.running).toBe(false);
  });

  it("marks a tool that was open when its turn completed as unknown, not ok", () => {
    const t = buildTrajectory([turnStarted(0), toolStart(1, "a", "Bash"), turnDone(6)]);
    expect(t.spans.tools[0]).toMatchObject({ status: "unknown", cut: true });
    expect(t.spans.tools[0]!.end - T0).toBe(6000);
    expect(t.turns[0]!.ok).toBe(true);
  });

  it("cuts an unfinished turn when a new one starts", () => {
    const t = buildTrajectory([turnStarted(0, "t1"), toolStart(1, "a", "Bash"), turnStarted(50, "t2"), turnDone(52, {}, "t2")], { running: true });
    expect(t.turns.map((x) => [x.id, x.cut, x.running])).toEqual([
      ["t1", true, false],
      ["t2", false, false],
    ]);
    expect(t.spans.tools[0]).toMatchObject({ status: "unknown", cut: true });
  });

  it("is not running when the last turn has completed, whatever the caller says", () => {
    const t = buildTrajectory([turnStarted(0), turnDone(2)], { running: true });
    expect(t.running).toBe(false);
  });
});

// ── trimmed logs ──────────────────────────────────────────────────────
describe("buildTrajectory: a trimmed log", () => {
  it("says so when the log begins partway through a turn", () => {
    const t = buildTrajectory([toolEnd(1, "lost", true, "ok"), said(2, "Done."), turnDone(3)]);
    expect(t.trimmed).toBe(true);
    expect(t.turns[0]).toMatchObject({ startTrimmed: true });
    // the turn's Input tick is not invented for a start the log never saw
    expect(t.spans.input).toHaveLength(0);
  });

  it("keeps an outcome whose start is not in the log, with no invented duration", () => {
    const t = buildTrajectory([toolEnd(1, "lost", false, "boom")]);
    const row = t.rows[0]!;
    expect(row).toMatchObject({ kind: "tool", status: "error", result: "boom" });
    expect(row.durationMs).toBeUndefined();
    expect(t.spans.tools[0]).toMatchObject({ start: ms(1), end: ms(1), status: "error" });
  });

  it("does not call the first step of a trimmed log tool-call-only", () => {
    const t = buildTrajectory([toolStart(1, "a", "Read"), toolEnd(2, "a"), turnDone(3)]);
    expect(t.rows.some((r) => r.toolCallOnly)).toBe(false);
  });

  it("says so when the server reports older records on disk", () => {
    expect(buildTrajectory([turnStarted(0), turnDone(1)], { olderOnDisk: true }).trimmed).toBe(true);
    expect(buildTrajectory([turnStarted(0), turnDone(1)], { olderOnDisk: false }).trimmed).toBe(false);
  });

  it("says so when the task banked more settled turns than the log shows", () => {
    const events = [turnStarted(0), turnDone(1), turnStarted(10, "t2"), turnDone(11, {}, "t2")];
    expect(buildTrajectory(events, { knownTurns: 5 }).trimmed).toBe(true);
    expect(buildTrajectory(events, { knownTurns: 2 }).trimmed).toBe(false);
    // a running turn is not banked yet, so it is not held against the log
    expect(buildTrajectory([...events, turnStarted(20, "t3")], { knownTurns: 2, running: true }).trimmed).toBe(false);
  });
});

// ── inputs ────────────────────────────────────────────────────────────
describe("buildTrajectory: what the person said", () => {
  const user = (id: string, sec: number, text: string): TrajectoryInput => ({ id, at: ms(sec), role: "user", text });

  it("puts the message on the Input lane and in the list, ahead of the turn it started", () => {
    const t = buildTrajectory([turnStarted(0.2), said(1, "Hello."), turnDone(2)], { inputs: [user("m1", 0, "Hi there")] });
    expect(t.rows.map((r) => [r.kind, r.title])).toEqual([
      ["user", "You"],
      ["assistant", "Assistant"],
    ]);
    expect(t.rows[0]!.text).toBe("Hi there");
    // the message stands in for the turn's own tick
    expect(t.spans.input.map((s) => [s.kind, s.start - T0])).toEqual([["user", 0]]);
  });

  it("lists an injected system message as CONTEXT, with its label", () => {
    const t = buildTrajectory([turnStarted(1), turnDone(2)], {
      inputs: [{ id: "s1", at: ms(0.5), role: "system", text: "Run the nightly check", label: "Routine" }],
    });
    expect(t.rows[0]).toMatchObject({ kind: "context", title: "Routine", text: "Run the nightly check" });
    expect(t.spans.input[0]).toMatchObject({ kind: "context", label: "Routine" });
  });

  it("drops messages from before a trimmed log begins", () => {
    const t = buildTrajectory([turnStarted(1000), turnDone(1002)], { inputs: [user("old", 0, "ancient"), user("new", 999, "recent")] });
    expect(t.rows.map((r) => r.text)).toEqual(["recent"]);
  });

  it("sorts a message before an event in the same millisecond", () => {
    const t = buildTrajectory([said(1, "Reply."), turnDone(2)], { inputs: [user("m", 1, "Ask")] });
    expect(t.rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
  });

  it("keeps a queued message sent long before its turn as its own tick, and still marks the turn", () => {
    const t = buildTrajectory([turnStarted(100), turnDone(105)], { inputs: [user("q", 60, "queued")] });
    expect(t.spans.input.map((s) => s.kind)).toEqual(["user", "turn"]);
  });
});

// ── context and errors ────────────────────────────────────────────────
describe("buildTrajectory: context and error rows", () => {
  const t = buildTrajectory([
    { ...base(0, undefined), type: "session.started", sessionId: "s", model: "opus" },
    turnStarted(1),
    { ...base(2), type: "request.opened", requestType: "permission", tool: "Bash", summary: "run rm -rf build" },
    { ...base(3), type: "request.resolved", behavior: "allow", source: "user" },
    { ...base(4), type: "turn.retrying", attempt: 1, delayMs: 5000, reason: "overloaded", maxAttempts: 3 },
    { ...base(5), type: "runtime.error", message: "socket hang up" },
    turnDone(6, { ok: false, stopReason: "error" }),
  ]);

  it("shows session, permission, retry and resolution as CONTEXT", () => {
    const context = t.rows.filter((r) => r.kind === "context");
    expect(context.map((r) => r.title)).toEqual(["Session", "Permission requested", "Request resolved", "Retrying"]);
    expect(context[0]!.text).toBe("started · opus");
    expect(context[1]).toMatchObject({ args: "Bash", text: "run rm -rf build" });
    expect(context[2]!.text).toBe("allow · user");
    expect(context[3]!.text).toBe("overloaded · attempt 1/3 · in 5s");
  });

  it("shows an error and a failed turn as ERROR, and counts them", () => {
    expect(t.rows.filter((r) => r.kind === "error").map((r) => r.title)).toEqual(["Error", "Turn failed"]);
    expect(t.turns[0]).toMatchObject({ ok: false, errors: 2 });
  });
});

// ── robustness ────────────────────────────────────────────────────────
describe("buildTrajectory: messy input", () => {
  it("returns an empty trajectory for no events", () => {
    const t = buildTrajectory([]);
    expect(t).toMatchObject({ rows: [], turns: [], axis: null, bounds: null, running: false, trimmed: false, eventCount: 0 });
  });

  it("ignores a duplicate eventId (a live tail overlaps its history)", () => {
    const start = turnStarted(0);
    const t = buildTrajectory([start, start, turnDone(1)]);
    expect(t.eventCount).toBe(2);
    expect(t.turns).toHaveLength(1);
  });

  it("sorts events that arrive out of order", () => {
    const t = buildTrajectory([turnDone(5), toolEnd(3, "a"), toolStart(2, "a", "Read"), turnStarted(0)]);
    expect(t.spans.tools[0]).toMatchObject({ status: "ok" });
    expect(t.spans.tools[0]!.end - t.spans.tools[0]!.start).toBe(1000);
    expect(t.turns[0]).toMatchObject({ durationMs: 5000, startTrimmed: false });
  });

  it("skips an event with an unreadable timestamp", () => {
    const bad = { ...turnStarted(0), createdAt: "not a date" } as RuntimeEvent;
    const t = buildTrajectory([bad, turnStarted(1, "t2"), turnDone(2, {}, "t2")]);
    expect(t.eventCount).toBe(2);
  });

  it("matches a completion with no item id to the oldest open call", () => {
    const t = buildTrajectory([
      turnStarted(0),
      { ...base(1), type: "item.started", itemType: "tool", title: "A" } as RuntimeEvent,
      { ...base(2), type: "item.started", itemType: "tool", title: "B" } as RuntimeEvent,
      { ...base(3), type: "item.completed", itemType: "tool", ok: true } as RuntimeEvent,
      turnDone(9),
    ]);
    const [a, b] = t.spans.tools;
    expect(a).toMatchObject({ label: "A", status: "ok" });
    expect(a!.end - T0).toBe(3000);
    expect(b).toMatchObject({ label: "B", status: "unknown" });
  });

  it("copes with events that carry no turn id at all", () => {
    const t = buildTrajectory([
      { ...base(0, undefined), type: "turn.started" } as RuntimeEvent,
      { ...base(1, undefined), type: "item.started", itemType: "tool", itemId: "a", title: "Read" } as RuntimeEvent,
      { ...base(2, undefined), type: "item.completed", itemType: "tool", itemId: "a", ok: true } as RuntimeEvent,
      { ...base(3, undefined), type: "turn.completed", ok: true } as RuntimeEvent,
    ]);
    expect(t.turns).toHaveLength(1);
    expect(t.spans.tools[0]).toMatchObject({ status: "ok" });
  });

  it("gives every row a unique, stable id", () => {
    const events = [turnStarted(0), toolStart(1, "a", "Read"), toolEnd(2, "a"), said(3, "x"), turnDone(4)];
    const a = buildTrajectory(events).rows.map((r) => r.id);
    const b = buildTrajectory(events).rows.map((r) => r.id);
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(b);
  });

  it("copes with the same item id reused within a turn", () => {
    const t = buildTrajectory([turnStarted(0), toolStart(1, "x", "A"), toolStart(2, "x", "B"), toolEnd(3, "x"), toolEnd(4, "x"), turnDone(5)]);
    expect(t.spans.tools.map((s) => s.status)).toEqual(["ok", "ok"]);
  });
});

// ── the axis ──────────────────────────────────────────────────────────
describe("buildAxis / axisX", () => {
  it("has no axis for nothing", () => {
    expect(buildAxis([])).toBeNull();
  });

  it("lays out one continuous stretch linearly", () => {
    const axis = buildAxis([[0, 10_000]])!;
    expect(axis.gaps).toHaveLength(0);
    expect(axisX(axis, 0)).toBe(0);
    expect(axisX(axis, 5000)).toBeCloseTo(0.5);
    expect(axisX(axis, 10_000)).toBe(1);
  });

  it("merges intervals closer together than the gap threshold", () => {
    const axis = buildAxis([[0, 5000], [DEFAULT_GAP_MS, DEFAULT_GAP_MS + 5000]])!;
    expect(axis.segments).toHaveLength(1);
    expect(axis.gaps).toHaveLength(0);
  });

  it("collapses a long idle gap to a fixed-width marker", () => {
    const hour = 60 * 60 * 1000;
    const axis = buildAxis([[0, 10_000], [3 * hour, 3 * hour + 10_000]])!;
    expect(axis.segments).toHaveLength(2);
    expect(axis.gaps).toHaveLength(1);
    const gap = axis.gaps[0]!;
    expect(gap.ms).toBe(3 * hour - 10_000);
    // three hours of silence takes a few percent of the axis, not 99.9%
    expect(gap.x1 - gap.x0).toBeLessThan(0.1);
    expect(gap.x1 - gap.x0).toBeGreaterThan(0);
    // the second stretch begins where the gap ends
    expect(axis.segments[1]!.x0).toBeCloseTo(gap.x1);
    expect(axis.segments[1]!.x1).toBeCloseTo(1);
  });

  it("treats a weekend and an hour alike", () => {
    const day = 24 * 60 * 60 * 1000;
    const short = buildAxis([[0, 10_000], [60 * 60 * 1000, 60 * 60 * 1000 + 10_000]])!;
    const long = buildAxis([[0, 10_000], [3 * day, 3 * day + 10_000]])!;
    expect(long.gaps[0]!.x1 - long.gaps[0]!.x0).toBeCloseTo(short.gaps[0]!.x1 - short.gaps[0]!.x0);
  });

  it("is monotonic across gaps and clamps outside itself", () => {
    const hour = 60 * 60 * 1000;
    const axis = buildAxis([[0, 10_000], [hour, hour + 10_000], [5 * hour, 5 * hour + 10_000]])!;
    const points = [-1, 0, 5000, 10_000, hour / 2, hour, hour + 5000, hour + 10_000, 2 * hour, 5 * hour, 5 * hour + 10_000, 9 * hour];
    const xs = points.map((p) => axisX(axis, p));
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(xs[0]).toBe(0);
    expect(xs.at(-1)).toBe(1);
    expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
    // the middle of a gap lands on the gap's left edge
    expect(axisX(axis, hour / 2)).toBe(axis.gaps[0]!.x0);
  });

  it("gives a lone instant somewhere to be", () => {
    const axis = buildAxis([[5000, 5000]])!;
    expect(axis.segments).toHaveLength(1);
    expect(axisX(axis, 5000)).toBeGreaterThanOrEqual(0);
    expect(axisX(axis, 5000)).toBeLessThanOrEqual(1);
  });

  it("compresses the gaps between turns of a real trajectory", () => {
    const t = buildTrajectory([
      turnStarted(0, "t1"),
      toolStart(1, "a", "Read"),
      toolEnd(4, "a"),
      turnDone(6, {}, "t1"),
      turnStarted(3 * 3600, "t2"),
      turnDone(3 * 3600 + 10, {}, "t2"),
    ]);
    expect(t.axis!.gaps).toHaveLength(1);
    expect(t.axis!.gaps[0]!.ms).toBe(3 * 3600 * 1000 - 6000);
    const before = axisX(t.axis!, ms(6));
    const after = axisX(t.axis!, ms(3 * 3600));
    expect(after - before).toBeLessThan(0.15);
    expect(t.bounds).toEqual({ start: ms(0), end: ms(3 * 3600 + 10) });
  });

  it("does not collapse idle time inside a turn (a long tool is real time)", () => {
    const t = buildTrajectory([turnStarted(0), toolStart(1, "a", "Bash"), toolEnd(600, "a"), turnDone(601)]);
    expect(t.axis!.gaps).toHaveLength(0);
  });
});

// ── search, grouping, sorting ─────────────────────────────────────────
describe("filterRows", () => {
  const t = buildTrajectory(
    [
      turnStarted(0),
      said(1, "I will check the Config file"),
      toolStart(2, "a", "Read", { target: "src/config.ts" }),
      toolEnd(3, "a", true, "42 lines of TypeScript"),
      toolStart(4, "b", "Bash", { target: "pnpm test", arguments: JSON.stringify({ command: "pnpm test", timeout: 60 }) }),
      toolEnd(5, "b", false, "ENOENT: no such file"),
      turnDone(6),
    ],
    { inputs: [{ id: "u", at: ms(-0.5), role: "user", text: "Please run the suite" }] },
  );
  const titles = (q: string) => filterRows(t.rows, q).map((r) => r.title);

  it("returns every row for an empty or blank query", () => {
    expect(filterRows(t.rows, "")).toHaveLength(t.rows.length);
    expect(filterRows(t.rows, "   ")).toHaveLength(t.rows.length);
  });

  it("matches tool names, case-insensitively", () => {
    expect(titles("BASH")).toEqual(["Bash"]);
  });

  it("matches compact arguments and the full JSON arguments", () => {
    expect(titles("src/config")).toEqual(["Read"]);
    expect(titles("timeout")).toEqual(["Bash"]);
  });

  it("matches results", () => {
    expect(titles("enoent")).toEqual(["Bash"]);
    expect(titles("typescript")).toEqual(["Read"]);
  });

  it("matches assistant and user text", () => {
    expect(titles("config file")).toEqual(["Assistant"]);
    expect(titles("run the suite")).toEqual(["You"]);
  });

  it("needs every word, in any order", () => {
    expect(titles("test pnpm")).toEqual(["Bash"]);
    expect(titles("pnpm banana")).toEqual([]);
  });

  it("matches the badge, so 'tool' finds every tool call", () => {
    expect(filterRows(t.rows, "tool")).toHaveLength(2);
  });
});

describe("groupByTurn", () => {
  it("groups consecutive rows under their turn's summary, keeping order", () => {
    const t = buildTrajectory([
      turnStarted(0, "t1"),
      toolStart(1, "a", "Read", {}, "t1"),
      toolEnd(2, "a", true, undefined, "t1"),
      turnDone(3, {}, "t1"),
      turnStarted(100, "t2"),
      said(101, "Hello", "t2"),
      turnDone(102, {}, "t2"),
    ]);
    const groups = groupByTurn(t.rows, t.turns);
    expect(groups.map((g) => [g.turn?.index, g.rows.map((r) => r.kind)])).toEqual([
      [1, ["assistant", "tool"]],
      [2, ["assistant"]],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it("gives a turn that recorded no steps a group of its own, in place, when asked", () => {
    const t = buildTrajectory([
      turnStarted(0, "t1"),
      said(1, "Hello", "t1"),
      turnDone(2, {}, "t1"),
      turnStarted(100, "t2"),
      turnDone(105, {}, "t2"),
      turnStarted(200, "t3"),
      said(201, "Again", "t3"),
      turnDone(202, {}, "t3"),
    ]);
    expect(groupByTurn(t.rows, t.turns).map((g) => g.turn?.id)).toEqual(["t1", "t3"]);
    const groups = groupByTurn(t.rows, t.turns, { emptyTurnsFrom: 0 });
    expect(groups.map((g) => [g.turn?.id, g.rows.length])).toEqual([["t1", 1], ["t2", 0], ["t3", 1]]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
    // an empty turn from before the window is left out, and one after the last step goes last
    expect(groupByTurn(t.rows, t.turns, { emptyTurnsFrom: ms(150) }).map((g) => g.turn?.id)).toEqual(["t1", "t3"]);
    const tail = buildTrajectory([turnStarted(0, "a"), said(1, "x", "a"), turnDone(2, {}, "a"), turnStarted(50, "b"), turnDone(51, {}, "b")]);
    expect(groupByTurn(tail.rows, tail.turns, { emptyTurnsFrom: 0 }).map((g) => g.turn?.id)).toEqual(["a", "b"]);
  });

  it("keeps the message and session that began a turn with that turn", () => {
    const t = buildTrajectory(
      [
        { ...base(0, undefined), type: "session.started", sessionId: "s" },
        turnStarted(1, "t1"),
        said(2, "Hello", "t1"),
        turnDone(3, {}, "t1"),
        turnStarted(100, "t2"),
        said(101, "Again", "t2"),
        turnDone(102, {}, "t2"),
      ],
      { inputs: [{ id: "u1", at: ms(0.5), role: "user", text: "hi" }, { id: "u2", at: ms(99.5), role: "user", text: "more" }] },
    );
    const groups = groupByTurn(t.rows, t.turns);
    expect(groups.map((g) => [g.turn?.id, g.rows.map((r) => r.title)])).toEqual([
      ["t1", ["Session", "You", "Assistant"]],
      ["t2", ["You", "Assistant"]],
    ]);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(t.rows.length);
  });

  it("puts rows after the last turn in a group of their own instead of dropping them", () => {
    const t = buildTrajectory([turnStarted(1), said(2, "Hello"), turnDone(3)], {
      inputs: [{ id: "u", at: ms(50), role: "user", text: "still there?" }],
    });
    const groups = groupByTurn(t.rows, t.turns);
    expect(groups.map((g) => [g.turn?.id, g.rows.map((r) => r.kind)])).toEqual([
      ["t1", ["assistant"]],
      [undefined, ["user"]],
    ]);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(t.rows.length);
  });

  it("keeps a turn-less row between two of one turn's rows with that turn", () => {
    const t = buildTrajectory([turnStarted(1), said(2, "a"), { ...base(3, undefined), type: "session.exited" } as RuntimeEvent, said(4, "b"), turnDone(5)]);
    // the session row carries no turn id of its own, but the turn was open
    expect(groupByTurn(t.rows, t.turns)).toHaveLength(1);
  });
});

describe("toolCalls / sortCalls", () => {
  const t = buildTrajectory([
    turnStarted(0),
    toolStart(1, "a", "Read"),
    toolEnd(2, "a"),
    toolStart(3, "b", "Bash"),
    toolEnd(10, "b"),
    toolStart(11, "c", "Grep"),
    toolEnd(13, "c"),
    turnDone(14),
  ]);
  const calls = toolCalls(t.rows);

  it("keeps only tool rows", () => {
    expect(calls.map((c) => c.title)).toEqual(["Read", "Bash", "Grep"]);
  });

  it("sorts by duration, longest first when descending", () => {
    expect(sortCalls(calls, "duration", true).map((c) => c.title)).toEqual(["Bash", "Grep", "Read"]);
    expect(sortCalls(calls, "duration", false).map((c) => c.title)).toEqual(["Read", "Grep", "Bash"]);
  });

  it("sorts by tool name and by start", () => {
    expect(sortCalls(calls, "tool", false).map((c) => c.title)).toEqual(["Bash", "Grep", "Read"]);
    expect(sortCalls(calls, "start", true).map((c) => c.title)).toEqual(["Grep", "Bash", "Read"]);
  });

  it("does not mutate its input", () => {
    const before = calls.map((c) => c.title);
    sortCalls(calls, "duration", true);
    expect(calls.map((c) => c.title)).toEqual(before);
  });
});

// ── formatting ────────────────────────────────────────────────────────
describe("compactArgs / compactResult", () => {
  it("prefers the engine's own headline", () => {
    expect(compactArgs("src/a.ts", '{"file_path":"src/a.ts","limit":10}')).toBe("src/a.ts");
  });

  it("turns JSON arguments into key=value pairs", () => {
    expect(compactArgs(undefined, '{"path":"src/a.ts","recursive":true,"depth":3,"filters":["a","b"],"opts":{"x":1}}')).toBe(
      'path="src/a.ts", recursive=true, depth=3, filters=[2], opts={…}',
    );
  });

  it("shows a payload that is not JSON as the text it is", () => {
    expect(compactArgs(undefined, "ls -la   /tmp")).toBe("ls -la /tmp");
  });

  it("has nothing to say for nothing", () => {
    expect(compactArgs(undefined, undefined)).toBeUndefined();
    expect(compactArgs("  ", "")).toBeUndefined();
    expect(compactArgs(undefined, "{}")).toBeUndefined();
    expect(compactResult(undefined)).toBeUndefined();
    expect(compactResult("   ")).toBeUndefined();
  });

  it("flattens whitespace and clips with an ellipsis", () => {
    expect(compactResult("line one\n\n  line two")).toBe("line one line two");
    const clipped = compactResult("x".repeat(500))!;
    expect(clipped).toHaveLength(120);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipLine("abc", 10)).toBe("abc");
  });

  it("clips a long string value inside JSON arguments", () => {
    const out = compactArgs(undefined, JSON.stringify({ content: "z".repeat(500) }))!;
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe("formatClock / formatGap", () => {
  it("prints the local time with seconds", () => {
    const at = new Date(2026, 8, 29, 14, 3, 7).getTime();
    expect(formatClock(at)).toBe("14:03:07");
    expect(formatClock(Number.NaN)).toBe("--:--:--");
  });

  it("says how long a gap was", () => {
    expect(formatGap(45_000)).toBe("45s later");
    expect(formatGap(90_000)).toBe("2m later");
    expect(formatGap(12 * 60_000)).toBe("12m later");
    expect(formatGap(2 * 3600_000 + 10 * 60_000)).toBe("2h 10m later");
    expect(formatGap(3 * 3600_000)).toBe("3h later");
  });
});

describe("inputsFromMessages", () => {
  const msg = (over: Record<string, unknown>) => ({ id: "m", at: 1000, role: "user" as const, kind: "text", text: "hello", ...over });

  it("keeps what people and automations said, and leaves the bot's own replies out", () => {
    const inputs = inputsFromMessages([
      msg({ id: "u", role: "user" }),
      msg({ id: "b", role: "bot", text: "reply" }),
      msg({ id: "s", role: "system", text: "nightly", automationSource: "schedule" }),
    ]);
    expect(inputs.map((i) => [i.id, i.role, i.label])).toEqual([
      ["u", "user", undefined],
      ["s", "system", "Routine"],
    ]);
  });

  it("leaves out cards, activity chips, empty text, queued messages and bad times", () => {
    expect(
      inputsFromMessages([
        msg({ id: "a", kind: "activity" }),
        msg({ id: "e", text: "   " }),
        msg({ id: "n", text: undefined }),
        msg({ id: "q", queued: true }),
        msg({ id: "t", at: Number.NaN }),
      ]),
    ).toEqual([]);
  });

  it("labels each way an automation can fire, and falls back for an unknown one", () => {
    const labels = ["schedule", "manual", "webhook", "resource", "delegation", "imessage", "mystery"].map(
      (automationSource) => inputsFromMessages([msg({ role: "system", automationSource })])[0]!.label,
    );
    expect(labels).toEqual(["Routine", "Manual run", "Webhook", "Resource trigger", "Delegation", "iMessage", undefined]);
    // the trajectory then calls an unlabelled one a system message
    const t = buildTrajectory([turnStarted(1), turnDone(2)], { inputs: [{ id: "x", at: ms(0.5), role: "system", text: "go" }] });
    expect(t.rows[0]!.title).toBe("System message");
  });
});

describe("fitLabels", () => {
  const label = (x: number, text: string, align: "left" | "center" | "right" = "left") => ({ x, text, align });

  it("keeps everything when there is room", () => {
    const labels = [label(0, "14:00:00"), label(0.5, "15:00:00"), label(1, "16:00:00", "right")];
    expect(fitLabels(labels, 800)).toEqual(labels);
  });

  it("drops a label that would print on top of a neighbour", () => {
    const labels = [label(0, "14:00:00"), label(0.5, "15:00:00"), label(0.52, "15:10:00"), label(1, "16:00:00", "right")];
    const kept = fitLabels(labels, 400);
    expect(kept.map((l) => l.text)).toEqual(["14:00:00", "15:00:00", "16:00:00"]);
  });

  it("always keeps where the strip starts and ends, dropping middle labels for them", () => {
    // the middle label sits where the end label needs to go
    const labels = [label(0, "14:00:00"), label(0.93, "15:00:00"), label(1, "16:00:00", "right")];
    expect(fitLabels(labels, 300).map((l) => l.text)).toEqual(["14:00:00", "16:00:00"]);
  });

  it("handles centred captions and returns them in strip order", () => {
    const labels = [label(0.2, "1h 59m later", "center"), label(0.27, "1h 30m later", "center")];
    expect(fitLabels(labels, 720)).toHaveLength(1);
    expect(fitLabels([label(0.1, "1h 59m later", "center"), label(0.8, "1h 30m later", "center")], 720).map((l) => l.x)).toEqual([0.1, 0.8]);
  });

  it("copes with no labels and with a strip too narrow for any", () => {
    expect(fitLabels([], 400)).toEqual([]);
    expect(fitLabels([label(0, "14:00:00"), label(1, "16:00:00", "right")], 60).map((l) => l.text)).toEqual(["14:00:00"]);
  });
});
