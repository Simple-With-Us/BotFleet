import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, GitFork } from "lucide-react";

import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import type { DelegationMessageView } from "../../shared/delegation-message";
import type { Message } from "@/state/store";
import { BotMascot } from "./Avatar";

export function DelegationCard({
  view,
  comm,
  targetBotName,
  icon,
}: {
  view: DelegationMessageView;
  comm?: Message["comm"];
  targetBotName?: string;
  icon?: ReactNode;
}) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const expandable = Boolean(view.payload);

  const header = (
    <>
      {icon ?? (
        comm?.withColor ? (
          <BotMascot color={comm.withColor} state="happy" size={18} animated={false} />
        ) : (
          <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <GitFork size={13} aria-hidden="true" />
          </div>
        )
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink" title={view.headline}>
            {view.headline}
          </span>
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            Bot to Bot
          </span>
        </span>
        {view.subtitle && (
          <span className="truncate text-[11.5px] text-ink-secondary" title={view.subtitle}>
            {view.subtitle}
          </span>
        )}
      </span>
      {expandable && (
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
          <span>{open ? "Collapse" : "Details"}</span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      )}
    </>
  );

  return (
    <div className="my-1 flex justify-start">
      <div className="w-full min-w-0 max-w-[36rem] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-[0_1px_0_rgba(0,0,0,0.04)]">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            title={open ? "Collapse Task Details" : "Show Task Details"}
            className={cn(
              "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-ink-secondary hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/40",
              (open || comm) && "border-b border-hairline/30",
            )}
          >
            {header}
          </button>
        ) : (
          <div className={cn("flex w-full items-center gap-2.5 px-3.5 py-2.5 text-ink-secondary", comm && "border-b border-hairline/30")}>
            {header}
          </div>
        )}
        {comm && (
          <div className="flex items-center justify-between bg-inset/40 px-3.5 py-1.5 text-[11.5px] text-ink-secondary">
            <span>Mirrored in bot-to-bot thread</span>
            <button
              type="button"
              onClick={() => dispatch({ type: "select", id: comm.groupId })}
              className="font-medium text-accent hover:underline inline-flex items-center gap-1"
            >
              Open @{comm.withName} ⇄ @{targetBotName ?? "Bot"} →
            </button>
          </div>
        )}
        {open && view.payload && (
          <pre className="max-h-60 overflow-auto bg-inset/70 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {view.payload}
          </pre>
        )}
      </div>
    </div>
  );
}
