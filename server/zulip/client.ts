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

import type { ZulipCredentials } from "./credentials.ts";
import type { ZulipMessage, ZulipUser } from "./types.ts";

const USER_AGENT = "BotFleet-Zulip/1";
const MAX_RATE_LIMIT_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 30_000;
const GET_RETRY_BACKOFF_MS = [1_000, 3_000];
const GATEWAY_STATUSES = new Set([502, 503, 504]);

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

export interface ZulipRegisterResult {
  queue_id: string;
  last_event_id: number;
  max_message_id?: number;
  realm_users?: ZulipUser[];
  event_queue_longpoll_timeout_seconds?: number;
}

export interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
  flags?: string[];
  /** `realm_user` events: "add", "remove" or "update", and who. */
  op?: string;
  person?: Partial<ZulipUser>;
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
  }

  /** Text with the key and the Basic token replaced. */
  scrub(text: string): string {
    let out = text;
    for (const value of this.hidden) out = out.split(value).join("[redacted]");
    return out;
  }

  async request<T extends object>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    params?: Record<string, ParamValue>,
    opts: { signal?: AbortSignal; timeoutMs?: number; longPoll?: boolean } = {},
  ): Promise<T> {
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
      // SAFETY: a successful Zulip response; each caller names the fields it
      // reads as optional and checks their types before use.
      return parsed as T;
    }
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

  me(signal?: AbortSignal): Promise<ZulipUser & { email: string; user_id: number }> {
    return this.request("GET", "users/me", undefined, { signal });
  }

  /** One unnarrowed queue: the bot's DMs and every channel it is subscribed
   *  to.  `realm_user` state is fetched so the router can tell bots from
   *  people and a DM can be checked against the realm's active members, and
   *  subscribed to so a deactivation reaches the cache without a restart. */
  register(signal?: AbortSignal): Promise<ZulipRegisterResult> {
    return this.request(
      "POST",
      "register",
      {
        event_types: ["message", "realm_user"],
        fetch_event_types: ["message", "realm_user"],
        apply_markdown: false,
        client_gravatar: true,
      },
      { signal },
    );
  }

  /** One long poll.  `timeoutMs` is the queue's own limit plus a margin
   *  (register's `event_queue_longpoll_timeout_seconds`), when known. */
  async events(queueId: string, lastEventId: number, signal?: AbortSignal, timeoutMs?: number): Promise<ZulipEvent[]> {
    const result = await this.request<{ events?: ZulipEvent[] }>(
      "GET",
      "events",
      { queue_id: queueId, last_event_id: lastEventId },
      { signal, timeoutMs: timeoutMs ?? this.eventsTimeoutMs, longPoll: true },
    );
    return Array.isArray(result.events) ? result.events : [];
  }

  async deleteQueue(queueId: string): Promise<void> {
    await this.request("DELETE", "events", { queue_id: queueId }, { timeoutMs: 3_000 });
  }

  async messages(
    narrow: Array<{ operator: string; operand: string | number }>,
    opts: { anchor: number | "newest" | "oldest"; numBefore?: number; numAfter?: number; includeAnchor?: boolean },
    signal?: AbortSignal,
  ): Promise<ZulipMessage[]> {
    const result = await this.request<{ messages?: ZulipMessage[] }>(
      "GET",
      "messages",
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
    return Array.isArray(result.messages) ? result.messages : [];
  }

  async send(
    target: { kind: "stream"; channel: string; topic: string } | { kind: "dm"; userIds: number[] },
    content: string,
  ): Promise<number> {
    const params: Record<string, ParamValue> =
      target.kind === "stream"
        ? { type: "stream", to: target.channel, topic: target.topic, content }
        : { type: "direct", to: target.userIds, content };
    const result = await this.request<{ id?: number }>("POST", "messages", params);
    return typeof result.id === "number" ? result.id : -1;
  }
}
