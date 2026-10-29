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

import { canonicalZulipRole } from "../launch-identity.ts";

import { directlyMentions, followKey, outsideCode } from "./format.ts";
import type { ZulipIdentity, ZulipMessage, ZulipOrigin, ZulipUser } from "./types.ts";

export const DEFAULT_OWNER_CLIENTS = ["website", "ZulipMobile", "ZulipFlutter", "ZulipElectron", "ZulipDesktop"];
const WILDCARD_FLAGS = ["wildcard_mentioned", "stream_wildcard_mentioned", "topic_wildcard_mentioned"];
/** Zulip's bot_type for an incoming-webhook integration (Sentry, Linear, …). */
const INCOMING_WEBHOOK_BOT = 2;

/** The no-wake marker:  the eyes emoji, written as the shortcode the
 *  fleet's tooling uses or as the character itself.  A message that STARTS
 *  with it wakes nobody. */
const EYES_MARKER = /^(?::eyes:|\u{1F440})/u;

/** The seat tag a post carries:  `[BF-PLUMBER]`, `[SEAT·session]` or
 *  `[SEAT→LABEL]`.  The harness prepends `[BF-ROLE] ` to every post, and
 *  the fleet's tooling writes `[SEAT·session] ` or `[SEAT→LABEL] `.  The
 *  seat name is matched in any case:  the seat tag is an identifier, and
 *  the tooling that writes it may write it in any case. */
const SEAT_TAG = /^\s*\[(?<seat>[A-Z0-9][A-Z0-9_-]*)(?<session>(?:\u00b7[^\]]*)?)(?:\u2192[^\]]*)?\]\s*/i;

/** A raw broadcast token in the visible content.  `all`, `channel` and
 *  `stream` wake the bot;  `everyone` is inbox-only and never does.  The
 *  lookbehind keeps a word or an escaped `@` from counting, and the
 *  trailing guard keeps `@all-of-the-team` from counting as `@all`. */
const BROADCAST_TOKEN =
  /(?<![\\\w*])@(?:\*\*(all|everyone|channel|stream)\*\*|(all|everyone|channel|stream)\b(?![-\w*]))/gi;

export interface RouterContext {
  me: ZulipIdentity;
  ownerUserId?: number;
  ownerClients: ReadonlySet<string>;
  /** Realm members by id.  An unknown sender counts as a bot. */
  users: ReadonlyMap<number, ZulipUser>;
  nowMs: number;
  staleMs: number;
  /** Topics this bot follows, by followKey(stream id, topic). */
  followed?: ReadonlySet<string>;
}

export interface Classification {
  own: boolean;
  owner: boolean;
  ownerViaApi: boolean;
  dm: boolean;
  groupDm: boolean;
  direct: boolean;
  /** A channel message in a topic this bot follows. */
  followed: boolean;
  wildcard: boolean;
  /** The message starts with the no-wake marker:  it wakes nobody. */
  noWake: boolean;
  /** The message carries an @all / @channel / @stream broadcast. */
  broadcastAll: boolean;
  senderIsBot: boolean;
  webhookSender: boolean;
  stale: boolean;
  /** Where a reply goes, or null for a message nobody can reply to here. */
  origin: ZulipOrigin | null;
}

/** Why a message woke the bot: an @-mention, a 1:1 DM, a new message in
 *  a topic it follows, or an @all broadcast. */
export type WakeReason = "mention" | "dm" | "followed" | "broadcast";

export type WakeVerdict = { wake: "owner" | "peer"; via: WakeReason } | { wake: null; reason: string };

export function isDirectMessage(message: Pick<ZulipMessage, "type">): boolean {
  return message.type === "private" || message.type === "direct";
}

export function messageTopic(message: Pick<ZulipMessage, "subject" | "topic">): string {
  return String(message.subject ?? message.topic ?? "");
}

/** The seat prefixes a bot email maps to.  Named constants, not inline
 *  templates:  the shipped source carries no operator-private naming
 *  patterns (server/prompt-privacy.test.ts). */
const BF_SEAT_PREFIX = "BF-";
const GB_SEAT_PREFIX = "GB-";

/** The fleet seat a bot email belongs to, or null when the email names no
 *  seat:  `bf-plumber-bot@` → `BF-PLUMBER`, `compiler-grok-bot@` →
 *  `GB-COMPILER`, `mm-bot@` → `MM`.  A legacy `bf-` address folds to its
 *  canonical seat (`bf-builder-bot@` → `BF-ENGINEER`), so the email-derived
 *  seat agrees with the tag a legacy-bound session posts under.  The seat
 *  tag is how a post says who wrote it, so the router can tell a post's own
 *  seat from another's. */
export function seatTagForEmail(email: string | undefined | null): string | null {
  const local = String(email ?? "").split("@")[0]?.trim().toLowerCase() ?? "";
  if (!local) return null;
  const base = local.endsWith("-bot") ? local.slice(0, -"-bot".length) : local;
  if (!base) return null;
  if (base.startsWith("bf-")) {
    return canonicalZulipRole(BF_SEAT_PREFIX + base.slice("bf-".length).toUpperCase()).toUpperCase();
  }
  if (base.endsWith("-grok")) return GB_SEAT_PREFIX + base.slice(0, -"-grok".length).toUpperCase();
  return base.toUpperCase();
}

/** True when the message starts with the no-wake marker, so it wakes
 *  nobody:  the eyes emoji (the `:eyes:` shortcode or the character),
 *  optionally right after the one seat tag the fleet prepends.
 *
 *  A marker inside a sentence, a quote or a code span is not a marker:  it
 *  has to start the message.  After a seat tag the marker counts only when
 *  the tag carries a session (`·`) or names the sender's OWN seat, so a
 *  post tagged for another seat cannot silence the fleet. */
export function startsWithNoWakeMarker(content: string, senderEmail?: string | null): boolean {
  const text = String(content ?? "").replace(/^\s+/, "");
  const tag = SEAT_TAG.exec(text);
  if (!tag) return EYES_MARKER.test(text);
  const seat = (tag.groups?.seat ?? "").toUpperCase();
  const session = tag.groups?.session ?? "";
  const ownSeat = seatTagForEmail(senderEmail);
  if (!session && seat !== ownSeat) return false;
  return EYES_MARKER.test(text.slice(tag[0].length));
}

/** True when the visible content carries an @all, @channel or @stream
 *  broadcast.  `@everyone` is inbox-only and never counts, and a token
 *  inside code or a quote is an example, not a call. */
export function hasBroadcastAll(content: string): boolean {
  const visible = outsideCode(String(content ?? ""));
  for (const match of visible.matchAll(BROADCAST_TOKEN)) {
    const token = (match[1] ?? match[2] ?? "").toLowerCase();
    if (token === "all" || token === "channel" || token === "stream") return true;
  }
  return false;
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
  const content = String(message.content ?? "");
  return {
    own,
    owner,
    ownerViaApi: fromOwnerAccount && !owner,
    dm,
    groupDm,
    direct: directlyMentions(content, message.flags, ctx.me),
    followed:
      !dm &&
      typeof message.stream_id === "number" &&
      Boolean(ctx.followed?.has(followKey(message.stream_id, messageTopic(message)))),
    wildcard: WILDCARD_FLAGS.some((flag) => message.flags?.includes(flag)),
    noWake: startsWithNoWakeMarker(content, message.sender_email),
    broadcastAll: hasBroadcastAll(content),
    senderIsBot: fromOwnerAccount ? false : (user?.is_bot ?? true),
    webhookSender: user?.bot_type === INCOMING_WEBHOOK_BOT,
    stale: typeof message.timestamp === "number" && ctx.nowMs - message.timestamp * 1000 > ctx.staleMs,
    origin,
  };
}

/** Whether this message wakes the bot, as whom, and why.  A direct
 *  @-mention, a 1:1 DM, a new message in a topic the bot follows, or an
 *  @all broadcast in a channel wakes it; `@everyone`, `@topic`, group
 *  mentions outside a followed topic, group DMs, incoming-webhook bots and
 *  the bot's own posts never do.
 *
 *  A message that starts with the no-wake marker (the eyes emoji) wakes
 *  nobody at all:  it is checked first, before every other rule.
 *
 *  A peer bot's mention or DM wakes the bot like anyone else's (the fleet's
 *  rule: peer requests are screened, not refused).  What stops a peer is
 *  the hub's loop guard and peer budgets, and the screen the woken turn is
 *  told to apply; the wake itself is never a grant of anything. */
export function wakeVerdict(c: Classification): WakeVerdict {
  if (c.noWake) return { wake: null, reason: "no_wake" };
  if (c.own) return { wake: null, reason: "own" };
  if (!c.origin) return { wake: null, reason: c.groupDm ? "group_dm" : "no_origin" };
  if (c.ownerViaApi) return { wake: null, reason: "owner_via_api" };
  if (c.webhookSender) return { wake: null, reason: "webhook_sender" };
  // An @all (or @channel / @stream) broadcast in a channel wakes the bot:
  // Jay's as the owner, a peer's as a peer (screened, and on the same
  // budgets and loop guard as any other peer wake).  `@everyone` is
  // inbox-only and never reaches this line.
  if (c.broadcastAll && !c.dm) {
    if (c.owner) return { wake: "owner", via: "broadcast" };
    return c.stale ? { wake: null, reason: "stale" } : { wake: "peer", via: "broadcast" };
  }
  const via: WakeReason | null = c.dm ? "dm" : c.direct ? "mention" : c.followed ? "followed" : null;
  if (c.owner && via) return { wake: "owner", via };
  if (via) return c.stale ? { wake: null, reason: "stale" } : { wake: "peer", via };
  if (c.wildcard) return { wake: null, reason: "wildcard" };
  return { wake: null, reason: "not_a_mention" };
}
