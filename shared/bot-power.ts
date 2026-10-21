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

import { joinRefusals } from "./peer-refusals.ts";

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

/** Why a handoff to an Off bot was turned away, in the words the bot that
 *  asked reads.  It names the bot, because one handoff can name several and
 *  the asker has to tell which of them said no.  It is not `BOT_OFF_REFUSAL`:
 *  that tells a person to turn the bot on to chat, which a bot cannot do. */
export function botOffPeerRefusal(name: string): string {
  return `${name} is switched off`;
}

/** What coordinate_bots answers when a handoff names Off bots: each of them,
 *  once.  The refusal covers the whole request and nothing is recorded, so
 *  when the handoff named other bots too it says none of them was handed the
 *  work either (`alsoNamedOthers`), and the asker does not read a refusal of
 *  one bot as a handoff to the rest. */
export function botOffPeersRefusal(names: readonly string[], alsoNamedOthers: boolean): string {
  const reasons = joinRefusals(names.map((name) => botOffPeerRefusal(name)));
  return alsoNamedOthers ? `${reasons}.${GAP}Nothing was handed off.` : reasons;
}

// ── switching Off a bot that is working ────────────────────────────────
//
// A person who flips this switch on a busy bot may mean either of two very
// different things, and nothing on screen tells them which one they got:
// stop the work now, or stop it starting from now.  The switch cannot know,
// so it asks — but only while a turn is actually running, because that is
// the only state in which the two answers differ.  An idle bot has nothing
// to stop, so the switch just flips and no one is interrupted by a dialog.
//
// The choice stays in the client.  Off alone still never touches a running
// turn (see `settleWorkForOffBot`), which is what makes "let it finish" a
// real choice rather than a delayed stop.

/** What the prompt calls the bot it is asking about. */
export function botOffWhileRunningTitle(name: string): string {
  return `${name} Is Working`;
}

/** What turning Off does to the turn that is running right now, and the two
 *  ways out of that. */
export function botOffWhileRunningBody(name: string): string {
  return `Turning ${name} off stops new work, but the turn running now will keep going.${GAP}Stop it now, or let it finish first.`;
}

/** Stop the running turn and switch Off.  The only answer that interrupts. */
export const BOT_OFF_STOP_AND_POWER_OFF = "Stop It And Power Off";
/** Switch Off now, let the running turn finish.  What Off means on its own. */
export const BOT_OFF_AFTER_TURN = "Power Off After This Turn";
/** Change nothing: the bot stays on and its turn keeps running. */
export const BOT_OFF_KEEP_ON = "Keep It On";

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
