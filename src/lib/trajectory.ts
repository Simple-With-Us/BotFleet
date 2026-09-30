// A thread's trajectory: what a bot actually did, in order, and where the time
// went.  Pure math over the runtime events the harness already logs
// (server/harness/bus.ts) — no measurement happens here, so it is exactly as
// honest as the timestamps on those events.
//
// From one event list this builds three things the Trajectory tab shows:
//
//   spans — three lanes over a time axis.  Input is the instant a person (or
//           a routine) spoke.  Model is the time the model was working: a turn
//           starting, or the last tool finishing, up to the next tool starting
//           or the turn ending, with reasoning called out inside it.  Tools is
//           each tool call, item.started to item.completed, overlapping calls
//           stacked on their own rows.
//   rows  — one line per step for the searchable list: USER, ASSISTANT,
//           TOOL, REASONING, CONTEXT, ERROR.
//   turns — per-turn duration and tokens, for the grouped view.
//
// The axis compresses long idle gaps between turns to a fixed-width marker, so
// a thread that spanned a weekend is as readable as one that took ten minutes.
//
// What the event stream cannot say, this does not pretend to know: a tool that
// never completed is "unknown" (or "running", while its turn is), not "ok";
// a log that starts mid-turn says so (`trimmed`) rather than presenting its
// first step as the thread's first.
import type { RuntimeEvent } from "../../server/contracts.ts";
import type { ToolKind } from "../../shared/tool-activity";
import { formatDuration } from "./thread-stats";

export type Lane = "input" | "model" | "tools";
export type RowKind = "user" | "assistant" | "tool" | "reasoning" | "context" | "error";
/** `ok`/`error` are outcomes; `running` is a step still in flight; `unknown`
 *  is a step that started and never reported an end (interrupted, or the end
 *  fell outside the log). */
export type SpanStatus = "ok" | "error" | "running" | "unknown";
export type SpanKind = "user" | "context" | "turn" | "model" | "reasoning" | "tool";

/** Something a person (or an automation) put into the thread.  Not in the
 *  runtime event stream — it comes from the thread's own messages. */
export interface TrajectoryInput {
  id: string;
  /** epoch ms */
  at: number;
  role: "user" | "system";
  text: string;
  /** What fired a system message ("Routine", "Webhook"…). */
  label?: string;
}

export interface BuildOptions {
  inputs?: readonly TrajectoryInput[];
  /** Epoch ms that a step still in flight is measured to.  Defaults to the
   *  newest event's time. */
  now?: number;
  /** Whether the thread is working right now.  False (the default) means a
   *  turn with no completion was interrupted, not running. */
  running?: boolean;
  /** The server reported older records still on disk behind this page. */
  olderOnDisk?: boolean;
  /** How many settled turns the task has banked.  More than the log shows
   *  means the log was trimmed from the front. */
  knownTurns?: number;
  /** An idle stretch longer than this collapses on the axis. */
  gapMs?: number;
}

export interface Span {
  id: string;
  lane: Lane;
  kind: SpanKind;
  /** "Read", "Model", "Reasoning", "You" */
  label: string;
  start: number;
  end: number;
  status: SpanStatus;
  /** Still in flight at `now`: its right edge is the present, not an event. */
  open: boolean;
  /** Started and never reported an end; drawn to the last thing seen. */
  cut: boolean;
  /** Stacking row within the lane (overlapping tool calls). */
  row: number;
  turnIndex?: number;
  /** The list row this span is, so a click can jump to it. */
  rowId?: string;
}

export interface RowDetail {
  target?: string;
  arguments?: string;
  result?: string;
  text?: string;
  meta: Array<[label: string, value: string]>;
}

export interface TrajectoryRow {
  id: string;
  kind: RowKind;
  at: number;
  endAt?: number;
  durationMs?: number;
  turnId?: string;
  turnIndex?: number;
  /** Tool name, "You", "Assistant", "Reasoning", a request's tool. */
  title: string;
  /** Compact one-line arguments. */
  args?: string;
  /** Compact one-line result. */
  result?: string;
  /** Compact one-line text (assistant / user / context / error). */
  text?: string;
  /** An assistant step that only called tools and said nothing. */
  toolCallOnly?: boolean;
  status?: SpanStatus;
  toolKind?: ToolKind;
  detail: RowDetail;
  /** Lowercased haystack the search box matches against. */
  searchText: string;
}

export interface TurnSummary {
  id: string;
  index: number;
  start: number;
  end: number;
  durationMs: number;
  running: boolean;
  /** No completion was seen and the thread is not running. */
  cut: boolean;
  /** The log begins partway through this turn. */
  startTrimmed: boolean;
  ok?: boolean;
  stopReason?: string | null;
  input?: number;
  output?: number;
  cachedInput?: number;
  costUsd?: number | null;
  toolCalls: number;
  /** Wall time with at least one tool running. */
  toolMs: number;
  modelMs: number;
  errors: number;
}

export interface AxisSegment {
  start: number;
  end: number;
  /** Layout position, 0..1 */
  x0: number;
  x1: number;
}
export interface AxisGap {
  from: number;
  to: number;
  x0: number;
  x1: number;
  ms: number;
}
export interface Axis {
  segments: AxisSegment[];
  gaps: AxisGap[];
}

export interface Trajectory {
  rows: TrajectoryRow[];
  turns: TurnSummary[];
  spans: { input: Span[]; model: Span[]; tools: Span[] };
  /** How many stacking rows the Tools lane needs. */
  toolRows: number;
  axis: Axis | null;
  bounds: { start: number; end: number } | null;
  running: boolean;
  /** Older steps than the first one shown existed and are not in the log. */
  trimmed: boolean;
  eventCount: number;
}

// ── small formatting ──────────────────────────────────────────────────

/** An idle stretch at least this long collapses on the axis. */
export const DEFAULT_GAP_MS = 60_000;
/** Most stacking rows the Tools lane draws; further overlap shares the last. */
export const MAX_TOOL_ROWS = 4;
/** A message this far before the first event still belongs to it: the person
 *  spoke, then the turn started. */
const INPUT_SLACK_MS = 60_000;
/** A message this close before a turn started is what started it. */
const TURN_INPUT_WINDOW_MS = 10_000;

const ROW_TEXT_LIMIT = 400;
const ARGS_LIMIT = 120;
const RESULT_LIMIT = 120;
const DETAIL_TEXT_LIMIT = 4000;

export const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export function clipLine(value: string, limit: number): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function valueSummary(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(clipLine(value, 48));
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return "{…}";
  return "";
}

/** One line for what a tool was asked.  An engine-supplied `target` (already a
 *  headline: the command, the path) wins; otherwise the JSON arguments become
 *  `key=value` pairs; a payload that is not JSON is shown as the text it is. */
export function compactArgs(target: string | undefined, argumentsJson: string | undefined, limit: number = ARGS_LIMIT): string | undefined {
  if (target && target.trim()) return clipLine(target, limit);
  if (!argumentsJson || !argumentsJson.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pairs = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => `${key}=${valueSummary(value)}`);
      return pairs.length ? clipLine(pairs.join(", "), limit) : undefined;
    }
    return clipLine(valueSummary(parsed), limit);
  } catch {
    return clipLine(argumentsJson, limit);
  }
}

export function compactResult(detail: string | undefined, limit: number = RESULT_LIMIT): string | undefined {
  if (!detail || !detail.trim()) return undefined;
  return clipLine(detail, limit);
}

/** Arguments for the expanded view: pretty JSON when it parses. */
function prettyArguments(argumentsJson: string | undefined): string | undefined {
  if (!argumentsJson || !argumentsJson.trim()) return undefined;
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    return argumentsJson;
  }
}

/** 850 → "850ms", 7_300 → "7.3s", 280_000 → "4m40s", 3_900_000 → "1h05m". */
export const formatSpan = (ms: number): string => formatDuration(ms) ?? "0ms";

/** 24-hour local clock, seconds included: "14:03:07". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** What a collapsed gap says: "2h 10m later", "12m later", "1m 30s later". */
export function formatGap(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes >= 60) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m ? `${h}h ${m}m later` : `${h}h later`;
  }
  if (totalMinutes >= 2) return `${totalMinutes}m later`;
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s later` : `${seconds}s later`;
}

export const ROW_KIND_LABEL: Record<RowKind, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  reasoning: "REASONING",
  context: "CONTEXT",
  error: "ERROR",
};

// ── the time axis ─────────────────────────────────────────────────────

/**
 * Lays `intervals` (each `[start, end]`, a tick being `start === end`) out on a
 * 0..1 axis, merging any that sit within `gapMs` of each other into one
 * segment and replacing every longer silence with a fixed-width gap.  A gap is
 * a few percent of the axis whatever it really was, so a weekend and an hour
 * look alike — what matters is that time passed, and the label says how much.
 */
export function buildAxis(intervals: ReadonlyArray<readonly [number, number]>, gapMs: number = DEFAULT_GAP_MS): Axis | null {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (sorted.length === 0) return null;

  const merged: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a - last[1] <= gapMs) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  // an instant still takes a sliver of axis, or a lone tick has nowhere to sit
  const lengthOf = ([a, b]: [number, number]) => Math.max(b - a, 1);
  const active = merged.reduce((sum, seg) => sum + lengthOf(seg), 0);
  // a collapsed gap: 4% of the active time, never more than the threshold that
  // made it a gap (so it is always shorter than what it replaces)
  const gapUnit = Math.min(gapMs, Math.max(active * 0.04, 1500));
  const total = active + gapUnit * (merged.length - 1);

  const segments: AxisSegment[] = [];
  const gaps: AxisGap[] = [];
  let cursor = 0;
  merged.forEach((seg, i) => {
    if (i > 0) {
      const previous = merged[i - 1]!;
      gaps.push({ from: previous[1], to: seg[0], x0: cursor / total, x1: (cursor + gapUnit) / total, ms: seg[0] - previous[1] });
      cursor += gapUnit;
    }
    const length = lengthOf(seg);
    segments.push({ start: seg[0], end: seg[1], x0: cursor / total, x1: (cursor + length) / total });
    cursor += length;
  });
  return { segments, gaps };
}

/** Where `at` sits on the axis, 0..1.  A moment inside a collapsed gap lands on
 *  the gap's left edge; one outside the axis clamps to its ends. */
export function axisX(axis: Axis, at: number): number {
  const segments = axis.segments;
  if (segments.length === 0) return 0;
  if (at <= segments[0]!.start) return segments[0]!.x0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (at <= seg.end) {
      const length = Math.max(seg.end - seg.start, 1);
      return seg.x0 + ((at - seg.start) / length) * (seg.x1 - seg.x0);
    }
    const next = segments[i + 1];
    if (next && at < next.start) return seg.x1;
  }
  return segments.at(-1)!.x1;
}

// ── keeping axis labels from printing on top of each other ────────────

export interface AxisLabel {
  /** Position along the strip, 0..1 */
  x: number;
  text: string;
  /** Which side of `x` the text extends to. */
  align: "left" | "center" | "right";
}

/**
 * The labels that fit on a strip `widthPx` wide without touching, in order.
 * Text width is estimated (`charPx` per character of a small tabular figure),
 * which is close enough for a caption and needs no measuring.  The first and
 * last labels are placed first — where the strip starts and ends is the one
 * thing a reader always wants — then the rest, left to right, each dropped if
 * it would land on one already placed.
 */
export function fitLabels<T extends AxisLabel>(labels: readonly T[], widthPx: number, charPx = 6.2, spacingPx = 10): T[] {
  const extent = (label: T): [number, number] => {
    const width = label.text.length * charPx;
    const x = label.x * widthPx;
    if (label.align === "left") return [x, x + width];
    if (label.align === "right") return [x - width, x];
    return [x - width / 2, x + width / 2];
  };
  const order = labels.length <= 2 ? [...labels] : [labels[0]!, labels[labels.length - 1]!, ...labels.slice(1, -1)];
  const placed: Array<{ label: T; lo: number; hi: number }> = [];
  for (const label of order) {
    const [lo, hi] = extent(label);
    if (placed.every((other) => hi + spacingPx <= other.lo || lo >= other.hi + spacingPx)) placed.push({ label, lo, hi });
  }
  return placed.map((entry) => entry.label).sort((a, b) => a.x - b.x);
}

// ── building ──────────────────────────────────────────────────────────

interface MutableRow extends TrajectoryRow {
  seq: number;
}

interface Call {
  key: string;
  itemId?: string;
  row: MutableRow;
  span: Span;
  start: number;
}

interface TurnAcc {
  index: number;
  id: string;
  start: number;
  startTrimmed: boolean;
  completed: boolean;
  cut: boolean;
  end: number;
  ok?: boolean;
  stopReason?: string | null;
  costUsd?: number | null;
  usage?: { input: number; output?: number; cachedInput?: number };
  liveUsage?: { input: number; output?: number; cachedInput?: number };
  calls: Map<string, Call>;
  toolIntervals: Array<[number, number]>;
  toolCount: number;
  errors: number;
  modelMs: number;
  /** Where the model's current stretch began; null while a tool runs. */
  pieceStart: number | null;
  reasonStart: number | null;
  reasonRow: MutableRow | null;
  reasonItemId?: string;
  stepHasText: boolean;
  lastAt: number;
}

interface Stamped {
  event: RuntimeEvent;
  at: number;
  seq: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Events in time order, one per eventId (a live tail overlaps the history it
 *  was appended to), stable where two share a millisecond. */
function prepare(events: readonly RuntimeEvent[]): Stamped[] {
  const seen = new Set<string>();
  const out: Stamped[] = [];
  events.forEach((event, seq) => {
    if (event.eventId) {
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
    }
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) return;
    out.push({ event, at, seq });
  });
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [a, b] of sorted) {
    if (Number.isNaN(curStart)) {
      curStart = a;
      curEnd = b;
    } else if (a <= curEnd) {
      curEnd = Math.max(curEnd, b);
    } else {
      total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

const SYSTEM_LABEL = "System message";

export function buildTrajectory(rawEvents: readonly RuntimeEvent[], options: BuildOptions = {}): Trajectory {
  const stamped = prepare(rawEvents);
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  const lastEventAt = stamped.at(-1)?.at ?? 0;
  const now = Math.max(options.now ?? lastEventAt, lastEventAt);

  const rows: MutableRow[] = [];
  const inputSpans: Span[] = [];
  const modelSpans: Span[] = [];
  const toolSpans: Span[] = [];
  const turns: TurnAcc[] = [];
  const turnsById = new Map<string, TurnAcc>();
  let seq = 0;
  let implicit = 0;

  const currentTurn = (): TurnAcc | null => {
    const last = turns.at(-1);
    return last && !last.completed && !last.cut ? last : null;
  };

  const newTurn = (id: string, at: number, startTrimmed: boolean): TurnAcc => {
    const turn: TurnAcc = {
      index: turns.length + 1,
      id,
      start: at,
      startTrimmed,
      completed: false,
      cut: false,
      end: at,
      calls: new Map(),
      toolIntervals: [],
      toolCount: 0,
      errors: 0,
      modelMs: 0,
      pieceStart: at,
      reasonStart: null,
      reasonRow: null,
      stepHasText: false,
      lastAt: at,
    };
    turns.push(turn);
    turnsById.set(id, turn);
    return turn;
  };

  /** A new turn superseded an unfinished one: that one is over, whatever it
   *  did or did not report. */
  const cutTurn = (turn: TurnAcc) => {
    if (turn.completed || turn.cut) return;
    finishOpen(turn, turn.lastAt, false);
    turn.cut = true;
    turn.end = turn.lastAt;
  };

  const turnFor = (event: RuntimeEvent, at: number, create: boolean): TurnAcc | null => {
    if (event.turnId) {
      const known = turnsById.get(event.turnId);
      if (known) return known;
      if (!create) return null;
      const open = currentTurn();
      if (open) cutTurn(open);
      return newTurn(event.turnId, at, true);
    }
    const open = currentTurn();
    if (open) return open;
    if (!create) return null;
    implicit += 1;
    return newTurn(`~${implicit}`, at, true);
  };

  const pushRow = (row: Omit<TrajectoryRow, "searchText" | "detail"> & { detail?: RowDetail }): MutableRow => {
    const detail: RowDetail = row.detail ?? { meta: [] };
    const full: MutableRow = { ...row, detail, seq: seq++, searchText: "" };
    rows.push(full);
    return full;
  };

  const emitModel = (turn: TurnAcc, from: number, to: number, kind: "model" | "reasoning", open = false) => {
    if (!(to > from)) return;
    turn.modelMs += to - from;
    modelSpans.push({
      id: `${kind}:${turn.id}:${from}`,
      lane: "model",
      kind,
      label: kind === "reasoning" ? "Reasoning" : "Model",
      start: from,
      end: to,
      status: open ? "running" : "ok",
      open,
      cut: false,
      row: 0,
      turnIndex: turn.index,
    });
  };

  /** The reasoning run ends here; the model stretch before it, and the run
   *  itself, become spans, and the model carries on from `at`. */
  const endReasoning = (turn: TurnAcc, at: number, open = false) => {
    if (turn.reasonStart !== null) {
      const from = turn.reasonStart;
      if (turn.pieceStart !== null) {
        emitModel(turn, turn.pieceStart, from, "model");
        emitModel(turn, from, at, "reasoning", open);
        turn.pieceStart = at;
      }
    }
    // a run that began while a tool was running has a row but no span
    if (turn.reasonRow) {
      turn.reasonRow.endAt = at;
      turn.reasonRow.durationMs = Math.max(0, at - turn.reasonRow.at);
    }
    turn.reasonStart = null;
    turn.reasonRow = null;
    turn.reasonItemId = undefined;
  };

  /** The model's stretch ends at `at`: a tool started, or the turn did. */
  const closePiece = (turn: TurnAcc, at: number, open = false) => {
    endReasoning(turn, at, open);
    if (turn.pieceStart !== null) {
      emitModel(turn, turn.pieceStart, at, "model", open);
      turn.pieceStart = null;
    }
  };

  /** Ends whatever is still in flight at `at`.  `running` says whether that is
   *  because the moment is now (still going) or because nothing more came. */
  function finishOpen(turn: TurnAcc, at: number, running: boolean) {
    for (const call of turn.calls.values()) {
      const end = Math.max(at, call.start);
      call.span.end = end;
      call.span.open = running;
      call.span.cut = !running;
      call.span.status = running ? "running" : "unknown";
      call.row.status = call.span.status;
      call.row.endAt = end;
      call.row.durationMs = end - call.start;
      turn.toolIntervals.push([call.start, end]);
    }
    turn.calls.clear();
    closePiece(turn, at, running);
  }

  const startCall = (turn: TurnAcc, e: Extract<RuntimeEvent, { type: "item.started" }>, at: number) => {
    const wasIdle = turn.calls.size === 0;
    if (wasIdle) {
      const hadPiece = turn.pieceStart !== null;
      closePiece(turn, at);
      // the model spoke by acting: a step that called a tool and said nothing.
      // Not claimed for the first thing a trimmed log shows: what came before
      // it is not here to say.
      const firstOfTrimmedLog = turn.startTrimmed && at === turn.start && turn.toolCount === 0;
      if (hadPiece && !turn.stepHasText && !firstOfTrimmedLog) {
        pushRow({
          id: `step:${e.eventId}`,
          kind: "assistant",
          at,
          turnId: turn.id,
          turnIndex: turn.index,
          title: "Assistant",
          toolCallOnly: true,
        });
      }
    }
    turn.toolCount += 1;
    const title = e.title?.trim() || "tool";
    const args = compactArgs(e.target, e.arguments);
    const row = pushRow({
      id: `tool:${e.eventId}`,
      kind: "tool",
      at,
      turnId: turn.id,
      turnIndex: turn.index,
      title,
      args,
      status: "running",
      toolKind: e.toolKind,
      detail: {
        target: e.target,
        arguments: prettyArguments(e.arguments),
        meta: [],
      },
    });
    const span: Span = {
      id: `tool:${e.eventId}`,
      lane: "tools",
      kind: "tool",
      label: title,
      start: at,
      end: at,
      status: "running",
      open: true,
      cut: false,
      row: 0,
      turnIndex: turn.index,
      rowId: row.id,
    };
    toolSpans.push(span);
    const key = e.itemId ?? `~${row.seq}`;
    // a repeated itemId (some engines reuse one) queues behind the first
    const unique = turn.calls.has(key) ? `${key}~${row.seq}` : key;
    turn.calls.set(unique, { key: unique, itemId: e.itemId, row, span, start: at });
  };

  const completeCall = (turn: TurnAcc | null, e: Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>, at: number) => {
    let owner = turn;
    let call: Call | undefined;
    const search = (t: TurnAcc) => {
      if (e.itemId) {
        for (const candidate of t.calls.values()) {
          if (candidate.itemId === e.itemId) return candidate;
        }
        return undefined;
      }
      // no id to match on: the oldest call still open
      return t.calls.values().next().value as Call | undefined;
    };
    if (owner) call = search(owner);
    if (!call) {
      // a completion that names a turn other than the one it landed in
      for (const candidate of turns) {
        if (candidate === owner || candidate.calls.size === 0) continue;
        const found = search(candidate);
        if (found) {
          owner = candidate;
          call = found;
          break;
        }
      }
    }
    if (!call || !owner) {
      // The start is not in this log (trimmed), or never came.  Keep the
      // outcome as a step with no duration rather than dropping what it said.
      const row = pushRow({
        id: `tool:${e.eventId}`,
        kind: "tool",
        at,
        turnId: turn?.id,
        turnIndex: turn?.index,
        title: "tool",
        result: compactResult(e.detail),
        status: e.ok ? "ok" : "error",
        detail: { arguments: prettyArguments(e.arguments), result: e.detail, meta: [["Note", "The start of this step is not in the log"]] },
      });
      if (!e.ok && turn) turn.errors += 1;
      toolSpans.push({
        id: `tool:${e.eventId}`,
        lane: "tools",
        kind: "tool",
        label: "tool",
        start: at,
        end: at,
        status: row.status ?? "unknown",
        open: false,
        cut: false,
        row: 0,
        turnIndex: turn?.index,
        rowId: row.id,
      });
      return;
    }
    owner.calls.delete(call.key);
    call.span.end = Math.max(at, call.start);
    call.span.open = false;
    call.span.status = e.ok ? "ok" : "error";
    call.row.status = call.span.status;
    call.row.endAt = call.span.end;
    call.row.durationMs = call.span.end - call.start;
    call.row.result = compactResult(e.detail);
    call.row.detail.result = e.detail;
    if (e.arguments) {
      call.row.detail.arguments = prettyArguments(e.arguments);
      if (!call.row.args) call.row.args = compactArgs(undefined, e.arguments);
    }
    if (!e.ok) owner.errors += 1;
    owner.toolIntervals.push([call.start, call.span.end]);
    if (owner.calls.size === 0) {
      // the model has the results and is working again
      owner.pieceStart = at;
      owner.stepHasText = false;
    }
  };

  const noteReasoning = (turn: TurnAcc, e: RuntimeEvent, at: number, tokens?: number | null) => {
    const itemId = e.itemId;
    // a new reasoning item ends the previous run and starts its own
    if (turn.reasonStart !== null && itemId && turn.reasonItemId && itemId !== turn.reasonItemId) endReasoning(turn, at);
    if (turn.reasonStart === null && turn.pieceStart !== null) {
      turn.reasonStart = at;
      turn.reasonItemId = itemId;
    }
    if (!turn.reasonRow) {
      turn.reasonRow = pushRow({
        id: `reasoning:${e.eventId}`,
        kind: "reasoning",
        at,
        turnId: turn.id,
        turnIndex: turn.index,
        title: "Reasoning",
        status: "ok",
      });
    }
    if (finite(tokens)) {
      const previous = Number(turn.reasonRow.detail.meta.find(([label]) => label === "Tokens")?.[1] ?? 0);
      const best = Math.max(previous, tokens);
      turn.reasonRow.detail.meta = [["Tokens", String(best)]];
      turn.reasonRow.text = `about ${best.toLocaleString("en-US")} tokens`;
    }
  };

  // ── walk the events ───────────────────────────────────────────────
  for (const { event: e, at } of stamped) {
    switch (e.type) {
      case "turn.started": {
        const open = currentTurn();
        const existing = e.turnId ? turnsById.get(e.turnId) : undefined;
        if (open && open !== existing) cutTurn(open);
        if (existing) {
          // its earlier events arrived out of order; this is the real start
          existing.start = Math.min(existing.start, at);
          existing.startTrimmed = false;
          existing.pieceStart ??= at;
          existing.lastAt = Math.max(existing.lastAt, at);
        } else {
          newTurn(e.turnId ?? `~${++implicit}`, at, false);
        }
        break;
      }
      case "turn.completed": {
        const turn = turnFor(e, at, true)!;
        finishOpen(turn, at, false);
        turn.completed = true;
        turn.end = at;
        turn.lastAt = at;
        turn.ok = e.ok;
        turn.stopReason = e.stopReason;
        turn.costUsd = e.cost;
        if (e.usage) turn.usage = e.usage;
        if (!e.ok) {
          turn.errors += 1;
          pushRow({
            id: `error:${e.eventId}`,
            kind: "error",
            at,
            turnId: turn.id,
            turnIndex: turn.index,
            title: "Turn failed",
            text: e.stopReason ? clipLine(String(e.stopReason), ROW_TEXT_LIMIT) : undefined,
            status: "error",
            detail: { text: e.stopReason ?? undefined, meta: e.denials?.length ? [["Denied", e.denials.join(", ")]] : [] },
          });
        }
        break;
      }
      case "item.started": {
        const turn = turnFor(e, at, true)!;
        turn.lastAt = Math.max(turn.lastAt, at);
        if (e.itemType === "tool") startCall(turn, e, at);
        else noteReasoning(turn, e, at);
        break;
      }
      case "item.updated": {
        const turn = turnFor(e, at, true)!;
        turn.lastAt = Math.max(turn.lastAt, at);
        if (e.itemType === "reasoning") noteReasoning(turn, e, at, e.tokens);
        break;
      }
      case "item.completed": {
        const turn = turnFor(e, at, true)!;
        turn.lastAt = Math.max(turn.lastAt, at);
        if (e.itemType === "tool") {
          completeCall(turn, e, at);
        } else {
          endReasoning(turn, at);
          const text = e.text;
          pushRow({
            id: `text:${e.eventId}`,
            kind: "assistant",
            at,
            turnId: turn.id,
            turnIndex: turn.index,
            title: "Assistant",
            text: text.trim() ? clipLine(text, ROW_TEXT_LIMIT) : undefined,
            toolCallOnly: !text.trim() ? true : undefined,
            detail: { text: text.slice(0, DETAIL_TEXT_LIMIT), meta: [] },
          });
          turn.stepHasText = true;
        }
        break;
      }
      case "content.delta": {
        // History never carries these (the read skips them) and the live feed
        // drops them, but a caller may pass one: reasoning text is reasoning.
        const turn = turnFor(e, at, false);
        if (turn && e.streamKind === "reasoning_text") {
          turn.lastAt = Math.max(turn.lastAt, at);
          noteReasoning(turn, e, at);
        }
        break;
      }
      case "thread.token-usage.updated": {
        const turn = turnFor(e, at, false);
        if (turn) {
          turn.lastAt = Math.max(turn.lastAt, at);
          turn.liveUsage = { input: e.input, output: e.output, cachedInput: e.cachedInput };
        }
        break;
      }
      case "request.opened": {
        const turn = turnFor(e, at, false);
        if (turn) turn.lastAt = Math.max(turn.lastAt, at);
        pushRow({
          id: `context:${e.eventId}`,
          kind: "context",
          at,
          turnId: turn?.id,
          turnIndex: turn?.index,
          title: e.requestType === "question" ? "Question asked" : "Permission requested",
          args: e.tool,
          text: clipLine(e.summary, ROW_TEXT_LIMIT),
          detail: { text: e.summary, meta: e.choices?.length ? [["Choices", e.choices.join(", ")]] : [] },
        });
        break;
      }
      case "request.resolved": {
        const turn = turnFor(e, at, false);
        if (turn) turn.lastAt = Math.max(turn.lastAt, at);
        pushRow({
          id: `context:${e.eventId}`,
          kind: "context",
          at,
          turnId: turn?.id,
          turnIndex: turn?.index,
          title: "Request resolved",
          text: `${e.behavior} · ${e.source}`,
          detail: { meta: [["Decision", e.behavior], ["Decided by", e.source]] },
        });
        break;
      }
      case "turn.retrying": {
        const turn = turnFor(e, at, false);
        if (turn) turn.lastAt = Math.max(turn.lastAt, at);
        const of = e.maxAttempts ? `/${e.maxAttempts}` : "";
        pushRow({
          id: `context:${e.eventId}`,
          kind: "context",
          at,
          turnId: turn?.id,
          turnIndex: turn?.index,
          title: "Retrying",
          text: `${clipLine(e.reason, ROW_TEXT_LIMIT)} · attempt ${e.attempt}${of} · in ${formatSpan(e.delayMs)}`,
          detail: { text: e.reason, meta: [] },
        });
        break;
      }
      case "runtime.error": {
        const turn = turnFor(e, at, false);
        if (turn) {
          turn.lastAt = Math.max(turn.lastAt, at);
          turn.errors += 1;
        }
        pushRow({
          id: `error:${e.eventId}`,
          kind: "error",
          at,
          turnId: turn?.id,
          turnIndex: turn?.index,
          title: e.setup ? "Setup needed" : "Error",
          text: clipLine(e.message, ROW_TEXT_LIMIT),
          status: "error",
          detail: { text: e.message, meta: [] },
        });
        break;
      }
      case "session.started":
      case "session.exited":
      case "session.invalidated": {
        const turn = turnFor(e, at, false);
        if (turn) turn.lastAt = Math.max(turn.lastAt, at);
        const text =
          e.type === "session.started"
            ? [e.rebuilt ? "rebuilt" : "started", e.model].filter(Boolean).join(" · ")
            : (e.reason ?? undefined);
        pushRow({
          id: `context:${e.eventId}`,
          kind: "context",
          at,
          turnId: turn?.id,
          turnIndex: turn?.index,
          title: e.type === "session.started" ? "Session" : e.type === "session.exited" ? "Session ended" : "Session reset",
          text: text ? clipLine(text, ROW_TEXT_LIMIT) : undefined,
          detail: { text, meta: [] },
        });
        break;
      }
    }
  }

  // ── what is still in flight at the end of the log ─────────────────
  const last = turns.at(-1);
  const running = Boolean(options.running) && Boolean(last) && !last!.completed && !last!.cut;
  for (const turn of turns) {
    if (turn.completed || turn.cut) continue;
    if (turn === last && running) {
      turn.end = now;
      finishOpen(turn, now, true);
    } else {
      turn.cut = true;
      turn.end = turn.lastAt;
      finishOpen(turn, turn.lastAt, false);
    }
  }

  // ── the user's own messages ───────────────────────────────────────
  const firstEventAt = stamped[0]?.at;
  const inputs = (options.inputs ?? [])
    .filter((input) => Number.isFinite(input.at))
    .filter((input) => firstEventAt === undefined || input.at >= firstEventAt - INPUT_SLACK_MS)
    .sort((a, b) => a.at - b.at);
  inputs.forEach((input, i) => {
    const isUser = input.role === "user";
    const label = isUser ? "You" : (input.label ?? SYSTEM_LABEL);
    const row: MutableRow = {
      id: `input:${input.id}`,
      kind: isUser ? "user" : "context",
      at: input.at,
      title: label,
      text: input.text.trim() ? clipLine(input.text, ROW_TEXT_LIMIT) : undefined,
      detail: { text: input.text.slice(0, DETAIL_TEXT_LIMIT), meta: [] },
      // before an event in the same millisecond: it caused them
      seq: -inputs.length + i,
      searchText: "",
    };
    rows.push(row);
    inputSpans.push({
      id: `input:${input.id}`,
      lane: "input",
      kind: isUser ? "user" : "context",
      label,
      start: input.at,
      end: input.at,
      status: "ok",
      open: false,
      cut: false,
      row: 0,
      rowId: row.id,
    });
  });
  // a turn nobody spoke to start: a scheduled or automatic one still began
  for (const turn of turns) {
    if (turn.startTrimmed) continue;
    const prompted = inputs.some((input) => input.at <= turn.start + 1500 && input.at >= turn.start - TURN_INPUT_WINDOW_MS);
    if (prompted) continue;
    inputSpans.push({
      id: `turn:${turn.id}`,
      lane: "input",
      kind: "turn",
      label: `Turn ${turn.index} started`,
      start: turn.start,
      end: turn.start,
      status: "ok",
      open: false,
      cut: false,
      row: 0,
      turnIndex: turn.index,
    });
  }
  inputSpans.sort((a, b) => a.start - b.start);

  // ── rows: order, text to search, turn membership ──────────────────
  rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
  for (const row of rows) {
    row.searchText = [
      ROW_KIND_LABEL[row.kind],
      row.title,
      row.args,
      row.result,
      row.text,
      row.detail.target,
      row.detail.arguments,
      row.detail.result,
      row.detail.text,
    ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n")
      .toLowerCase();
  }

  // ── tools lane: overlapping calls stack ───────────────────────────
  toolSpans.sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  for (const span of toolSpans) {
    let row = laneEnds.findIndex((end) => end <= span.start);
    if (row === -1) row = laneEnds.length < MAX_TOOL_ROWS ? laneEnds.length : MAX_TOOL_ROWS - 1;
    laneEnds[row] = Math.max(laneEnds[row] ?? span.end, span.end);
    span.row = row;
  }

  // ── turns ─────────────────────────────────────────────────────────
  const summaries: TurnSummary[] = turns.map((turn) => {
    const usage = turn.usage ?? turn.liveUsage;
    return {
      id: turn.id,
      index: turn.index,
      start: turn.start,
      end: turn.end,
      durationMs: Math.max(0, turn.end - turn.start),
      running: turn === last && running,
      cut: turn.cut,
      startTrimmed: turn.startTrimmed,
      ok: turn.completed ? turn.ok : undefined,
      stopReason: turn.stopReason,
      input: usage?.input,
      output: usage?.output,
      cachedInput: usage?.cachedInput,
      costUsd: turn.costUsd,
      toolCalls: turn.toolCount,
      toolMs: unionMs(turn.toolIntervals),
      modelMs: turn.modelMs,
      errors: turn.errors,
    };
  });

  // ── the axis ──────────────────────────────────────────────────────
  const intervals: Array<[number, number]> = [];
  for (const span of [...inputSpans, ...modelSpans, ...toolSpans]) intervals.push([span.start, span.end]);
  for (const turn of summaries) intervals.push([turn.start, turn.end]);
  for (const row of rows) intervals.push([row.at, row.endAt ?? row.at]);
  const axis = buildAxis(intervals, gapMs);
  let bounds: Trajectory["bounds"] = null;
  for (const [a, b] of intervals) {
    bounds = bounds ? { start: Math.min(bounds.start, a), end: Math.max(bounds.end, b) } : { start: a, end: b };
  }

  const settled = turns.filter((turn) => turn.completed).length;
  const trimmed =
    Boolean(options.olderOnDisk) ||
    Boolean(turns[0]?.startTrimmed) ||
    (typeof options.knownTurns === "number" && settled < options.knownTurns);

  return {
    rows,
    turns: summaries,
    spans: { input: inputSpans, model: modelSpans, tools: toolSpans },
    toolRows: Math.max(1, Math.min(laneEnds.length, MAX_TOOL_ROWS)),
    axis,
    bounds,
    running,
    trimmed,
    eventCount: stamped.length,
  };
}

// ── the thread's own messages ─────────────────────────────────────────

/** The part of a chat message this needs; structural, so the chat store's
 *  `Message` satisfies it without this module importing the store. */
export interface MessageLike {
  id: string;
  at: number;
  role: "bot" | "user" | "system";
  kind: string;
  text?: string;
  queued?: boolean;
  automationSource?: string;
}

const AUTOMATION_LABEL: Record<string, string> = {
  schedule: "Routine",
  manual: "Manual run",
  webhook: "Webhook",
  resource: "Resource trigger",
  delegation: "Delegation",
  imessage: "iMessage",
};

/** What the person (or an automation) said, from the thread's messages.  A
 *  message still queued has not reached the bot, so it is not an input yet. */
export function inputsFromMessages(messages: readonly MessageLike[]): TrajectoryInput[] {
  const out: TrajectoryInput[] = [];
  for (const message of messages) {
    if (message.role === "bot" || message.kind !== "text" || message.queued) continue;
    if (!message.text?.trim() || !Number.isFinite(message.at)) continue;
    out.push({
      id: message.id,
      at: message.at,
      role: message.role,
      text: message.text,
      label: message.role === "system" ? (AUTOMATION_LABEL[message.automationSource ?? ""] ?? undefined) : undefined,
    });
  }
  return out;
}

// ── searching and grouping ────────────────────────────────────────────

/** Rows whose name, arguments, result or text contain every word of `query`,
 *  case-insensitively.  An empty query is every row. */
export function filterRows<T extends Pick<TrajectoryRow, "searchText">>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => words.every((word) => row.searchText.includes(word)));
}

export interface TurnGroup {
  key: string;
  turn?: TurnSummary;
  rows: TrajectoryRow[];
}

/** Rows grouped under the turn they belong to, each group headed by that
 *  turn's summary, in order.  A row with no turn of its own — the message that
 *  started a turn, a session starting — travels with the turn that follows it,
 *  since it is what began it; only rows after the last turn stand alone.
 *  Nothing is dropped.  A turn that recorded no steps at all still has a
 *  duration and a state worth showing: with `emptyTurnsFrom`, those that began
 *  at or after that time get a group of their own, in place. */
export function groupByTurn(
  rows: readonly TrajectoryRow[],
  turns: readonly TurnSummary[],
  options: { emptyTurnsFrom?: number } = {},
): TurnGroup[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const groups: TurnGroup[] = [];
  let pending: TrajectoryRow[] = [];
  for (const row of rows) {
    if (!row.turnId) {
      pending.push(row);
      continue;
    }
    const last = groups.at(-1);
    if (last && last.turn?.id === row.turnId && pending.length === 0) {
      last.rows.push(row);
      continue;
    }
    if (last && last.turn?.id === row.turnId) {
      // a row without a turn between two of the same turn's rows belongs to it
      last.rows.push(...pending, row);
      pending = [];
      continue;
    }
    groups.push({ key: `${row.turnId}:${groups.length}`, turn: byId.get(row.turnId), rows: [...pending, row] });
    pending = [];
  }
  if (pending.length > 0) groups.push({ key: `outside:${groups.length}`, rows: pending });
  if (options.emptyTurnsFrom !== undefined) {
    const withRows = new Set(rows.map((row) => row.turnId));
    for (const turn of turns) {
      if (withRows.has(turn.id) || turn.start < options.emptyTurnsFrom) continue;
      const position = groups.findIndex((group) => (group.rows[0]?.at ?? Infinity) > turn.start);
      const empty: TurnGroup = { key: `${turn.id}:empty`, turn, rows: [] };
      if (position === -1) groups.push(empty);
      else groups.splice(position, 0, empty);
    }
  }
  return groups;
}

/** Tool calls only, oldest first — the Calls table's rows. */
export const toolCalls = (rows: readonly TrajectoryRow[]): TrajectoryRow[] => rows.filter((row) => row.kind === "tool");

export type CallSort = "start" | "tool" | "duration";

export function sortCalls(calls: readonly TrajectoryRow[], sort: CallSort, descending: boolean): TrajectoryRow[] {
  const direction = descending ? -1 : 1;
  const compare = (a: TrajectoryRow, b: TrajectoryRow): number => {
    switch (sort) {
      case "tool":
        return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
      case "duration":
        // a call with no duration (unfinished) sorts as the shortest
        return (a.durationMs ?? -1) - (b.durationMs ?? -1);
      default:
        return a.at - b.at;
    }
  };
  // ties fall back to start time, oldest first, whichever way the column runs
  return [...calls].sort((a, b) => compare(a, b) * direction || a.at - b.at);
}
