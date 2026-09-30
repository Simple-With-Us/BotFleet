// The Trajectory tab: what a thread's bot actually did, and where the time went.
//
// A timeline strip (Input, Model and Tools lanes over a time axis that folds
// away long idle gaps) above a searchable one-line-per-step list, viewed three
// ways: by Duration (timeline and list), by Turns (the list grouped under each
// turn's summary) or as Calls (a flat, sortable table of tool calls).
//
// Nothing is measured here.  The steps come from the runtime events the
// harness already logs to disk (GET /api/threads/:id/events?view=trajectory)
// and, while a turn is running, from the same events as they arrive on the
// app's event stream (src/lib/runtime-feed.ts).  All the arithmetic is in
// src/lib/trajectory.ts; this file renders it.
//
// `TrajectoryPanel` is the pure renderer (props in, markup out) and is what the
// tests render; `TrajectoryView` owns the fetching, the live tail and the
// controls' state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  buildTrajectory,
  filterRows,
  formatSpan,
  groupByTurn,
  inputsFromMessages,
  sortCalls,
  toolCalls,
  type CallSort,
  type MessageLike,
  type Trajectory,
} from "@/lib/trajectory";
import { createEventBatcher, subscribeRuntimeEvents } from "@/lib/runtime-feed";
import type { InspectorPage } from "@/lib/inspector";
import type { RuntimeEvent } from "../../server/contracts.ts";
import { CallsTable, ROW_FOCUS, StepList, TurnList, tabStop, type ListControl } from "./TrajectoryRows";
import { TrajectoryTimeline } from "./TrajectoryTimeline";

export type TrajectoryMode = "duration" | "turns" | "calls";

const MODES: ReadonlyArray<{ id: TrajectoryMode; label: string; hint: string }> = [
  { id: "duration", label: "Duration", hint: "Timeline and steps in order" },
  { id: "turns", label: "Turns", hint: "Steps grouped by turn" },
  { id: "calls", label: "Calls", hint: "Tool calls as a table" },
];

/** Steps drawn before "Show Earlier Steps" — a long thread has thousands. */
export const STEP_WINDOW = 250;
/** Events asked of the server; it clips each one and skips streamed deltas. */
const HISTORY_LIMIT = 1000;
/** Live events held between history reloads. */
const LIVE_CAP = 3000;

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function summary(trajectory: Trajectory, shown: number, filtering: boolean): string {
  const total = trajectory.rows.length;
  const parts = [filtering ? `${shown.toLocaleString("en-US")} of ${plural(total, "step")}` : plural(total, "step")];
  parts.push(plural(trajectory.turns.length, "turn"));
  const active = trajectory.turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  if (active > 0) parts.push(formatSpan(active));
  return parts.join(" · ");
}

export interface TrajectoryPanelProps {
  trajectory: Trajectory;
  mode: TrajectoryMode;
  onMode: (mode: TrajectoryMode) => void;
  query: string;
  onQuery: (query: string) => void;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** No page has come back yet. */
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function TrajectoryPanel({
  trajectory,
  mode,
  onMode,
  query,
  onQuery,
  expanded,
  onToggle,
  loading = false,
  error = null,
  onRetry,
}: TrajectoryPanelProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [windowSize, setWindowSize] = useState(STEP_WINDOW);
  const [sort, setSort] = useState<CallSort>("start");
  const [descending, setDescending] = useState(false);

  const filtering = query.trim().length > 0;
  const matching = useMemo(() => filterRows(trajectory.rows, query), [trajectory.rows, query]);
  const calls = useMemo(
    () => sortCalls(toolCalls(matching), sort, descending),
    [matching, sort, descending],
  );
  // the newest steps are the ones a person is here for
  const shownRows = useMemo(() => matching.slice(-windowSize), [matching, windowSize]);
  const shownCalls = useMemo(
    () => (sort === "start" && !descending ? calls.slice(-windowSize) : calls.slice(0, windowSize)),
    [calls, sort, descending, windowSize],
  );
  // A search shows matching steps only; without one, a turn that recorded no
  // steps still appears (from the first step on screen), so no turn goes missing.
  const groups = useMemo(
    () =>
      groupByTurn(shownRows, trajectory.turns, {
        emptyTurnsFrom: filtering ? undefined : (shownRows[0]?.at ?? trajectory.bounds?.start),
      }),
    [shownRows, trajectory.turns, trajectory.bounds, filtering],
  );

  const visible = mode === "calls" ? shownCalls : shownRows;
  const hidden = (mode === "calls" ? calls.length : matching.length) - visible.length;
  const control: ListControl = {
    expanded,
    onToggle,
    tabStopId: tabStop(
      visible.map((row) => row.id),
      focusId,
    ),
    onFocusStep: setFocusId,
  };

  const empty = trajectory.eventCount === 0;
  const onSort = (next: CallSort) => {
    if (next === sort) setDescending((value) => !value);
    else {
      setSort(next);
      // a duration column reads best longest-first; the others oldest/A-first
      setDescending(next === "duration");
    }
  };

  return (
    <section aria-label="Trajectory" className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline/40 px-5 py-2">
        <div role="group" aria-label="Trajectory View" className="flex rounded-lg bg-inset p-0.5">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={mode === option.id}
              title={option.hint}
              onClick={() => onMode(option.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium",
                ROW_FOCUS,
                mode === option.id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="relative min-w-[10rem] flex-1 sm:max-w-xs">
          <span className="sr-only">Search Steps</span>
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                onQuery("");
              }
            }}
            placeholder="Search steps"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-hairline/50 bg-inset py-1 pl-7 pr-7 text-[12.5px] text-ink placeholder:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label="Clear Search"
              className={cn("absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-secondary hover:text-ink", ROW_FOCUS)}
            >
              <X size={13} />
            </button>
          )}
        </label>
        {!empty && (
          <span className="ml-auto flex items-center gap-2 text-[12px] tabular-nums text-ink-secondary" role="status">
            {trajectory.running && (
              <span className="flex items-center gap-1.5 text-accent-text">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
                Running
              </span>
            )}
            {summary(trajectory, matching.length, filtering)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        {error && (
          <div role="alert" className="flex items-center gap-3 px-5 py-3 text-[13px] text-danger">
            Couldn't load this thread's steps: {error}
            {onRetry && (
              <button type="button" onClick={onRetry} className={cn("rounded-md border border-hairline/50 px-2 py-0.5 text-ink hover:bg-raised", ROW_FOCUS)}>
                Try Again
              </button>
            )}
          </div>
        )}
        {!error && loading && empty && (
          <p role="status" className="px-5 py-6 text-[13px] text-ink-secondary">
            Loading steps…
          </p>
        )}
        {!error && !loading && empty && (
          <div className="px-5 py-10 text-center">
            <p className="text-[14px] font-medium text-ink">No steps yet</p>
            <p className="mt-1 text-[12.5px] text-ink-secondary">Steps appear here as this thread's bot works.</p>
          </div>
        )}

        {!empty && (
          <>
            {trajectory.trimmed && (
              <p role="note" className="px-5 pt-2 text-[12px] text-ink-secondary">
                Older steps were trimmed.
              </p>
            )}
            {mode === "duration" && <TrajectoryTimeline trajectory={trajectory} />}
            {filtering && matching.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-ink-secondary">No steps match “{query.trim()}”.</p>
            ) : (
              <>
                {hidden > 0 && (
                  <div className="flex justify-center px-5 py-2">
                    <button
                      type="button"
                      onClick={() => setWindowSize((value) => value + STEP_WINDOW)}
                      className={cn(
                        "rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
                        ROW_FOCUS,
                      )}
                    >
                      Show Earlier Steps ({hidden.toLocaleString("en-US")} more)
                    </button>
                  </div>
                )}
                {mode === "duration" && <StepList rows={shownRows} control={control} label="Steps" />}
                {mode === "turns" && <TurnList groups={groups} control={control} />}
                {mode === "calls" &&
                  (shownCalls.length === 0 ? (
                    <p className="px-5 py-6 text-[13px] text-ink-secondary">No tool calls in this thread yet.</p>
                  ) : (
                    <CallsTable calls={shownCalls} control={control} sort={sort} descending={descending} onSort={onSort} />
                  ))}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Runtime events out of a page, in the order the server sent them. */
function eventsOf(page: InspectorPage): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const entry of page.entries) if (entry.kind === "runtime") out.push(entry.data);
  return out;
}

export interface TrajectoryViewProps {
  threadId: string;
  /** The thread's messages, for the person's own inputs. */
  messages: readonly MessageLike[];
  /** The thread is working right now. */
  running: boolean;
  /** Settled turns the task has banked, to tell when the log was trimmed. */
  knownTurns?: number;
}

export function TrajectoryView({ threadId, messages, running, knownTurns }: TrajectoryViewProps) {
  const [history, setHistory] = useState<{ events: RuntimeEvent[]; older: boolean } | null>(null);
  const [live, setLive] = useState<RuntimeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<TrajectoryMode>("duration");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/events?view=trajectory&limit=${HISTORY_LIMIT}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const page = (await res.json()) as InspectorPage;
      if (controller.signal.aborted) return;
      const events = eventsOf(page);
      setHistory({ events, older: page.older === true });
      setError(null);
      // what the log now holds no longer needs the live copy
      const seen = new Set(events.map((event) => event.eventId));
      setLive((prev) => (prev.length ? prev.filter((event) => !seen.has(event.eventId)) : prev));
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [threadId]);

  // Subscribe BEFORE reading history, so nothing that happens in between is
  // missed; the duplicates that overlap are dropped by event id when built.
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const batcher = createEventBatcher((batch) => setLive((prev) => [...prev, ...batch].slice(-LIVE_CAP)));
    const unsubscribe = subscribeRuntimeEvents(threadId, (event) => {
      batcher.push(event);
      if (event.type === "turn.completed" || event.type === "runtime.error") {
        // let the log catch up with what streamed
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => void load(), 600);
      }
    });
    void load();
    return () => {
      unsubscribe();
      batcher.dispose();
      if (settle) clearTimeout(settle);
      loadAbort.current?.abort();
    };
  }, [threadId, load]);

  // a running turn's open spans grow: tick once a second, and never behind a hidden tab
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const inputs = useMemo(() => inputsFromMessages(messages), [messages]);
  const events = useMemo(() => (history ? [...history.events, ...live] : live), [history, live]);
  const trajectory = useMemo(
    () => buildTrajectory(events, { inputs, running, now: running ? now : undefined, olderOnDisk: history?.older, knownTurns }),
    [events, inputs, running, now, history?.older, knownTurns],
  );

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <TrajectoryPanel
      trajectory={trajectory}
      mode={mode}
      onMode={setMode}
      query={query}
      onQuery={setQuery}
      expanded={expanded}
      onToggle={toggle}
      loading={history === null && error === null}
      error={error}
      onRetry={() => void load()}
    />
  );
}
