// The Trajectory tab's timeline strip: three labelled lanes over one time axis.
//
//   Input   the instants a person (or an automation) spoke
//   Model   the time the model was working, reasoning called out
//   Tools   each tool call, colored by outcome; overlapping calls stack
//
// Long idle gaps between turns are collapsed to a fixed-width hatched marker
// (see `buildAxis`), so a thread that spanned a weekend reads like one that
// took ten minutes.  Each span is a real button that opens the same popover on
// focus that it does on hover, and each lane is ONE tab stop: Left and Right
// (and Home and End) move between its spans, the way the step list below it
// moves with Up and Down, so a thread with hundreds of calls is not hundreds
// of Tab presses.
//
// Color never carries meaning alone: every lane has a text label, every span
// has an accessible name that says its outcome, and an unfinished span is
// drawn dashed, not just tinted.
import { memo, useEffect, useRef, useState } from "react";
import { Popover } from "@/components/ui/Popover";
import { spanKeyDown, tabStop } from "./TrajectoryRows";
import { cn } from "@/lib/cn";
import {
  axisX,
  formatClock,
  formatGap,
  fitLabels,
  formatSpan,
  type Axis,
  type AxisLabel,
  type Span,
  type SpanStatus,
  type Trajectory,
  type TrajectoryRow,
} from "@/lib/trajectory";

const LANES = [
  { id: "input", label: "Input" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" },
] as const;

/** Height of one stacked row in the Tools lane, and the air between rows. */
const ROW_PX = 14;
const ROW_GAP_PX = 3;
/** The strip's width before it has been measured (and under server rendering). */
const DEFAULT_STRIP_PX = 720;

const OUTCOME: Record<SpanStatus, string> = {
  ok: "Succeeded",
  error: "Failed",
  running: "Still running",
  unknown: "Never finished",
};

/** Fill and edge for a span, by lane, kind and outcome. */
function spanClass(span: Span): string {
  if (span.lane === "input") {
    return span.kind === "user" ? "bg-accent" : "bg-ink-secondary";
  }
  if (span.lane === "model") {
    return span.kind === "reasoning"
      ? "bg-accent/35 ring-1 ring-inset ring-accent/60"
      : "bg-ink-secondary/35";
  }
  switch (span.status) {
    case "error":
      return "bg-danger/80";
    case "running":
      return "bg-accent motion-safe:animate-pulse";
    case "unknown":
      return "border border-dashed border-warning bg-warning/25";
    default:
      return "bg-success/70";
  }
}

function spanName(span: Span, duration: string): string {
  const start = formatClock(span.start);
  if (span.lane === "input") return `${span.label}, at ${start}`;
  return `${span.label}, ${duration}, started ${start}, ${OUTCOME[span.status].toLowerCase()}`;
}

interface SpanPopoverProps {
  span: Span;
  row?: TrajectoryRow;
  /** The lane's one tab stop. */
  tabStop: boolean;
  onFocusSpan: (id: string) => void;
}

const SpanPopover = memo(function SpanPopover({ span, row, tabStop, onFocusSpan }: SpanPopoverProps) {
  const instant = span.end <= span.start;
  // an instant is a thin tick inside a wider hit area, not a filled block
  const tick = span.lane === "input" || instant;
  const duration = formatSpan(span.end - span.start);
  const rows: Array<[string, string]> = [];
  if (!instant) rows.push(["Duration", span.open ? `${duration} so far` : duration]);
  rows.push(["Started", formatClock(span.start)]);
  if (span.lane !== "input") rows.push(["Outcome", OUTCOME[span.status]]);
  if (span.turnIndex !== undefined) rows.push(["Turn", String(span.turnIndex)]);
  if (row?.args) rows.push(["Arguments", row.args]);
  if (row?.result) rows.push(["Result", row.result]);
  if (row?.text && span.lane === "input") rows.push(["Message", row.text]);
  return (
    <Popover
      title={span.label}
      titleAside={instant ? undefined : duration}
      triggerLabel={spanName(span, duration)}
      tabIndex={tabStop ? 0 : -1}
      triggerData={{ "data-span": "" }}
      onTriggerFocus={() => onFocusSpan(span.id)}
      trigger={tick ? <span aria-hidden="true" className={cn("mx-auto block h-full w-[3px] rounded-[1px]", spanClass(span))} /> : null}
      className={cn(
        "block size-full rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        !tick && spanClass(span),
      )}
      panelClassName="max-w-[min(26rem,calc(100vw-1rem))]"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-secondary">{label}</dt>
            <dd className="min-w-0 break-words font-medium tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
});

/** One lane's track: the gap markers behind, the spans on top. */
function Track({
  axis,
  spans,
  rowsById,
  rowCount,
  label,
}: {
  axis: Axis;
  spans: readonly Span[];
  rowsById: ReadonlyMap<string, TrajectoryRow>;
  rowCount: number;
  label: string;
}) {
  const height = rowCount * ROW_PX + (rowCount - 1) * ROW_GAP_PX;
  // one tab stop per lane: the span last used, else the first
  const [focusId, setFocusId] = useState<string | null>(null);
  const stopId = tabStop(
    spans.map((span) => span.id),
    focusId,
  );
  return (
    <div
      role="group"
      aria-label={`${label} lane, ${spans.length} ${spans.length === 1 ? "item" : "items"}`}
      className="relative rounded-md bg-inset"
      style={{ height: Math.max(height, ROW_PX) + 6 }}
      onKeyDown={spanKeyDown}
    >
      {axis.gaps.map((gap) => (
        <div
          key={`${gap.from}-${gap.to}`}
          aria-hidden="true"
          title={formatGap(gap.ms)}
          className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent_0,transparent_3px,var(--color-hairline)_3px,var(--color-hairline)_4px)] opacity-70"
          style={{ left: `${gap.x0 * 100}%`, width: `${(gap.x1 - gap.x0) * 100}%` }}
        />
      ))}
      {spans.map((span) => {
        const left = axisX(axis, span.start) * 100;
        const right = axisX(axis, span.end) * 100;
        const instant = span.lane === "input" || right - left <= 0;
        const top = 3 + span.row * (ROW_PX + ROW_GAP_PX);
        return (
          <div
            key={span.id}
            className="absolute"
            style={
              instant
                ? { left: `calc(${left}% - 4px)`, width: 8, top, height: ROW_PX }
                : { left: `${left}%`, width: `${right - left}%`, minWidth: 3, top, height: ROW_PX }
            }
          >
            <SpanPopover
              span={span}
              row={span.rowId ? rowsById.get(span.rowId) : undefined}
              tabStop={span.id === stopId}
              onFocusSpan={setFocusId}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The clock times to print along the axis: where each stretch begins, and where it all ends. */
function timeLabels(axis: Axis, end: number): AxisLabel[] {
  const out: AxisLabel[] = axis.segments.map((segment) => ({ x: segment.x0, text: formatClock(segment.start), align: "left" }));
  const last = axis.segments.at(-1);
  if (last) out.push({ x: last.x1, text: formatClock(end), align: "right" });
  return out;
}

/** The strip's width in pixels, kept current, so labels can be fitted to it. */
function useStripWidth(mounted: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_STRIP_PX);
  useEffect(() => {
    const el = ref.current;
    if (!mounted || !el) return;
    const update = () => setWidth(el.clientWidth || DEFAULT_STRIP_PX);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);
  return [ref, width] as const;
}

/** Memoized: the step list's search box and focus moves re-render the panel
 *  around it, and none of that changes the strip. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({ trajectory }: { trajectory: Trajectory }) {
  const { axis, bounds } = trajectory;
  // a hook, so ahead of the early return below
  const [stripRef, stripPx] = useStripWidth(Boolean(axis && bounds));
  if (!axis || !bounds) return null;
  const rowsById = new Map(trajectory.rows.map((row) => [row.id, row]));
  const rowCount = { input: 1, model: 1, tools: trajectory.toolRows } as const;
  // labels are fitted to the strip's real width, so a narrow window drops the
  // ones that would collide instead of printing them on top of each other
  const gapCaptions = fitLabels(
    axis.gaps.map((gap): AxisLabel => ({ x: (gap.x0 + gap.x1) / 2, text: formatGap(gap.ms), align: "center" })),
    stripPx,
  );
  const labels = fitLabels(timeLabels(axis, bounds.end), stripPx);

  return (
    <div role="group" aria-label="Timeline" className="px-5 pb-1 pt-3">
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
        {gapCaptions.length > 0 && (
          <>
            <span aria-hidden="true" />
            <div aria-hidden="true" className="relative h-3.5 text-[10.5px] leading-[14px] text-ink-secondary">
              {gapCaptions.map((caption) => (
                <span key={caption.x} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${caption.x * 100}%` }}>
                  {caption.text}
                </span>
              ))}
            </div>
          </>
        )}
        {LANES.map((lane) => (
          <div key={lane.id} className="contents">
            <span className="text-[11.5px] font-medium text-ink-secondary">{lane.label}</span>
            <Track axis={axis} spans={trajectory.spans[lane.id]} rowsById={rowsById} rowCount={rowCount[lane.id]} label={lane.label} />
          </div>
        ))}
        <span aria-hidden="true" />
        <div ref={stripRef} aria-hidden="true" className="relative h-3.5 text-[10.5px] tabular-nums leading-[14px] text-ink-secondary">
          {labels.map((label) => (
            <span
              key={`${label.align}-${label.x}`}
              className={cn("absolute whitespace-nowrap", label.align === "right" && "-translate-x-full")}
              style={{ left: `${label.x * 100}%` }}
            >
              {label.text}
            </span>
          ))}
        </div>
      </div>
      <ul aria-label="Legend" className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 pl-[3.75rem] text-[11px] text-ink-secondary">
        {[
          ["bg-ink-secondary/35", "Model"],
          ["bg-accent/35 ring-1 ring-inset ring-accent/60", "Reasoning"],
          ["bg-success/70", "Tool"],
          ["bg-danger/80", "Failed"],
          ["border border-dashed border-warning bg-warning/25", "Unfinished"],
        ].map(([swatch, text]) => (
          <li key={text} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("inline-block h-2.5 w-4 rounded-[2px]", swatch)} />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
});
