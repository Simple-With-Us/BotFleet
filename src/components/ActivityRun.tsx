// A folded stretch of tool chips: interactive summary card with live step counters, click to open.
//
// Collapsed by default, with two exceptions the transcript would be worse
// without: a run holding a failure opens itself (the failure is the reason
// you would have opened it), and a run stays open once you have opened it.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Check, X, Loader2 } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { cn } from "@/lib/cn";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const failed = messages.some((message) => message.tool?.ok === false);
  const running = messages.some((message) => message.tool?.ok === undefined);
  const [open, setOpen] = useState(failed || forceOpen);

  const firstAt = messages[0]?.at;
  const lastAt = messages[messages.length - 1]?.at;
  const durationSec = firstAt && lastAt && lastAt - firstAt >= 1000
    ? Math.round((lastAt - firstAt) / 1000)
    : 0;

  useEffect(() => {
    if (failed || forceOpen) setOpen(true);
  }, [failed, forceOpen]);

  if (open) {
    return (
      <div className="my-1 flex flex-col gap-1.5 rounded-xl border border-hairline/40 bg-panel/60 p-2">
        <div className="flex items-center justify-between border-b border-hairline/30 pb-1.5">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] font-medium text-ink-secondary hover:bg-control hover:text-ink transition-colors"
          >
            <ChevronDown size={14} className="text-ink-secondary" />
            <span>{describeRun(messages)}</span>
            {durationSec > 0 && (
              <span className="text-[11px] text-ink-secondary/70 font-mono font-normal">
                · {durationSec}s
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[11px] font-medium text-accent hover:underline px-2 py-0.5"
          >
            Collapse
          </button>
        </div>
        <div className="flex flex-col gap-1.5 pt-1 pl-1">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="my-0.5 flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Show All Steps"
        className={cn(
          "group flex items-center gap-2.5 rounded-xl border border-hairline/40 bg-panel px-3.5 py-2 text-[13px] transition-all hover:bg-raised hover:border-hairline/80 shadow-xs",
          failed ? "border-danger/30 text-danger bg-danger/5" : "text-ink-secondary",
        )}
      >
        <div className="flex items-center justify-center">
          {running ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : failed ? (
            <X size={13} className="text-danger" />
          ) : (
            <Check size={13} className="text-success" />
          )}
        </div>
        <span className="max-w-[480px] font-medium text-ink truncate" title={describeRun(messages)}>{describeRun(messages)}</span>
        {durationSec > 0 && (
          <span className="text-[11px] text-ink-secondary/70 font-mono font-normal shrink-0">
            {durationSec}s
          </span>
        )}
        <div className="flex items-center gap-1 text-[11px] font-medium text-accent opacity-90 group-hover:opacity-100">
          <span>Show {messages.length}</span>
          <ChevronRight size={13} />
        </div>
      </button>
    </div>
  );
}
