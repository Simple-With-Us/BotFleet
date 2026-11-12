// Incoming webhook / routine / iMessage as a collapsible work card, not a
// user bubble.
//
// Auto-delivered instructions are stored as role=system so the model still
// sees them as the turn prompt without a blue user bubble.  Older webhook
// rows used role=user; the card still catches those.  The card sits on the
// transcript's left edge like a tool-run fold: a one-line headline, with
// the untrusted payload behind Details.
import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, Webhook } from "lucide-react";

import { instructionCardLabel } from "@/lib/chat-accessibility";
import { cn } from "@/lib/cn";

export interface TriggerCardView {
  headline: string;
  subtitle?: string;
  payload?: string;
}

export function WebhookCard({
  view,
  icon,
  detailsNoun = "Event Details",
}: {
  view: TriggerCardView;
  icon?: ReactNode;
  detailsNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(view.payload);
  const label = instructionCardLabel({ headline: view.headline, subtitle: view.subtitle });

  const header = (
    <>
      {icon ?? <Webhook size={14} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-semibold text-ink" title={view.headline}>
          {view.headline}
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
          {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
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
            aria-label={label}
            title={open ? `Collapse ${detailsNoun}` : `Show ${detailsNoun}`}
            className={cn(
              // Inset, not an outward ring: the card wrapper is overflow-hidden
              // (clips the payload pane and hover fill to the rounded corners),
              // which would clip an outward focus ring at every edge and leave
              // keyboard focus invisible.
              "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-ink-secondary hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/40",
              open && "border-b border-hairline/30",
            )}
          >
            {header}
          </button>
        ) : (
          <div role="article" aria-label={label} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-ink-secondary">{header}</div>
        )}
        {open && view.payload && (
          <pre className="max-h-48 overflow-auto bg-inset/70 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {view.payload}
          </pre>
        )}
      </div>
    </div>
  );
}
