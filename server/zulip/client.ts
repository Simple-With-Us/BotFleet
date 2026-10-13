// A small Zulip REST client on `fetch`, ported from the fleet's agent-sync
// client (AFC scripts/agent_sync/zulip.py) so both speak the realm the same
// way:
//
//   - Basic auth (email:key).  The realm is fixed at construction and a
//     redirect is an error, so the Authorization header never reaches a host
//     the operator did not name.
//   - Parameters are form-encoded; lists and objects are JSON-encoded
//     (`event_types`, `narrow`, `to`), which is what the Zulip API expects.
//   - 429 waits `Retry-After` (capped at 30 s, three tries).  A GET also
//     retries a network failure or a 502/503/504 twice.  A POST is never
//     retried after a network failure: it may already have posted.
//   - Every error text is scrubbed of the key and the Basic token, so a
//     server that echoes the header cannot leak it into a log.
//   - Every success body is parsed with a zod schema (wire.ts) before anything
//     reads it.  A body of the wrong shape is a `ZulipApiError` coded
//     `invalid_response`, so the hub backs off and retries it like any other
//     failed call; a bad element inside a list is dropped and reported
//     through `onInvalid` instead.

import type { z } from "zod";

import type { ZulipCredentials } from "./credentials.ts";
import {
  ZULIP_PAYLOAD_EVENT_TYPES,
  zulipAckSchema,
  zulipEventSchema,
  zulipEventsSchema,
  zulipMessageSchema,
  zulipMessagesSchema,
  zulipRegisterSchema,
  zulipSelfSchema,
  zulipSentSchema,
  zulipSubscriptionsSchema,
  type ZulipEvent,
  type ZulipMessage,
  type ZulipRegisterResult,
  type ZulipSelf,
  type ZulipUserTopic,
} from "./wire.ts";

export type { ZulipEvent, ZulipRegisterResult, ZulipSelf, ZulipUserTopic };

const USER_AGENT = "BotFleet-Zulip/1";
const MAX_RATE_LIMIT_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 30_000;
const GET_RETRY_BACKOFF_MS = [1_000, 3_000];
const GATEWAY_STATUSES = new Set([502, 503, 504]);
/** `ZulipApiError.code` of a success body that is not the shape the call needs. */
export const INVALID_RESPONSE = "invalid_response";

// No constructor parameter properties in this module tree: the server runs
// under Node's strip-only TypeScript, which refuses them at load time.
export class ZulipApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  constructor(message: string, code: string | undefined, status: number) {
    super(code ? `${message} [${code}]` : message);
    this.name = "ZulipApiError";
    this.code = code;
    this.status = status;
  }
}

export class ZulipNetworkError extends Error {
  readonly timeout: boolean;
  /** The request may have reached Zulip (a POST that timed out). */
  readonly maybeSent: boolean;
  constructor(message: string, timeout: boolean, maybeSent: boolean) {
    super(message);
    this.name = "ZulipNetworkError";
    this.timeout = timeout;
    this.maybeSent = maybeSent;
  }
}

// A request parameter as the Zulip API takes it.  Objects and arrays are
// JSON-encoded, which is why the value is wider than a scalar.
type ParamValue = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;

export function encodeParams(params: Record<string, ParamValue> | undefined): string {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out.append(name, value);
    else if (typeof value === "number" || typeof value === "boolean") out.append(name, String(value));
    else out.append(name, JSON.stringify(value));
  }
  return out.toString();
}

export interface ZulipClientOptions {
  fetch?: typeof fetch;
  /** Abortable sleep; tests pass a fast one. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  /** A long poll is held up to ~90 s by Zulip, which then sends a heartbeat. */
  eventsTimeoutMs?: number;
  /** Told when elements of a good response were dropped for being malformed
   *  ("2 message(s) from messages").  A count and a call, never the content. */
  onInvalid?: (what: string) => void;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Zulip's visibility_policy for a followed topic, and for "no setting". */
export const ZULIP_TOPIC_FOLLOWED = 3;
export const ZULIP_TOPIC_NONE = 0;

/** One page of GET /messages.  `messages` are the ones that parsed;
 *  `received` and `newestId` describe the page as Zulip sent it, so paging
 *  (a full page means there may be more; the next page starts after the
 *  newest id) is not thrown off by a message that was dropped. */
export interface ZulipMessagePage {
  messages: ZulipMessage[];
  received: number;
  newestId: number | null;
}

export class ZulipClient {
  readonly realm: string;
  private readonly base: string;
  private readonly auth: string;
  private readonly hidden: string[];
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly eventsTimeoutMs: number;
  private readonly onInvalid: ((what: string) => void) | undefined;

  constructor(creds: ZulipCredentials, realm: string, opts: ZulipClientOptions = {}) {
    this.realm = new URL(realm).origin;
    this.base = `${this.realm}/api/v1/`;
    const token = Buffer.from(`${creds.email}:${creds.key}`, "utf8").toString("base64");
    this.auth = `Basic ${token}`;
    this.hidden = [creds.key, token].filter((value) => value.length > 0);
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? abortableSleep;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.eventsTimeoutMs = opts.eventsTimeoutMs ?? 100_000;
    this.onInvalid = opts.onInvalid;
  }

  /** Text with the key and the Basic token replaced. */
  scrub(text: string): string {
    let out = text;
    for (const value of this.hidden) out = out.split(value).join("[redacted]");
    return out;
  }

  /** One call.  `schema` is what a success must look like; the result is the
   *  schema's output, never the raw body. */
  async request<S extends z.ZodType>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    schema: S,
    params?: Record<string, ParamValue>,
    opts: { signal?: AbortSignal; timeoutMs?: number; longPoll?: boolean } = {},
  ): Promise<z.output<S>> {
    const query = encodeParams(params);
    let url = this.base + path.replace(/^\/+/, "");
    let body: string | undefined;
    if (method === "GET") {
      if (query) url += `?${query}`;
    } else if (method === "DELETE") {
      // Zulip reads DELETE parameters from the body; the query string is
      // sent as well for a server that only looks there.
      if (query) {
        url += `?${query}`;
        body = query;
      }
    } else {
      body = query;
    }
    const headers = new Headers({ authorization: this.auth, "user-agent": USER_AGENT, accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/x-www-form-urlencoded");
    let rateRetries = 0;
    let netRetries = 0;
    for (;;) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.doFetch(url, { method, headers, body, redirect: "error", signal });
      } catch (e) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? e;
        const timedOut = timeout.aborted;
        const retryable = method === "GET" && netRetries < GET_RETRY_BACKOFF_MS.length && !(opts.longPoll && timedOut);
        if (retryable) {
          await this.sleep(GET_RETRY_BACKOFF_MS[netRetries]!, opts.signal);
          netRetries += 1;
          continue;
        }
        const detail = timedOut ? "timed out" : this.scrub(e instanceof Error ? e.message : String(e));
        // SAFETY: undici's fetch failure is a TypeError whose `cause` names the
        // socket error; any other thrown value simply has no cause.
        const refused = /ECONNREFUSED/.test(String((e as { cause?: unknown })?.cause ?? ""));
        throw new ZulipNetworkError(
          `${method} ${path} failed: ${detail}${method !== "GET" && !refused ? "; Zulip may or may not have received it" : ""}`,
          timedOut,
          method !== "GET" && !refused,
        );
      }
      const text = await res.text().catch(() => "");
      if (res.status === 429 && rateRetries < MAX_RATE_LIMIT_RETRIES) {
        rateRetries += 1;
        await this.sleep(this.retryAfterMs(res, text), opts.signal);
        continue;
      }
      if (method === "GET" && GATEWAY_STATUSES.has(res.status) && netRetries < GET_RETRY_BACKOFF_MS.length) {
        await this.sleep(GET_RETRY_BACKOFF_MS[netRetries]!, opts.signal);
        netRetries += 1;
        continue;
      }
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = text ? JSON.parse(text) : {};
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = Object.fromEntries(Object.entries(value));
      } catch {
        throw new ZulipApiError(`Zulip answered ${method} ${path} with something that is not JSON`, undefined, res.status);
      }
      if (!res.ok || parsed.result === "error") {
        const msg = this.scrub(typeof parsed.msg === "string" ? parsed.msg : `HTTP ${res.status}`);
        const code = typeof parsed.code === "string" ? this.scrub(parsed.code) : undefined;
        throw new ZulipApiError(msg, code, res.status);
      }
      const checked = schema.safeParse(parsed);
      if (!checked.success) {
        // Where the body went wrong, never what it held: the text is logged
        // and shown to the model, and a hostile body could put anything in it.
        const where = [...new Set(checked.error.issues.map((issue) => issue.path.map(String).join(".") || "the body"))].slice(0, 3);
        throw new ZulipApiError(
          this.scrub(`Zulip answered ${method} ${path} with a response of an unexpected shape (${where.join(", ")})`),
          INVALID_RESPONSE,
          res.status,
        );
      }
      return checked.data;
    }
  }

  private invalid(count: number, what: string): void {
    if (count > 0) this.onInvalid?.(`${count} malformed ${what}`);
  }

  private retryAfterMs(res: Response, body: string): number {
    let seconds = Number(res.headers.get("retry-after"));
    if (!Number.isFinite(seconds)) {
      try {
        // SAFETY: a non-object parse makes the lookup undefined, and Number()
        // of that is NaN, which the check below turns into the default.
        seconds = Number((JSON.parse(body) as Record<string, unknown>)["retry-after"]);
      } catch {
        seconds = Number.NaN;
      }
    }
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  me(signal?: AbortSignal): Promise<ZulipSelf> {
    return this.request("GET", "users/me", zulipSelfSchema, undefined, { signal });
  }

  /** One unnarrowed queue: the bot's DMs and every channel it is subscribed
   *  to.  `realm_user` state is fetched so the router can tell bots from
   *  people and a DM can be checked against the realm's active members, and
   *  subscribed to so a deactivation reaches the cache without a restart.
   *  `user_topic` likewise: the topics the bot follows wake it, and a follow
   *  or unfollow (from the tool, or from the Zulip app) arrives as an event. */
  async register(signal?: AbortSignal): Promise<ZulipRegisterResult> {
    const registered = await this.request(
      "POST",
      "register",
      zulipRegisterSchema,
      {
        event_types: ["message", "realm_user", "user_topic"],
        fetch_event_types: ["message", "realm_user", "user_topic"],
        apply_markdown: false,
        client_gravatar: true,
      },
      { signal },
    );
    this.invalid(registered.dropped, "member or topic row(s) from register");
    return registered;
  }

  /** One long poll.  `timeoutMs` is the queue's own limit plus a margin
   *  (register's `event_queue_longpoll_timeout_seconds`), when known.  An
   *  event whose payload does not parse comes back as a bare `{ id, type }`:
   *  the hub ignores it, and the queue is still acknowledged past it. */
  async events(queueId: string, lastEventId: number, signal?: AbortSignal, timeoutMs?: number): Promise<ZulipEvent[]> {
    const result = await this.request(
      "GET",
      "events",
      zulipEventsSchema,
      { queue_id: queueId, last_event_id: lastEventId },
      { signal, timeoutMs: timeoutMs ?? this.eventsTimeoutMs, longPoll: true },
    );
    const events: ZulipEvent[] = [];
    let dropped = 0;
    for (const raw of result.events) {
      const full = zulipEventSchema.safeParse(raw);
      if (full.success) {
        events.push(full.data);
        continue;
      }
      events.push({ id: raw.id, type: raw.type });
      if (ZULIP_PAYLOAD_EVENT_TYPES.has(raw.type)) dropped += 1;
    }
    this.invalid(dropped, "event payload(s) from events");
    return events;
  }

  async deleteQueue(queueId: string): Promise<void> {
    await this.request("DELETE", "events", zulipAckSchema, { queue_id: queueId }, { timeoutMs: 3_000 });
  }

  async messages(
    narrow: Array<{ operator: string; operand: string | number }>,
    opts: { anchor: number | "newest" | "oldest"; numBefore?: number; numAfter?: number; includeAnchor?: boolean },
    signal?: AbortSignal,
  ): Promise<ZulipMessagePage> {
    const result = await this.request(
      "GET",
      "messages",
      zulipMessagesSchema,
      {
        narrow,
        anchor: opts.anchor,
        num_before: opts.numBefore ?? 0,
        num_after: opts.numAfter ?? 0,
        include_anchor: opts.includeAnchor ?? false,
        apply_markdown: false,
      },
      { signal },
    );
    const messages: ZulipMessage[] = [];
    let newestId: number | null = null;
    for (const raw of result.messages) {
      newestId = newestId === null ? raw.id : Math.max(newestId, raw.id);
      const parsed = zulipMessageSchema.safeParse(raw);
      if (parsed.success) messages.push(parsed.data);
    }
    this.invalid(result.messages.length - messages.length, "message(s) from messages");
    return { messages, received: result.messages.length, newestId };
  }

  /** The channels this bot is subscribed to, by id and name. */
  async subscriptions(signal?: AbortSignal): Promise<Array<{ stream_id: number; name: string }>> {
    const result = await this.request("GET", "users/me/subscriptions", zulipSubscriptionsSchema, undefined, { signal });
    this.invalid(result.dropped, "subscription(s) from users/me/subscriptions");
    return result.subscriptions;
  }

  /** Follow (3) or clear (0) one topic for this bot. */
  async setTopicVisibility(streamId: number, topic: string, visibilityPolicy: number): Promise<void> {
    await this.request("POST", "user_topics", zulipAckSchema, { stream_id: streamId, topic, visibility_policy: visibilityPolicy });
  }

  async send(
    target: { kind: "stream"; channel: string; topic: string } | { kind: "dm"; userIds: number[] },
    content: string,
  ): Promise<number> {
    const params: Record<string, ParamValue> =
      target.kind === "stream"
        ? { type: "stream", to: target.channel, topic: target.topic, content }
        : { type: "direct", to: target.userIds, content };
    const result = await this.request("POST", "messages", zulipSentSchema, params);
    return result.id ?? -1;
  }
}
