// The row a helper replaces.  Task, Agent, spawn_agent and invoke_subagent
// used to read as one more tool line.  This card names the helper, the
// step it is on, how many tools it has used, its tokens and how long it
// has run (jobs P3).
import { useEffect, useState } from "react";

import {
  helperCardModel,
  helperElapsedMs,
  helperStatsLine,
  helperStatusWord,
  type HelperStatus,
} from "../../shared/helpers";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";

const RUNNING_DOT = "bg-blue-500 motion-safe:animate-pulse";

function dotClass(status: HelperStatus): string {
  if (status === "running") return RUNNING_DOT;
  if (status === "failed") return "bg-danger";
  return "bg-success";
}

export function HelperCard({ message, now: fixedNow }: { message: Message; now?: number }) {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  const model = helperCardModel(
    { kind: message.kind, at: message.at, helper: message.helper, tool: message.tool },
    fixedNow ?? now,
  );
  useEffect(() => {
    if (fixedNow !== undefined || model?.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow, model?.status]);
  if (!model) return null;
  const status = helperStatusWord(model.status);
  const stats = helperStatsLine(model, fixedNow ?? now);
  const duration = helperElapsedMs(model, fixedNow ?? now);
  return (
    <div
      className="my-1 flex w-full max-w-[36rem] flex-col gap-1 rounded-xl border border-hairline/50 bg-card px-3.5 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.04)]"
      data-testid="helper-card"
      data-status={model.status}
      data-fidelity={model.fidelity}
      data-depth={model.depth}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotClass(model.status))} />
        <span className="shrink-0 text-[13px] font-semibold text-ink">Helper</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={model.label}>
          {model.label}
        </span>
        <span className={cn("shrink-0 text-[11.5px] font-medium", model.status === "failed" ? "text-danger" : "text-ink-secondary")}>
          {status}
        </span>
      </div>
      {model.lastActivity && (
        <div className="truncate pl-4 text-[12px] text-ink-secondary" title={model.lastActivity} data-testid="helper-activity">
          {model.lastActivity}
        </div>
      )}
      <div className="pl-4 text-[11.5px] text-ink-secondary" data-testid="helper-stats" data-duration-ms={duration}>
        {stats}
      </div>
    </div>
  );
}
