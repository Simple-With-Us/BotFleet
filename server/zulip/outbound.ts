// The rules every outbound Zulip post passes, on both tool lanes and for the
// auto-reply: one function decides the target, one decides whether the text
// may leave.  The schema a model sees says what to pass; this file is what
// actually holds the line, so the two lanes cannot drift.
//
//   - zulip_reply goes to the conversation that woke this turn, and nowhere
//     else.  The model cannot redirect it.
//   - zulip_post needs a channel AND a topic (at most 58 characters, never
//     the bot's own name), and the channel must be the origin's (any topic
//     in it: one topic per unit of work) or one the owner listed in
//     `zulip.postChannels`.  Other channels are refused rather than carded:
//     a Zulip turn is unattended, so a card would only stall it.
//   - A DM goes to the person whose 1:1 DM started this turn, or to any
//     active realm member who is the owner or a bot: never the bot itself,
//     never an incoming-webhook bot, never a deactivated or unknown user,
//     and never a person who is not the owner.  The hub also caps DMs that
//     are not replies per bot per hour (`budgets.dmsPerHour`).
//   - Text that looks like a secret is refused, in the content and in a new
//     topic, and the refusal names the kind of match, never the matched text.

import { z } from "zod";

import { redactSecretsInText } from "../../shared/redact.ts";
import { ZULIP_MAX_CONTENT_CHARS, sameOrigin, splitContent, topicRefusal } from "./format.ts";
import { sentenceGap } from "./sentence-gap.ts";
import type { ZulipOrigin, ZulipUser } from "./types.ts";

/** At most this many chunks per call; longer belongs in a file or a link. */
export const ZULIP_MAX_CHUNKS = 4;

export type ZulipTarget = { kind: "stream"; channel: string; topic: string } | { kind: "dm"; userIds: number[] };

/** A run of exactly 32 letters and digits: the length of a Zulip API key. */
const ZULIP_KEY_CANDIDATE = /(?<![A-Za-z0-9])[A-Za-z0-9]{32}(?![A-Za-z0-9])/g;

/** What kind of secret `text` holds, or null.  `known` are exact values that
 *  must never leave (every loaded Zulip key and its Basic token). */
export function secretRefusal(text: string, known: readonly string[]): string | null {
  for (const value of known) {
    if (value && value.length >= 8 && text.includes(value)) return "a loaded Zulip credential";
  }
  if (redactSecretsInText(text) !== text) return "a credential-shaped value";
  for (const match of text.matchAll(ZULIP_KEY_CANDIDATE)) {
    const token = match[0];
    // Zulip API keys are 32 mixed-case letters and digits.  A hex digest or
    // an all-lowercase slug is not one.
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token)) return "a Zulip-shaped API key";
  }
  return null;
}

/** The arguments both tools take, parsed once at the boundary (the hub's
 *  `send`) on both lanes.  Extra keys are dropped: a model that passes a bot
 *  or thread id is passing something the harness never reads. */
export const zulipToolArgsSchema = z.object({
  content: z.string().optional(),
  channel: z.string().optional(),
  topic: z.string().optional(),
  dm_user_id: z.union([z.number(), z.string()]).optional(),
});

export type OutboundArgs = z.infer<typeof zulipToolArgsSchema>;

/** zulip_follow_topic's arguments, parsed at the hub's boundary like the
 *  post tools'.  `follow` may arrive as a JSON boolean or its text. */
export const zulipFollowArgsSchema = z.object({
  channel: z.string(),
  topic: z.string(),
  follow: z.union([z.boolean(), z.enum(["true", "false"])]),
});

/** An argument as trimmed text.  Absent and blank are both "not given". */
function text(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

export interface OutboundPolicy {
  /** Channels a bot may post to outside its origin. */
  postChannels: readonly string[];
  /** The bot's own names: its role and its Zulip display name. */
  names: readonly string[];
  /** Who a DM may reach beyond the origin's sender: the realm's active
   *  members as the bot's session cached them at register.  Without it,
   *  a DM goes only to the origin's sender. */
  directory?: DmDirectory;
}

export interface DmDirectory {
  /** The bot's own Zulip user id. */
  me: number;
  /** Jay's Zulip user id, when configured. */
  ownerUserId?: number;
  /** Active realm members by id (register's `realm_users`). */
  users: ReadonlyMap<number, ZulipUser>;
}

/** Zulip's bot_type for an incoming-webhook integration (Sentry, Linear, …). */
const INCOMING_WEBHOOK_BOT = 2;

/** Why a DM may not go to `userId`, or null.  Fails closed: a user the
 *  directory does not list (unknown, or deactivated, which register leaves
 *  out of `realm_users`) is refused. */
export function dmRefusal(userId: number, directory: DmDirectory): string | null {
  if (userId === directory.me) return "a bot cannot DM itself";
  const user = directory.users.get(userId);
  if (!user || user.is_active === false) return `user ${userId} is not an active member of this realm`;
  if (user.bot_type === INCOMING_WEBHOOK_BOT) return `user ${userId} is an incoming-webhook integration, which cannot be messaged`;
  if (directory.ownerUserId !== undefined && userId === directory.ownerUserId) return null;
  if (user.is_bot === true) return null;
  return `user ${userId} is a person who is not the owner; a DM may go only to the owner or to a bot`;
}

export type TargetResult = { target: ZulipTarget; toOrigin: boolean } | { error: string };

function originTarget(origin: ZulipOrigin): ZulipTarget {
  return origin.kind === "dm"
    ? { kind: "dm", userIds: [origin.userId] }
    : { kind: "stream", channel: origin.channel, topic: origin.topic };
}

/** Where a call may post, or why it may not.  `origin` is the conversation
 *  that woke this turn, when one did. */
export function resolveTarget(
  tool: "reply" | "post",
  args: OutboundArgs,
  origin: ZulipOrigin | undefined,
  policy: OutboundPolicy,
): TargetResult {
  if (tool === "reply") {
    if (!origin) {
      return {
        error:
          "zulip_reply answers the Zulip message that started this turn, and this turn was not started from Zulip.  Use zulip_post with a channel and a topic.",
      };
    }
    return { target: originTarget(origin), toOrigin: true };
  }
  const dmRaw = text(args.dm_user_id);
  const channel = text(args.channel).replace(/^#/, "");
  const topic = text(args.topic);
  if (dmRaw) {
    if (channel || topic) return { error: "Pass either dm_user_id or a channel and topic, not both." };
    const userId = Number(dmRaw);
    if (!Number.isInteger(userId) || userId <= 0) return { error: "dm_user_id must be a Zulip user id (a whole number)." };
    if (origin?.kind === "dm" && origin.userId === userId) return { target: originTarget(origin), toOrigin: true };
    if (!policy.directory) {
      return {
        error:
          "A DM may go only to the person whose direct message started this turn.  Post in a channel topic instead (zulip_post with channel and topic).",
      };
    }
    const refused = dmRefusal(userId, policy.directory);
    if (refused) return { error: `Not posted: ${refused}.` };
    return { target: { kind: "dm", userIds: [userId] }, toOrigin: false };
  }
  if (!channel) return { error: "zulip_post needs a channel and a topic (or use zulip_reply to answer where you were woken)." };
  // The origin's own topic may be the resolved form, which can run past 58.
  const candidate: ZulipOrigin = { kind: "stream", channel, topic };
  const toOrigin = origin?.kind === "stream" && sameOrigin(origin, candidate);
  if (!toOrigin) {
    const refused = topicRefusal(topic, policy.names);
    if (refused) return { error: `Not posted: ${refused}.` };
    const same = (name: string) => name.replace(/^#/, "").toLowerCase() === channel.toLowerCase();
    // The channel that woke this turn is always allowed: a new unit of work
    // there gets its own topic, which is the guide's one-topic-per-unit rule.
    const originChannel = origin?.kind === "stream" && same(origin.channel);
    if (!originChannel && !policy.postChannels.some(same)) {
      return {
        error: `Not posted: #${channel} is neither the channel that woke this turn nor one of this workspace's post channels (zulip.postChannels).  Answer where you were woken with zulip_reply, or ask the owner to allow the channel.`,
      };
    }
  }
  // A post that lands on the origin uses the origin's own spelling, so it
  // joins that topic rather than opening a near-duplicate.
  if (toOrigin && origin?.kind === "stream") return { target: originTarget(origin), toOrigin: true };
  return { target: { kind: "stream", channel, topic }, toOrigin: false };
}

export type ContentResult = { chunks: string[] } | { error: string };

/** The text split for posting, or why it may not be posted.  Every outbound
 *  text passes here (zulip_reply, zulip_post to a channel or a DM, and the
 *  auto-reply), and the sentence gap is applied first, so the secret scan
 *  sees exactly what is sent. */
export function checkContent(content: string | undefined, known: readonly string[]): ContentResult {
  const body = sentenceGap(content?.trim() ?? "");
  if (!body) return { error: "Nothing to post: content is empty." };
  const secret = secretRefusal(body, known);
  if (secret) {
    return {
      error: `Not posted: the text contains ${secret}.  Never post secrets to Zulip; describe where the value lives instead.`,
    };
  }
  const chunks = splitContent(body, ZULIP_MAX_CONTENT_CHARS);
  if (chunks.length > ZULIP_MAX_CHUNKS) {
    return {
      error: `Not posted: the text is longer than ${ZULIP_MAX_CHUNKS} Zulip messages.  Summarize it, or put the detail in a file or a PR and link it.`,
    };
  }
  return { chunks };
}
