// Versioned, typed event envelope for the plugin integration platform.
//
// Host API v1 knew only cards and commands.  v2 adds event sources:
// the trusted host emits typed envelopes like the one below, subscribed
// plugins return a routing decision, and the host executes the narrowly
// scoped action.  Event payloads carry only what the granted capability
// permits; webhook payload text is always re-fetched through the host
// adapter and never passes through here verbatim as authority.
//
// This file is the schema.  `server/plugin-events.ts` is the bus that
// moves these envelopes; `server/plugin-sandbox-*.ts` is the wire they
// cross on.
import { z } from "zod";

/** Event envelope major version.  Bumped only for breaking changes. */
export const PLUGIN_EVENT_API_VERSION = 1;

/** Event types the host can emit.  One today; the union grows. */
export const PLUGIN_EVENT_TYPES = ["zulip.message"] as const;
export type PluginEventType = typeof PLUGIN_EVENT_TYPES[number];

/** Platforms that can source events.  One today; the union grows. */
export const PLUGIN_EVENT_PLATFORMS = ["zulip"] as const;
export type PluginEventPlatform = typeof PLUGIN_EVENT_PLATFORMS[number];

/** Why the source message qualifies: an @-mention, a 1:1 DM, or a
 *  followed-topic message.  Mirrors server/zulip/router.ts WakeReason. */
export const PLUGIN_WAKE_REASONS = ["mention", "dm", "followed"] as const;
export type PluginWakeReason = typeof PLUGIN_WAKE_REASONS[number];

/** Sender classes the host router assigns.  Owner vs peer budgets and
 *  loop guards key off this, not off anything the plugin claims. */
export const PLUGIN_SENDER_KINDS = ["owner", "peer"] as const;
export type PluginSenderKind = typeof PLUGIN_SENDER_KINDS[number];

/** A scoped conversation summary the host attaches so a dispatcher can
 *  identify relevant existing conversations.  Metadata only: no message
 *  bodies, no transcripts.  The dispatcher turn reads content under its
 *  own authority through the normal thread APIs. */
export const pluginChatSummarySchema = z.object({
  botId: z.string().min(1).max(128),
  botName: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  title: z.string().max(200),
  lastActiveAt: z.string().min(1).max(64),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PluginChatSummary = z.infer<typeof pluginChatSummarySchema>;

/** One typed host event.  Strict: unknown fields fail rather than slip
 *  past review, matching the manifest and registry schemas. */
export const pluginEventEnvelopeSchema = z.object({
  /** Stable id `<platform>:<accountId>:<messageId>`.  Dedup keys off this. */
  eventId: z.string().min(1).max(256),
  type: z.enum(PLUGIN_EVENT_TYPES),
  source: z.object({
    platform: z.enum(PLUGIN_EVENT_PLATFORMS),
    /** Host-side account identity, e.g. the Zulip role name. */
    accountId: z.string().min(1).max(128),
  }).strict(),
  occurredAt: z.string().min(1).max(64),
  receivedAt: z.string().min(1).max(64),
  refs: z.object({
    messageId: z.number().int().positive(),
    /** Where a reply goes: `dm:<userId>` or `stream:<channel>/<topic>`. */
    conversationKey: z.string().min(1).max(512),
    realm: z.string().max(512).optional(),
    channel: z.string().max(256).optional(),
    topic: z.string().max(256).optional(),
  }).strict(),
  /** Bot/user mentions the host parser found.  Bounded. */
  mentions: z.array(z.string().min(1).max(128)).max(32).default([]),
  /** Canonical text, fetched by the host adapter.  Present only when
   *  the subscription permits content; otherwise the plugin routes on
   *  refs and context alone. */
  content: z.object({
    text: z.string().max(8192),
    format: z.enum(["text"]),
  }).strict().optional(),
  context: z.object({
    botId: z.string().min(1).max(128),
    wakeReason: z.enum(PLUGIN_WAKE_REASONS),
    senderKind: z.enum(PLUGIN_SENDER_KINDS),
    /** Scoped chat/session listing.  Present only with `chat.read`. */
    chatSummaries: z.array(pluginChatSummarySchema).max(20).optional(),
  }).strict(),
}).strict();
export type PluginEventEnvelope = z.infer<typeof pluginEventEnvelopeSchema>;

/** What a plugin's `onEvent` handler returns.  Either a wake request
 *  the host validates and executes, or an explicit no-op with a reason.
 *  No other action exists: plugins cannot name arbitrary host calls. */
export const pluginRoutingDecisionSchema = z.object({
  action: z.enum(["requestWake", "none"]),
  /** Bot to wake as the dispatcher/continuation target. */
  targetBotId: z.string().min(1).max(128).optional(),
  /** Existing thread to continue instead of starting a wake. */
  continueThreadId: z.string().min(1).max(128).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Short human-readable rationale.  Shown in health views. */
  rationale: z.string().max(280).optional(),
  /** Hint text for the woken turn.  Treated as untrusted input and
   *  wrapped in nonce markers by the host, like any inbound message. */
  replyHint: z.string().max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "requestWake") {
    if (!value.targetBotId && !value.continueThreadId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetBotId"],
        message: "requestWake needs targetBotId or continueThreadId",
      });
    }
  }
});
export type PluginRoutingDecision = z.infer<typeof pluginRoutingDecisionSchema>;

/** Stable per-event delivery outcomes.  Reason codes only cross into
 *  logs and health views; event text never does. */
export const PLUGIN_DELIVERY_RESULTS = [
  "delivered",
  "duplicate",
  "retry",
  "deadLetter",
  "failed",
  "refused",
  "disabled",
  "noSubscription",
] as const;
export type PluginDeliveryResult = typeof PLUGIN_DELIVERY_RESULTS[number];

export const pluginDeliveryOutcomeSchema = z.object({
  eventId: z.string().min(1).max(256),
  plugin: z.string().min(1).max(128),
  result: z.enum(PLUGIN_DELIVERY_RESULTS),
  at: z.string().min(1).max(64),
  attempts: z.number().int().min(0).max(1000),
  /** Stable reason code, e.g. `duplicate`, `timeout`, `handler_threw`,
   *  `not_implemented`, `target_unknown`, `rate_limited`, `crash`. */
  reason: z.string().max(128).optional(),
}).strict();
export type PluginDeliveryOutcome = z.infer<typeof pluginDeliveryOutcomeSchema>;

/** One declared event subscription from a manifest. */
export const pluginEventSubscriptionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  source: z.enum(PLUGIN_EVENT_PLATFORMS),
  kinds: z.array(z.enum(["message"])).min(1).max(8),
  /** Include canonical text in deliveries.  Default false: route on
   *  refs and context alone. */
  includeContent: z.boolean().optional().default(false),
  /** Attach scoped chat summaries.  Requires `chat.read`. */
  includeChats: z.boolean().optional().default(false),
  /** Max summaries attached per event.  Default 10, cap 20. */
  maxChats: z.number().int().min(0).max(20).optional().default(10),
}).strict();
export type PluginEventSubscription = z.infer<typeof pluginEventSubscriptionSchema>;

/** Stable event id for one platform message. */
export function stablePluginEventId(platform: string, accountId: string, messageId: number): string {
  return `${platform}:${accountId}:${messageId}`;
}

/** True when this subscription wants this event. */
export function subscriptionMatchesEvent(
  subscription: Pick<PluginEventSubscription, "source" | "kinds">,
  event: Pick<PluginEventEnvelope, "type" | "source">,
): boolean {
  if (subscription.source !== event.source.platform) return false;
  if (event.type === "zulip.message") return subscription.kinds.includes("message");
  return false;
}
