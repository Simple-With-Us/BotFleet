// The Engine Quotas disclosure that sits under the model picker header.
//
// Replaces the per-row chip that packed a two-window engine's whole quota
// state into one unreadable string — `(93% / 3% for 5h / w)` — repeated on
// every model of the engine.  That form was the same sentence down the list,
// it never said which window was binding, and `5h` / `w` were unexplained
// abbreviations sitting where a number should be.
//
// This panel is deliberately scoped to the *engine* rather than the model: the
// windows belong to the account, not to any one model, so repeating them per
// row was also repeating a fact that does not vary.  Each engine gets one
// entry, each window gets its own name, bar and reset time, and the engine
// with the least headroom is named as the one that will stop a turn first.
import * as React from "react";
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import {
  bindingQuotaWindow,
  quotaWindows,
  type QuotaWindow,
} from "@/lib/quota-display";
import { cn } from "@/lib/cn";

/** The subset of `InstanceInfo` this panel reads.
 *
 *  A structural subset, not a cast:  `state.instances` is `InstanceInfo[]`, and
 *  this interface is satisfied by it structurally, so the picker passes its
 *  instances straight through with no assertion at all. */
export interface QuotaEngineInfo {
  instanceId: string;
  displayName: string;
  driverKind: string;
  snapshot: {
    quota?: {
      capped: boolean;
      windowsLabel?: string;
      models?: Record<string, {
        capped: boolean;
        remainingPercent?: number | null;
        secondaryRemainingPercent?: number | null;
        resetsAt?: number | null;
        windowsLabel?: string;
      }>;
    };
  };
}

/** Bar colour by remaining headroom, matching the picker header's status
 *  chips so the two never disagree about whether an engine is in trouble. */
function barTone(remaining: number): string {
  if (remaining <= 0) return "bg-danger";
  if (remaining <= 10) return "bg-danger/80";
  if (remaining <= 25) return "bg-warning";
  return "bg-accent";
}

function QuotaBar({ remaining }: { remaining: number }) {
  const width = Math.max(0, Math.min(100, remaining));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset" aria-hidden>
      <div className={cn("h-full rounded-full", barTone(remaining))} style={{ width: `${width}%` }} />
    </div>
  );
}

/** "resets in 3h 20m" / "resets in 2d 4h", or null when there is no reset. */
function resetLabel(resetsAt?: number | null): string | null {
  if (resetsAt == null) return null;
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function WindowRow({ window }: { window: QuotaWindow }) {
  const reset = resetLabel(window.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11.5px] text-ink-secondary">{window.label}</span>
        <span className="text-[11.5px] font-medium tabular-nums text-ink">
          {window.remainingPercent}% left
        </span>
      </div>
      <QuotaBar remaining={window.remainingPercent} />
      {reset && <span className="text-[10.5px] text-ink-secondary/80">{reset}</span>}
    </div>
  );
}

/** The windows for one engine, collapsed to the best reading available.
 *
 *  Models on an engine share the account's windows, so the union is the honest
 *  answer: take the *lowest* remaining percentage reported for each window
 *  across models, because that is the reading that reflects real headroom. */
/** The named windows and source label for one engine. */
interface EngineWindows {
  windows: QuotaWindow[];
  label?: string;
}

function engineWindows(engine: QuotaEngineInfo): EngineWindows {
  const models = Object.values(engine.snapshot.quota?.models ?? {});
  if (models.length === 0) return { windows: [] };
  const label = models.find((m) => m.windowsLabel)?.windowsLabel ?? engine.snapshot.quota?.windowsLabel;
  let primary: number | null = null;
  let secondary: number | null = null;
  let resetsAt: number | null = null;
  for (const model of models) {
    if (model.remainingPercent != null) {
      primary = primary == null ? model.remainingPercent : Math.min(primary, model.remainingPercent);
    }
    if (model.secondaryRemainingPercent != null) {
      secondary = secondary == null
        ? model.secondaryRemainingPercent
        : Math.min(secondary, model.secondaryRemainingPercent);
    }
    if (model.resetsAt != null && (resetsAt == null || model.resetsAt < resetsAt)) {
      resetsAt = model.resetsAt;
    }
  }
  const windows = quotaWindows(primary, secondary, { windowsLabel: label });
  if (windows.length > 0 && resetsAt != null && windows[0]) windows[0].resetsAt = resetsAt;
  return { windows, label };
}

export interface EngineQuotasPanelProps {
  engines: QuotaEngineInfo[];
  /** Which engine the picker is currently showing, marked in the list. */
  activeInstanceId?: string;
  className?: string;
  /** Start with the detail panel open.  The picker leaves this collapsed;
   *  the visual fixture sets it so a screenshot covers the bars and the
   *  named windows rather than one collapsed line of text. */
  defaultOpen?: boolean;
}

export function EngineQuotasPanel({
  engines,
  activeInstanceId,
  className,
  defaultOpen = false,
}: EngineQuotasPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);

  const rows = useMemo(
    () =>
      engines
        .map((engine) => ({ engine, ...engineWindows(engine) }))
        .filter((row) => row.windows.length > 0)
        // The engine closest to its limit leads: it is the one that decides
        // whether the next turn can run at all.
        .sort((a, b) => bindingQuotaWindow(a.windows)!.remainingPercent - bindingQuotaWindow(b.windows)!.remainingPercent),
    [engines],
  );

  // Worst engine on this Mac, named in the collapsed trigger so the button
  // carries information before it is ever opened.
  const tightest = rows[0];
  const tightestWindow = tightest ? bindingQuotaWindow(tightest.windows) : null;

  if (rows.length === 0) return null;

  const detailId = "engine-quotas-detail";
  return (
    <div className={cn("mt-2", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11.5px] text-ink-secondary hover:text-ink"
      >
        <span className="min-w-0 flex-1 truncate">
          <strong className="font-medium">Engine Quotas</strong>
          {tightest && tightestWindow && (
            <span className="text-ink-secondary">
              {" · "}
              {tightest.engine.displayName} {tightestWindow.label.toLowerCase()} at {tightestWindow.remainingPercent}%
            </span>
          )}
        </span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={detailId}
          className="mt-1.5 max-h-56 space-y-3 overflow-y-auto rounded-lg border border-hairline/40 bg-inset/30 px-3 py-2.5"
        >
          {rows.map(({ engine, windows }) => {
            const binding = bindingQuotaWindow(windows);
            const isActive = engine.instanceId === activeInstanceId;
            return (
              <div key={engine.instanceId} data-testid={`engine-quota-${engine.instanceId}`} className={cn(isActive && "rounded bg-control/40 px-1.5 py-1 -mx-1.5")}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-medium text-ink">
                    {engine.displayName}
                    {isActive && <span className="ml-1.5 text-[10.5px] font-normal text-ink-secondary">selected</span>}
                  </span>
                  {engine.snapshot.quota?.capped && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300">
                      Capped
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {windows.map((window) => (
                    <WindowRow key={window.kind} window={window} />
                  ))}
                </div>
                {binding && binding.remainingPercent <= 10 && (
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                    <strong>{binding.label}</strong> is nearly spent — this engine is the first to stop accepting turns.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}