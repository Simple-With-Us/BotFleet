// Shapes shared by the Zulip source: what the API hands back, what the
// harness persists, and what the settings section holds.  Types only, so any
// module (including the tool executors under server/tools/) can import it
// without dragging the client or the hub in behind it.

/** One Zulip message as the register/events and GET /messages APIs return it,
 *  narrowed to the fields this module reads.  `flags` lives on the event for
 *  the events API and on the message for GET /messages; the queue copies the
 *  event's flags onto the message so the router only ever reads one place. */
export interface ZulipMessage {
  id: number;
  sender_id: number;
  sender_email?: string;
  sender_full_name?: string;
  /** What the sending request said it was ("website", "ZulipMobile", or an
   *  API client name).  Part of the owner rule, never authority on its own. */
  client?: string;
  /** "stream" for a channel message; "private" (older servers) or "direct"
   *  for a DM. */
  type: string;
  /** Channel name for a channel message; the participant list for a DM. */
  display_recipient: string | Array<{ id: number; email?: string; full_name?: string }>;
  stream_id?: number;
  subject?: string;
  topic?: string;
  content: string;
  /** Seconds since the epoch. */
  timestamp: number;
  flags?: string[];
}

/** A realm member as the register response's `realm_users` lists one. */
export interface ZulipUser {
  user_id: number;
  email?: string;
  full_name?: string;
  is_bot?: boolean;
  /** 1 generic, 2 incoming webhook, 3 outgoing webhook, 4 embedded. */
  bot_type?: number | null;
  role?: number;
  is_admin?: boolean;
  is_owner?: boolean;
}

/** Who this bot is on Zulip, from GET /users/me. */
export interface ZulipIdentity {
  userId: number;
  fullName: string;
  email: string;
}

/** Where a turn's Zulip conversation lives: a channel topic, or a 1:1 DM. */
export type ZulipOrigin =
  | { kind: "stream"; channel: string; topic: string }
  | { kind: "dm"; userId: number };

/** One message the bot was woken for, as it is persisted and handed to the
 *  model.  `owner` is the listener's own verdict (user id AND a human
 *  client), never the message's claim about itself. */
export interface ZulipInboundItem {
  id: number;
  senderId: number;
  senderName: string;
  senderIsBot: boolean;
  owner: boolean;
  /** Jay's user id posting from an API client: a peer, flagged. */
  ownerViaApi: boolean;
  content: string;
  timestamp: number;
}

/** One unit of work: every message for one origin that arrived before the
 *  bot could start.  Two origins never share a unit, so a reply binding is
 *  always exactly one place. */
export interface ZulipWorkUnit {
  origin: ZulipOrigin;
  items: ZulipInboundItem[];
  /** ms since the epoch the unit was created, and its last item arrived. */
  createdAt: number;
  updatedAt: number;
  /** Dispatch attempts that were refused with a retryable status. */
  attempts: number;
  /** Earliest ms the next attempt may run. */
  notBefore: number;
}

/** The `zulip` section of ~/.botfleet/config.json. */
export interface ZulipSettings {
  enabled?: boolean;
  /** Classify and log would-wake decisions without starting any turn. */
  dryRun?: boolean;
  realm?: string;
  /** Jay's Zulip user id.  Without it no message is ever the owner's. */
  ownerUserId?: number;
  /** Zulip clients that count as a human app for the owner rule. */
  ownerClients?: string[];
  /** Folder holding `<Role>-zuliprc` files (INI [api] email/key/site, mode
   *  600).  No default: the file source is off until this is set. */
  credentialDir?: string;
  /** BotFleet bot id -> its Zulip role (the file code, e.g. "BF-Plumber"). */
  bots?: Record<string, { role: string; enabled?: boolean }>;
  /** Channels a bot may post to outside the conversation it was woken by. */
  postChannels?: string[];
  /** "final" posts the turn's last reply to the origin when the bot did not
   *  call zulip_reply itself. */
  autoReply?: "final" | "off";
  /** Peer messages older than this do not wake (backfill after an outage). */
  staleMinutes?: number;
  /** Bot user ids whose DMs may wake a BF bot (pair work). */
  peerDmAllow?: number[];
  budgets?: {
    peerWakesPerHour?: number;
    peerWakesPerTopicPerHour?: number;
    ownerWakesPerHour?: number;
    /** Bot-originated wakes in one topic with no owner message between them. */
    peerChainLimit?: number;
  };
}
