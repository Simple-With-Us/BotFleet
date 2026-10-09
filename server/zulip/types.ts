// Shapes shared by the Zulip source: what the API hands back, what the
// harness persists, and what the settings section holds.  Types only, so any
// module (including the tool executors under server/tools/) can import it
// without dragging the client or the hub in behind it.

// The wire shapes (a message, a realm member) are derived from their zod
// schemas in wire.ts and re-exported here, so this stays the one import for
// every Zulip type.  A type-only re-export: nothing of wire.ts loads with it.
export type { ZulipMessage, ZulipUser } from "./wire.ts";

/** Who this bot is on Zulip, from GET /users/me. */
export interface ZulipIdentity {
  userId: number;
  fullName: string;
  email: string;
}

/** Where a turn's Zulip conversation lives: a channel topic, or a 1:1 DM. */
export type ZulipOrigin =
  /** `streamId` is the channel's numeric id when the message carried one:
   *  it builds message links and keys followed topics, never the
   *  conversation (originKey is channel name + topic). */
  | { kind: "stream"; channel: string; topic: string; streamId?: number }
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
  /** Why it woke the bot: an @-mention, a 1:1 DM, or a new message in a
   *  topic the bot follows.  Absent on units saved before follows existed. */
  via?: "mention" | "dm" | "followed";
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
  /** Where the keys come from: "file" (`credentialDir`) or "infisical"
   *  (BotFleet's own vault, `infisicalPath`).  Unset means the file source
   *  when `credentialDir` is set, and none otherwise.  An open owner
   *  decision (docs/zulip.md, D0). */
  credentialSource?: "file" | "infisical";
  /** The Infisical folder holding `ZULIP_<ROLE>_EMAIL` / `_API_KEY`.
   *  Default `/zulip`. */
  infisicalPath?: string;
  /** BotFleet bot id -> its Zulip role (the file code, e.g. "BF-Plumber"). */
  bots?: Record<string, { role: string; enabled?: boolean }>;
  /** Channels a bot may post to outside the conversation it was woken by. */
  postChannels?: string[];
  /** "final" posts the turn's last reply to the origin when the bot did not
   *  call zulip_reply itself. */
  autoReply?: "final" | "off";
  /** Peer messages older than this do not wake (backfill after an outage). */
  staleMinutes?: number;
  budgets?: {
    /** DMs a bot may send per hour that are not replies to the DM that
     *  woke it.  Default 20. */
    dmsPerHour?: number;
    peerWakesPerHour?: number;
    peerWakesPerTopicPerHour?: number;
    ownerWakesPerHour?: number;
    /** Bot-originated wakes in one topic with no owner message between them. */
    peerChainLimit?: number;
  };
}
