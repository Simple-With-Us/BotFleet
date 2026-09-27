// Closed-app wake: when a paired phone has no live SSE stream, the sidecar
// sends an APNs alert so iOS can relaunch the companion.  The .p8 never
// leaves this process; tests inject sendImpl.
import { connect as http2Connect, constants as http2Constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR, writeFileAtomic } from "./state.ts";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8: string;
  production: boolean;
}

/** Where the signing key lives.  The path, never the contents. */
export function apnsKeyPath(): string {
  const keyId = process.env.APNS_KEY_ID?.trim() || "N3949G7CN6";
  return process.env.APNS_P8_PATH?.trim() || join(homedir(), ".secrets", `AuthKey_${keyId}.p8`);
}

/** A fingerprint of the key FILE — its path, modification time and size,
 * never a byte of the key itself.  Cheap enough to take every few minutes,
 * and enough to notice a rotated .p8 that kept its path.  The path is part
 * of it because `APNS_P8_PATH` can move the key: pointing the sidecar at a
 * different file is a key change, and a fault recorded against the old one
 * must not survive it. */
export function apnsKeyStamp(path = apnsKeyPath()): string | null {
  try {
    const info = statSync(path);
    return `${path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

export function loadApnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim() || "N3949G7CN6";
  const teamId = process.env.APNS_TEAM_ID?.trim() || "CC8UTF7ATG";
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || "app.botfleet";
  const p8Path = apnsKeyPath();
  if (!existsSync(p8Path)) return null;
  let p8: string;
  try {
    p8 = readFileSync(p8Path, "utf8");
  } catch {
    return null;
  }
  if (!p8.includes("BEGIN PRIVATE KEY")) return null;
  return {
    keyId,
    teamId,
    bundleId,
    p8,
    production: process.env.APNS_PRODUCTION !== "0",
  };
}

export function apnsJwt(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">, now = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString("base64url");
  const data = `${header}.${payload}`;
  const key = createPrivateKey(config.p8);
  const sig = cryptoSign("SHA256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${Buffer.from(sig).toString("base64url")}`;
}

// --- Provider token cache -------------------------------------------------
//
// Apple refuses a provider token minted more often than once every 20
// minutes with `TooManyProviderTokenUpdates`, and accepts one for an hour.
// Re-signing per send walked straight into that rate limit on a busy fleet
// and paid for an ES256 signature every push for nothing.  One token per
// key, reused for the whole window, re-signed the moment Apple says it is
// no longer good.

export const PROVIDER_TOKEN_MAX_AGE_MS = 20 * 60 * 1000;

interface CachedProviderToken {
  jwt: string;
  issuedAt: number;
}

const providerTokens = new Map<string, CachedProviderToken>();

/** Cache identity, not key material.  The digest distinguishes a rotated
 * .p8 that kept its key id from the one it replaced; it is one-way, so the
 * map holds nothing that could be turned back into a signing key. */
function providerTokenKey(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">): string {
  const fingerprint = createHash("sha256").update(config.p8).digest("hex").slice(0, 16);
  return `${config.teamId}:${config.keyId}:${fingerprint}`;
}

/** The provider token for this key, minted at most once per window. */
export function providerToken(
  config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">,
  now = Date.now(),
): string {
  const key = providerTokenKey(config);
  const cached = providerTokens.get(key);
  if (cached && now - cached.issuedAt < PROVIDER_TOKEN_MAX_AGE_MS) return cached.jwt;
  const jwt = apnsJwt(config, Math.floor(now / 1000));
  providerTokens.set(key, { jwt, issuedAt: now });
  return jwt;
}

/** Drop a token Apple rejected, so the next send signs a fresh one. */
export function invalidateProviderToken(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">): void {
  providerTokens.delete(providerTokenKey(config));
}

/** Test seam: forget every cached token. */
export function resetProviderTokens(): void {
  providerTokens.clear();
}

// --- Payload shape --------------------------------------------------------

export const APNS_APPROVAL_CATEGORY = "BOTFLEET_APPROVAL";
/** A question is blocking, but Approve and Deny mean nothing for it — it
 * wants an answer, not a verdict.  Its own category is what keeps those two
 * buttons off a notification that cannot use them. */
export const APNS_QUESTION_CATEGORY = "BOTFLEET_QUESTION";
export const APNS_UPDATE_CATEGORY = "BOTFLEET_UPDATE";

/** The harness notify kinds, mirrored from `server/notify.ts`. */
export type ApnsAlertKind = "approval" | "question" | "done" | "routine-failed" | "takeover";

/** True for the kinds where a bot is blocked on a person.  These go to the
 * front of a phone's queue and are the last thing dropped from it: a report
 * that arrives late is stale, an approval that arrives late is a bot that
 * sat waiting, and one that never arrives is a bot that waits forever. */
export function alertIsBlocking(kind: string | undefined): boolean {
  return kind === "approval" || kind === "question";
}

export interface ApnsAlert {
  title: string;
  body: string;
  /** Which notify frame this came from; decides how loudly it lands. */
  kind?: string;
  threadId?: string;
  botId?: string;
  /** The request waiting on an answer, on an approval or a question.  A
   * phone answering from a lock screen has no transcript to search, so
   * without this it has to guess which card the banner meant. */
  requestId?: string;
  /** The tool that asked — display only. */
  tool?: string;
  /** The harness stream position this alert was built from.  The phone uses
   * it to recognise the replayed frame as the one it has already been shown,
   * so a wake-and-replay does not draw the same banner a second time. */
  seq?: number;
}

export interface ApnsDelivery {
  category: string;
  interruptionLevel: "time-sensitive" | "active";
  relevanceScore: number;
}

/** How a kind should land on a locked phone.
 *
 * A bot blocked on you is the only thing here worth breaking a Focus for,
 * so approval and question get the time-sensitive level the app is entitled
 * to and everything else stays `active`.  The relevance score orders the
 * stack when several arrive at once: approvals on top, then the question
 * that is also waiting, then the reports. */
export function deliveryForKind(kind: string | undefined): ApnsDelivery {
  switch (kind) {
    case "approval":
      return { category: APNS_APPROVAL_CATEGORY, interruptionLevel: "time-sensitive", relevanceScore: 1 };
    case "question":
      return { category: APNS_QUESTION_CATEGORY, interruptionLevel: "time-sensitive", relevanceScore: 0.9 };
    case "takeover":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.7 };
    case "routine-failed":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.6 };
    case "done":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.4 };
    default:
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.3 };
  }
}

/** The `aps` dictionary Apple reads.  Named rather than open so the shape
 * is a contract a test can assert against and a reviewer can read. */
export interface ApnsAps {
  alert: { title: string; body: string };
  sound: string;
  "thread-id"?: string;
  category: string;
  "interruption-level": "time-sensitive" | "active";
  "relevance-score": number;
  "mutable-content": 1;
  "content-available": 1;
}

export interface ApnsPayload {
  aps: ApnsAps;
  threadId?: string;
  botId?: string;
  kind?: string;
  requestId?: string;
  tool?: string;
  /** The harness frame's own sequence number — see `ApnsAlert.seq`. */
  seq?: number;
}

/** The JSON body for one alert.  Exported so a test can read the shape
 * without standing up a fetch. */
export function apnsPayload(alert: ApnsAlert): ApnsPayload {
  const delivery = deliveryForKind(alert.kind);
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      "thread-id": alert.threadId,
      category: delivery.category,
      "interruption-level": delivery.interruptionLevel,
      "relevance-score": delivery.relevanceScore,
      "mutable-content": 1,
      // Background fetch so a suspended companion reconnects without a tap.
      // A force-quit app still needs the lock-screen alert (user tap).
      "content-available": 1,
    },
    // The same keys the in-app path puts in `content.userInfo`, so one
    // routing function on the phone covers a local and a remote delivery.
    threadId: alert.threadId,
    botId: alert.botId,
    kind: alert.kind,
    requestId: alert.requestId,
    tool: alert.tool,
    // The phone drops the local banner for a frame it already got by push.
    // Without this the same notification arrives twice on a closed app: once
    // from Apple, and again when the wake reconnects and the harness replays
    // the very frame the push was built from.
    seq: alert.seq,
  };
}

// --- Sending --------------------------------------------------------------

/** The bucketed shape of why a send did not land.  Defaults to "none" on a
 * healthy send so old callers that build `ApnsSendResult` by hand stay valid
 * — a missing `failureKind` field reads as "none", which is the value the
 * helper writes for every successful send and for the cheap rejections that
 * never went anywhere near the wire (a bad device token in the call site). */
export type ApnsFailureKind =
  | "none"
  | "transport"        // DNS / TCP / TLS handshake before any HTTP/2 frame
  | "http2_protocol"   // GOAWAY, RST_STREAM, INTERNAL_ERROR, PROTOCOL_ERROR
  | "socket_closed"    // socket dropped mid-request
  | "timeout"
  | "rate_limit"       // 429 / 503 with Retry-After
  | "bad_token"        // 400 BadDeviceToken / DeviceTokenNotForTopic, 410
  | "expired_token"    // 403 ExpiredProviderToken
  | "key_fault"        // 403 InvalidProviderToken
  | "server"           // 500-504 other than 503 rate limit
  | "rejected";        // 400 / 403 with reason Apple sent that does not match the buckets above

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  /** Apple's own `reason` string, when it sent one.  Safe to log. */
  reason?: string;
  attempts: number;
  /** The bucketed shape of why this send did not land.  "none" on a healthy
   * send or on the cheap rejections that never reached the wire. */
  failureKind?: ApnsFailureKind;
  /** Apple-side `err.code` / HTTP/2 code, surfaced verbatim from the underlying
   * transport error so the health page can name what actually went wrong
   * (e.g. "ECONNRESET", "ERR_HTTP2_PROTOCOL_ERROR"). */
  errorCode?: string;
  /** Apple's own `timestamp` field — sent on a 403 InvalidProviderToken
   * body and on a 410 Unregistered body (the token's invalidation time).
   * The exact value the Apple debug page asks for. */
  errorTimestamp?: number;
}

export interface ApnsSendOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Inject a session factory for tests.  The default opens a Node http2
   * session with the APNs-recommended keepalive and concurrency settings. */
  http2SessionFactory?: Http2SessionFactory;
}

/** One send plus its retries.  Three is enough to ride out a rate limit or
 * a brief 503 without holding the notify loop open behind a wall of sleeps. */
export const APNS_MAX_ATTEMPTS = 3;

const APNS_MAX_BACKOFF_MS = 30_000;

/** Statuses worth trying again: Apple is asking us to slow down, or one of
 * its gateways is briefly unwell.  Everything else is about this request
 * and will fail identically next time. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The one rejection worth signing a new token for.  `InvalidProviderToken`
 * is NOT here: it means Apple refuses the key itself — wrong team, revoked,
 * a .p8 that does not match its key id — and re-signing produces exactly the
 * same rejection, forever, on every send.  The watcher treats it as a key
 * fault instead. */
const EXPIRED_TOKEN_REASON = "ExpiredProviderToken";

/** Apple refuses the signing key itself.  A new signature cannot help. */
export const INVALID_PROVIDER_TOKEN = "InvalidProviderToken";

/** `status: 0` with this reason means the request never reached Apple at
 * all — the connection failed, rather than the notification being refused. */
export const TRANSPORT_FAILURE_REASON = "SendFailed";

/** Rejections that mean this device token will never work again.  410 says
 * the same thing with a status; these two say it with a 400, and retrying
 * either one earns the identical answer on every future notification. */
export const PERMANENT_TOKEN_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

/** True when Apple has told us to stop using this device token. */
export function tokenIsDead(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  return status === 400 && reason !== undefined && PERMANENT_TOKEN_REASONS.has(reason);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` is seconds or an HTTP date; only the first is worth
 * honouring here, and a hostile value must not park the loop for a day. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, APNS_MAX_BACKOFF_MS);
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), APNS_MAX_BACKOFF_MS);
}

// --- HTTP/2 transport -----------------------------------------------------
//
// Node 26's native `fetch` (undici) opens a fresh HTTP/2 session per
// request, sets no TCP keepalive, no HTTP/2 keepalive, and reports
// GOAWAY/RST_STREAM as a generic "fetch failed".  Apple explicitly asks
// long-lived APNs senders to keep a persistent HTTP/2 session with PING
// keepalives.  We hold one session per (host, keyId) — a key rotation
// rebuilds the cache entry — close it cleanly when the stream is idle and
// no peer still holds a request, and rebuild lazily after a GOAWAY.

/** What an `http2.connect(...)` call takes, narrowed to the options we use.
 * Node silently ignores unknown keys here, so placement matters:
 * `keepaliveTimeoutMillis` / `keepaliveIntervalMillis` are not real options
 * at all, `initialWindowSize` only applies nested under `settings`, and
 * `maxSessionMemory` is measured in MEGAbytes — 10_485_760 would be ~10 TB,
 * not 10 MiB.  The HTTP/2 PING keepalive Apple asks for has no connect
 * option either; the default factory runs `session.ping` on
 * `pingIntervalMs`. */
export interface Http2ConnectOptions {
  /** The local settings frame sent to the peer. */
  settings: {
    /** 1 MiB initial flow-control window — Apple's documented guidance. */
    initialWindowSize: number;
    /** Concurrent-stream cap; 500 is the documented APNs guidance. */
    maxConcurrentStreams: number;
  };
  /** Session memory cap in MEGAbytes — 10 means 10 MiB. */
  maxSessionMemory: number;
  /** TCP keepalive, applied with `socket.setKeepAlive` once the session
   * connects; the delay is milliseconds. */
  keepAlive: boolean;
  keepAliveInitialDelay: number;
  /** HTTP/2 PING keepalive cadence in milliseconds. */
  pingIntervalMs: number;
  /** How long one PING may go unanswered before the session is treated as
   * half-open, evicted, and destroyed.  Node puts no deadline on a PING. */
  pingDeadlineMs: number;
}

/** Apple's recommended dial for long-lived APNs HTTP/2 senders.  Pulled from
 * the APNs HTTP/2 reference: TCP keepalive after 30s idle, an HTTP/2 PING
 * every 30s, and the 1 MiB initial window + 500 concurrent streams cap. */
export const DEFAULT_HTTP2_OPTIONS: Http2ConnectOptions = {
  settings: {
    initialWindowSize: 1_048_576,
    maxConcurrentStreams: 500,
  },
  maxSessionMemory: 10,
  keepAlive: true,
  keepAliveInitialDelay: 30_000,
  pingIntervalMs: 30_000,
  pingDeadlineMs: 10_000,
};

/** One transport session: the http2 client + a notifier for the call site. */
export interface Http2ApnsSession {
  /** The Node http2 session.  May be closed by either side; callers must
   * reopen rather than reuse a session whose `closed` flag is true. */
  raw: ClientHttp2Session;
}

/** Factory injected into `sendApnsAlert` so tests can count rebuilds and
 * fake the wire without standing up a real socket. */
export type Http2SessionFactory = (host: string, keyId: string) => Http2ApnsSession;

/** Wire a session's own error / goaway / close events to the cache and to
 * the sends in flight on it.  Pulled out of the default factory so tests
 * can drive the same wiring on a fake session; a custom factory that wants
 * the production failure handling calls it too. */
export function watchHttp2SessionLifecycle(host: string, session: ClientHttp2Session): void {
  // A session-level 'error' with no listener is an uncaught exception: one
  // DNS/TCP/TLS failure would take the whole companion process down.
  // Handle it, drop the session from the cache, and reject everything still
  // in flight on it — a send waiting on a dead session must fail, not hang.
  session.on("error", (err) => {
    failCachedSession(host, session, err);
    try {
      session.destroy();
    } catch {
      /* already gone */
    }
  });
  // A GOAWAY means the peer refuses new streams on this session.  In-flight
  // streams still settle on their own, so evict rather than destroy: the
  // next send opens a fresh session while this one drains.
  session.on("goaway", () => {
    evictCachedSession(host, session);
  });
  // A close with requests still pending is a dropped connection: those
  // streams will never settle on their own, so reject them now.
  session.on("close", () => {
    failCachedSession(
      host,
      session,
      Object.assign(new Error("APNs http2 session closed with requests in flight"), {
        code: "ERR_HTTP2_SESSION_EOF",
        name: "Error",
      }),
    );
  });
}

/** Default factory — `node:http2` with Apple's recommended settings. */
export const defaultHttp2SessionFactory: Http2SessionFactory = (host, _keyId) => {
  const session = http2Connect(
    `https://${host}`,
    {
      settings: DEFAULT_HTTP2_OPTIONS.settings,
      maxSessionMemory: DEFAULT_HTTP2_OPTIONS.maxSessionMemory,
    },
    (_session, socket) => {
      // TCP keepalive: `http2.connect` exposes no typed option for it, so
      // set it on the underlying socket the moment the connection is up.
      socket.setKeepAlive(
        DEFAULT_HTTP2_OPTIONS.keepAlive,
        DEFAULT_HTTP2_OPTIONS.keepAliveInitialDelay,
      );
    },
  );
  watchHttp2SessionLifecycle(host, session);
  startHttp2PingKeepalive(host, session);
  return { raw: session };
};

export interface Http2PingKeepaliveOptions {
  /** Cadence in ms; defaults to DEFAULT_HTTP2_OPTIONS.pingIntervalMs. */
  intervalMs?: number;
  /** Per-PING deadline in ms; defaults to DEFAULT_HTTP2_OPTIONS.pingDeadlineMs. */
  deadlineMs?: number;
}

/** The PING keepalive Apple asks long-lived senders for.  Node has no
 * connect option for it, so run `session.ping` on a cadence.  A PING is
 * the only probe an idle session gets, so it has to act on what it learns:
 * an error delivered to the PING callback, or no answer inside the
 * deadline, means the connection is dead or half-open.  Either one evicts
 * the session from the cache, fails every send still pending on it, and
 * destroys it, so the next send opens a fresh session instead of waiting
 * out the full request deadline on a dead socket.  One PING is in flight at
 * a time; the timers are unref'd so they never keep the process alive, and
 * everything stops with the session.  Exported so tests can drive it on a
 * fake session; returns a stop function. */
export function startHttp2PingKeepalive(
  host: string,
  session: ClientHttp2Session,
  options: Http2PingKeepaliveOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_HTTP2_OPTIONS.pingIntervalMs;
  const deadlineMs = options.deadlineMs ?? DEFAULT_HTTP2_OPTIONS.pingDeadlineMs;
  let stopped = false;
  let inFlight: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (inFlight) clearTimeout(inFlight);
    inFlight = null;
  };
  const kill = (err: unknown) => {
    stop();
    failCachedSession(host, session, err);
    try {
      session.destroy();
    } catch {
      /* already gone, or a test double with no destroy() */
    }
  };
  const timer = setInterval(() => {
    if (session.closed || session.destroyed) {
      stop();
      return;
    }
    // The previous PING is still out; its own deadline decides its fate.
    if (inFlight) return;
    let answered = false;
    const deadline = setTimeout(() => {
      if (answered) return;
      answered = true;
      inFlight = null;
      kill(
        Object.assign(new Error(`APNs http2 PING went unanswered for ${deadlineMs}ms`), {
          code: "ETIMEDOUT",
          name: "TimeoutError",
        }),
      );
    }, deadlineMs);
    deadline.unref?.();
    inFlight = deadline;
    try {
      const sent = session.ping((err) => {
        if (answered) return;
        answered = true;
        clearTimeout(deadline);
        inFlight = null;
        if (err) kill(err);
      });
      if (sent === false && !answered) {
        // Node refused to queue the PING (too many outstanding); nothing
        // was written, so there is nothing to wait for this cycle.
        answered = true;
        clearTimeout(deadline);
        inFlight = null;
      }
    } catch (err) {
      // `ping` throws only on a session that is already unusable.
      answered = true;
      clearTimeout(deadline);
      inFlight = null;
      kill(err);
    }
  }, intervalMs);
  timer.unref?.();
  session.once("close", stop);
  return stop;
}

/** Read every field Node attaches to a thrown error in a single helper, so
 * the caller can stash them on `ApnsSendResult` verbatim and the health
 * page can render what actually went wrong without re-classifying. */
export interface TransportErrorInfo {
  name: string;
  code: string;
  message: string;
  /** The underlying cause when the error chains; HTTP/2 surfaces the real
   * reason on `err.cause`, undici chains an `UndiciError` onto a `fetch`,
   * and the stack of `Error` subclasses Node produces otherwise all
   * converge there. */
  cause?: unknown;
}

export function inspectTransportError(err: unknown): TransportErrorInfo {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      code: typeof e.code === "string" ? e.code : "",
      message: typeof e.message === "string" ? e.message : String(err),
      cause: e.cause,
    };
  }
  return { name: "Error", code: "", message: String(err) };
}

/** Bucketed shape of why a transport-layer call did not return a Response.
 * Pure decision: takes the fields we read off the error and the elapsed
 * time, returns the `ApnsFailureKind` that lands on the health page. */
export function classifyTransportError(info: TransportErrorInfo): Exclude<ApnsFailureKind, "none"> {
  const code = info.code.toUpperCase();
  const name = info.name.toUpperCase();
  // Timeouts first: the request deadline raises ETIMEDOUT / TimeoutError, a
  // PING that never came back is ERR_HTTP2_PING_CANCEL, and a session that
  // ended under a live stream is ERR_HTTP2_SESSION_EOF.  The last two start
  // with ERR_HTTP2 but are a dead or stalled link, not Apple speaking bad
  // HTTP/2, so they must not feed the protocol breaker.
  if (name === "TIMEOUTERROR" || code === "ETIMEDOUT" || code === "ERR_HTTP2_PING_CANCEL" ||
      code === "ERR_HTTP2_SESSION_EOF") return "timeout";
  // HTTP/2 protocol-level: GOAWAY, RST_STREAM, INTERNAL_ERROR, PROTOCOL_ERROR,
  // FRAME_SIZE_ERROR, FLOW_CONTROL_ERROR, COMPRESSION_ERROR.  Node raises
  // these as a `DOMException` whose `code` carries one of the magic strings
  // (`ERR_HTTP2_PROTOCOL_ERROR`, `ERR_HTTP2_STREAM_ERROR`, etc.) — name
  // rarely matches because the wrapper class is generic.
  if (code.startsWith("ERR_HTTP2") || name.includes("HTTP2")) return "http2_protocol";
  // The classic mid-request drop: ECONNRESET / EPIPE on the TCP layer, and
  // the http2-specific RST_STREAM that arrives too late for the request
  // promise to resolve.
  if (code === "ECONNRESET" || code === "EPIPE") return "socket_closed";
  // Anything below the TLS layer — DNS, TCP handshake, TLS handshake —
  // gets the generic "transport" bucket.  Err.code is normally enough.
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" || code === "ENETUNREACH" ||
      code === "ECONNRESET" || code === "EPIPE" || code === "CERT_HAS_EXPIRED" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      code === "ERR_TLS_CERT_ALTNAME_INVALID" || code.startsWith("ERR_SSL"))
    return "transport";
  // Fall-through: still a transport error — we never saw a Response, so
  // "transport" is the honest default.
  return "transport";
}

/** Apple answers a rejection with `{"reason":"BadDeviceToken"}`; the 403
 * InvalidProviderToken body additionally carries a `timestamp` field whose
 * value Apple's debug page asks for verbatim.  Both reads are best-effort:
 * a body we could not parse must not turn a clean 400 into a thrown error. */
async function readErrorBody(res: Response): Promise<{ reason?: string; timestamp?: number }> {
  try {
    const text = (await res.text()).slice(0, 512);
    if (!text) return {};
    // SAFETY: this came from Apple's error body and the assertion grants no
    // behaviour — it permits two optional property reads, each of which is
    // type-checked before use, and the values are only logged or compared
    // to fixed literals.
    const parsed = JSON.parse(text) as { reason?: unknown; timestamp?: unknown };
    return {
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
    };
  } catch {
    return {};
  }
}

/** POST one JSON payload over a persistent http2 session.  Returns a
 * `Response`-shaped object so the test seam and the production path stay
 * type-compatible with `fetch`.  Internally holds the session open and
 * rebuilds it after a GOAWAY. */
export type ApnsHttp2Fetch = (
  input: URL | string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

interface SessionCacheEntry {
  factory: Http2SessionFactory;
  session: Http2ApnsSession | null;
  lastKeyId: string | null;
}

const sessionCache = new Map<string, SessionCacheEntry>();

/** Reject callbacks for the sends in flight, keyed by the session they were
 * written to.  Scoped per session, not per host: after a GOAWAY evicts a
 * session, its streams keep draining while the replacement serves new
 * sends, and a failure on either one must reject only its own streams.
 * A WeakMap so a session that is gone takes its set with it. */
const pendingBySession = new WeakMap<ClientHttp2Session, Set<(err: unknown) => void>>();

function pendingFor(session: ClientHttp2Session): Set<(err: unknown) => void> {
  let pending = pendingBySession.get(session);
  if (!pending) {
    pending = new Set();
    pendingBySession.set(session, pending);
  }
  return pending;
}

/** Build (or reuse) the cache entry for `(host, keyId)`.  Pulled out so
 * tests can inject a factory that counts how many times a fresh session
 * was opened — the rebuild-on-rotation invariant asserts on that count. */
function getOrOpenEntry(
  host: string,
  keyId: string,
  factory: Http2SessionFactory,
): SessionCacheEntry {
  let entry = sessionCache.get(host);
  if (!entry) {
    entry = { factory, session: null, lastKeyId: null };
    sessionCache.set(host, entry);
  }
  // Always replace a session whose key changed — a rotated .p8 should never
  // share a TLS session with the key it replaced, and a small hole of
  // reusing the same TLS ticket is not worth the bookkeeping.  This is the
  // invariant `refreshConfig` asserts on in the watcher.
  if (entry.factory !== factory || entry.lastKeyId !== keyId || !entry.session || entry.session.raw.closed || entry.session.raw.destroyed) {
    if (entry.session && !entry.session.raw.closed && !entry.session.raw.destroyed) {
      try {
        entry.session.raw.close();
      } catch {
        /* ignore — close() can throw on an already-closing session */
      }
    }
    entry.factory = factory;
    entry.lastKeyId = keyId;
    entry.session = factory(host, keyId);
  }
  return entry;
}

/** Build (or reuse) the persistent session for `(host, keyId)`. */
export function getOrOpenSession(
  host: string,
  keyId: string,
  factory: Http2SessionFactory,
): Http2ApnsSession {
  return getOrOpenEntry(host, keyId, factory).session as Http2ApnsSession;
}

/** Evict a session from the cache without touching its in-flight sends:
 * the next send opens a fresh session while this one drains.  Used on
 * GOAWAY, where the peer keeps serving streams it already accepted. */
function evictCachedSession(host: string, session: ClientHttp2Session): void {
  const entry = sessionCache.get(host);
  if (!entry || !entry.session || entry.session.raw !== session) return;
  entry.session = null;
}

/** A session died underneath its sends (error or close).  Drop it from the
 * cache if it is still the cached one, and reject every send still waiting
 * on THIS session — a dead session must fail its queue, never hang it.
 * The sweep runs even when the session was already evicted (GOAWAY), so a
 * draining session's own close/error still settles its streams, and it
 * never touches the replacement session's sends. */
function failCachedSession(host: string, session: ClientHttp2Session, err: unknown): void {
  const entry = sessionCache.get(host);
  if (entry && entry.session && entry.session.raw === session) entry.session = null;
  const set = pendingBySession.get(session);
  if (!set || set.size === 0) return;
  const pending = [...set];
  set.clear();
  for (const reject of pending) {
    try {
      reject(err);
    } catch {
      /* a drained rejector must never take the sweep down with it */
    }
  }
}

/** Clear every cached session.  Exposed so tests can reset between runs
 * and so `refreshConfig` can drop the cache when the loaded key changes
 * fingerprint (not just keyId — a same-id-but-different-bytes key should
 * also force a rebuild, which the caller does by calling this with the
 * new keyId, and the cache miss on next send reopens). */
export function dropHttp2Sessions(): void {
  for (const entry of sessionCache.values()) {
    if (entry.session && !entry.session.raw.closed && !entry.session.raw.destroyed) {
      try {
        entry.session.raw.close();
      } catch {
        /* ignore */
      }
    }
  }
  sessionCache.clear();
}

/** How long one push may sit unanswered before the stream is cancelled and
 * the send fails with ETIMEDOUT.  Apple answers in milliseconds; a stream
 * with no response after 30s is a stalled gateway, and letting it hang
 * would park that phone's queue and starve the circuit breaker of the
 * failures it counts. */
export const APNS_REQUEST_DEADLINE_MS = 30_000;

export interface ApnsHttp2FetchOptions {
  /** Sessions are keyed by the signing key id, passed in explicitly —
   * never derived from the request URL, whose last path segment is the
   * DEVICE TOKEN.  Keying by that would close and re-open the TLS session
   * for every phone, paying a fresh handshake per push. */
  keyId: string;
  /** Session factory; tests inject a fake, production uses the default. */
  factory?: Http2SessionFactory;
  /** Per-request deadline in ms; defaults to APNS_REQUEST_DEADLINE_MS. */
  requestDeadlineMs?: number;
}

/** Build the default production transport: POST through a persistent http2
 * session, accepting the same `(URL | string, init)` shape as `fetch` so a
 * test can swap a `fetchImpl` in and the rest of `sendApnsAlert` does not
 * change.  The key id and session factory come in through options, so the
 * session cache is keyed by the signing key and tests can inject their own
 * session. */
export function createApnsHttp2Fetch(options: ApnsHttp2FetchOptions): ApnsHttp2Fetch {
  const factory = options.factory ?? defaultHttp2SessionFactory;
  const keyId = options.keyId;
  const deadlineMs = options.requestDeadlineMs ?? APNS_REQUEST_DEADLINE_MS;
  return (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const host = url.host;
    return new Promise<Response>((resolve, reject) => {
      let entry = getOrOpenEntry(host, keyId, factory);
      const open = entry.session as Http2ApnsSession;
      if (open.raw.closed || open.raw.destroyed) {
        // Mid-GOAWAY race: drop the cache and re-open.
        dropHttp2Sessions();
        entry = getOrOpenEntry(host, keyId, factory);
      }
      sendOver(entry, url, init, resolve, reject, deadlineMs);
    });
  };
}

/** Names for the HTTP/2 error codes `req.rstCode` can carry, so a reset
 * rejection records the reason Apple gave instead of a bare number. */
const NGHTTP2_ERROR_NAMES: Record<number, string> = {
  [http2Constants.NGHTTP2_NO_ERROR]: "NO_ERROR",
  [http2Constants.NGHTTP2_PROTOCOL_ERROR]: "PROTOCOL_ERROR",
  [http2Constants.NGHTTP2_INTERNAL_ERROR]: "INTERNAL_ERROR",
  [http2Constants.NGHTTP2_FLOW_CONTROL_ERROR]: "FLOW_CONTROL_ERROR",
  [http2Constants.NGHTTP2_SETTINGS_TIMEOUT]: "SETTINGS_TIMEOUT",
  [http2Constants.NGHTTP2_STREAM_CLOSED]: "STREAM_CLOSED",
  [http2Constants.NGHTTP2_FRAME_SIZE_ERROR]: "FRAME_SIZE_ERROR",
  [http2Constants.NGHTTP2_REFUSED_STREAM]: "REFUSED_STREAM",
  [http2Constants.NGHTTP2_CANCEL]: "CANCEL",
  [http2Constants.NGHTTP2_COMPRESSION_ERROR]: "COMPRESSION_ERROR",
  [http2Constants.NGHTTP2_CONNECT_ERROR]: "CONNECT_ERROR",
  [http2Constants.NGHTTP2_ENHANCE_YOUR_CALM]: "ENHANCE_YOUR_CALM",
  [http2Constants.NGHTTP2_INADEQUATE_SECURITY]: "INADEQUATE_SECURITY",
  [http2Constants.NGHTTP2_HTTP_1_1_REQUIRED]: "HTTP_1_1_REQUIRED",
};

/** The rejection for a stream that closed before its response settled.
 * `rstCode` is the HTTP/2 error code from the RST_STREAM frame, or
 * NGHTTP2_NO_ERROR when the stream closed without one.  A real RST_STREAM
 * is Apple speaking HTTP/2 at us and classifies as `http2_protocol`; a
 * close with no reset means the socket went away and classifies as
 * `socket_closed`, like any mid-request drop. */
function streamClosedError(req: ClientHttp2Stream): Error {
  // Test doubles and older Node leaves may not carry rstCode at all.
  const rstCode = typeof req.rstCode === "number" ? req.rstCode : http2Constants.NGHTTP2_NO_ERROR;
  if (rstCode === http2Constants.NGHTTP2_NO_ERROR) {
    return Object.assign(new Error("APNs http2 stream closed before a response, with no RST_STREAM"), {
      code: "ECONNRESET",
      name: "Error",
    });
  }
  const rstName = NGHTTP2_ERROR_NAMES[rstCode] ?? `code ${rstCode}`;
  return Object.assign(new Error(`APNs http2 stream reset before a response (RST_STREAM ${rstName})`), {
    code: "ERR_HTTP2_STREAM_ERROR",
    name: "HTTP2StreamError",
  });
}

function sendOver(
  entry: SessionCacheEntry,
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  resolve: (response: Response) => void,
  reject: (reason: unknown) => void,
  deadlineMs: number,
): void {
  const raw = entry.session?.raw;
  if (!raw) {
    reject(new Error("APNs http2 session is not open"));
    return;
  }
  const headers: Record<string, string> = { ":method": init?.method ?? "POST", ":path": url.pathname, ...(init?.headers ?? {}) };
  // Host header is required by HTTP/2; Node fills `:authority` from the
  // connect URL automatically, but we set Host explicitly so the header map
  // matches what `fetch` would have produced.
  headers[":authority"] = url.host;
  headers["host"] = url.host;
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  // Registered on the session this send is written to: when that session
  // fails, its handler drains its pending set and this send rejects instead
  // of hanging on a dead connection.
  const pending = pendingFor(raw);
  const onSessionFailure = (err: unknown) => settle(() => reject(err));
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    pending.delete(onSessionFailure);
    fn();
  };
  let req: ReturnType<ClientHttp2Session["request"]>;
  try {
    req = raw.request(headers, { endStream: false });
  } catch (err) {
    settle(() => reject(err));
    return;
  }
  req.setEncoding("utf8");
  pending.add(onSessionFailure);
  // Bound the request: a stalled stream never settles on its own, and an
  // unbounded wait would park this phone's queue and starve the circuit
  // breaker of the failures it counts.  On expiry, cancel the stream and
  // fail the send as a timeout so the retry ladder and breaker see it.
  deadline = setTimeout(() => {
    settle(() => {
      try {
        req.close(http2Constants.NGHTTP2_CANCEL);
      } catch {
        /* the stream is already gone */
      }
      reject(
        Object.assign(new Error(`APNs request exceeded the ${deadlineMs}ms deadline`), {
          code: "ETIMEDOUT",
          name: "TimeoutError",
        }),
      );
    });
    // A stream that got no answer at all means the connection under it is
    // most likely half-open, and cancelling the stream does not fix that:
    // left cached, the retry and every later send would be written to the
    // same dead socket.  The PING keepalive would only catch it on its next
    // cycle, up to a full interval plus the PING deadline later.  So evict
    // the session, fail every other send still waiting on it (they are on
    // the same dead connection and would each wait out their own deadline),
    // and destroy it.  Only this session's pending set is swept; a
    // replacement session's sends are never touched.
    failCachedSession(
      url.host,
      raw,
      Object.assign(new Error(`APNs http2 session evicted after a request exceeded the ${deadlineMs}ms deadline`), {
        code: "ETIMEDOUT",
        name: "TimeoutError",
      }),
    );
    try {
      raw.destroy();
    } catch {
      /* already gone, or a test double with no destroy() */
    }
  }, deadlineMs);
  deadline.unref?.();
  const bodyChunks: string[] = [];
  req.on("response", (responseHeaders) => {
    const status = Number(responseHeaders[":status"] ?? 0);
    const responseHeadersObj: Record<string, string> = {};
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.startsWith(":")) continue;
      if (typeof value === "string") responseHeadersObj[key.toLowerCase()] = value;
    }
    req.on("data", (chunk: string) => bodyChunks.push(chunk));
    req.on("end", () => {
      const body = bodyChunks.join("");
      const response = new Response(body, {
        status,
        statusText: responseHeadersObj["status"] ?? "",
        headers: responseHeadersObj,
      });
      settle(() => resolve(response));
    });
    req.on("error", (err) => {
      settle(() => reject(err));
    });
  });
  req.on("error", (err) => {
    settle(() => reject(err));
  });
  req.on("frameError", (type, code) => {
    settle(() => reject(Object.assign(new Error(`HTTP/2 frameError type=${type} code=${code}`), { code: "ERR_HTTP2_PROTOCOL_ERROR", name: "HTTP2FrameError" })));
  });
  // A close with no response settled means the stream ended before APNs
  // answered — almost always an RST_STREAM ahead of any headers.  Reject
  // right away: waiting out the request deadline would turn a retry-now
  // reset into a 30s stall, and the deadline path would evict and destroy
  // a session that just proved it is alive.  settle() clears the deadline
  // timer, so this path never runs the eviction: an RST_STREAM kills one
  // stream, not the connection, and the retry belongs on this same
  // session.  A close after a settled response — or after the deadline's
  // own CANCEL — is a no-op through the settled guard.
  req.on("close", () => {
    settle(() => reject(streamClosedError(req)));
  });
  // Write the body and end the stream.  An empty body is fine — APNs allows
  // it for keepalive probes.
  req.end(init?.body ?? "");
}

export async function sendApnsAlert(
  config: ApnsConfig,
  deviceToken: string,
  alert: ApnsAlert,
  options: ApnsSendOptions = {},
): Promise<ApnsSendResult> {
  // The default transport is the http2 path, keyed by the SIGNING KEY and
  // opened through the injected session factory when one is given; tests
  // inject `fetchImpl` and bypass it entirely.  `fetchImpl` keeps the same
  // URL-or-string input shape as the production impl so a test that swaps
  // in a fake does not have to know about http2.
  const fetchImpl: typeof fetch =
    (options.fetchImpl as typeof fetch | undefined) ??
    (createApnsHttp2Fetch({
      keyId: config.keyId,
      factory: options.http2SessionFactory,
    }) as unknown as typeof fetch);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? APNS_MAX_ATTEMPTS);
  const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const token = deviceToken.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{64,}$/.test(token)) {
    return { ok: false, status: 400, reason: "BadDeviceToken", attempts: 0, failureKind: "bad_token" };
  }
  const body = JSON.stringify(apnsPayload(alert));

  let attempts = 0;
  let resigned = false;
  let lastStatus = 0;
  let lastReason: string | undefined;
  let lastFailureKind: ApnsFailureKind = "none";
  let lastErrorCode: string | undefined;
  let lastErrorTimestamp: number | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    let res: Response;
    try {
      res = await fetchImpl(`https://${host}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${providerToken(config, now())}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body,
      });
    } catch (err) {
      // A reset connection, a DNS blip, a Wi-Fi drop, an HTTP/2 GOAWAY.  This
      // is the most common transient failure on a home link and the only
      // one the status ladder below cannot see, so it earns the same bounded
      // backoff a 503 gets rather than losing the alert on the first
      // attempt.  The bucketed kind lands on `failureKind` so the health
      // page can tell a DNS blip apart from a RST_STREAM.
      const info = inspectTransportError(err);
      lastStatus = 0;
      lastReason = TRANSPORT_FAILURE_REASON;
      lastFailureKind = classifyTransportError(info);
      lastErrorCode = info.code || undefined;
      if (attempts >= maxAttempts) break;
      await sleep(backoffMs(attempts));
      continue;
    }
    if (res.ok) return { ok: true, status: res.status, attempts, failureKind: "none" };

    const { reason, timestamp } = await readErrorBody(res);
    lastStatus = res.status;
    lastErrorCode = undefined;
    lastReason = reason;
    lastErrorTimestamp = timestamp;
    lastFailureKind = classifyHttpResponse(res.status, reason);

    // Apple has unregistered this token.  The caller drops it; sending again
    // would only earn the same answer.  The 410 body carries Apple's
    // invalidation `timestamp` — keep it for the health page.
    if (res.status === 410) return { ok: false, status: 410, reason, attempts, failureKind: "bad_token", errorTimestamp: timestamp };

    // A stale provider token is the one failure worth retrying instantly:
    // sign a new one and go straight back, no backoff, exactly once.
    if (reason === EXPIRED_TOKEN_REASON && !resigned) {
      invalidateProviderToken(config);
      resigned = true;
      continue;
    }

    if (!RETRYABLE_STATUSES.has(res.status)) {
      // Surface the InvalidProviderToken timestamp on the health page so
      // Jay's debug page interaction does not require a log dive.
      return {
        ok: false,
        status: res.status,
        reason,
        attempts,
        failureKind: lastFailureKind,
        errorTimestamp: timestamp,
      };
    }
    if (attempts >= maxAttempts) break;
    const wait = res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : null;
    await sleep(wait ?? backoffMs(attempts));
  }

  return {
    ok: false,
    status: lastStatus,
    reason: lastReason,
    attempts,
    failureKind: lastFailureKind,
    errorCode: lastErrorCode,
    errorTimestamp: lastErrorTimestamp,
  };
}

/** Bucketed shape of why a HTTP-layer call did not land.  Decision table:
 * every status Apple commonly returns plus the matching reason string. */
export function classifyHttpResponse(status: number, reason: string | undefined): Exclude<ApnsFailureKind, "none"> {
  if (status === 429) return "rate_limit";
  if (status === 410) return "bad_token";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return "bad_token";
  if (status === 403 && reason === EXPIRED_TOKEN_REASON) return "expired_token";
  if (status === 403 && reason === INVALID_PROVIDER_TOKEN) return "key_fault";
  if (status === 503) return "rate_limit";
  if (status >= 500 && status < 600) return "server";
  if (status === 400 || status === 403) return "rejected";
  return "server";
}

// --- Sender health --------------------------------------------------------

/** Why this sidecar is not sending pushes at all.  A word rather than a
 * sentence, so the phone and the pairing page can each say it their own
 * way: `no-key` (no usable .p8 on disk), `key-rejected` (Apple refuses the
 * one we have), `unreachable` (every paired phone's circuit is open because
 * Apple's push service cannot be reached). */
export type PushesOffReason = "no-key" | "key-rejected" | "unreachable";

/** One paired phone's own push state.
 *
 * Per device because the breaker is per device.  A single shared counter
 * could not open: `deliver` fans every notification out to every
 * disconnected phone, so one other phone's `400 BadDeviceToken` zeroed the
 * run before it could reach the threshold, and a link that was down for two
 * days never tripped anything. */
export interface PushDeviceHealth {
  deviceId: string;
  /** The bucketed shape of this phone's last failure. */
  failureKind: ApnsFailureKind;
  /** Transport-family failures in a row for THIS phone. */
  consecutiveTransportFailures: number;
  /** `err.code` from this phone's last failure, verbatim. */
  lastErrorCode: string | null;
  /** Epoch ms; non-null means this phone's lane is holding its alerts until
   * then.  They are held, not discarded. */
  circuitOpenUntil: number | null;
  /** Alerts waiting on this phone's lane right now. */
  queued: number;
  /** Alerts this phone's lane has dropped because it was full. */
  dropped: number;
}

/** What the desktop and the phone may know about the push sender.  Every
 * field here is either a count, a timestamp, or a status Apple sent us —
 * nothing derived from the signing key. */
export interface PushSenderHealth {
  /** Whether a usable .p8 has been found yet. */
  configured: boolean;
  /** Production or sandbox APNs, once configured. */
  production: boolean | null;
  /** Paired devices holding a push token right now. */
  tokensRegistered: number;
  sent: number;
  failed: number;
  lastSentAt: number | null;
  lastErrorAt: number | null;
  /** Status plus Apple's reason, e.g. `403 ExpiredProviderToken`.  The
   * InvalidProviderToken case additionally carries the `timestamp` field
   * Apple sent (formatted as `InvalidProviderToken (timestamp=12345)`) so
   * the owner can paste it straight into the Apple debug page. */
  lastError: string | null;
  /** Set when Apple refused the signing key itself.  Sending is off until
   * the key file changes; a new signature from the same key cannot help. */
  keyRejected: string | null;
  /** Notifications dropped because a device's queue was already full. */
  dropped: number;
  /** Drain passes HELD BACK because the circuit breaker was open — Apple's
   * push service was unreachable, not a full queue on this computer.  Kept
   * apart from `dropped` so the phone can say which one happened, and it is
   * deliberately not a count of lost notifications: an open circuit now
   * leaves every alert on its lane and sends it when the circuit closes. */
  circuitDropped: number;
  /** The bucketed shape of the last failure — Apple vs transport vs key.
   * "none" when the last attempt succeeded or no attempt has happened yet.
   * This is the field that tells the owner which fix to read next. */
  failureKind: ApnsFailureKind;
  /** Transport failures in a row (DNS / TCP / TLS / HTTP/2 socket drop,
   * request timeout).
   * Resets to zero the moment a send lands at Apple with a 2xx, regardless
   * of how many transport failures came before — a recovered network
   * should not carry an old run's bad luck forward. */
  consecutiveTransportFailures: number;
  /** `err.code` / HTTP/2 code from the last failure, surfaced verbatim so
   * the owner sees exactly what Node raised (e.g. `ECONNRESET`,
   * `ERR_HTTP2_PROTOCOL_ERROR`).  Null between failures. */
  lastErrorCode: string | null;
  /** Epoch ms; non-null means at least one phone's lane is intentionally
   * holding its alerts because transport failures exceeded the threshold.
   * The latest of the open circuits, so it reads as "everything is moving
   * again by then".  Null when every circuit is closed. */
  circuitOpenUntil: number | null;
  /** One row per phone the sender knows something about — its own failure
   * run, its own circuit, its own backlog.  Empty when nothing has failed
   * and nothing is queued. */
  devices: PushDeviceHealth[];
  /** True when this sidecar is not going to deliver a push right now, for
   * any reason.  The one field a phone can trust to say "closed-app
   * notifications are off" — `lastSentAt` cannot, because a sender that
   * stopped working an hour ago still has one. */
  pushesOff: boolean;
  /** Why, when `pushesOff`.  Null when pushes are on. */
  pushesOffReason: PushesOffReason | null;
}

interface HealthTracker {
  snapshot(): PushSenderHealth;
  setConfigured(config: ApnsConfig | null): void;
  rejectKey(at: number, reason: string, errorTimestamp?: number): void;
  recordSent(deviceId: string, at: number): void;
  recordError(
    deviceId: string,
    at: number,
    status: number,
    reason?: string,
    failureKind?: ApnsFailureKind,
    errorCode?: string,
    errorTimestamp?: number,
  ): void;
  recordDropped(deviceId: string): void;
  /** A drain pass held back because that phone's circuit is open. */
  recordCircuitDeferred(): void;
  /** Transport-family failures in a row for one phone. */
  transportFailureRun(deviceId: string): number;
  /** HTTP/2 protocol errors in a row for one phone — only `http2_protocol`
   * failures, so timeouts and socket drops never trip the tighter protocol
   * breaker. */
  protocolFailureRun(deviceId: string): number;
  /** True iff this phone's circuit is open — its lane must hold rather than
   * send, and without incrementing `failed`. */
  circuitIsOpen(deviceId: string, at: number): boolean;
  /** When this phone's circuit closes, or null. */
  circuitClosesAt(deviceId: string): number | null;
  /** Open one phone's circuit for 60 seconds.  Used by the watcher when the
   * transport-failure or http2-protocol threshold trips for that phone. */
  openCircuit(deviceId: string, at: number, ms: number): void;
}

export const APNS_CIRCUIT_WINDOW_MS = 60_000;
export const APNS_TRANSPORT_THRESHOLD = 20;
export const APNS_HTTP2_PROTOCOL_THRESHOLD = 5;

/** The failure shapes that mean the request never reached Apple.  These are
 * the only ones the breaker counts: an answer from Apple — a dead token, a
 * rate limit, a refused key — says the connection is fine, and counting it
 * as transport weather is what kept the breaker from ever opening.
 *
 * `http2_protocol` belongs here.  It used to increment the run and then be
 * excluded from the branch that trips, so a GOAWAY arriving on the run's
 * twentieth failure skipped the trip entirely. */
export function isTransportFailure(kind: ApnsFailureKind | undefined): boolean {
  return kind === "transport" || kind === "socket_closed" || kind === "timeout" || kind === "http2_protocol";
}

/** One phone's slice of the sender state. */
interface DeviceCircuit {
  consecutiveTransportFailures: number;
  consecutiveProtocolFailures: number;
  failureKind: ApnsFailureKind;
  lastErrorCode: string | null;
  circuitOpenUntil: number | null;
  dropped: number;
}

function createHealthTracker(
  tokensRegistered: () => number,
  queueDepths: () => Map<string, number>,
  now: () => number,
): HealthTracker {
  let configured = false;
  let production: boolean | null = null;
  let sent = 0;
  let failed = 0;
  let lastSentAt: number | null = null;
  let lastErrorAt: number | null = null;
  let lastError: string | null = null;
  let keyRejected: string | null = null;
  let dropped = 0;
  let circuitDropped = 0;
  let failureKind: ApnsFailureKind = "none";
  let lastErrorCode: string | null = null;
  const perDevice = new Map<string, DeviceCircuit>();

  const state = (deviceId: string): DeviceCircuit => {
    let found = perDevice.get(deviceId);
    if (!found) {
      found = {
        consecutiveTransportFailures: 0,
        consecutiveProtocolFailures: 0,
        failureKind: "none",
        lastErrorCode: null,
        circuitOpenUntil: null,
        dropped: 0,
      };
      perDevice.set(deviceId, found);
    }
    return found;
  };

  const isOpen = (device: DeviceCircuit, at: number): boolean =>
    device.circuitOpenUntil !== null && device.circuitOpenUntil > at;

  return {
    snapshot: () => {
      const at = now();
      const depths = queueDepths();
      const ids = new Set([...perDevice.keys(), ...depths.keys()]);
      const devices: PushDeviceHealth[] = [...ids].map((deviceId) => {
        const device = perDevice.get(deviceId);
        return {
          deviceId,
          failureKind: device?.failureKind ?? "none",
          consecutiveTransportFailures: device?.consecutiveTransportFailures ?? 0,
          lastErrorCode: device?.lastErrorCode ?? null,
          circuitOpenUntil: device && isOpen(device, at) ? device.circuitOpenUntil : null,
          queued: depths.get(deviceId) ?? 0,
          dropped: device?.dropped ?? 0,
        };
      });
      const open = devices.filter((device) => device.circuitOpenUntil !== null);
      const tokens = tokensRegistered();
      // Pushes are off when there is no usable key, when Apple refuses the
      // one we have, or when every phone that holds a token is behind an
      // open circuit.  A quiet fleet with nothing queued is not "off".
      let pushesOffReason: PushesOffReason | null = null;
      if (keyRejected !== null) pushesOffReason = "key-rejected";
      else if (!configured) pushesOffReason = "no-key";
      else if (tokens > 0 && open.length >= tokens) pushesOffReason = "unreachable";
      return {
        configured,
        production,
        tokensRegistered: tokens,
        sent,
        failed,
        lastSentAt,
        lastErrorAt,
        lastError,
        keyRejected,
        dropped,
        circuitDropped,
        failureKind,
        // The worst run across the fleet: the number the owner wants when a
        // single phone's link is the thing that is broken.
        consecutiveTransportFailures: devices.reduce(
          (worst, device) => Math.max(worst, device.consecutiveTransportFailures),
          0,
        ),
        lastErrorCode,
        // The latest of the open circuits, so the page can say when
        // everything is moving again rather than when the first one is.
        circuitOpenUntil: open.reduce<number | null>(
          (latest, device) => (latest === null || (device.circuitOpenUntil ?? 0) > latest ? device.circuitOpenUntil : latest),
          null,
        ),
        devices,
        pushesOff: pushesOffReason !== null,
        pushesOffReason,
      };
    },
    setConfigured: (config) => {
      configured = config !== null;
      production = config ? config.production : null;
      // A key that loads again clears the rejection: the file changed, so
      // the verdict on the old one no longer describes what we hold.
      if (config) keyRejected = null;
    },
    rejectKey: (at, reason, errorTimestamp) => {
      configured = false;
      production = null;
      keyRejected = reason;
      lastErrorAt = at;
      // Apple stamps InvalidProviderToken rejections with a `timestamp`
      // field the debug page asks for verbatim.  Surface it on the health
      // so the owner does not have to dig through the log.
      if (reason === INVALID_PROVIDER_TOKEN && typeof errorTimestamp === "number") {
        lastError = `${reason} (timestamp=${errorTimestamp})`;
      } else {
        lastError = reason;
      }
    },
    recordSent: (deviceId, at) => {
      sent += 1;
      lastSentAt = at;
      // A successful send resets THIS phone's transport-failure run and
      // closes its circuit.  Even a 200 against the test seam means the
      // round trip worked, which is the only signal the circuit reacts to.
      // Another phone's run is untouched: its link may still be broken.
      const device = state(deviceId);
      device.consecutiveTransportFailures = 0;
      device.consecutiveProtocolFailures = 0;
      device.failureKind = "none";
      device.lastErrorCode = null;
      device.circuitOpenUntil = null;
      failureKind = "none";
      lastErrorCode = null;
    },
    recordError: (deviceId, at, status, reason, kind, code, errorTimestamp) => {
      failed += 1;
      lastErrorAt = at;
      failureKind = kind ?? "transport";
      const device = state(deviceId);
      device.failureKind = failureKind;
      // A transport-layer failure increments THIS phone's run; an HTTP-layer
      // Apple verdict zeroes it — but only for the phone it was about.  One
      // shared counter, reset by any device's 400, is why the breaker shipped
      // in #525 could never reach its threshold.
      if (isTransportFailure(failureKind)) {
        device.consecutiveTransportFailures += 1;
      } else {
        device.consecutiveTransportFailures = 0;
      }
      device.consecutiveProtocolFailures =
        failureKind === "http2_protocol" ? device.consecutiveProtocolFailures + 1 : 0;
      device.lastErrorCode = code ?? null;
      lastErrorCode = code ?? null;
      let formatted: string;
      if (reason) {
        formatted = `${status} ${reason}`;
        // Apple stamps a `timestamp` on the two verdicts that carry one:
        // 403 InvalidProviderToken and 410 Unregistered — the token's
        // invalidation time, which the debug page asks for verbatim.
        // Surface it on the health so the owner does not have to dig
        // through the log.
        if ((failureKind === "key_fault" || status === 410) && typeof errorTimestamp === "number") {
          formatted = `${formatted} (timestamp=${errorTimestamp})`;
        }
      } else {
        formatted = String(status);
        if (status === 410 && typeof errorTimestamp === "number") {
          formatted = `${formatted} (timestamp=${errorTimestamp})`;
        }
      }
      lastError = formatted;
    },
    recordDropped: (deviceId) => {
      dropped += 1;
      state(deviceId).dropped += 1;
    },
    recordCircuitDeferred: () => {
      circuitDropped += 1;
    },
    transportFailureRun: (deviceId) => perDevice.get(deviceId)?.consecutiveTransportFailures ?? 0,
    protocolFailureRun: (deviceId) => perDevice.get(deviceId)?.consecutiveProtocolFailures ?? 0,
    circuitIsOpen: (deviceId, at) => {
      const device = perDevice.get(deviceId);
      return device !== undefined && isOpen(device, at);
    },
    circuitClosesAt: (deviceId) => perDevice.get(deviceId)?.circuitOpenUntil ?? null,
    openCircuit: (deviceId, at, ms) => {
      state(deviceId).circuitOpenUntil = at + ms;
    },
  };
}

// --- Key-fault persistence ------------------------------------------------
//
// `InvalidProviderToken` means Apple refuses the signing KEY, not this
// request: a fresh signature earns the identical answer, forever.  Holding
// that verdict in a process-local `let` meant every Electron relaunch
// resumed full-rate sends against a key Apple had already refused — two
// days of them, one failure every forty seconds, with every surface still
// reporting pushes as on.
//
// So the verdict goes on disk, beside the device registry, keyed to the key
// FILE: replacing the file is what clears it, and nothing else does.  What
// is written is a fingerprint — path, mtime, size — plus Apple's own words.
// Never a byte of the key.

export interface PersistedKeyFault {
  /** Apple's reason string, e.g. `InvalidProviderToken`. */
  reason: string;
  /** When the verdict was recorded, epoch ms. */
  at: number;
  /** `apnsKeyStamp()` at the moment of the fault.  A different value means a
   * different file, which is the only thing that turns pushes back on. */
  keyStamp: string | null;
  /** Apple's own `timestamp` field, for the debug page. */
  errorTimestamp?: number;
}

/** Where a key fault is remembered across restarts.  A seam rather than a
 * bare file path so a test can hold one in memory, and so a watcher given
 * no store behaves exactly as it did before — in memory, for this process
 * only. */
export interface KeyFaultStore {
  load(): PersistedKeyFault | null;
  save(fault: PersistedKeyFault | null): void;
}

/** The file name, beside `devices.json` rather than inside it: the registry
 * rewrites its whole document on every change, so a second key living in
 * that object would be erased by the next pairing. */
export const KEY_FAULT_FILE = "push-key-fault.json";

/** The production store.  Every failure is swallowed: a full or read-only
 * disk is a reason for the fault to be forgotten at the next restart, never
 * a reason to take down the sidecar every paired phone depends on. */
export function diskKeyFaultStore(dir: string = DATA_DIR): KeyFaultStore {
  const file = join(dir, KEY_FAULT_FILE);
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedKeyFault>;
        if (typeof parsed?.reason !== "string") return null;
        return {
          reason: parsed.reason,
          at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0,
          keyStamp: typeof parsed.keyStamp === "string" ? parsed.keyStamp : null,
          errorTimestamp: typeof parsed.errorTimestamp === "number" ? parsed.errorTimestamp : undefined,
        };
      } catch {
        return null;
      }
    },
    save: (fault) => {
      try {
        if (fault === null) {
          rmSync(file, { force: true });
          return;
        }
        // 0700, the same posture the registry keeps: this file names a path
        // on this machine, and nothing else on it needs to read that.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileAtomic(file, JSON.stringify(fault, null, 2));
      } catch {
        /* the fault still holds in memory; it just will not survive a restart */
      }
    },
  };
}

// --- The watcher ----------------------------------------------------------

/** How often to look for a .p8 that was not there at startup, or one that
 * has been replaced since.  Someone who drops a key in afterwards, or
 * rotates one, should get working pushes without restarting the sidecar,
 * and a five-minute stat() costs nothing. */
export const APNS_KEY_RECHECK_MS = 5 * 60 * 1000;

/** How many notifications may wait for ONE phone before the oldest is
 * dropped.  A phone Apple is rate-limiting must not be able to grow an
 * unbounded backlog inside a sidecar that runs for weeks, and when a
 * backlog does form the newest alerts are the ones worth keeping. */
export const APNS_MAX_QUEUED_PER_DEVICE = 8;

/** How often a link that keeps failing is allowed to say so.  A broken
 * transport produced 6,003 identical log lines over two days — one per
 * attempt cycle, forever — because transport failures were the one outcome
 * class with no dedupe.  The first failure of a kind is logged; after that
 * one summary line carries the count. */
export const APNS_TRANSPORT_SUMMARY_MS = 10 * 60 * 1000;

export interface PushWatch {
  /** Stop tailing the harness and sending. */
  stop(): void;
  /** What to show on a status page.  Never key material. */
  health(): PushSenderHealth;
}

/** Watch harness SSE on loopback and APNs-wake phones that are not streaming. */
export function watchHarnessNotifications(options: {
  harnessPort: number;
  connectedIds: () => string[];
  tokensForDisconnected: () => { deviceId: string; token: string }[];
  send?: typeof sendApnsAlert;
  /** Explicit config pins the sender; `undefined` discovers it from disk and
   * keeps looking until it appears, then watches for it changing. */
  config?: ApnsConfig | null;
  loadConfig?: () => ApnsConfig | null;
  /** Fingerprint of the key file, so a rotated key is noticed. */
  keyStamp?: () => string | null;
  /** Retire a token Apple has rejected.  The token is named so a phone
   * that registered a replacement while this send was in flight keeps it. */
  forgetToken?: (deviceId: string, token: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  keyRecheckMs?: number;
  maxQueuedPerDevice?: number;
  /** Where a key fault is remembered across restarts.  The sidecar hands in
   * `diskKeyFaultStore()`; a watcher without one keeps the fault in memory
   * for this process only, which is what a test wants. */
  keyFaultStore?: KeyFaultStore;
  /** Test seam: how a lane holding alerts behind an open circuit schedules
   * its retry.  Production uses an unref'd `setTimeout`; a test with a fake
   * clock hands in something it can fire itself.  Returns its own cancel. */
  scheduleRetry?: (run: () => void, ms: number) => () => void;
}): PushWatch {
  const fixed = options.config;
  const loadConfig = options.loadConfig ?? loadApnsConfig;
  const keyStamp = options.keyStamp ?? (() => apnsKeyStamp());
  const now = options.now ?? Date.now;
  const recheckMs = options.keyRecheckMs ?? APNS_KEY_RECHECK_MS;
  const maxQueued = Math.max(1, options.maxQueuedPerDevice ?? APNS_MAX_QUEUED_PER_DEVICE);
  const keyFaultStore = options.keyFaultStore ?? null;
  const scheduleRetry =
    options.scheduleRetry ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return () => clearTimeout(handle);
    });

  // One queue per device, drained on its own chain.  A phone Apple is rate
  // limiting sleeps out its own Retry-After without holding up any other
  // phone, and each phone still sees its notifications in order.  Declared
  // here, above the pinned-off early return, because the health snapshot
  // reads the queue depths and a pinned-off watcher still answers health().
  const queues = new Map<string, DeviceQueue>();
  const queueDepth = (queue: DeviceQueue): number => queue.blocking.length + queue.normal.length;

  const health = createHealthTracker(
    () => options.tokensForDisconnected().length,
    () => new Map([...queues].map(([deviceId, queue]) => [deviceId, queueDepth(queue)])),
    () => now(),
  );

  // An explicit null means "this process does not send pushes" — the desktop
  // saying so, or a test.  Honour it without holding a stream open.
  if (fixed === null) {
    health.setConfigured(null);
    return { stop: () => {}, health: health.snapshot };
  }

  const send = options.send ?? sendApnsAlert;
  // The harness SSE stream is HTTP/1.1 loopback; native `fetch` is the
  // right choice for it.  APNs pushes go through the http2 path inside
  // `sendApnsAlert`, not here — the watcher never calls `fetch` against
  // an APNs host.
  const fetchImpl = options.fetchImpl ?? fetch;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let retry: (() => void) | null = null;
  let discovered: ApnsConfig | null = fixed ?? null;
  let discoveredStamp: string | null = null;
  let warnedMissing = false;
  /** Set when Apple refused the key itself.  Only a different key file
   * clears it — a fresh signature from the same one earns the same answer. */
  let keyFault = false;
  /** The newest SSE id seen, so a reconnect resumes rather than silently
   * skipping every notification raised while we were away. */
  let lastEventId: string | null = null;
  /** One line per device and failure, so a phone with a dead token does not
   * write a log line for every notification the fleet ever sends. */
  const loggedFailures = new Set<string>();
  /** APNs host → the key fingerprint (sha256[:16] of the .p8) we last
   * built an http2 session with.  Used to rebuild the session when the
   * watcher reloads a rotated key — a TLS session tied to the old key is
   * not safe to reuse, even with the same keyId. */
  const sessionFingerprints = new Map<string, string>();
  /** What each phone's circuit has already been announced for, so a
   * 60-second blip does not log a warning every drain iteration.  The key is
   * the device and the CAUSE and nothing else: it used to carry the failure
   * count, which only ever resets on success, so no key ever matched twice,
   * a warning was logged on every trip, and the set grew without bound. */
  const loggedCircuitOpen = new Set<string>();
  /** Phones whose full backlog has already been reported once. */
  const loggedQueueFull = new Set<string>();
  /** Per phone: the transport failure being lived through right now, so a
   * broken link writes one line for the state change and then one summary
   * line every ten minutes instead of one line per attempt forever. */
  const transportLogs = new Map<string, { key: string; count: number; since: number; lastLoggedAt: number }>();
  /** Per phone: cancel the pending retry of a lane held behind an open
   * circuit, so stop() leaves no timer behind. */
  const circuitRetries = new Map<string, () => void>();

  if (fixed) health.setConfigured(fixed);

  /** True the first time this exact failure is seen for this device. */
  const firstTime = (key: string): boolean => {
    if (loggedFailures.has(key)) return false;
    loggedFailures.add(key);
    return true;
  };

  /** One line when a phone's transport starts failing, and one summary line
   * every ten minutes while it keeps failing the same way.  Keyed on the
   * device and the failure shape, so a link that changes its mind (a DNS
   * failure becoming a GOAWAY) still says so once. */
  const noteTransportFailure = (deviceId: string, at: number, result: ApnsSendResult) => {
    const kind = result.failureKind ?? "transport";
    const key = `${kind}:${result.errorCode ?? result.reason ?? ""}`;
    const entry = transportLogs.get(deviceId);
    if (!entry || entry.key !== key) {
      transportLogs.set(deviceId, { key, count: 1, since: at, lastLoggedAt: at });
      console.warn(
        `companion: APNs ${kind}${result.errorCode ? ` (${result.errorCode})` : ""} — a phone's push connection is failing.  ` +
          `Further identical failures are summarised every ${APNS_TRANSPORT_SUMMARY_MS / 60_000} minutes.`,
      );
      return;
    }
    entry.count += 1;
    if (at - entry.lastLoggedAt < APNS_TRANSPORT_SUMMARY_MS) return;
    entry.lastLoggedAt = at;
    console.warn(
      `companion: APNs ${entry.key} — ${entry.count} transport failures for one phone over ` +
        `${Math.max(1, Math.round((at - entry.since) / 60_000))} min.  Still retrying.`,
    );
  };

  /** A phone's link came back.  Say so once if it had been failing, and
   * forget every key that was deduping its failures — otherwise the next
   * outage would be silent, which is the opposite mistake. */
  const clearTransportLog = (deviceId: string) => {
    const entry = transportLogs.get(deviceId);
    if (!entry) return;
    transportLogs.delete(deviceId);
    if (entry.count > 1) {
      console.log(`companion: APNs delivery recovered for a phone after ${entry.count} transport failures`);
    }
  };

  /** Everything a phone's success should make us forget. */
  const forgetFailureLogs = (deviceId: string) => {
    clearTransportLog(deviceId);
    loggedCircuitOpen.delete(`${deviceId}:transport`);
    loggedCircuitOpen.delete(`${deviceId}:http2_protocol`);
    loggedCircuitOpen.delete(`${deviceId}:defer`);
    loggedQueueFull.delete(deviceId);
  };

  const onKeyFault = (config: ApnsConfig, reason: string, errorTimestamp?: number) => {
    if (keyFault) return;
    keyFault = true;
    // Pin the verdict to the file that is on disk right now: only a
    // DIFFERENT file clears it, here and across restarts.
    const stamp = keyStamp();
    if (stamp !== null) discoveredStamp = stamp;
    // `discovered` is deliberately kept.  Nulling it here is what used to
    // make a later rotation skip the key-identity comparison in
    // `refreshConfig`, so the replacement .p8 was signed against the
    // provider token cached for the key Apple had just refused — and was
    // refused in turn, permanently.  The refused key's token and its TLS
    // sessions are worthless either way, so drop them now.
    invalidateProviderToken(config);
    dropHttp2Sessions();
    sessionFingerprints.clear();
    const at = now();
    health.rejectKey(at, reason, errorTimestamp);
    keyFaultStore?.save({ reason, at, keyStamp: discoveredStamp, errorTimestamp });
    console.warn(`companion: APNs refused the signing key (${reason}); pushes are off until the key file changes`);
    // Leave the stream so the pump re-enters the key check rather than
    // sending the same doomed request for every notification that follows.
    abort?.abort();
  };

  /** Open one phone's circuit breaker.  Called when that phone's transport
   * failures exceed the threshold OR when its http2_protocol errors cluster
   * — a hot loop burning provider-token re-signs against an unreachable
   * gateway is what we are guarding against.  Logged once per phone per
   * cause, and that key is cleared by the phone's next success. */
  const tripCircuit = (deviceId: string, host: string, cause: "transport" | "http2_protocol", detail: string) => {
    health.openCircuit(deviceId, now(), APNS_CIRCUIT_WINDOW_MS);
    const key = `${deviceId}:${cause}`;
    if (loggedCircuitOpen.has(key)) return;
    loggedCircuitOpen.add(key);
    console.warn(`companion: APNs circuit open for ${APNS_CIRCUIT_WINDOW_MS / 1000}s after ${detail} on ${host}`);
  };

  /** Come back to a lane that is holding alerts behind an open circuit.
   * Without this the backlog would wait for an unrelated notification to
   * that same phone — which for a blocking approval is exactly the delay
   * the lane exists to prevent. */
  const scheduleCircuitRetry = (deviceId: string, ms: number) => {
    if (circuitRetries.has(deviceId)) return;
    const cancel = scheduleRetry(() => {
      circuitRetries.delete(deviceId);
      const queue = queues.get(deviceId);
      if (stopped || !queue || queue.running || queueDepth(queue) === 0) return;
      void drain(deviceId, queue);
    }, ms);
    circuitRetries.set(deviceId, cancel);
  };

  /** Look at the key file and reload when it has changed.  Runs on a timer
   * rather than only when the stream reconnects: a sidecar whose harness
   * stays up for days never reconnects, and a key dropped in or rotated
   * under it would otherwise go unnoticed for exactly as long. */
  const refreshConfig = (): ApnsConfig | null => {
    const stamp = keyStamp();
    if (keyFault) {
      // Apple refuses what is on disk.  Only a different file can help.
      if (stamp === null || stamp === discoveredStamp) return null;
      keyFault = false;
      keyFaultStore?.save(null);
      console.log("companion: the APNs key file changed; closed-app phone wake is being tried again");
      if (fixed) {
        // A pinned config cannot be reloaded, but the key file under it
        // changed: the cached provider token and the TLS sessions that were
        // built for the refused key must not be reused against the new one.
        health.setConfigured(fixed);
        invalidateProviderToken(fixed);
        dropHttp2Sessions();
        sessionFingerprints.clear();
        resumeIdleQueues();
      }
    }
    if (fixed) {
      discoveredStamp = stamp;
      return fixed;
    }
    if (discovered && stamp !== null && stamp === discoveredStamp) {
      // The same file as last time: keep the config, and the provider token
      // cached against it.
      return discovered;
    }
    const loaded = loadConfig();
    // Whatever is on disk now may not be what the cached token was signed
    // with.  Compare key identity rather than the file stamp: a .p8 rewritten
    // with identical bytes — a secrets sync, a backup restore — is the same
    // key, and throwing away its cached provider token would spend one of
    // Apple's once-per-twenty-minutes re-signs for nothing.
    const previousKey = discovered ? providerTokenKey(discovered) : null;
    const nextKey = loaded ? providerTokenKey(loaded) : null;
    if (previousKey && nextKey && previousKey !== nextKey) {
      // The key changed.  Forget the cached provider token and force the
      // http2 session cache to rebuild on the next send — a TLS session
      // tied to the old key is not safe to reuse against the new one.
      invalidateProviderToken(discovered!);
      dropHttp2Sessions();
      sessionFingerprints.clear();
    }
    discovered = loaded;
    discoveredStamp = stamp;
    health.setConfigured(discovered);
    // A usable key again.  Anything stranded mid-drain when the old key
    // faulted goes out now, rather than sitting in memory until some
    // unrelated notification for that same phone happens to restart its
    // queue — which for a blocking approval is the whole point of the lane.
    if (discovered) resumeIdleQueues();
    if (!discovered && !warnedMissing) {
      warnedMissing = true;
      console.warn("companion: APNs key missing; closed-app phone wake is off until it appears");
    }
    return discovered;
  };

  /** What to sign with right now.  Read per send rather than captured when
   * the stream opened, so a key replaced mid-stream is used immediately and
   * a rejected one stops being used immediately. */
  const activeConfig = (): ApnsConfig | null => {
    if (keyFault) return null;
    return fixed ?? discovered;
  };

  // A key fault Apple has already delivered survives this process.  Without
  // this, every Electron relaunch resumed full-rate sends against a key
  // Apple had refused days earlier — and every surface, including the
  // phone's own settings row, went on reporting pushes as on.
  const persistedFault = keyFaultStore?.load() ?? null;
  if (persistedFault) {
    const stamp = keyStamp();
    if (stamp !== null && stamp === persistedFault.keyStamp) {
      keyFault = true;
      discoveredStamp = stamp;
      health.rejectKey(persistedFault.at, persistedFault.reason, persistedFault.errorTimestamp);
      console.warn(
        `companion: APNs pushes stay off — Apple refused this signing key (${persistedFault.reason}) ` +
          `and the key file has not changed since.  Replace ${apnsKeyPath()} to turn them back on.`,
      );
    } else {
      // A different file, or no file at all: the verdict was about a key we
      // no longer hold, so it has nothing left to say.
      keyFaultStore?.save(null);
    }
  }

  const keyTimer = setInterval(() => {
    refreshConfig();
  }, recheckMs);
  keyTimer.unref?.();

  /** Sleep, but wake immediately when stop() is called. */
  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      retry = resolve;
      timer = setTimeout(() => {
        retry = null;
        resolve();
      }, ms);
    });

  interface QueuedAlert {
    token: string;
    alert: ApnsAlert;
  }

  interface DeviceQueue {
    /** Approvals and questions — someone is blocked on these. */
    blocking: QueuedAlert[];
    /** Reports, in arrival order. */
    normal: QueuedAlert[];
    running: boolean;
  }

  // The circuit is checked by `drain` BEFORE it takes an alert off a lane,
  // not here: this function is only reached for an alert that is already
  // detached from its queue, and skipping it there is what used to destroy
  // a backlog — including a blocking approval — in a single loop.
  const sendOne = async (config: ApnsConfig, deviceId: string, token: string, alert: ApnsAlert) => {
    const at = now();
    let result: ApnsSendResult;
    try {
      result = await send(config, token, alert);
    } catch (err) {
      const info = inspectTransportError(err);
      const kind = classifyTransportError(info);
      health.recordError(deviceId, at, 0, TRANSPORT_FAILURE_REASON, kind, info.code || undefined);
      noteTransportFailure(deviceId, at, {
        ok: false,
        status: 0,
        reason: TRANSPORT_FAILURE_REASON,
        attempts: 0,
        failureKind: kind,
        errorCode: info.code || undefined,
      });
      return;
    }
    // Everything below is bookkeeping, and some of it writes to disk:
    // `forgetToken` persists the device registry.  `drain` is fired and
    // forgotten, so a throw here would be an unhandled rejection, and Node's
    // default `--unhandled-rejections=throw` turns that into an exit — one
    // full disk taking down the proxy every paired phone depends on.
    try {
      recordOutcome(config, deviceId, token, result);
    } catch {
      console.warn("companion: APNs bookkeeping after a send failed");
    }
  };

  const recordOutcome = (config: ApnsConfig, deviceId: string, token: string, result: ApnsSendResult) => {
    if (result.ok) {
      health.recordSent(deviceId, now());
      forgetFailureLogs(deviceId);
      return;
    }
    const at = now();
    const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
    health.recordError(
      deviceId,
      at,
      result.status,
      result.reason,
      result.failureKind,
      result.errorCode,
      result.errorTimestamp,
    );
    // Trip THIS phone's circuit when the failure shape is what we open on.
    // Counted after recording, so the run below includes the failure that
    // tripped it.  `http2_protocol` is part of the transport family here:
    // excluding it from the branch meant a GOAWAY landing on the twentieth
    // failure of a run skipped the trip and started the count again.
    const kind = result.failureKind ?? "transport";
    if (isTransportFailure(kind)) {
      const transportRun = health.transportFailureRun(deviceId);
      const protocolRun = health.protocolFailureRun(deviceId);
      if (transportRun >= APNS_TRANSPORT_THRESHOLD) {
        tripCircuit(deviceId, host, "transport", `${transportRun} transport failures in a row`);
      } else if (kind === "http2_protocol" && protocolRun >= APNS_HTTP2_PROTOCOL_THRESHOLD) {
        tripCircuit(deviceId, host, "http2_protocol", `${protocolRun} HTTP/2 protocol errors in a row`);
      }
    }

    // The key, not the phone: every device is about to fail the same way.
    if (result.reason === INVALID_PROVIDER_TOKEN) {
      // Only when the key that signed THIS request is still the one in use.
      // A rotation can land while a request signed with the old key is in
      // flight, and reading that request's rejection as a verdict on the
      // replacement would disable the replacement — then hold it disabled,
      // because the fault only clears for a key file that differs from the
      // recorded stamp and the file on disk is already the replacement.
      //
      // Key identity, not object identity: `refreshConfig` builds a fresh
      // config object whenever the file's mtime or size changes, so an
      // identity check would read a .p8 rewritten with the same bytes as a
      // rotation and wave through a rejection of the key still in use.
      const current = fixed ?? discovered;
      if (current !== null && providerTokenKey(config) === providerTokenKey(current)) {
        onKeyFault(config, result.reason, result.errorTimestamp);
      } else if (!keyFault) {
        console.warn("companion: APNs refused a signing key that has since been replaced; the replacement stands");
      }
      return;
    }

    // Apple has retired this token — 410, or a 400 that means the same
    // thing.  Drop it and let the phone register a new one; anything still
    // queued for it would earn the identical answer.
    if (tokenIsDead(result.status, result.reason)) {
      // Name the token, so a phone that registered a replacement while this
      // send was in flight does not lose the new one to the old one's 410.
      options.forgetToken?.(deviceId, token);
      const queue = queues.get(deviceId);
      if (queue) {
        queue.blocking = queue.blocking.filter((entry) => entry.token !== token);
        queue.normal = queue.normal.filter((entry) => entry.token !== token);
      }
      if (firstTime(`${deviceId}:dead:${result.reason ?? result.status}`)) {
        console.warn(
          `companion: APNs ${result.status}${result.reason ? ` ${result.reason}` : ""} — dropped that phone's push token; it will register a new one`,
        );
      }
      return;
    }

    // 400 and 403 are configuration, not weather: the same push will fail
    // the same way forever, so say it once and stay quiet.
    if (result.status === 400 || result.status === 403) {
      if (!firstTime(`${deviceId}:${result.status}:${result.reason ?? ""}`)) return;
    }
    // A transport failure never reached Apple, so there is no verdict to
    // report and no reason to report the same weather every forty seconds.
    // This was the one outcome class that fell through to an unconditional
    // log line, and on a link that stayed down it wrote 6,003 of them.
    if (isTransportFailure(kind) || result.status === 0) {
      noteTransportFailure(deviceId, at, result);
      return;
    }
    console.warn(`companion: APNs ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
  };

  const drain = async (deviceId: string, queue: DeviceQueue) => {
    queue.running = true;
    try {
      while (!stopped) {
        // Blocking first, always: an approval queued behind a rate-limited
        // report would wait out that report's whole retry ladder, which is
        // the one delay this queue exists to prevent.
        // The key first, the alert second.  Shifting before the check
        // detaches an alert from the queue with nothing holding it, so a key
        // that faults during the send immediately before would silently
        // swallow whatever was queued behind it — uncounted, and unsent.
        const config = activeConfig();
        if (!config) break;
        // Nothing left is the ordinary way out, and it comes before the
        // circuit check so an empty lane never reports itself as held.
        if (queueDepth(queue) === 0) break;
        // The circuit, also before the shift, and for the same reason.  An
        // open circuit is Apple being briefly unreachable; every alert stays
        // exactly where it is and goes out when the circuit closes.  Taking
        // them off the lane and discarding them emptied a whole backlog in
        // one loop, and a blocking approval caught by that was never
        // delivered at all.
        const at = now();
        if (health.circuitIsOpen(deviceId, at)) {
          health.recordCircuitDeferred();
          const until = health.circuitClosesAt(deviceId) ?? at;
          if (!loggedCircuitOpen.has(`${deviceId}:defer`)) {
            loggedCircuitOpen.add(`${deviceId}:defer`);
            console.warn(
              `companion: APNs is unreachable — holding ${queueDepth(queue)} notification(s) for a phone ` +
                `until ${new Date(until).toISOString()}`,
            );
          }
          scheduleCircuitRetry(deviceId, Math.max(1, until - at));
          break;
        }
        loggedCircuitOpen.delete(`${deviceId}:defer`);
        const next = queue.blocking.shift() ?? queue.normal.shift();
        if (!next) break;
        await sendOne(config, deviceId, next.token, next.alert);
      }
    } catch {
      // Nothing here may reject: this chain is started with `void`.
      console.warn("companion: APNs queue drain failed");
    } finally {
      queue.running = false;
      if (queueDepth(queue) === 0) queues.delete(deviceId);
    }
  };

  /** Restart every queue that still holds something and is not draining.
   * A key fault breaks the drain loop with entries left behind and nothing
   * to restart it — only a later notification for that same phone would, so
   * an approval queued at the moment the key failed would otherwise arrive
   * hours late, behind an unrelated report. */
  const resumeIdleQueues = () => {
    for (const [deviceId, queue] of [...queues]) {
      if (!queue.running && queueDepth(queue) > 0) void drain(deviceId, queue);
    }
  };

  const deliver = (
    notification: {
      title?: string;
      body?: string;
      kind?: string;
      threadId?: string;
      botId?: string;
      requestId?: string;
      tool?: string;
    },
    seq?: number,
  ) => {
    const connected = new Set(options.connectedIds());
    const alert: ApnsAlert = {
      title: notification.title ?? "BotFleet",
      body: notification.body ?? "",
      kind: notification.kind,
      threadId: notification.threadId,
      botId: notification.botId,
      requestId: notification.requestId,
      tool: notification.tool,
      seq,
    };
    const blocking = alertIsBlocking(alert.kind);
    for (const row of options.tokensForDisconnected()) {
      if (connected.has(row.deviceId)) continue;
      let queue = queues.get(row.deviceId);
      if (!queue) {
        queue = { blocking: [], normal: [], running: false };
        queues.set(row.deviceId, queue);
      }
      (blocking ? queue.blocking : queue.normal).push({ token: row.token, alert });
      if (queueDepth(queue) > maxQueued) {
        // Drop a report before an approval, whatever the order they arrived
        // in.  A stale report is worth nothing; a dropped approval leaves a
        // bot waiting on an answer nobody was ever asked for.  This cap is
        // what keeps a lane holding alerts through an outage bounded: the
        // count lands on that phone's own row on the health page.
        const lane = queue.normal.length ? queue.normal : queue.blocking;
        lane.shift();
        health.recordDropped(row.deviceId);
        if (!loggedQueueFull.has(row.deviceId)) {
          loggedQueueFull.add(row.deviceId);
          console.warn(
            `companion: APNs backlog for a phone is full at ${maxQueued}; dropping its oldest notifications`,
          );
        }
      }
      if (!queue.running) void drain(row.deviceId, queue);
    }
  };

  const pump = async () => {
    while (!stopped) {
      const config = refreshConfig();
      if (!config) {
        await pause(recheckMs);
        continue;
      }
      abort = new AbortController();
      try {
        // Resume where the last connection stopped.  Without this every
        // notification raised during a harness restart, or during our own
        // four-second retry, is simply never pushed.
        const headers = new Headers({ accept: "text/event-stream" });
        if (lastEventId) headers.set("last-event-id", lastEventId);
        const res = await fetchImpl(`http://127.0.0.1:${options.harnessPort}/api/events`, {
          headers,
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const rows = part.split("\n");
            const id = rows.find((row) => row.startsWith("id:"));
            if (id) lastEventId = id.slice(3).trim();
            const line = rows.find((row) => row.startsWith("data:"));
            if (!line) continue;
            let frame: {
              kind?: string;
              cursor?: string;
              /** Hello only: whether the harness could replay what we missed. */
              resumed?: boolean;
              /** The stream position of this frame, stamped by `broadcast`. */
              seq?: number;
              notification?: {
                title?: string;
                body?: string;
                kind?: string;
                threadId?: string;
                botId?: string;
                requestId?: string;
                tool?: string;
              };
            };
            try {
              // SAFETY: the frame came off the harness's own loopback stream
              // and the assertion grants no behaviour — every field below is
              // optional, and each one is defaulted or checked before use.
              frame = JSON.parse(line.slice(5).trim()) as typeof frame;
            } catch {
              continue;
            }
            // The harness's opening frame carries the stream's current
            // position but no `id:` line of its own, and on a COLD stream
            // that is the baseline: without taking it, a link that drops
            // before the first real event reconnects with no cursor at all,
            // and every notification raised in between is never pushed.
            //
            // On a RESUMED stream it is the opposite — the cursor is the
            // tip, and everything we missed is replayed after it.  Adopting
            // it there would jump us past the whole gap if the link died
            // before a replayed frame was read, skipping those pushes
            // forever.  Let the replayed `id:` lines advance the cursor
            // instead, which is exactly what the iOS client does with the
            // same frame.  A harness too old to send `resumed` replayed
            // nothing either, so absent reads as cold.
            if (frame.kind === "hello" && frame.cursor && frame.resumed !== true) {
              lastEventId = frame.cursor;
            }
            if (frame.kind !== "notify" || !frame.notification) continue;
            // Returns at once: the sends happen on each device's own queue,
            // so a reader that has to keep up with the harness never waits
            // on one phone's retry.
            deliver(frame.notification, frame.seq);
          }
        }
      } catch {
        /* harness down or stop() — retry unless we were asked to quit */
      }
      if (stopped) return;
      await pause(4000);
    }
  };
  void pump();
  return {
    stop: () => {
      stopped = true;
      abort?.abort();
      if (timer) clearTimeout(timer);
      clearInterval(keyTimer);
      retry?.();
      for (const cancel of circuitRetries.values()) cancel();
      circuitRetries.clear();
      transportLogs.clear();
      loggedCircuitOpen.clear();
      loggedQueueFull.clear();
      for (const queue of queues.values()) {
        queue.blocking.length = 0;
        queue.normal.length = 0;
      }
      queues.clear();
      // Close the persistent http2 session on the way out.  Tests do not
      // expect open sockets across runs.
      dropHttp2Sessions();
      sessionFingerprints.clear();
    },
    health: health.snapshot,
  };
}
