import { Power } from "lucide-react";
import { cn } from "@/lib/cn";

const GAP = "  ";

/** What the switch promises, in the owner's terms.  Kept as data so the
 *  settings panel, the visual fixture and the tests read one copy. */
export const BOT_POWER_COPY = {
  label: "On/Off",
  on: `This bot answers chat, runs its routines and webhooks, and speaks in rooms.${GAP}Turn it off to stop all new work.`,
  off: `Nothing new starts for this bot.${GAP}Chat from every app, routines, webhooks and rooms are skipped, and a turn already running finishes.${GAP}Its chat stays visible.`,
} as const;

/** The bot's On/Off switch (shared/bot-power.ts), a card in the Bot Profile
 *  panel.  Off is a state, not a mode: it is the only control here that stops
 *  routines and webhooks as well as chat, which is why it sits first. */
export function BotPowerToggle({ off, onChange }: { off: boolean; onChange: (off: boolean) => void }) {
  const on = !off;
  return (
    <div
      data-testid="bot-power-toggle"
      className={cn(
        "flex items-center justify-between gap-4 rounded-xl border p-4",
        off ? "border-hairline/60 bg-control/60" : "border-transparent bg-card",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            on ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
          )}
        >
          <Power size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">
            {BOT_POWER_COPY.label}
            <span className="ml-2 text-[12.5px] font-normal text-ink-secondary">{on ? "On" : "Off"}</span>
          </div>
          <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
            {on ? BOT_POWER_COPY.on : BOT_POWER_COPY.off}
          </div>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Bot On/Off"
        onClick={() => onChange(on)}
        className={cn(
          "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
          on ? "bg-accent" : "bg-control",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] size-5 rounded-full bg-white transition-all",
            on ? "left-[21px]" : "left-[3px]",
          )}
        />
      </button>
    </div>
  );
}
