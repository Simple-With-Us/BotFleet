// The Zulip source: one event queue per configured BF role bot, wakes that
// bot, and posts back as that bot.
//
// Each bound bot gets a `ZulipSession` that loads its own key, checks who
// the key belongs to, registers an unnarrowed event queue (the bot's DMs and
// every channel it is subscribed to) and long-polls it.  A message that
// directly @-mentions the bot, or a 1:1 DM to it, becomes a work unit; units
// wait in a per-bot FIFO until the bot is free, then start ONE turn as an
// unattended `zulip` source, in the thread the harness keeps for that
// conversation (never the owner's own active thread).  The conversation that
// woke the turn is bound to that turn alone, so `zulip_reply` (and the
// auto-reply, when the bot did not call it) lands exactly there.
//
// Everything outside this file is injected (`ZulipHubDeps`), the way the
// job wake coordinator is: the hub never imports the harness, so the tests
// drive it against a fake Zulip server with a fake `startTurn`.
//
// Message content is data.  It is persisted for crash safety and handed to
// a model only between nonce-marked untrusted markers; it is never logged.
// The log holds ids, roles, decisions and counts.

import { randomBytes } from "node:crypto";

import {
  ZULIP_TOPIC_FOLLOWED,
  ZULIP_TOPIC_NONE,
  ZulipApiError,
  ZulipClient,
  ZulipNetworkError,
  abortableSleep,
  type ZulipUserTopic,
} from "./client.ts";
import {
  ZulipCredentialError,
  credentialSourceFor,
  resolveRealm,
  validZulipRole,
  verifyCredentialRealm,
  type ZulipCredentialSource,
  type ZulipCredentials,
  type ZulipVaultReader,
} from "./credentials.ts";
import { buildInboundPrompt, followKey, originKey, withTag, ZULIP_INBOUND_UNIT_MAX_ITEMS } from "./format.ts";
import {
  checkContent,
  resolveTarget,
  secretRefusal,
  zulipFollowArgsSchema,
  zulipToolArgsSchema,
  type ZulipTarget,
} from "./outbound.ts";
import { DEFAULT_OWNER_CLIENTS, classify, wakeVerdict, type RouterContext } from "./router.ts";
import { ZulipStateStore, emptyState, type ZulipBotState } from "./state.ts";
import type { ZulipIdentity, ZulipMessage, ZulipOrigin, ZulipSettings, ZulipUser } from "./types.ts";

/** Zulip roles a BF bot may hold: moderator (300) and member (400).  An
 *  owner (100) or admin (200) key is refused outright: a bot that can change
 *  the realm is not one the harness will drive. */
const ALLOWED_ROLES = new Set([300, 400]);
const BACKOFF_MS = [5_000, 30_000, 60_000, 120_000];
const PAGE = 100;
const MAX_PAGES = 20;
/** Followed topics a reconnect backfills, and pages per topic: what was said
 *  there while the queue was down (the fleet listener caps it the same way). */
const FOLLOWED_BACKFILL_TOPICS = 25;
const FOLLOWED_BACKFILL_PAGES = 2;
/** Zulip's own limit on a topic name. */
const ZULIP_TOPIC_NAME_MAX = 60;
const DEFAULTS = {
  dmsPerHour: 20,
  staleMinutes: 30,
  peerWakesPerHour: 6,
  peerWakesPerTopicPerHour: 2,
  ownerWakesPerHour: 30,
  peerChainLimit: 4,
};
/** A peer DM conversation's loop-guard chain resets after this long with no
 *  peer wake in it (Jay cannot speak in a peer's DM to reset it). */
const DM_CHAIN_QUIET_MS = 3600_000;
/** A unit nobody could start for this long is dropped (a stopped bot). */
const UNIT_MAX_AGE_MS = 6 * 3600_000;
/** A binding whose turn never reported completion is let go after this, but
 *  only when the harness cannot say which turn the bot is running. */
const BINDING_MAX_AGE_MS = 2 * 3600_000;
const STORED_ITEMS_PER_UNIT = ZULIP_INBOUND_UNIT_MAX_ITEMS * 2;
/** Message ids one connection remembers for de-duplication above its floor:
 *  every id it classified, wake-worthy or not, so it must be bounded. */
const SEEN_LIMIT = 5_000;
/** Long polls in a row that time out before the queue is presumed dead and
 *  registered again.  Zulip heartbeats an idle queue well inside one. */
const MAX_POLL_TIMEOUTS = 3;
/** The long-poll limit when register does not say, and the margin on top. */
const DEFAULT_LONGPOLL_SECONDS = 90;
const LONGPOLL_MARGIN_MS = 10_000;

export interface ZulipStartedTurn {
  threadId: string;
  /** The stored message the turn starts from: where the auto-reply looks,
   *  and the mark that tells this turn from any later one in the thread. */
  triggerMessageId?: string;
}

/** The conversation a turn is started for. */
export interface ZulipTurnConversation {
  origin: ZulipOrigin;
  /** originKey(origin): stable per channel + topic, or per DM peer. */
  key: string;
}

export interface ZulipHubDeps {
  dataDir: string;
  /** The live `zulip` settings section, read on every reconcile. */
  settings: () => ZulipSettings | undefined;
  botExists: (botId: string) => boolean;
  /** The bot cannot take Zulip work now: a turn is running, or an
   *  interrupted turn is still waiting for boot recovery. */
  isBusy: (botId: string) => boolean;
  /** The thread the bot's running turn is on, when the harness knows it. */
  busyThread?: (botId: string) => string | undefined;
  /** The id of the newest stored message that started a turn in this
   *  thread (steered and queued lines are not starters).  A binding answers
   *  only while its trigger is still that message. */
  turnStarter?: (threadId: string) => string | undefined;
  /** True while nothing may be dispatched yet (boot recovery has not
   *  claimed the turns a restart interrupted). */
  dispatchHeld?: () => boolean;
  /** Start one unattended `zulip` turn for this conversation, in the thread
   *  the harness keeps for it.  Throws an error carrying `status` when the
   *  harness refuses (409 busy, stopped or reloading; 503 quiescing; 404 no
   *  such bot). */
  startTurn: (botId: string, text: string, conversation: ZulipTurnConversation) => Promise<ZulipStartedTurn>;
  /** The bot's last reply after the trigger message, for the auto-reply.
   *  A later turn's starter ends the scan: only text before it counts. */
  finalReply?: (threadId: string, triggerMessageId: string | undefined) => { text: string } | undefined;
  /** A one-line activity row in the thread (an auto-reply withheld, …). */
  note?: (threadId: string, text: string) => void;
  /** The rolling spend ceiling is holding unattended work. */
  spendBlocked?: () => boolean;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test override for the credential source. */
  credentialSource?: (settings: ZulipSettings | undefined) => ZulipCredentialSource | null;
  /** Reads a folder of BotFleet's own Infisical project, for
   *  `credentialSource: "infisical"` (the harness passes its
   *  InfisicalManager, cached).  Without it that source is off. */
  vault?: ZulipVaultReader;
  timings?: {
    coalesceMs?: number;
    drainIntervalMs?: number;
    reconcileIntervalMs?: number;
    backoffMs?: number[];
    eventsTimeoutMs?: number;
    postSpacingMs?: number;
    retryBaseMs?: number;
  };
}

export interface ZulipBotStatus {
  botId: string;
  role: string;
  state: "starting" | "connected" | "reconnecting" | "disabled" | "stopped";
  reason?: string;
  userId?: number;
  fullName?: string;
  pending: number;
  since: number;
  /** Realm members the session cached at register, and how many are bots:
   *  counts only.  A DM out is checked against this list, so zero bots
   *  means every DM to a peer would be refused. */
  members?: number;
  memberBots?: number;
  /** Topics the bot follows (each wakes it on a new message). */
  following?: number;
}

export interface ZulipSendRequest {
  botId: string;
  threadId: string;
  /** "follow" is zulip_follow_topic: it changes a topic's visibility for
   *  the bot and posts nothing. */
  tool: "reply" | "post" | "follow";
  /** The model's arguments as they arrived; `send` parses them. */
  args: unknown;
}

export interface ZulipHubStatus {
  enabled: boolean;
  realm?: string;
  dryRun: boolean;
  bots: ZulipBotStatus[];
}

export interface ZulipSendResult {
  ok: boolean;
  text: string;
}

/** The Zulip conversation one turn answers.  It belongs to the turn that
 *  started from `triggerMessageId` (and that turn's model fallbacks, which
 *  reuse the trigger), never to whatever runs in the thread after it. */
interface Binding {
  botId: string;
  threadId: string;
  origin: ZulipOrigin;
  triggerMessageId?: string;
  startedAt: number;
  /** Its own turn reported completion; `ok` and `reply` are from that. */
  completed: boolean;
  ok: boolean;
  /** The final reply, read when the turn completed. */
  reply?: string;
  /** Another turn started in the thread: the binding answers nothing more. */
  closed: boolean;
  replied: boolean;
  /** The final reply may be posted for the bot.  False for a unit that woke
   *  only because the bot follows the topic: following is listening, and
   *  two bots that follow one topic must not answer each other forever. */
  autoReply: boolean;
}

class RoleRefused extends Error {}

/** What a thrown value says about itself.  A caught value is `unknown` by
 *  the language's own contract, so these two are where it is read. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function statusOf(error: unknown): number | undefined {
  // SAFETY: startTurn's refusals are Errors carrying a numeric `status`; any
  // other thrown value has no such field and reads as undefined below.
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One BF bot's connection to Zulip. */
class ZulipSession {
  readonly abort = new AbortController();
  status: ZulipBotStatus;
  client?: ZulipClient;
  creds?: ZulipCredentials;
  me?: ZulipIdentity;
  users = new Map<number, ZulipUser>();
  /** Topics this bot follows, by followKey: register's `user_topics`, kept
   *  current by `user_topic` events (the tool's own change, or the app's). */
  readonly followed = new Map<string, { streamId: number; topic: string }>();
  state: ZulipBotState;
  queueId?: string;
  lastEventId = -1;
  lastPostAt = 0;
  /** The cursor when this connection was made.  Anything at or below it was
   *  decided by an earlier connection; above it, `seen` de-duplicates.  The
   *  live cursor is NOT the gate: Zulip can deliver a lower id after a higher
   *  one (ids are assigned at insert, events go out after commit). */
  floor: number | null = null;
  private readonly seen = new Set<number>();
  /** Consecutive failures since the last poll that returned. */
  failures = 0;
  /** This queue's long-poll limit plus a margin, from register. */
  longpollMs = DEFAULT_LONGPOLL_SECONDS * 1000 + LONGPOLL_MARGIN_MS;
  private postChain: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private savedAt = 0;
  running?: Promise<void>;
  private readonly hub: ZulipHub;
  readonly botId: string;
  readonly role: string;
  readonly realm: string;

  // Plain fields, not constructor parameter properties: the server runs under
  // Node's strip-only TypeScript, which refuses those at load time.
  constructor(hub: ZulipHub, botId: string, role: string, realm: string) {
    this.hub = hub;
    this.botId = botId;
    this.role = role;
    this.realm = realm;
    this.state = hub.store.load(botId, role);
    this.status = { botId, role, state: "starting", pending: this.state.pending.length, since: hub.now() };
    this.seedSeen();
  }

  get ready(): boolean {
    return Boolean(this.client && this.me);
  }

  /** The persisted decisions, so a restart overlap is caught in memory. */
  private seedSeen(): void {
    this.seen.clear();
    for (const id of this.state.handled) this.remember(id);
    for (const unit of this.state.pending) for (const item of unit.items) this.remember(item.id);
  }

  private remember(id: number): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) {
      // A Set iterates in insertion order: drop the oldest.
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  /** True the first time this connection meets `id` above its floor. */
  firstSighting(id: number): boolean {
    if (this.floor !== null && id <= this.floor) return false;
    if (this.seen.has(id)) return false;
    this.remember(id);
    return true;
  }

  setStatus(state: ZulipBotStatus["state"], reason?: string): void {
    if (this.status.state !== state || this.status.reason !== reason) {
      this.status = { ...this.status, state, reason, since: this.hub.now() };
      this.hub.log(`[zulip] ${this.role} (${this.botId}): ${state}${reason ? ` — ${reason}` : ""}`);
    }
    this.status.pending = this.state.pending.length;
    if (this.me) {
      this.status.userId = this.me.userId;
      this.status.fullName = this.me.fullName;
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  save(force = false): void {
    if (!force && !this.dirty) return;
    this.dirty = false;
    this.savedAt = this.hub.now();
    try {
      this.hub.store.save(this.botId, this.state, this.hub.now());
    } catch (e) {
      this.hub.log(`[zulip] ${this.role}: could not save state: ${describe(e)}`);
    }
    this.status.pending = this.state.pending.length;
  }

  /** Save a cursor-only change at most once a second.  A wake is always
   *  saved at once (`save(true)`); losing a second of "nothing woke" to a
   *  crash only means re-reading messages that will not wake again. */
  saveSoon(): void {
    if (this.dirty && this.hub.now() - this.savedAt >= 1_000) this.save();
  }

  start(): void {
    this.running = this.run().catch((e) => {
      if (!this.abort.signal.aborted) this.setStatus("disabled", `stopped unexpectedly: ${describe(e)}`);
    });
  }

  async stop(): Promise<void> {
    this.abort.abort(new Error("zulip session stopped"));
    await this.running;
    this.save();
    const queueId = this.queueId;
    this.queueId = undefined;
    if (queueId && this.client) {
      // Best effort: a queue Zulip never hears about expires on its own.
      await this.client.deleteQueue(queueId).catch(() => {});
    }
    this.setStatus("stopped");
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        await this.connect(signal);
        // `failures` is reset by a poll that returns, not by a connect: a
        // queue that registers and then fails every poll must back off.
        await this.poll(signal);
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof ZulipCredentialError || e instanceof RoleRefused) {
          this.setStatus("disabled", e.message);
          return;
        }
        if (e instanceof ZulipApiError && (e.status === 401 || e.status === 403)) {
          // A revoked or wrong key: retrying would only hammer the realm.
          this.client = undefined;
          this.setStatus("disabled", `Zulip refused the key (${e.message})`);
          return;
        }
        if (!(await this.backoff(describe(e), signal))) return;
      }
    }
  }

  /** Wait the next backoff step.  False when the session was stopped. */
  private async backoff(reason: string, signal: AbortSignal): Promise<boolean> {
    const wait = this.hub.backoffMs[Math.min(this.failures, this.hub.backoffMs.length - 1)]!;
    this.failures += 1;
    this.setStatus("reconnecting", `${reason}; retrying in ${Math.round(wait / 1000)}s`);
    try {
      await this.hub.sleep(wait, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** The long-poll timeout: the test override, else this queue's limit. */
  private eventsTimeoutMs(): number {
    return this.hub.deps.timings?.eventsTimeoutMs ?? this.longpollMs;
  }

  private async loadClient(): Promise<ZulipClient> {
    if (this.client) return this.client;
    const source = this.hub.credentialSource();
    if (!source) {
      throw new ZulipCredentialError(
        'no credential source: set zulip.credentialDir to the folder holding <Role>-zuliprc files, or zulip.credentialSource to "infisical"',
        "missing",
      );
    }
    const creds = await source.load(this.role);
    verifyCredentialRealm(creds, this.realm);
    this.creds = creds;
    this.client = new ZulipClient(creds, this.realm, {
      fetch: this.hub.deps.fetch,
      sleep: this.hub.sleep,
      eventsTimeoutMs: this.hub.deps.timings?.eventsTimeoutMs,
    });
    return this.client;
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const client = await this.loadClient();
    // A queue left over from a failed connection: delete it before
    // registering another, so reconnects never pile orphaned queues (each
    // holding events for ~10 minutes) on the realm.  Best effort.
    const leftover = this.queueId;
    this.queueId = undefined;
    if (leftover) await client.deleteQueue(leftover).catch(() => {});
    const me = await client.me(signal);
    if (String(me.email ?? "").toLowerCase() !== this.creds!.email.toLowerCase()) {
      throw new RoleRefused(`users/me answered as a different user than ${this.creds!.source} names; refusing it`);
    }
    if (me.is_admin || me.is_owner || !ALLOWED_ROLES.has(Number(me.role))) {
      throw new RoleRefused(
        `the ${this.role} bot has Zulip role ${String(me.role)}; only moderator (300) and member (400) bots are accepted`,
      );
    }
    this.me = { userId: me.user_id, fullName: String(me.full_name ?? this.role), email: this.creds!.email };
    if (this.state.userId !== undefined && this.state.userId !== me.user_id) {
      // Same role name, different Zulip user: the old cursor and ring
      // describe another mailbox.  Keep nothing but the pending work.
      this.state = { ...emptyState(this.role), pending: this.state.pending };
      this.seedSeen();
    }
    this.state.userId = me.user_id;
    const registered = await client.register(signal);
    this.queueId = registered.queue_id;
    this.lastEventId = registered.last_event_id ?? -1;
    const longpoll = Number(registered.event_queue_longpoll_timeout_seconds);
    this.longpollMs =
      (Number.isFinite(longpoll) && longpoll > 0 ? longpoll : DEFAULT_LONGPOLL_SECONDS) * 1000 + LONGPOLL_MARGIN_MS;
    this.users.clear();
    for (const user of registered.realm_users ?? []) {
      if (typeof user?.user_id === "number") this.users.set(user.user_id, user);
    }
    this.followed.clear();
    for (const entry of registered.user_topics ?? []) this.applyUserTopic(entry);
    if (this.state.cursor === null) {
      // First connection: start from now.  History is not a wake.
      this.state.cursor = typeof registered.max_message_id === "number" ? registered.max_message_id : 0;
      this.floor = this.state.cursor;
      this.markDirty();
      this.save();
    } else {
      // Fixed for this connection: the gate below which messages were
      // decided, and where the backfill starts.
      this.floor = this.state.cursor;
      await this.backfill(client, signal);
    }
    this.setStatus("connected");
  }

  /** DMs and mentions above the floor: what the bot missed while its queue
   *  was down.  Everything that can wake is one or the other, so chatter is
   *  never fetched. */
  private async backfill(client: ZulipClient, signal: AbortSignal): Promise<void> {
    const floor = this.floor ?? 0;
    const found = new Map<number, ZulipMessage>();
    const narrows: Array<{ narrow: Array<{ operator: string; operand: string | number }>; pages: number }> = [
      { narrow: [{ operator: "is", operand: "dm" }], pages: MAX_PAGES },
      { narrow: [{ operator: "is", operand: "mentioned" }], pages: MAX_PAGES },
      // A followed topic wakes on any message, so what was said there while
      // the queue was down is fetched too: one narrow per topic, capped.
      ...[...this.followed.values()].slice(0, FOLLOWED_BACKFILL_TOPICS).map(({ streamId, topic }) => ({
        narrow: [
          { operator: "stream", operand: streamId },
          { operator: "topic", operand: topic },
        ],
        pages: FOLLOWED_BACKFILL_PAGES,
      })),
    ];
    for (const { narrow, pages } of narrows) {
      let anchor = floor;
      for (let page = 0; page < pages; page++) {
        const messages = await client.messages(narrow, { anchor, numAfter: PAGE }, signal);
        for (const message of messages) if (message.id > floor) found.set(message.id, message);
        if (messages.length < PAGE) break;
        anchor = Math.max(...messages.map((m) => m.id));
      }
    }
    const ordered = [...found.keys()].sort((a, b) => a - b);
    if (ordered.length) this.hub.log(`[zulip] ${this.role}: backfilled ${ordered.length} message(s) above ${floor}`);
    for (const id of ordered) this.hub.handleMessage(this, found.get(id)!);
    this.save();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const client = this.client!;
    let timeouts = 0;
    for (;;) {
      if (!this.queueId) return;
      let events;
      try {
        events = await client.events(this.queueId, this.lastEventId, signal, this.eventsTimeoutMs());
      } catch (e) {
        if (e instanceof ZulipApiError && e.code === "BAD_EVENT_QUEUE_ID") {
          // Zulip garbage-collected the queue (an idle Mac, a long sleep).
          // Re-register at once and backfill from the cursor.  The queue is
          // already gone, so there is nothing to delete.
          this.hub.log(`[zulip] ${this.role}: event queue expired; re-registering`);
          this.queueId = undefined;
          this.setStatus("reconnecting", "event queue expired");
          return;
        }
        if (e instanceof ZulipNetworkError && !signal.aborted) {
          // A long poll that timed out, or a connection something cut.  The
          // queue lives on at Zulip, so poll it again rather than register
          // another; Zulip answers BAD_EVENT_QUEUE_ID if it is gone.
          if (e.timeout) {
            timeouts += 1;
            // Several silent timeouts in a row: Zulip heartbeats an idle
            // queue, so this one is dead.  Register again (the old one is
            // deleted first).
            if (timeouts >= MAX_POLL_TIMEOUTS) throw e;
            continue;
          }
          if (!(await this.backoff(describe(e), signal))) return;
          continue;
        }
        throw e;
      }
      timeouts = 0;
      this.failures = 0;
      if (this.status.state !== "connected") this.setStatus("connected");
      for (const event of events) {
        if (typeof event.id === "number" && event.id > this.lastEventId) this.lastEventId = event.id;
        if (event.type === "message" && event.message) {
          this.hub.handleMessage(this, { ...event.message, flags: event.flags ?? event.message.flags ?? [] });
        } else if (event.type === "realm_user") {
          this.applyRealmUser(event.op, event.person);
        } else if (event.type === "user_topic") {
          this.applyUserTopic(event);
        }
      }
      this.saveSoon();
    }
  }

  /** One topic's visibility for this bot: followed (3) adds it, anything
   *  else (none, muted, unmuted) removes it. */
  applyUserTopic(entry: ZulipUserTopic | undefined): void {
    if (typeof entry?.stream_id !== "number" || typeof entry.topic_name !== "string") return;
    const key = followKey(entry.stream_id, entry.topic_name);
    if (entry.visibility_policy === ZULIP_TOPIC_FOLLOWED) {
      this.followed.set(key, { streamId: entry.stream_id, topic: entry.topic_name });
    } else {
      this.followed.delete(key);
    }
  }

  /** Keep the member cache current between registers: an added member is
   *  listed, a removed or deactivated one is dropped (so a DM to it is
   *  refused), and an update changes only the fields it names. */
  private applyRealmUser(op: string | undefined, person: Partial<ZulipUser> | undefined): void {
    const userId = person?.user_id;
    if (typeof userId !== "number") return;
    if (op === "remove" || (op === "update" && person?.is_active === false)) {
      this.users.delete(userId);
    } else if (op === "add" && person?.is_active !== false) {
      this.users.set(userId, { ...person, user_id: userId });
    } else if (op === "update") {
      const known = this.users.get(userId);
      if (known) this.users.set(userId, { ...known, ...person, user_id: userId });
    }
  }

  /** Post `chunks` to `target` as this bot, one at a time and spaced, each
   *  carrying the role tag on its first line. */
  post(target: ZulipTarget, chunks: readonly string[]): Promise<number[]> {
    const run = async (): Promise<number[]> => {
      const client = this.client;
      if (!client) throw new Error("Zulip is not connected for this bot");
      const ids: number[] = [];
      for (const chunk of chunks) {
        const wait = this.lastPostAt + this.hub.postSpacingMs - this.hub.now();
        if (wait > 0) await this.hub.sleep(wait);
        try {
          ids.push(await client.send(target.kind === "dm" ? { kind: "dm", userIds: target.userIds } : target, withTag(this.role, chunk)));
        } finally {
          this.lastPostAt = this.hub.now();
        }
      }
      return ids;
    };
    const next = this.postChain.then(run, run);
    this.postChain = next.catch(() => {});
    return next;
  }
}

export class ZulipHub {
  readonly store: ZulipStateStore;
  readonly backoffMs: number[];
  readonly postSpacingMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly sessions = new Map<string, ZulipSession>();
  private readonly bindings = new Map<string, Binding>();
  private readonly dispatching = new Set<string>();
  /** Sessions being stopped.  A replacement for the same bot waits for the
   *  old one to finish, so two sessions never write one bot's state file. */
  private readonly stopping = new Map<string, Promise<void>>();
  private drainTimer?: ReturnType<typeof setInterval>;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private draining = false;
  private redrain = false;
  private stopped = false;

  readonly deps: ZulipHubDeps;

  constructor(deps: ZulipHubDeps) {
    this.deps = deps;
    this.store = new ZulipStateStore(deps.dataDir);
    this.backoffMs = deps.timings?.backoffMs ?? BACKOFF_MS;
    this.postSpacingMs = deps.timings?.postSpacingMs ?? 3_000;
    this.sleep = deps.sleep ?? abortableSleep;
  }

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private settings(): ZulipSettings | undefined {
    return this.deps.settings();
  }

  credentialSource(): ZulipCredentialSource | null {
    const settings = this.settings();
    if (this.deps.credentialSource) return this.deps.credentialSource(settings);
    const realm = resolveRealm(settings, this.env);
    return credentialSourceFor(settings, this.env, {
      vault: this.deps.vault,
      realm: "realm" in realm ? realm.realm : undefined,
    });
  }

  /** Whether the Zulip source should run at all. */
  enabled(): boolean {
    return this.settings()?.enabled === true && this.env.OMB_ZULIP_DISABLE !== "1";
  }

  start(): void {
    this.stopped = false;
    this.reconcile();
    const drainEvery = this.deps.timings?.drainIntervalMs ?? 1_000;
    this.drainTimer = setInterval(() => void this.drain(), drainEvery);
    this.drainTimer.unref?.();
    const reconcileEvery = this.deps.timings?.reconcileIntervalMs ?? 5 * 60_000;
    this.reconcileTimer = setInterval(() => this.reconcile(), reconcileEvery);
    this.reconcileTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.drainTimer = undefined;
    this.reconcileTimer = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.stop()));
  }

  /** Start, stop or restart sessions to match the settings.  Called at boot,
   *  after a settings save, and on a slow timer (which is also what retries a
   *  bot whose credential file did not exist yet). */
  reconcile(opts: { retryDisabled?: boolean } = {}): void {
    if (this.stopped) return;
    const retryDisabled = opts.retryDisabled ?? true;
    const settings = this.settings();
    const wanted = new Map<string, string>();
    let realm = "";
    if (this.enabled()) {
      const resolved = resolveRealm(settings, this.env);
      if ("error" in resolved) {
        this.log(`[zulip] not starting: ${resolved.error}`);
      } else {
        realm = resolved.realm;
        const roles = new Set<string>();
        for (const [botId, entry] of Object.entries(settings?.bots ?? {})) {
          const role = typeof entry?.role === "string" ? entry.role.trim() : "";
          if (entry?.enabled === false || !role || !this.deps.botExists(botId)) continue;
          if (!validZulipRole(role)) {
            this.log(`[zulip] bot ${botId}: "${role}" is not a valid Zulip role name; skipped`);
            continue;
          }
          // One Zulip identity, one session: two queues for the same bot
          // would answer every message twice.
          if (roles.has(role.toLowerCase())) {
            this.log(`[zulip] bot ${botId}: ${role} is already bound to another bot; skipped`);
            continue;
          }
          roles.add(role.toLowerCase());
          wanted.set(botId, role);
        }
      }
    }
    for (const [botId, session] of this.sessions) {
      const role = wanted.get(botId);
      const retry = retryDisabled && session.status.state === "disabled";
      if (role !== session.role || session.realm !== realm || retry) {
        this.sessions.delete(botId);
        const stopped = session.stop().finally(() => {
          this.stopping.delete(botId);
          // Start the replacement, if one is still wanted, now that the old
          // session has written its state for the last time.
          // It never retries other disabled bots: that is the timer's job,
          // and doing it here would let two failing bots restart each other.
          if (wanted.has(botId)) this.reconcile({ retryDisabled: false });
        });
        this.stopping.set(botId, stopped);
      }
    }
    for (const [botId, role] of wanted) {
      if (this.sessions.has(botId) || this.stopping.has(botId)) continue;
      const session = new ZulipSession(this, botId, role, realm);
      this.sessions.set(botId, session);
      session.start();
    }
  }

  status(): ZulipHubStatus {
    const settings = this.settings();
    const realm = resolveRealm(settings, this.env);
    return {
      enabled: this.enabled(),
      realm: "realm" in realm ? realm.realm : undefined,
      dryRun: settings?.dryRun === true,
      bots: [...this.sessions.values()].map((session) => ({
        ...session.status,
        pending: session.state.pending.length,
        following: session.followed.size,
        members: session.users.size,
        memberBots: [...session.users.values()].filter((user) => user.is_bot === true).length,
      })),
    };
  }

  private dryRun(): boolean {
    return this.settings()?.dryRun === true;
  }

  /** Whether this bot can post right now: what gates the Zulip tools.  A
   *  dry run classifies and logs only, so it posts nothing either. */
  outboundReady(botId: string): boolean {
    return !this.dryRun() && this.sessions.get(botId)?.ready === true;
  }

  /** One bot's live session, for the de-duplication tests. */
  sessionFor(botId: string): ZulipSession | undefined {
    return this.sessions.get(botId);
  }

  /** A Zulip turn is bound to this thread and is still the thread's current
   *  turn: a continuation of it (a card answered, a model fallback) keeps
   *  the Zulip tools it started with. */
  answersThread(botId: string, threadId: string): boolean {
    const binding = this.bindings.get(threadId);
    return Boolean(binding && binding.botId === botId && !binding.closed && this.starterMatches(binding));
  }

  /** Every loaded key and its Basic token: text that must never be posted. */
  private knownSecrets(): string[] {
    const out: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.creds) continue;
      out.push(session.creds.key, Buffer.from(`${session.creds.email}:${session.creds.key}`).toString("base64"));
    }
    return out;
  }

  /** Jay's Zulip user id, when the settings name a valid one. */
  ownerUserId(): number | undefined {
    const owner = Number(this.settings()?.ownerUserId);
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  }

  private routerContext(session: ZulipSession): RouterContext {
    const settings = this.settings();
    return {
      me: session.me!,
      ownerUserId: this.ownerUserId(),
      ownerClients: new Set(settings?.ownerClients?.length ? settings.ownerClients : DEFAULT_OWNER_CLIENTS),
      users: session.users,
      nowMs: this.now(),
      staleMs: Math.max(1, settings?.staleMinutes ?? DEFAULTS.staleMinutes) * 60_000,
      followed: new Set(session.followed.keys()),
    };
  }

  private budget(key: keyof NonNullable<ZulipSettings["budgets"]>): number {
    const value = this.settings()?.budgets?.[key];
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : DEFAULTS[key];
  }

  /** Classify one message for one bot and queue it when it wakes the bot.
   *  Exposed for the session; nothing else calls it. */
  handleMessage(session: ZulipSession, message: ZulipMessage): void {
    if (!session.me || typeof message?.id !== "number") return;
    const state = session.state;
    const id = message.id;
    // Already decided: at or below this connection's floor, already seen on
    // it, in the handled ring, or waiting in a unit.  Not "at or below the
    // live cursor": Zulip can deliver a lower id after a higher one, and that
    // message would be lost for good (the next backfill starts at the cursor).
    if (!session.firstSighting(id)) return;
    if (state.handled.includes(id)) return;
    if (state.pending.some((unit) => unit.items.some((item) => item.id === id))) return;
    state.cursor = Math.max(state.cursor ?? 0, id);
    session.markDirty();
    const c = classify(message, this.routerContext(session));
    // Jay speaking in a conversation resets its peer chain, mention or not.
    if (c.owner && c.origin) state.chains[originKey(c.origin)] = 0;
    const settings = this.settings();
    const verdict = wakeVerdict(c);
    if (verdict.wake === null) {
      if (verdict.reason !== "own" && verdict.reason !== "not_a_mention") {
        this.log(`[zulip] ${session.role}: message ${id} not woken (${verdict.reason})`);
      }
      return;
    }
    const origin = c.origin!;
    const key = originKey(origin);
    const now = this.now();
    const unit = state.pending.find((candidate) => originKey(candidate.origin) === key);
    if (!unit) {
      // A new wake: budgets and the loop guard decide whether it may exist.
      const refusal = this.wakeRefusal(state, verdict.wake, key, now);
      if (refusal) {
        state.handled.push(id);
        this.log(`[zulip] ${session.role}: message ${id} not woken (${refusal})`);
        session.save(true);
        return;
      }
    }
    const item = {
      id,
      senderId: message.sender_id,
      senderName: String(message.sender_full_name ?? message.sender_email ?? message.sender_id),
      senderIsBot: c.senderIsBot,
      owner: c.owner,
      ownerViaApi: c.ownerViaApi,
      content: String(message.content ?? ""),
      timestamp: typeof message.timestamp === "number" ? message.timestamp : Math.floor(now / 1000),
      via: verdict.via,
    };
    if (settings?.dryRun) {
      state.handled.push(id);
      this.log(
        `[zulip] ${session.role}: dry run — message ${id} would wake (${verdict.wake})` +
          (verdict.via === "followed" ? " from a followed topic" : ""),
      );
      session.save(true);
      return;
    }
    if (unit) {
      unit.items.push(item);
      if (unit.items.length > STORED_ITEMS_PER_UNIT) unit.items.splice(0, unit.items.length - STORED_ITEMS_PER_UNIT);
      unit.updatedAt = now;
    } else {
      state.pending.push({ origin, items: [item], createdAt: now, updatedAt: now, attempts: 0, notBefore: 0 });
      state.wakes.push({ at: now, kind: verdict.wake, key });
      if (verdict.wake === "peer") state.chains[key] = (state.chains[key] ?? 0) + 1;
    }
    this.log(`[zulip] ${session.role}: message ${id} queued (${verdict.wake})`);
    session.save(true);
    this.scheduleDrain();
  }

  private wakeRefusal(state: ZulipBotState, kind: "owner" | "peer", key: string, now: number): string | null {
    const hour = state.wakes.filter((w) => now - w.at < 3600_000);
    if (kind === "owner") {
      return hour.filter((w) => w.kind === "owner").length >= this.budget("ownerWakesPerHour") ? "owner_budget" : null;
    }
    // A topic's chain resets when Jay speaks there.  Jay never speaks in a
    // peer's DM with the bot, so a DM chain resets after a quiet spell
    // instead; without that, a peer that reached the limit once could never
    // DM this bot again.
    if (key.startsWith("dm:") && (state.chains[key] ?? 0) > 0) {
      const last = Math.max(0, ...state.wakes.filter((w) => w.kind === "peer" && w.key === key).map((w) => w.at));
      if (now - last >= DM_CHAIN_QUIET_MS) state.chains[key] = 0;
    }
    if ((state.chains[key] ?? 0) >= this.budget("peerChainLimit")) return "loop_guard";
    if (hour.filter((w) => w.kind === "peer").length >= this.budget("peerWakesPerHour")) return "peer_budget";
    if (hour.filter((w) => w.kind === "peer" && w.key === key).length >= this.budget("peerWakesPerTopicPerHour")) {
      return "topic_budget";
    }
    return null;
  }

  private scheduleDrain(): void {
    const delay = (this.deps.timings?.coalesceMs ?? 2_000) + 20;
    const timer = setTimeout(() => void this.drain(), delay);
    timer.unref?.();
  }

  /** Whether the binding's trigger is still the thread's newest turn
   *  starter.  Unknown on either side counts as yes: without the harness's
   *  answer the hub cannot tell turns apart. */
  private starterMatches(binding: Binding): boolean {
    const trigger = binding.triggerMessageId;
    if (trigger === undefined) return true;
    const current = this.deps.turnStarter?.(binding.threadId);
    return current === undefined || current === trigger;
  }

  /** The binding's own turn, or a model fallback of it (which reuses the
   *  trigger), is still running.  Age alone never ends one that is: a long
   *  build or deploy keeps its binding for as long as it runs. */
  private turnRunning(binding: Binding): boolean {
    if (!this.deps.isBusy(binding.botId) || !this.starterMatches(binding)) return false;
    const thread = this.deps.busyThread?.(binding.botId);
    if (thread !== undefined) return thread === binding.threadId;
    // No way to tell where the bot is working: the age cap is then the only
    // release for a completion that never came.
    return this.now() - binding.startedAt < BINDING_MAX_AGE_MS;
  }

  /** A turn on this thread ended.  It counts only when it is the binding's
   *  own turn: a later turn in the same thread (a queued send, a relay turn)
   *  closes the binding instead, and can neither overwrite its outcome nor
   *  inherit its reply target.  The final reply is read now, while the
   *  thread still ends with this turn's output. */
  turnCompleted(threadId: string, ok: boolean): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    if (!this.starterMatches(binding)) {
      binding.closed = true;
      return;
    }
    binding.completed = true;
    binding.ok = ok;
    binding.reply = ok ? this.deps.finalReply?.(threadId, binding.triggerMessageId)?.text : undefined;
  }

  /** Finalize settled turns, then start the next unit for every free bot.
   *  Called from the harness's queue drain and on a timer. */
  async drain(): Promise<void> {
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.redrain = false;
        await this.finalizeSettled();
        for (const session of this.sessions.values()) {
          if (this.stopped) return;
          await this.dispatchNext(session);
        }
      } while (this.redrain && !this.stopped);
    } finally {
      this.draining = false;
    }
  }

  /** Let go of every binding whose turn is over: its own turn completed and
   *  no fallback of it is running, or the bot has moved on to other work. */
  private async finalizeSettled(): Promise<void> {
    // Deleting the entry being visited is safe in a Map's own iteration.
    for (const [threadId, binding] of this.bindings) {
      if (this.dispatching.has(binding.botId) || this.turnRunning(binding)) continue;
      this.bindings.delete(threadId);
      await this.autoReply(threadId, binding);
    }
  }

  private async autoReply(threadId: string, binding: Binding): Promise<void> {
    if (binding.replied || !binding.completed || !binding.ok || !binding.autoReply) return;
    if ((this.settings()?.autoReply ?? "final") !== "final" || this.dryRun()) return;
    const session = this.sessions.get(binding.botId);
    if (!session?.ready) return;
    const reply = binding.reply?.trim();
    if (!reply) return;
    const content = checkContent(reply, this.knownSecrets());
    if ("error" in content) {
      this.log(`[zulip] ${session.role}: auto-reply withheld (${content.error})`);
      this.deps.note?.(threadId, `Zulip reply withheld: ${content.error}`);
      return;
    }
    const target: ZulipTarget =
      binding.origin.kind === "dm"
        ? { kind: "dm", userIds: [binding.origin.userId] }
        : { kind: "stream", channel: binding.origin.channel, topic: binding.origin.topic };
    try {
      await session.post(target, content.chunks);
      this.log(`[zulip] ${session.role}: auto-reply posted`);
    } catch (e) {
      this.log(`[zulip] ${session.role}: auto-reply failed: ${describe(e)}`);
      this.deps.note?.(threadId, `Zulip reply failed: ${describe(e).slice(0, 160)}`);
    }
  }

  private async dispatchNext(session: ZulipSession): Promise<void> {
    const botId = session.botId;
    const state = session.state;
    if (!state.pending.length || !session.ready) return;
    // Held while boot recovery has not claimed the turns a restart
    // interrupted (a Zulip turn would take the bot first and the interrupted
    // turn would never resume), and in a dry run, which starts nothing: units
    // persisted by an earlier live run wait rather than start.
    if (this.deps.dispatchHeld?.() || this.dryRun()) return;
    if (this.dispatching.has(botId) || this.deps.isBusy(botId)) return;
    // The previous Zulip turn on this bot must be finalized first: its
    // binding (and auto-reply) belongs to that turn alone.
    for (const binding of this.bindings.values()) if (binding.botId === botId) return;
    const now = this.now();
    const coalesceMs = this.deps.timings?.coalesceMs ?? 2_000;
    // Drop work nobody could start for hours: a stopped bot's backlog is
    // stale by the time it is started again.
    const expired = state.pending.filter((unit) => now - unit.createdAt > UNIT_MAX_AGE_MS);
    if (expired.length) {
      for (const unit of expired) for (const item of unit.items) state.handled.push(item.id);
      state.pending = state.pending.filter((unit) => !expired.includes(unit));
      this.log(`[zulip] ${session.role}: dropped ${expired.length} unit(s) older than ${UNIT_MAX_AGE_MS / 3600_000}h`);
      session.save(true);
    }
    const unit = state.pending.find((candidate) => candidate.notBefore <= now && now - candidate.updatedAt >= coalesceMs);
    if (!unit) return;
    const owner = unit.items.some((item) => item.owner);
    // The spend ceiling holds peer work; Jay asking is not held by it.
    if (!owner && this.deps.spendBlocked?.()) {
      unit.notBefore = now + 60_000;
      return;
    }
    this.dispatching.add(botId);
    // The batch this turn is handed, fixed before the await: a message for
    // the same conversation can join `unit` while startTurn runs, and it must
    // not be marked handled without ever reaching a prompt.
    const batch = unit.items.slice();
    const nonce = randomBytes(6).toString("hex");
    // Only a mention or a DM is answered for the bot: a unit that woke only
    // because the bot follows the topic is listening, not being asked.
    const autoReply =
      (this.settings()?.autoReply ?? "final") === "final" && batch.some((item) => item.via !== "followed");
    const text = buildInboundPrompt(
      { origin: unit.origin, items: batch },
      {
        role: session.role,
        me: session.me!,
        nonce,
        autoReply,
        ownerUserId: this.ownerUserId(),
        realm: session.realm,
      },
    );
    /** Retire exactly the batch.  What arrived meanwhile stays pending as
     *  the conversation's next unit. */
    const retireBatch = () => {
      const ids = new Set(batch.map((item) => item.id));
      for (const id of ids) state.handled.push(id);
      unit.items = unit.items.filter((item) => !ids.has(item.id));
      if (!unit.items.length) state.pending = state.pending.filter((candidate) => candidate !== unit);
      return unit.items.length;
    };
    try {
      const started = await this.deps.startTurn(botId, text, { origin: unit.origin, key: originKey(unit.origin) });
      this.bindings.set(started.threadId, {
        botId,
        threadId: started.threadId,
        origin: unit.origin,
        triggerMessageId: started.triggerMessageId,
        startedAt: this.now(),
        completed: false,
        ok: false,
        closed: false,
        replied: false,
        autoReply,
      });
      const left = retireBatch();
      this.log(
        `[zulip] ${session.role}: started a turn for ${batch.length} message(s)` +
          (left ? `; ${left} more arrived meanwhile and wait for the next turn` : ""),
      );
    } catch (e) {
      const status = statusOf(e);
      if (status === 409 || status === 503) {
        unit.attempts += 1;
        const base = this.deps.timings?.retryBaseMs ?? 5_000;
        unit.notBefore = now + Math.min(base * 2 ** Math.min(unit.attempts - 1, 6), 5 * 60_000);
        this.log(`[zulip] ${session.role}: turn not started (${status}); retrying`);
      } else {
        retireBatch();
        this.log(`[zulip] ${session.role}: turn not started (${status ?? "error"}: ${describe(e).slice(0, 160)}); dropped`);
      }
    } finally {
      this.dispatching.delete(botId);
      session.save(true);
    }
  }

  /** Post for a bot's tool call.  Identity (`botId`, `threadId`) comes from
   *  the caller's turn, never from the model's arguments. */
  async send(request: ZulipSendRequest): Promise<ZulipSendResult> {
    const session = this.sessions.get(request.botId);
    if (!session?.ready) {
      return { ok: false, text: `Zulip is not connected for this bot (${session?.status.state ?? "not configured"}).` };
    }
    if (this.dryRun()) return { ok: false, text: "Not posted: Zulip is in a dry run (zulip.dryRun), which posts nothing." };
    if (request.tool === "follow") return this.follow(session, request);
    const parsed = zulipToolArgsSchema.safeParse(request.args ?? {});
    if (!parsed.success) {
      return { ok: false, text: "Not posted: content, channel and topic must be text, and dm_user_id a Zulip user id." };
    }
    const args = parsed.data;
    // The origin belongs to the turn the binding was made for, and only
    // while that turn is the thread's current one: a later turn in the same
    // thread neither answers nor DMs the earlier sender.
    const candidate = this.bindings.get(request.threadId);
    const binding =
      candidate && candidate.botId === request.botId && !candidate.closed && this.starterMatches(candidate)
        ? candidate
        : undefined;
    const origin = binding?.origin;
    const names = [session.role, session.me?.fullName ?? ""].filter(Boolean);
    const target = resolveTarget(request.tool, args, origin, {
      postChannels: this.settings()?.postChannels ?? [],
      names,
      directory: { me: session.me!.userId, ownerUserId: this.ownerUserId(), users: session.users },
    });
    if ("error" in target) return { ok: false, text: target.error };
    // A DM out (not a reply to the DM that woke the turn) is rate limited
    // per bot: a peer's prompt cannot turn a bot into a DM cannon.
    const dmOut = target.target.kind === "dm" && !target.toOrigin;
    if (target.target.kind === "dm" && dmOut) {
      const now = this.now();
      const limit = this.budget("dmsPerHour");
      const lastHour = session.state.dms.filter((at) => now - at < 3600_000).length;
      if (lastHour >= limit) {
        this.log(`[zulip] ${session.role}: DM to user ${target.target.userIds.join(", ")} refused (dm_budget)`);
        return {
          ok: false,
          text: `Not posted: this bot has sent ${lastHour} DMs in the last hour, its limit (zulip.budgets.dmsPerHour).  Post in a channel topic instead, or wait.`,
        };
      }
    }
    const known = this.knownSecrets();
    // A new topic is text the model wrote, posted where everyone in the
    // channel reads it: it passes the same secret scan as the content.
    if (target.target.kind === "stream" && !target.toOrigin) {
      const secret = secretRefusal(target.target.topic, known);
      if (secret) {
        return { ok: false, text: `Not posted: the topic contains ${secret}.  Never post secrets to Zulip; describe where the value lives instead.` };
      }
    }
    const content = checkContent(args.content, known);
    if ("error" in content) return { ok: false, text: content.error };
    try {
      const ids = await session.post(target.target, content.chunks);
      if (target.toOrigin && binding) binding.replied = true;
      if (target.target.kind === "dm") {
        // The recipient's id, never the text.
        this.log(`[zulip] ${session.role}: DM posted to user ${target.target.userIds.join(", ")}${dmOut ? "" : " (reply)"}`);
        if (dmOut) {
          session.state.dms.push(this.now());
          session.markDirty();
          session.save();
        }
      }
      const where =
        target.target.kind === "dm"
          ? `a direct message to user ${target.target.userIds.join(", ")}`
          : `#${target.target.channel} > ${target.target.topic}`;
      return { ok: true, text: `Posted to ${where} as ${session.role} (message id ${ids.join(", ")}).` };
    } catch (e) {
      if (e instanceof ZulipNetworkError && e.maybeSent) {
        return {
          ok: false,
          text: `The post may or may not have reached Zulip (${e.message}).  Do not post it again blindly; it may already be there.`,
        };
      }
      return { ok: false, text: `Zulip refused the post: ${describe(e)}` };
    }
  }


  /** zulip_follow_topic: follow, or stop following, one topic as this bot.
   *  It posts nothing.  The channel must be one the bot is subscribed to:
   *  a queue never delivers any other, so following one there would wake
   *  nothing. */
  private async follow(session: ZulipSession, request: ZulipSendRequest): Promise<ZulipSendResult> {
    const parsed = zulipFollowArgsSchema.safeParse(request.args ?? {});
    if (!parsed.success) {
      return { ok: false, text: "Not changed: zulip_follow_topic needs a channel and a topic (text) and follow (true or false)." };
    }
    const channel = parsed.data.channel.trim().replace(/^#/, "");
    const topic = parsed.data.topic.trim();
    const follow = parsed.data.follow === true || parsed.data.follow === "true";
    if (!channel || !topic) return { ok: false, text: "Not changed: zulip_follow_topic needs a channel and a topic." };
    if ([...topic].length > ZULIP_TOPIC_NAME_MAX) {
      return { ok: false, text: `Not changed: a Zulip topic is at most ${ZULIP_TOPIC_NAME_MAX} characters.` };
    }
    const client = session.client!;
    let subscriptions: Array<{ stream_id: number; name: string }>;
    try {
      subscriptions = await client.subscriptions();
    } catch (e) {
      return { ok: false, text: `Zulip refused the channel lookup: ${describe(e)}` };
    }
    const channelRow = subscriptions.find((sub) => sub.name.toLowerCase() === channel.toLowerCase());
    if (!channelRow) {
      return {
        ok: false,
        text: `Not changed: this bot is not subscribed to #${channel}, so no message there ever reaches it.  Ask the owner to subscribe it first.`,
      };
    }
    const policy = follow ? ZULIP_TOPIC_FOLLOWED : ZULIP_TOPIC_NONE;
    try {
      await client.setTopicVisibility(channelRow.stream_id, topic, policy);
    } catch (e) {
      return { ok: false, text: `Zulip refused the change: ${describe(e)}` };
    }
    // The user_topic event confirms it; apply it now so the next message
    // there is judged by the new setting even if the event is slow.
    session.applyUserTopic({ stream_id: channelRow.stream_id, topic_name: topic, visibility_policy: policy });
    this.log(`[zulip] ${session.role}: ${follow ? "followed" : "stopped following"} a topic in channel ${channelRow.stream_id}`);
    return {
      ok: true,
      text: follow
        ? `Following #${channelRow.name} > ${topic}.  New messages there wake you (never your own posts).  A wake from a followed topic is not auto-replied:  answer with zulip_reply only when the conversation needs you, and unfollow when it no longer concerns you.`
        : `Stopped following #${channelRow.name} > ${topic}.`,
    };
  }
}

export type { ZulipSession };
