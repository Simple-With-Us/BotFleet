// Classify one Zulip message for one BF bot and decide whether it wakes the
// bot.  Pure functions over plain data, ported from the fleet listener's
// router (AFC scripts/agent_sync/router.py) so a BF bot and a CLI seat read
// the same message the same way.
//
// Owner rule (docs/protocols/zulip-fleet-guide.md, Identity and Sessions):
// a message is Jay's only when the sender is his user id AND the sending
// client is a human Zulip app.  His id from any other client is flagged and
// treated as a peer.  The client name is what the sending request claims, so
// this catches honest API use and cannot stop someone holding his key: the
// verdict labels a turn, it is never authority for a side effect.

import { directlyMentions } from "./format.ts";
import type { ZulipIdentity, ZulipMessage, ZulipOrigin, ZulipUser } from "./types.ts";

export const DEFAULT_OWNER_CLIENTS = ["website", "ZulipMobile", "ZulipFlutter", "ZulipElectron", "ZulipDesktop"];
const WILDCARD_FLAGS = ["wildcard_mentioned", "stream_wildcard_mentioned", "topic_wildcard_mentioned"];
/** Zulip's bot_type for an incoming-webhook integration (Sentry, Linear, …). */
const INCOMING_WEBHOOK_BOT = 2;

export interface RouterContext {
  me: ZulipIdentity;
  ownerUserId?: number;
  ownerClients: ReadonlySet<string>;
  /** Realm members by id.  An unknown sender counts as a bot. */
  users: ReadonlyMap<number, ZulipUser>;
  nowMs: number;
  staleMs: number;
}

export interface Classification {
  own: boolean;
  owner: boolean;
  ownerViaApi: boolean;
  dm: boolean;
  groupDm: boolean;
  direct: boolean;
  wildcard: boolean;
  senderIsBot: boolean;
  webhookSender: boolean;
  stale: boolean;
  /** Where a reply goes, or null for a message nobody can reply to here. */
  origin: ZulipOrigin | null;
}

export type WakeVerdict = { wake: "owner" | "peer" } | { wake: null; reason: string };

export function isDirectMessage(message: Pick<ZulipMessage, "type">): boolean {
  return message.type === "private" || message.type === "direct";
}

export function messageTopic(message: Pick<ZulipMessage, "subject" | "topic">): string {
  return String(message.subject ?? message.topic ?? "");
}

export function classify(message: ZulipMessage, ctx: RouterContext): Classification {
  const sender = message.sender_id;
  const own = sender === ctx.me.userId;
  const dm = isDirectMessage(message);
  let groupDm = false;
  let origin: ZulipOrigin | null = null;
  if (dm) {
    const others = Array.isArray(message.display_recipient)
      ? message.display_recipient.map((r) => r.id).filter((id) => id !== ctx.me.userId)
      : [];
    groupDm = others.length !== 1 || others[0] !== sender;
    if (!groupDm && !own) origin = { kind: "dm", userId: sender };
  } else if (typeof message.display_recipient === "string") {
    origin = { kind: "stream", channel: message.display_recipient, topic: messageTopic(message) };
    if (typeof message.stream_id === "number") origin.streamId = message.stream_id;
  }
  const fromOwnerAccount = Boolean(ctx.ownerUserId) && sender === ctx.ownerUserId;
  const owner = fromOwnerAccount && !own && ctx.ownerClients.has(String(message.client ?? ""));
  const user = ctx.users.get(sender);
  return {
    own,
    owner,
    ownerViaApi: fromOwnerAccount && !owner,
    dm,
    groupDm,
    direct: directlyMentions(message.content ?? "", message.flags, ctx.me),
    wildcard: WILDCARD_FLAGS.some((flag) => message.flags?.includes(flag)),
    senderIsBot: fromOwnerAccount ? false : (user?.is_bot ?? true),
    webhookSender: user?.bot_type === INCOMING_WEBHOOK_BOT,
    stale: typeof message.timestamp === "number" && ctx.nowMs - message.timestamp * 1000 > ctx.staleMs,
    origin,
  };
}

/** Whether this message wakes the bot, and as whom.  Only a direct
 *  @-mention or a 1:1 DM ever wakes; wildcard and group mentions, group DMs,
 *  incoming-webhook bots and the bot's own posts never do.
 *
 *  A peer bot's mention or DM wakes the bot like anyone else's (the fleet's
 *  rule: peer requests are screened, not refused).  What stops a peer is
 *  the hub's loop guard and peer budgets, and the screen the woken turn is
 *  told to apply; the wake itself is never a grant of anything. */
export function wakeVerdict(c: Classification): WakeVerdict {
  if (c.own) return { wake: null, reason: "own" };
  if (!c.origin) return { wake: null, reason: c.groupDm ? "group_dm" : "no_origin" };
  if (c.ownerViaApi) return { wake: null, reason: "owner_via_api" };
  if (c.webhookSender) return { wake: null, reason: "webhook_sender" };
  if (c.owner && (c.direct || c.dm)) return { wake: "owner" };
  if (c.dm || c.direct) return c.stale ? { wake: null, reason: "stale" } : { wake: "peer" };
  if (c.wildcard) return { wake: null, reason: "wildcard" };
  return { wake: null, reason: "not_a_mention" };
}
