// What a bot's roster row should say beyond the generic busy spinner.
//
// Ported from upstream's SidebarBotActivity shape (OMB PR #1228,
// src/components/SidebarBotActivity.tsx): a bot's "busy" state there
// distinguishes waiting-on-a-person from waiting-on-a-teammate
// (`task.waitingForTeammates`) from plain work, and each gets its own
// icon/label instead of one undifferentiated spinner.
//
// BotFleet has no `waitingForTeammates` field — this derives the same
// three-way split from signals the harness already sends the renderer:
//   - an open options card (server/index.ts "request.opened"): `card.tool`
//     set means a permission ask ("waiting for approval"); unset means the
//     bot posed its own question ("waiting for you").
//   - a peer-approval card (server/peer-approval.ts): `card.tool` is
//     "ask_bot" or "delegate_bot" and `card.allowKey` is stamped
//     "<action>:<targetBotId>" (server/peer-approval-key.ts) — the target
//     bot is knowable, so this outranks the plain approval/question split
//     ("waiting on @Teammate").
//   - the comm chip a bot's own thread gets the moment it calls ask_bot
//     (server/comms-visibility.ts mirrorExchange: "Messaged @X", carrying
//     `comm.withName`) or delegate_bot (server/delegations.ts
//     queueDelegation: "Delegated to @X…", prose-only) — while the bot is
//     still busy and that chip is the last thing in its active thread, it
//     is almost certainly still waiting on that reply.
import type { Bot, Message, OptionCardData } from "@/state/store";

export type BotWaitReason =
  | { kind: "teammate"; name: string }
  | { kind: "approval" }
  | { kind: "question" };

const MESSAGED_PREFIX = "Messaged @";
const DELEGATED_PREFIX = "Delegated to @";

/** The still-open card at the tail of a thread, if any. Answered/dismissed
 * cards are not open — the harness only ever pauses a bot for a LIVE ask. */
function openCardOf(last: Message | undefined): OptionCardData | undefined {
  if (last?.kind !== "options" || !last.card) return undefined;
  return last.card.answered || last.card.dismissed ? undefined : last.card;
}

/** The peer this card names, straight from the allowKey the harness and
 * the "always allow" grant already agree on (server/peer-approval-key.ts)
 * — never parsed out of the card's prose title, which is copy and may
 * change under it. */
function peerApprovalTeammate(card: OptionCardData | undefined, bots: Bot[]): string | undefined {
  if (card?.tool !== "ask_bot" && card?.tool !== "delegate_bot") return undefined;
  const targetId = card.allowKey?.split(":")[1];
  return targetId ? bots.find((bot) => bot.id === targetId)?.name : undefined;
}

/** The peer named in the bot's own most recent outbound comm/delegation
 * chip — the only two chip shapes server/comms-visibility.ts and
 * server/delegations.ts stamp into the CALLING bot's own thread. */
function outboundTeammate(last: Message | undefined, bots: Bot[]): string | undefined {
  if (last?.kind !== "activity") return undefined;
  const name = last.tool?.name;
  if (!name) return undefined;
  if (last.comm && name.startsWith(MESSAGED_PREFIX)) return last.comm.withName;
  if (name.startsWith(DELEGATED_PREFIX)) {
    const label = name.slice(DELEGATED_PREFIX.length).split(/[:\n]/, 1)[0]?.trim();
    return label && bots.some((bot) => bot.name === label) ? label : undefined;
  }
  return undefined;
}

/** What a bot's indicator should say, beyond the plain spinner. `last` is
 * the tail of the bot's own visible thread (`visibleMessages(bot).at(-1)`)
 * — the same message the roster row's plain-text preview already reads.
 * Returns null when there is nothing more specific to say than "Working…". */
export function botWaitReason(bot: Bot, last: Message | undefined, bots: Bot[]): BotWaitReason | null {
  const openCard = openCardOf(last);
  if (bot.activity === "waiting-on-you") {
    const teammate = peerApprovalTeammate(openCard, bots);
    if (teammate) return { kind: "teammate", name: teammate };
    return openCard?.tool ? { kind: "approval" } : { kind: "question" };
  }
  if (bot.busy) {
    const teammate = outboundTeammate(last, bots);
    if (teammate) return { kind: "teammate", name: teammate };
  }
  return null;
}

/** The roster row's status text — ported 1:1 from upstream's own copy
 * choices for "waiting" vs "working", split further for approval vs
 * question. Falls back to the pre-existing "Working…" for a plain busy
 * bot with nothing more specific to report, and "" when idle. */
export function botStatusText(bot: Bot, wait: BotWaitReason | null): string {
  if (wait?.kind === "teammate") return `Waiting on @${wait.name}…`;
  if (wait?.kind === "approval") return "Waiting for approval…";
  if (wait?.kind === "question") return "Waiting for you…";
  return bot.busy ? "Working…" : "";
}
