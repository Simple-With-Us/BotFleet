import { Power } from "lucide-react";
import { BOT_OFF_COMPOSER_NOTICE, BOT_OFF_TURN_ON_LABEL } from "../../shared/bot-power";

/** What the composer shows instead of its input while the bot is Off.
 *
 *  The chat above it stays fully visible and scrollable; only sending is
 *  withheld, because the harness refuses every new turn for an Off bot.  The
 *  one action offered is the way out of the state, so the person is never
 *  left guessing why typing does nothing.  The message in progress is not
 *  lost: the draft lives in `useComposerDraft`, keyed by bot, and comes back
 *  the moment the real composer does. */
export function BotOffComposer({ botName, onTurnOn }: { botName: string; onTurnOn: () => void }) {
  return (
    <div className="pointer-events-none relative px-5 pb-3" data-testid="bot-off-composer">
      <div
        aria-hidden
        className="pointer-events-none h-10 bg-gradient-to-t from-app to-transparent"
      />
      <div className="pointer-events-auto relative w-full overflow-hidden rounded-3xl border border-hairline/50 bg-raised shadow-[0_-10px_28px_rgba(20,24,32,0.08)]">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-control text-ink-secondary">
            <Power size={16} aria-hidden="true" />
          </span>
          <p role="status" aria-disabled="true" className="min-w-0 flex-1 text-[14px] text-ink-secondary">
            {BOT_OFF_COMPOSER_NOTICE}
          </p>
          <button
            type="button"
            onClick={onTurnOn}
            aria-label={`${BOT_OFF_TURN_ON_LABEL} ${botName}`}
            className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
          >
            {BOT_OFF_TURN_ON_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}
