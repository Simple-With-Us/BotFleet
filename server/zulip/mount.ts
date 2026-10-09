// Which turns get the Zulip tools.  One pure predicate, so the dispatch in
// server/index.ts, the comms grant it mints, and the tests all read the same
// rule:
//
//   - a Zulip turn (`automationSource === "zulip"`), where the harness's own
//     target rules and secret scan stand in for a card;
//   - a continuation of one (a card answered, a model fallback): the same
//     turn, resumed;
//   - a turn the owner is attending in BotFleet: no automation source, no
//     unattended mark, and NOT a peer-invoked (`ask_bot`) turn.  A peer's
//     `ask_bot` arrives with no automation source and a comms depth above
//     zero; it carries another bot's words and nobody is watching it, so it
//     never gets an uncarded way to post as this bot.
//
// Webhook, iMessage, Linq, routine and job turns carry outside text with
// nobody watching, so they get nothing.  And nothing is mounted unless the
// bot's own Zulip session is connected and not in a dry run.

export interface ZulipMountInput {
  /** The turn's automation source, when an automation started it. */
  automationSource?: string;
  /** 0 for a turn a person or an automation started; above 0 for ask_bot. */
  commsDepth: number;
  /** The ceiling on comms depth: at it, no agents tools are mounted. */
  maxCommsDepth: number;
  /** The thread's Zulip turn is still the thread's current turn. */
  continuesZulipTurn: boolean;
  /** The bot carries an unattended mark (an outside event, a job wake). */
  unattended: boolean;
  /** The bot's Zulip session is connected and not in a dry run. */
  outboundReady: boolean;
}

export function zulipToolsMounted(input: ZulipMountInput): boolean {
  if (!input.outboundReady || input.commsDepth >= input.maxCommsDepth) return false;
  if (input.automationSource === "zulip" || input.continuesZulipTurn) return true;
  return input.automationSource === undefined && input.commsDepth === 0 && !input.unattended;
}
