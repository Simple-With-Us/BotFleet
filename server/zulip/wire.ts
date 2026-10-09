// What Zulip's REST API sends back, parsed at the boundary.  The shapes the
// rest of the Zulip source reads (`ZulipMessage`, `ZulipUser`, `ZulipEvent`,
// the register result) are derived from these schemas with `z.infer`, so the
// check that runs and the type the code is written against cannot drift.
//
// The rules the client applies with them (client.ts):
//   - The envelope is checked first: `result: "success"`.  A body that is not
//     the shape a call needs (no `queue_id`, `events` not a list, a message
//     with no integer `id`) is a malformed response and fails the call with a
//     `ZulipApiError` coded `invalid_response`, which the hub's existing
//     error path backs off and retries.
//   - Inside a list, one bad element costs that element, not the response.  A
//     realm member, a followed topic or a subscription that does not parse is
//     left out and counted; a message that does not parse is left out of a
//     fetch; an event whose payload does not parse is kept as a bare
//     `{ id, type }`, which the hub ignores but which still advances the
//     queue's `last_event_id`.  Failing the whole response over one element
//     would let a single odd message wedge the bot: the backfill after a
//     reconnect fetches the same message again.
//   - Unknown fields are stripped, so nothing the module does not read rides
//     along into the router, the prompt or a log.
//
// Types and parsers only: no I/O, so the tool executors can import the types
// without pulling the client in behind them.

import { z } from "zod";

/** The envelope every Zulip success carries.  An error never reaches a
 *  schema: the client turns `result: "error"` and any non-2xx into a
 *  `ZulipApiError` first. */
const envelopeFields = {
  result: z.literal("success"),
  msg: z.string().optional(),
  code: z.string().optional(),
};
const successEnvelope = z.object(envelopeFields);

/** A list whose bad elements are dropped and counted instead of failing the
 *  response.  `items` are the parsed elements; `dropped` is how many were not. */
export function lenientList<S extends z.ZodType>(item: S) {
  return z.array(z.unknown()).transform((entries) => {
    const items: Array<z.output<S>> = [];
    for (const entry of entries) {
      const parsed = item.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
    }
    return { items, dropped: entries.length - items.length };
  });
}

/** A realm member, as register's `realm_users` lists one and as a
 *  `realm_user` event's `person` carries one. */
export const zulipUserSchema = z.object({
  user_id: z.number().int(),
  email: z.string().optional(),
  full_name: z.string().optional(),
  is_bot: z.boolean().optional(),
  /** 1 generic, 2 incoming webhook, 3 outgoing webhook, 4 embedded. */
  bot_type: z.number().int().nullable().optional(),
  role: z.number().int().optional(),
  is_admin: z.boolean().optional(),
  is_owner: z.boolean().optional(),
  /** Absent in register's `realm_users` (every one listed is active); set on
   *  `realm_user` events. */
  is_active: z.boolean().optional(),
});
export type ZulipUser = z.infer<typeof zulipUserSchema>;

/** One Zulip message as the register/events and GET /messages APIs return it,
 *  narrowed to the fields this module reads.  `flags` lives on the event for
 *  the events API and on the message for GET /messages; the queue copies the
 *  event's flags onto the message so the router only ever reads one place. */
export const zulipMessageSchema = z.object({
  id: z.number().int(),
  sender_id: z.number().int(),
  sender_email: z.string().optional(),
  sender_full_name: z.string().optional(),
  /** What the sending request said it was ("website", "ZulipMobile", or an
   *  API client name).  Part of the owner rule, never authority on its own. */
  client: z.string().optional(),
  /** "stream" for a channel message; "private" (older servers) or "direct"
   *  for a DM. */
  type: z.string(),
  /** Channel name for a channel message; the participant list for a DM. */
  display_recipient: z.union([
    z.string(),
    z.array(z.object({ id: z.number().int(), email: z.string().optional(), full_name: z.string().optional() })),
  ]),
  stream_id: z.number().int().optional(),
  subject: z.string().optional(),
  topic: z.string().optional(),
  content: z.string(),
  /** Seconds since the epoch. */
  timestamp: z.number(),
  flags: z.array(z.string()).optional(),
});
export type ZulipMessage = z.infer<typeof zulipMessageSchema>;

/** One row of the bot's topic visibility settings: register's
 *  `user_topics`, and the body of a `user_topic` event. */
export const zulipUserTopicSchema = z.object({
  stream_id: z.number().int().optional(),
  topic_name: z.string().optional(),
  /** 0 none, 1 muted, 2 unmuted, 3 followed. */
  visibility_policy: z.number().int().optional(),
});
export type ZulipUserTopic = z.infer<typeof zulipUserTopicSchema>;

/** One queue event.  `message` and `flags` ride on `message` events, `op` and
 *  `person` on `realm_user` events, and the last three on `user_topic`. */
export const zulipEventSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  message: zulipMessageSchema.optional(),
  flags: z.array(z.string()).optional(),
  /** `realm_user` events: "add", "remove" or "update", and who. */
  op: z.string().optional(),
  person: zulipUserSchema.optional(),
  /** `user_topic` events: the topic and its new visibility policy. */
  stream_id: z.number().int().optional(),
  topic_name: z.string().optional(),
  visibility_policy: z.number().int().optional(),
});
export type ZulipEvent = z.infer<typeof zulipEventSchema>;

/** The event types whose payload the hub acts on.  A malformed payload on any
 *  other type (a heartbeat, a type this module never asked for) is not worth
 *  a log line. */
export const ZULIP_PAYLOAD_EVENT_TYPES: ReadonlySet<string> = new Set(["message", "realm_user", "user_topic"]);

/** GET /users/me: who the key belongs to. */
export const zulipSelfSchema = zulipUserSchema.extend({ ...envelopeFields, email: z.string() });
export type ZulipSelf = z.infer<typeof zulipSelfSchema>;

/** POST /register.  The member and topic lists are cleaned here (a bad row is
 *  dropped), so the hub reads plain arrays; `dropped` counts the rows lost. */
export const zulipRegisterSchema = successEnvelope
  .extend({
    queue_id: z.string().min(1),
    last_event_id: z.number().int(),
    max_message_id: z.number().int().optional(),
    realm_users: lenientList(zulipUserSchema).optional(),
    user_topics: lenientList(zulipUserTopicSchema).optional(),
    event_queue_longpoll_timeout_seconds: z.number().optional(),
  })
  .transform((registered) => ({
    queue_id: registered.queue_id,
    last_event_id: registered.last_event_id,
    max_message_id: registered.max_message_id,
    event_queue_longpoll_timeout_seconds: registered.event_queue_longpoll_timeout_seconds,
    realm_users: registered.realm_users?.items ?? [],
    user_topics: registered.user_topics?.items ?? [],
    dropped: (registered.realm_users?.dropped ?? 0) + (registered.user_topics?.dropped ?? 0),
  }));
export type ZulipRegisterResult = z.infer<typeof zulipRegisterSchema>;

/** GET /events.  The first layer: every element must at least say which event
 *  it is, because the queue is acknowledged by `id`.  An element that cannot
 *  even do that makes the response malformed (re-delivery of an event nobody
 *  can acknowledge would be a hot loop); the payload layer is
 *  `zulipEventSchema`, applied by the client element by element. */
export const zulipEventsSchema = successEnvelope.extend({
  events: z.array(z.looseObject({ id: z.number().int(), type: z.string() })),
});

/** GET /messages.  The same two layers: an integer `id` per element (the
 *  backfill pages by it), then `zulipMessageSchema` per element. */
export const zulipMessagesSchema = successEnvelope.extend({
  messages: z.array(z.looseObject({ id: z.number().int() })),
});

/** GET /users/me/subscriptions: the channels the bot can hear. */
export const zulipSubscriptionsSchema = successEnvelope
  .extend({ subscriptions: lenientList(z.object({ stream_id: z.number().int(), name: z.string() })) })
  .transform((response) => ({ subscriptions: response.subscriptions.items, dropped: response.subscriptions.dropped }));

/** POST /messages.  `id` is read when it is an integer and otherwise left
 *  out: the post has already happened, and failing the call here would invite
 *  a second copy of it. */
export const zulipSentSchema = successEnvelope.extend({ id: z.number().int().optional().catch(undefined) });

/** The calls that answer with the envelope alone: DELETE /events and
 *  POST /user_topics. */
export const zulipAckSchema = successEnvelope;
