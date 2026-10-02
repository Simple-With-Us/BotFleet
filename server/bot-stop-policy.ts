// "A bot a person stopped must stay stopped."
//
// The product already records that decision — `RoutineManager.snoozeBot(botId)`
// writes a durable `botSnoozes` entry that survives restarts, and every
// *scheduled* dispatcher already consults it (`routines.ts` `isBotSnoozed`).
// What no dispatcher consulted was the set of paths that wake a bot because
// the SYSTEM decided to, not the person:
//
//   - `resumeInterruptedChatTurns` (an update's pause-and-install, its
//     rollback, and its post-reboot resume),
//   - `recoverInflightTurn` (boot recovery),
//   - the credential / connector / secret card continuations.
//
// Each of those re-dispatched through `startTurn`, and `startTurn` began with
// `if (!opts?.automationSource) routines?.clearBotSnooze(botId)` — so a resume
// carrying a *human* prompt (no `automationSource`) actively ERASED the stop
// before the bot was re-dispatched.  A person who stopped a bot to stop it
// watched it restart, by itself, on the next update or the next reboot.
//
// The distinction that matters is not "is this turn automated" — a person's
// own message is how you WAKE a bot, and that must keep working.  It is "did
// a person ask for THIS turn".  A resume is the system replaying work on its
// own initiative, so it must never both clear the stop and start the turn.
//
// Pure and clock-free so the policy is testable without booting a harness.
export type BotStopDecision =
  /** The stop stands.  Do not dispatch, and do not clear the stop. */
  | { action: "refuse"; reason: "bot-stopped" }
  /** A person asked for this turn; it may proceed and clears the stop. */
  | { action: "allow"; clearsStop: true }
  /** System-initiated work on a bot that is not stopped. */
  | { action: "allow"; clearsStop: false };

export interface BotStopInput {
  /** `RoutineManager.isBotSnoozed(botId)` for the bot this turn targets. */
  stopped: boolean;
  /**
   * True when a PERSON initiated this specific turn — a message they sent, or
   * an explicit "run now".  False for every system-initiated dispatch: update
   * resume, boot recovery, card continuations, jobs, routines, webhooks.
   */
  personInitiated: boolean;
}

/**
 * The one place that answers "may this turn start, and does it clear a stop?".
 *
 * `personInitiated` is the load-bearing input and callers must be honest about
 * it.  A resume that passes `personInitiated: true` because the *original*
 * turn was a person's message is the exact bug this module exists to prevent:
 * the person stopped the bot, and the system replayed their old message over
 * the top of that decision.
 */
export function decideBotStop(input: BotStopInput): BotStopDecision {
  if (input.personInitiated) return { action: "allow", clearsStop: true };
  if (input.stopped) return { action: "refuse", reason: "bot-stopped" };
  return { action: "allow", clearsStop: false };
}

/**
 * Why a refusal is worth telling the person about, in the words the thread
 * already uses.  A system turn that was refused is silent on purpose: nobody
 * asked for it, so a message in the transcript would be noise.  The caller
 * logs instead.
 */
export function botStopRefusalMessage(): string {
  return "This bot is stopped. Start it again to let this work continue.";
}

/** Whether a dispatch failure was this policy refusing, not a real error.
 *
 * Callers that retry on failure (a card continuation, a boot resume) must be
 * able to tell "the provider is unhappy" from "you stopped this bot on
 * purpose" — only the first is worth retrying or reporting as a failure.
 */
export function isBotStoppedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "bot_stopped");
}
