// Stop is this turn.  Off is the only hold.
//
// Owner ruling, Sun Oct 18 2026 (docs/decisions/2026-10-18-stop-is-this-turn.md):
// the stop button stops that turn, like every other coding app; it does not
// turn the bot off, because that is what Off is for.  So Stop (the button,
// the typed /stop, the iMessage /stop, all through `interruptBot`) interrupts
// the turn running now, closes its approvals and cancels the routine run that
// turn was carrying, and it leaves nothing behind.  There is no latch on the
// bot: the next webhook, schedule, resource trigger, Zulip message, job wake
// or person's message starts a turn exactly as it would have before the Stop,
// and nobody has to send the bot a message to "wake" it.
//
// That replaces two earlier rules.  Sep 21 (#514) made Stop snooze every
// automation for the bot until the person's next message, so webhooks and
// schedules could not restart a bot seconds after a Stop during an update.
// Oct 2 (#802) made that snooze outlive updates and resumes ("a stopped bot
// stays stopped").  The snooze lived in routines.json as `botSnoozes`, no
// client showed it, and a stray Stop on an idle bot set it.  `RoutineManager`
// drops any `botSnoozes` an older build saved, so an update unlatches every
// install by itself.
//
// Keeping a bot from starting work is Off's job (shared/bot-power.ts): a
// visible decision about the BOT that refuses every new turn, a person's
// included, until an explicit Turn On.  `startTurn` refuses an Off bot before
// anything else, so an update resume, a boot recovery or a card continuation
// can never restart one.  Those callers retry on failure, so they need to tell
// "the bot is off" (a decision: settle quietly) from "the provider failed"
// (worth retrying or reporting), and that is `isBotOffError`.
//
// Pure and clock-free so the policy is testable without booting a harness.
import { BOT_OFF_CODE, BOT_OFF_REFUSAL } from "../shared/bot-power.ts";

/** The error `startTurn` throws for an Off bot: a 409 with a stable code, so a
 *  caller or client can tell it apart from a busy bot or a fenced harness. */
export function botOffError(): Error & { status: number; code: string } {
  return Object.assign(new Error(BOT_OFF_REFUSAL), { status: 409, code: BOT_OFF_CODE });
}

/** Whether a dispatch failure was an Off bot refusing, not a real error.
 *
 * Callers that retry on failure (a card continuation, an update resume, boot
 * recovery) must be able to tell "the provider is unhappy" from "the person
 * switched this bot Off on purpose": only the first is worth retrying or
 * remembering as a failure. */
export function isBotOffError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === BOT_OFF_CODE;
}
