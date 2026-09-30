// Two quiet status-line chips under the composer, each opening a small
// popover on hover or focus:
//
//   2 turns · 27 steps · 92 tok/s      645k tok · Cache hit 91%
//
// The trigger's visible pieces are adjacent spans, which a screen reader would
// fuse ("2 turns27 steps"), so each carries a full aria-label of its figures —
// including the ones the container query hides.
//
// Both are derived from what the task already banked (`stats` and `usage`),
// so nothing here measures anything.  A figure the engine never reported is
// left out rather than shown as 0, and a chip with nothing to say is not
// rendered at all.  On a narrow footer the stats chip sheds tok/s first, then
// steps, and the token chip sheds its cache hit — by container width, so it
// follows the chat column rather than the window.
import { Fragment } from "react";
import { Popover } from "@/components/ui/Popover";
import { deriveSessionStats, deriveTokenUsage } from "@/lib/thread-stats";
import type { TaskStats, TaskUsage } from "@/state/store";

const CHIP =
  "inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] leading-4 text-ink-secondary transition-colors hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink";

function StatRows({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[12px]">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className="text-ink-secondary">{row.label}</dt>
          <dd className="text-right font-medium tabular-nums text-ink">{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function ThreadStatsBar({ stats, usage }: { stats?: TaskStats; usage?: TaskUsage }) {
  const session = deriveSessionStats(stats, usage);
  const tokens = deriveTokenUsage(usage);
  if (!session && !tokens) return null;
  return (
    // `pointer-events-auto` because the composer column above is
    // pointer-events-none in its gutters
    <div
      role="group"
      aria-label="Session Summary"
      className="pointer-events-auto w-full bg-app px-6 pb-2 @container/statsbar"
    >
      <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {session ? (
          <Popover
            title="Session Statistics"
            triggerLabel={`Session Statistics: ${[session.turns, session.steps, session.rate].filter(Boolean).join(", ")}`}
            className={CHIP}
            trigger={
              <>
                <span>{session.turns}</span>
                {session.steps ? (
                  <span className="hidden @min-[18rem]/statsbar:inline">
                    <span aria-hidden="true">{" · "}</span>
                    {session.steps}
                  </span>
                ) : null}
                {session.rate ? (
                  <span className="hidden @min-[24rem]/statsbar:inline">
                    <span aria-hidden="true">{" · "}</span>
                    {session.rate}
                  </span>
                ) : null}
              </>
            }
          >
            {session.rows.length > 0 ? <StatRows rows={session.rows} /> : (
              <p className="text-[12px] text-ink-secondary">Timing appears after the next turn</p>
            )}
            {session.note ? <p className="mt-2 text-[11.5px] text-ink-secondary">{session.note}</p> : null}
          </Popover>
        ) : null}
        {tokens ? (
          <Popover
            title="Token Usage"
            titleAside={tokens.headline}
            triggerLabel={`Token Usage: ${[tokens.total, tokens.cacheHit ? `cache hit ${tokens.cacheHit}` : undefined].filter(Boolean).join(", ")}`}
            className={CHIP}
            trigger={
              <>
                <span>{tokens.total}</span>
                {tokens.cacheHit ? (
                  <span className="hidden @min-[14rem]/statsbar:inline">
                    <span aria-hidden="true">{" · "}</span>
                    {`Cache hit ${tokens.cacheHit}`}
                  </span>
                ) : null}
              </>
            }
          >
            <StatRows rows={tokens.rows} />
          </Popover>
        ) : null}
      </div>
    </div>
  );
}
