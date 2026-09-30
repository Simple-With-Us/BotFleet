// The Trajectory tab's lists: the same steps three ways.
//
//   StepList   one compact monospace line per step, newest last; click a line
//              to open it in place
//   TurnList   the same lines grouped under each turn's summary
//   CallsTable a flat, sortable table of tool calls
//
// Every step is one button, and the whole list is a single tab stop: Up and
// Down (and Home and End) move between steps the way they do in a menu, so a
// keyboard user does not tab through a thousand rows.  The open/closed state
// lives with the caller, so the lists themselves stay pure renderers.
import { memo, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  formatClock,
  formatSpan,
  ROW_KIND_LABEL,
  type CallSort,
  type RowKind,
  type SpanStatus,
  type TrajectoryRow,
  type TurnGroup,
  type TurnSummary,
} from "@/lib/trajectory";
import { formatTokens, formatUsd } from "@/lib/usage";
import type { ItemIoRef } from "@/lib/item-io";
import { ItemIoBlocks, useItemIo } from "./ItemIoBlocks";

const BADGE: Record<RowKind, string> = {
  user: "bg-accent/15 text-accent-text",
  assistant: "bg-inset text-ink",
  tool: "bg-inset text-ink-secondary",
  reasoning: "bg-inset text-ink-secondary",
  context: "bg-warning/15 text-warning",
  error: "bg-danger/15 text-danger",
};

const STATUS_TEXT: Record<SpanStatus, string> = {
  ok: "Succeeded",
  error: "Failed",
  running: "Running",
  unknown: "Never finished",
};

export const ROW_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";

/** Which control in a list may be tabbed to: the last one used, else the first. */
export function tabStop(ids: readonly string[], focused: string | null): string | undefined {
  return focused !== null && ids.includes(focused) ? focused : ids[0];
}

/** A keydown handler that moves focus between the `selector` controls inside
 *  the element it is attached to: `previous`/`next` (arrow keys) one at a time,
 *  Home and End to the ends.  What lets a group of many controls be ONE tab
 *  stop, the way a menu is. */
export function rovingKeyDown(selector: string, previous: string, next: string) {
  const keys = [previous, next, "Home", "End"];
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (!target.closest(selector)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
    const at = items.indexOf(target.closest(selector) as HTMLElement);
    if (at === -1) return;
    const to =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (event.key === next ? 1 : -1)));
    event.preventDefault();
    items[to]?.focus();
  };
}

/** Up/Down/Home/End between the list's `[data-step]` controls. */
export const stepKeyDown = rovingKeyDown("[data-step]", "ArrowUp", "ArrowDown");

/** Left/Right/Home/End between a timeline lane's `[data-span]` controls. */
export const spanKeyDown = rovingKeyDown("[data-span]", "ArrowLeft", "ArrowRight");

function Outcome({ status }: { status?: SpanStatus }) {
  if (!status) return null;
  return (
    <span className="inline-flex shrink-0 items-center" role="img" aria-label={STATUS_TEXT[status]} title={STATUS_TEXT[status]}>
      {status === "ok" ? (
        <Check size={12} className="text-success" aria-hidden="true" />
      ) : status === "error" ? (
        <X size={12} className="text-danger" aria-hidden="true" />
      ) : (
        <span className={cn("text-[10.5px] leading-none", status === "running" ? "text-accent" : "text-warning")}>
          {status === "running" ? "running" : "unfinished"}
        </span>
      )}
    </span>
  );
}

/** The one-line summary of a step, by kind. */
function StepLine({ row }: { row: TrajectoryRow }): ReactNode {
  switch (row.kind) {
    case "user":
      return <span className="text-ink">{row.text ?? <em className="text-ink-secondary">(empty message)</em>}</span>;
    case "assistant":
      return row.toolCallOnly ? <em className="text-ink-secondary">(tool call only)</em> : <span className="text-ink">{row.text}</span>;
    case "tool":
      return (
        <>
          <span className="font-semibold text-ink">{row.title}</span>
          {row.args ? <span className="text-ink-secondary"> {row.args}</span> : null}
          {row.result ? (
            <>
              <span className="text-ink-secondary" aria-hidden="true">
                {" → "}
              </span>
              <span className="sr-only"> returned </span>
              <span className={row.status === "error" ? "text-danger" : "text-ink"}>{row.result}</span>
            </>
          ) : null}
        </>
      );
    case "reasoning":
      return <em className="text-ink-secondary">{row.text ?? "(reasoning)"}</em>;
    case "context":
      return (
        <>
          <span className="font-semibold text-ink">{row.title}</span>
          {row.args ? <span className="text-ink-secondary"> {row.args}</span> : null}
          {row.text ? <span className="text-ink-secondary"> {row.text}</span> : null}
        </>
      );
    case "error":
      return (
        <>
          <span className="font-semibold text-danger">{row.title}</span>
          {row.text ? <span className="text-danger"> {row.text}</span> : null}
        </>
      );
  }
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-medium text-ink-secondary">{label}</div>
      <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-app px-2 py-1.5 text-[11px] leading-relaxed text-ink">
        {text}
      </pre>
    </div>
  );
}

/** The part of an opened step that is the step's own payload.
 *
 *  A step opened in place reads its full input and output from the harness
 *  (only now — a closed step asks for nothing).  Until they arrive, or when
 *  they were never recorded, the clipped Arguments and Result the list already
 *  has are shown instead, with a line saying which it is.  A row with no thread
 *  to ask (the pure renderer in a test) keeps the clipped blocks alone. */
function StepPayload({ row, threadId }: { row: TrajectoryRow; threadId?: string }) {
  const { detail } = row;
  const ref: ItemIoRef | null = threadId && row.ioRef ? { threadId, itemId: row.ioRef.itemId, turnId: row.ioRef.turnId } : null;
  // a step still running has no output written yet: show what is there, keep nothing
  const io = useItemIo(ref, true, row.status !== "running");
  const clippedArguments = detail.arguments ? <Block label="Arguments" text={detail.arguments} /> : null;
  const clippedResult = detail.result ? <Block label="Result" text={detail.result} /> : null;
  const clippedText = detail.text ? <Block label="Text" text={detail.text} /> : null;
  if (!ref) {
    return (
      <>
        {clippedArguments}
        {clippedResult}
        {clippedText}
      </>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <ItemIoBlocks
        state={io.state}
        failed={row.status === "error"}
        onRetry={io.retry}
        fallback={
          <>
            {clippedArguments}
            {clippedResult}
            {clippedText}
          </>
        }
        outputFallback={clippedResult}
      />
    </div>
  );
}

/** A step opened in place: when, how long, and everything the line clipped. */
export function StepDetail({ row, id, threadId }: { row: TrajectoryRow; id: string; threadId?: string }) {
  const { detail } = row;
  return (
    <div id={id} className="border-t border-hairline/20 bg-inset/60 px-3 pb-2.5 pt-2 text-[11.5px]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5">
        <dt className="text-ink-secondary">Started</dt>
        <dd className="tabular-nums text-ink">{formatClock(row.at)}</dd>
        {row.durationMs !== undefined && (
          <>
            <dt className="text-ink-secondary">Duration</dt>
            <dd className="tabular-nums text-ink">{formatSpan(row.durationMs)}</dd>
          </>
        )}
        {row.kind === "tool" && row.status ? (
          <>
            <dt className="text-ink-secondary">Outcome</dt>
            <dd className="text-ink">{STATUS_TEXT[row.status]}</dd>
          </>
        ) : null}
        {detail.meta.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-secondary">{label}</dt>
            <dd className="break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {detail.target ? <Block label="Target" text={detail.target} /> : null}
      <StepPayload row={row} threadId={threadId} />
    </div>
  );
}

export interface ListControl {
  /** The thread the steps belong to, so an opened step can read its full
   *  input and output.  Absent in the pure renderer's tests. */
  threadId?: string;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** The one step that is a tab stop. */
  tabStopId: string | undefined;
  onFocusStep: (id: string) => void;
}

interface StepProps {
  row: TrajectoryRow;
  threadId?: string;
  open: boolean;
  /** This step is the list's one tab stop. */
  tabStop: boolean;
  onToggle: (id: string) => void;
  onFocusStep: (id: string) => void;
}

/** Primitives and stable callbacks only, so a list re-render (a keystroke in
 *  the search box, focus moving) leaves every step it did not change alone. */
const Step = memo(function Step({ row, threadId, open, tabStop, onToggle, onFocusStep }: StepProps) {
  const detailId = `${row.id}::detail`;
  return (
    <li className={cn("border-b border-hairline/20", row.kind === "error" && "bg-danger/5")}>
      <button
        type="button"
        data-step=""
        data-row-id={row.id}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        tabIndex={tabStop ? 0 : -1}
        onFocus={() => onFocusStep(row.id)}
        onClick={() => onToggle(row.id)}
        className={cn("flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-raised/60", ROW_FOCUS)}
      >
        <span className="mt-[3px] shrink-0 text-ink-secondary" aria-hidden="true">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <time className="shrink-0 tabular-nums text-ink-secondary" dateTime={new Date(row.at).toISOString()}>
          {formatClock(row.at)}
        </time>
        <span className={cn("mt-[1px] w-[4.75rem] shrink-0 rounded px-1 text-center text-[10px] font-semibold leading-4", BADGE[row.kind])}>
          {ROW_KIND_LABEL[row.kind]}
        </span>
        <span className={cn("min-w-0 flex-1", open ? "whitespace-pre-wrap break-words" : "truncate")}>
          <StepLine row={row} />
        </span>
        {row.kind === "tool" || row.kind === "reasoning" ? (
          <span className="flex shrink-0 items-center gap-1.5">
            {row.durationMs !== undefined && <span className="tabular-nums text-ink-secondary">{formatSpan(row.durationMs)}</span>}
            {row.kind === "tool" && <Outcome status={row.status} />}
          </span>
        ) : null}
      </button>
      {open && <StepDetail row={row} id={detailId} threadId={threadId} />}
    </li>
  );
});

function StepItem({ row, control }: { row: TrajectoryRow; control: ListControl }) {
  return (
    <Step
      row={row}
      threadId={control.threadId}
      open={control.expanded.has(row.id)}
      tabStop={control.tabStopId === row.id}
      onToggle={control.onToggle}
      onFocusStep={control.onFocusStep}
    />
  );
}

export function StepList({ rows, control, label }: { rows: readonly TrajectoryRow[]; control: ListControl; label: string }) {
  return (
    <ul aria-label={label} onKeyDown={stepKeyDown} className="font-mono text-[11.5px] leading-5">
      {rows.map((row) => (
        <StepItem key={row.id} row={row} control={control} />
      ))}
    </ul>
  );
}

// ── turns ─────────────────────────────────────────────────────────────

function turnFacts(turn: TurnSummary): string[] {
  const facts = [formatSpan(turn.durationMs)];
  if (turn.toolCalls > 0) facts.push(`${turn.toolCalls} ${turn.toolCalls === 1 ? "tool call" : "tool calls"}`);
  if (turn.modelMs > 0) facts.push(`model ${formatSpan(turn.modelMs)}`);
  if (turn.toolMs > 0) facts.push(`tools ${formatSpan(turn.toolMs)}`);
  if (turn.input !== undefined) {
    const tokens = turn.output !== undefined ? `${formatTokens(turn.input)} in · ${formatTokens(turn.output)} out` : `${formatTokens(turn.input)} in`;
    // a turn still running has only the provider's latest figure, not a total
    facts.push(turn.usageLive ? `latest ${tokens}` : tokens);
  }
  if (typeof turn.costUsd === "number") facts.push(formatUsd(turn.costUsd));
  return facts;
}

function turnState(turn: TurnSummary): { text: string; tone: string } | null {
  if (turn.running) return { text: "Running", tone: "bg-accent/15 text-accent-text" };
  // a stop the person asked for is not a failure, and is not drawn like one
  if (turn.stopped) return { text: "Stopped", tone: "bg-inset text-ink-secondary" };
  if (turn.ok === false) return { text: "Failed", tone: "bg-danger/15 text-danger" };
  if (turn.cut) return { text: "Never finished", tone: "bg-warning/15 text-warning" };
  return null;
}

export function TurnList({ groups, control }: { groups: readonly TurnGroup[]; control: ListControl }) {
  return (
    <div onKeyDown={stepKeyDown}>
      {groups.map((group) => {
        const turn = group.turn;
        const state = turn ? turnState(turn) : null;
        const headingId = `turn-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h3
              id={headingId}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-y border-hairline/30 bg-raised/40 px-5 py-1.5 text-[12px] font-semibold text-ink"
            >
              <span>{turn ? `Turn ${turn.index}` : "Outside a Turn"}</span>
              {turn && (
                <span className="font-normal tabular-nums text-ink-secondary">
                  {formatClock(turn.start)} · {turnFacts(turn).join(" · ")}
                </span>
              )}
              {turn?.startTrimmed && <span className="font-normal text-ink-secondary">(start trimmed)</span>}
              {state && <span className={cn("rounded px-1.5 text-[10.5px] font-semibold leading-4", state.tone)}>{state.text}</span>}
            </h3>
            {group.rows.length > 0 ? (
              <StepListBody rows={group.rows} control={control} />
            ) : (
              <p className="px-5 py-1.5 text-[12px] text-ink-secondary">No steps in this turn.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Steps without their own onKeyDown — the turn list owns it across groups. */
function StepListBody({ rows, control }: { rows: readonly TrajectoryRow[]; control: ListControl }) {
  return (
    <ul className="font-mono text-[11.5px] leading-5">
      {rows.map((row) => (
        <StepItem key={row.id} row={row} control={control} />
      ))}
    </ul>
  );
}

// ── calls ─────────────────────────────────────────────────────────────

const HEADERS: Array<{ id: CallSort | null; label: string; className?: string }> = [
  { id: "tool", label: "Tool" },
  { id: "start", label: "Started" },
  { id: "duration", label: "Duration", className: "text-right" },
  { id: null, label: "Outcome" },
  { id: null, label: "Arguments" },
];

export function CallsTable({
  calls,
  control,
  sort,
  descending,
  onSort,
}: {
  calls: readonly TrajectoryRow[];
  control: ListControl;
  sort: CallSort;
  descending: boolean;
  onSort: (sort: CallSort) => void;
}) {
  return (
    <div className="overflow-x-auto" onKeyDown={stepKeyDown}>
      <table className="w-full min-w-[34rem] border-collapse text-left text-[11.5px]">
        <caption className="sr-only">Tool calls</caption>
        <thead>
          <tr className="border-b border-hairline/40 text-[11px] text-ink-secondary">
            {HEADERS.map((header) => (
              <th
                key={header.label}
                scope="col"
                aria-sort={header.id && header.id === sort ? (descending ? "descending" : "ascending") : undefined}
                className={cn("px-3 py-1.5 font-medium", header.className)}
              >
                {header.id ? (
                  <button
                    type="button"
                    onClick={() => onSort(header.id!)}
                    className={cn("rounded px-0.5 hover:text-ink", ROW_FOCUS, header.id === sort && "text-ink")}
                  >
                    {header.label}
                    {header.id === sort ? <span aria-hidden="true">{descending ? " ↓" : " ↑"}</span> : null}
                  </button>
                ) : (
                  header.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {calls.map((row) => (
            <CallRows
              key={row.id}
              row={row}
              threadId={control.threadId}
              open={control.expanded.has(row.id)}
              tabStop={control.tabStopId === row.id}
              onToggle={control.onToggle}
              onFocusStep={control.onFocusStep}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CallRows = memo(function CallRows({ row, threadId, open, tabStop, onToggle, onFocusStep }: StepProps) {
  const detailId = `${row.id}::detail`;
  return (
    <>
      <tr className={cn("border-b border-hairline/20 hover:bg-raised/40", row.status === "error" && "bg-danger/5")}>
        <td className="max-w-[14rem] px-3 py-1">
          <button
            type="button"
            data-step=""
            data-row-id={row.id}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            tabIndex={tabStop ? 0 : -1}
            onFocus={() => onFocusStep(row.id)}
            onClick={() => onToggle(row.id)}
            className={cn("flex w-full items-center gap-1.5 rounded text-left font-semibold text-ink", ROW_FOCUS)}
          >
            <span className="shrink-0 text-ink-secondary" aria-hidden="true">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span className="truncate">{row.title}</span>
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-1 tabular-nums text-ink-secondary">{formatClock(row.at)}</td>
        <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums text-ink">
          {row.durationMs !== undefined ? formatSpan(row.durationMs) : <span className="text-ink-secondary">unknown</span>}
        </td>
        <td className="px-3 py-1">
          <span className={cn(row.status === "error" ? "text-danger" : row.status === "ok" ? "text-ink" : "text-ink-secondary")}>
            {row.status ? STATUS_TEXT[row.status] : ""}
          </span>
        </td>
        <td className="max-w-0 truncate px-3 py-1 text-ink-secondary" title={row.args}>
          {row.args ?? ""}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-hairline/20">
          <td colSpan={HEADERS.length} className="p-0">
            <StepDetail row={row} id={detailId} threadId={threadId} />
          </td>
        </tr>
      )}
    </>
  );
});
