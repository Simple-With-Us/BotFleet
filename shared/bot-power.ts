// A bot's On/Off switch.
//
// Off is a decision about the BOT: no new turn starts for it, from any source,
// until a person turns it back on.  It is deliberately not any of the things
// it resembles:
//
//   - `hidden` is an archive.  It removes the bot from the roster, and a room
//     calls it "archived".  Off keeps the bot, and its chat, fully visible.
//   - the routine manager's `botSnoozes` entry is a "stop".  A stop halts
//     automation but a person's own message wakes the bot and clears it
//     (server/bot-stop-policy.ts).  Off must survive a message: only an
//     explicit Turn On clears it.
//
// The flag lives on the bot record (`off?: boolean`, absent means on), so it
// persists with the roster across harness restarts and updates, and every
// client already receives it because the wire frame spreads the record.
//
// A turn that is already running is never interrupted by switching Off.  The
// gate is on STARTING work; it finishes what it began and nothing new follows.

/** Real U+00A0 plus a space: the repo's sentence gap for copy that a renderer
 *  would otherwise collapse (see src/lib/remote-access.ts `sentenceGapHtml`). */
const GAP = "  ";

/** Whether this bot is switched Off.  Total over a missing bot so callers can
 *  pass `store.bot(id)` without a null check of their own. */
export function botIsOff(bot: { off?: boolean } | null | undefined): boolean {
  return bot?.off === true;
}

/** Stable machine-readable code carried on the refusal error and the HTTP body. */
export const BOT_OFF_CODE = "bot_off";

/** Why a message to an Off bot was refused, in the words the composer uses. */
export const BOT_OFF_REFUSAL = `This bot is off.${GAP}Turn it on to chat.`;

/** The composer's disabled-state headline and its button. */
export const BOT_OFF_COMPOSER_NOTICE = BOT_OFF_REFUSAL;
export const BOT_OFF_TURN_ON_LABEL = "Turn On";

/** Run-history entry for a routine, webhook or resource trigger that fired
 *  while the bot was Off.  Skipped, not retried: it is gone, but recorded. */
export const BOT_OFF_SKIPPED = "Skipped: this bot is off";

/** Transcript line for words a person queued behind a running turn when the
 *  bot was switched Off before they could be sent. */
export function botOffQueuedNotSent(count: number): string {
  return count === 1
    ? `Not sent: this bot is off.${GAP}Your queued message was dropped.`
    : `Not sent: this bot is off.${GAP}Your ${count} queued messages were dropped.`;
}

/** Room line for a member who cannot speak because they are Off. */
export function botOffRoomNotice(name: string): string {
  return `${name} is off and can't respond.${GAP}Turn it on, or mention another room member.`;
}
