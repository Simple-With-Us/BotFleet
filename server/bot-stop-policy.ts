// Stop is this turn.  Off is the only hold.
//
// Owner ruling (Linear BF-2453; Jay via iMessage, Nov 15 2026: stop the
// "current turn", because powering off is how you stop a bot longer term):
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
// client showed it, and a stray Stop on an idle bot set it.  No code path
// writes a snooze any more, and `RoutineManager` drops any `botSnoozes` an
// older build saved, so an update unlatches every install by itself.
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

/** Whether a dispatch failure was a deliberate refusal, not a real error.
 *
 * Callers that retry on failure (a card continuation, an update resume, boot
 * recovery) must be able to tell "the provider is unhappy" from "the person
 * switched this bot Off on purpose": only the first is worth retrying or
 * remembering as a failure.  The legacy `bot_stopped` code is matched too:
 * turns refused by a build from before Stop became turn-scoped still carry
 * it, and a deliberate Stop was the same kind of decision, never a fault.
 *
 * `botStopErrorCode` is the same read for a caller whose recovery differs
 * between a stop and an Off switch (server/jobs/wake.ts, BF-2454); new code
 * should use `isBotOffError`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught dispatch failure is the untrusted input this boundary parses
export function botStopErrorCode(error: unknown): "bot_stopped" | typeof BOT_OFF_CODE | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "bot_stopped" || code === BOT_OFF_CODE ? code : undefined;
}

export function isBotOffError(error: unknown): boolean {
  return botStopErrorCode(error) !== undefined;
}

/** The skip receipt text for a routine a snooze held back.  Stop no longer
 *  sets a snooze, so only an explicit `snoozeBot` call (a test, or a future
 *  deliberate-pause feature) can produce this. */
export function botAutomationsPausedMessage(): string {
  return "Automations paused for this bot.  A person's message or Run now resumes them.";
}
