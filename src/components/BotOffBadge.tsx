import { cn } from "@/lib/cn";

/** The "Off" marker for a bot that is switched Off (shared/bot-power.ts).
 *  Shown beside the bot in the sidebar and next to its name in the chat
 *  header, together with a dimmed avatar, so an Off bot is never mistaken for
 *  one that is merely idle.  Status text, so sentence case. */
export function BotOffBadge({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span
      data-testid="bot-off-badge"
      title="This bot is off"
      aria-label="Off"
      className={cn(
        "shrink-0 select-none rounded-md border border-hairline/60 bg-control font-semibold leading-none text-ink-secondary",
        compact ? "px-1 py-[3px] text-[9.5px]" : "px-1.5 py-[3px] text-[11px]",
        className,
      )}
    >
      Off
    </span>
  );
}
