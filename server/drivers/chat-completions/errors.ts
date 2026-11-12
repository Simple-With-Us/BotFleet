// Typed HTTP-error classification for chat-completions drivers (MiniMax
// today; openai-compat and grok once they land on the shared base in a
// later PR).  A raw `HTTP 401` string tells a user nothing actionable —
// mapping it onto the same ProviderErrorCode union the ACP drivers already
// use (see server/drivers/acp/dsh.ts's classifyDshError for the reference
// mapping) is what lets a revoked key reach the setup affordance instead of
// a red chip mid-turn, and lets model-fallback.ts consult the failover
// chain on a real outage instead of only on a regex match over chip prose.
import type { ProviderErrorCode } from "../../contracts.ts";
import { ProviderError } from "../../contracts.ts";
import { RETRY_MAX_ATTEMPTS } from "../retry.ts";

export interface HttpErrorClassification {
  code: ProviderErrorCode;
  /** A failure the user fixes by reconfiguring credentials, not by
   *  retrying.  Only true for invalid_credentials — matching the ACP
   *  drivers' `needsAuth` convention in acp/core.ts — so `runtime.error`
   *  carries `setup: true` and the bot goes dead with a setup affordance
   *  instead of idling behind a red chip. */
  setup: boolean;
}

/** Maps an HTTP status from a chat-completions endpoint onto the shared
 *  ProviderErrorCode union.  Returns undefined for a status this driver
 *  family has no opinion on (400, 422, a stray 3xx, …) — those keep
 *  today's generic "error" exit rather than being force-fit into a code. */
export function classifyHttpError(status: number): HttpErrorClassification | undefined {
  if (status === 401 || status === 403) return { code: "invalid_credentials", setup: true };
  if (status === 402 || status === 429) return { code: "quota_or_region_restriction", setup: false };
  if (status === 404) return { code: "model_catalog_outage", setup: false };
  if (status >= 500 && status <= 599) return { code: "upstream_outage", setup: false };
  return undefined;
}

/** Builds the error a driver's `complete()` throws for a non-2xx chat-
 *  completions response.  A classified status becomes a `ProviderError`
 *  loop.ts keys off of — `error:<code>` as the terminal stopReason, and
 *  `runtime.error.setup` for invalid_credentials.  An unmapped status stays
 *  a plain Error, exactly like before this file existed.
 *
 *  `headers` is optional and additive: pass the response's own headers and
 *  the error also carries the status and the parsed `Retry-After` (see
 *  `httpFailureOf`), which is what lets the loop retry a 502 or honour a
 *  429's cool-down instead of inferring a policy from the message text.
 *  Omitting them costs only the retry, never the classification — the
 *  status is recorded either way. */
export function httpErrorFor(status: number, body: string, headers?: HeaderReader): Error {
  const message = `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  const classification = classifyHttpError(status);
  const error = classification ? new ProviderError(classification.code, message) : new Error(message);
  const failure: HttpFailure = { status };
  const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
  if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs;
  HTTP_FAILURES.set(error, failure);
  return error;
}

// ── retry policy ───────────────────────────────────────────────────────
// A status is not only a name for a failure — it is also the answer to
// "is trying again a reasonable thing to do".  That second question lives
// here, next to the first, so the loop that acts on it never has to
// re-derive a status's meaning from prose.  The ACTING — the attempt
// loop, the sleep, the turn.retrying event, the budget guard — is
// loop.ts's; this file only says what a status is worth.

/** Ceiling on a provider's own `Retry-After`.  Honouring the header is the
 *  point — a provider knows its own cool-down better than a fixed schedule
 *  does — but a 429 asking for five minutes is a wait no chat turn should
 *  serve: the person is watching a spinner, and a provider that has
 *  asked for silence would trip the round's 120s idle clock anyway.  Past this cap the loop's budget guard
 *  declines the retry outright rather than sleeping toward a deadline it
 *  cannot beat. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** Statuses worth a second attempt with the full backoff schedule.  501
 *  (Not Implemented) and 505 are deliberately absent: they are permanent
 *  statements about the endpoint, not the transient overload 500/502/503/
 *  504/529 describe, even though errors.ts maps all of them to
 *  `upstream_outage`.
 *
 *  529 is not an IANA status, but it is what several providers return for
 *  "overloaded, come back" — and it is the status the plan's own
 *  completion criterion names (docs/plans/agent-harness-upgrades-v2.md
 *  §3.4: "a simulated 529 produces a visible retry and a completed turn"),
 *  so a lane that failed it outright would be retry in name only. */
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504, 529]);

/** What a failed HTTP round knows about itself beyond its message.
 *  Carried ON the error `httpErrorFor` builds, so the loop classifies a
 *  round's rejection from the real status rather than by regexing the
 *  message it printed. */
export interface HttpFailure {
  status: number;
  /** The provider's own `Retry-After`, parsed and capped at
   *  RETRY_AFTER_CAP_MS.  Absent when the header was missing or
   *  unparseable — which is itself load-bearing for a 429. */
  retryAfterMs?: number;
}

/** The status detail, held BESIDE the errors rather than on them.  A
 *  property — even a symbol one — would have to be read back through an
 *  unchecked assertion, and it would ride along into any structured log or
 *  JSON dump of the error; a WeakMap keeps the detail exactly typed at
 *  both ends, leaves the Error byte-identical to what it was before this
 *  field existed, and releases with the error itself. */
const HTTP_FAILURES = new WeakMap<Error, HttpFailure>();

/** Reads back the status detail `httpErrorFor` recorded, if any.  A
 *  network failure, a stream that died mid-body, or an error from a driver
 *  that does not use `httpErrorFor` returns undefined — the caller falls
 *  back to the shared text classifier in drivers/retry.ts. */
export function httpFailureOf(error: Error): HttpFailure | undefined {
  return HTTP_FAILURES.get(error);
}

/** Undici's own identifier for "the socket went away underneath a request
 *  that had already been accepted".  Matched on the CODE rather than the
 *  prose so a Node release rewording the message cannot silently turn a
 *  retryable disconnect back into a failed turn. */
const UNDICI_SOCKET_ERROR_CODE = "UND_ERR_SOCKET";

/** True for the way Node's built-in fetch reports a 200 response whose
 *  connection died before the body finished — `TypeError: terminated`,
 *  with a `SocketError: other side closed` cause carrying
 *  `UND_ERR_SOCKET`.
 *
 *  This shape needs naming HERE because it says nothing the shared text
 *  classifier in drivers/retry.ts recognises: there is no status, no
 *  "reset", no "hang up", no "fetch failed" — just the word "terminated",
 *  which matches no transient pattern and so reads as terminal.  Yet it is
 *  the single most common way a streaming chat-completions round dies
 *  before its first delta, and a round that published nothing is exactly
 *  the round a retry is safe for.  The caller still owns that second
 *  condition: this function only identifies the shape, it does not decide
 *  that replaying is safe.
 *
 *  Deliberately narrow.  `UND_ERR_ABORTED` is NOT here — an abort is the
 *  person pressing Stop, and the loop must settle it as an interrupt
 *  rather than quietly trying again. */
export function isPrematureCloseError(error: Error): boolean {
  const { cause } = error;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const { code } = cause as { code?: unknown };
    // A cause that named itself IS the answer, both ways: `UND_ERR_ABORTED`
    // must not fall through to the message check below and be read as a
    // disconnect, because `TypeError: terminated` is also what an aborted
    // fetch throws.
    if (typeof code === "string") return code === UNDICI_SOCKET_ERROR_CODE;
  }
  // Some Node builds surface the same failure with the cause stripped, so
  // the bare `TypeError: terminated` fetch throws is worth recognising on
  // its own — the message is exact, not a substring match, so an unrelated
  // error merely containing the word does not qualify.  Safe here only
  // because the loop checks `!turnSignal.aborted` before it ever asks.
  return error.name === "TypeError" && error.message.trim() === "terminated";
}

/** Minimal read side of `Headers` — so a driver passes `res.headers`
 *  straight through and a test can pass a one-line stand-in. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** RFC 9110 `Retry-After`: either delta-seconds or an HTTP-date.  Anything
 *  else (a float, a bare word, a date in the past) reads as "no usable
 *  header", which for a 429 means the loop spends one polite retry instead
 *  of the full schedule. */
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1_000;
    return Number.isFinite(ms) ? Math.min(ms, RETRY_AFTER_CAP_MS) : undefined;
  }
  // A number that is not delta-seconds (a float, a signed value) is not an
  // HTTP-date either, and `Date.parse` is loose enough to read "1.5" as a
  // real date — so rule it out before asking, or a malformed header
  // silently becomes a zero-second wait.
  if (/^[+-]?[\d.]+$/.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), RETRY_AFTER_CAP_MS);
}

/** Attempts a 429 gets when nothing named a cool-down.  A rate limit with
 *  no `Retry-After` is much more often a real quota wall than a momentary
 *  burst, so it is worth exactly one polite retry — and the SAME ceiling
 *  has to apply when a driver's 429 reached us as bare text rather than
 *  through `httpErrorFor`, or the policy would depend on which driver
 *  threw it. */
export const UNHINTED_RATE_LIMIT_ATTEMPTS = 2;

export interface HttpRetryPolicy {
  /** Total attempts this status is worth, the FIRST one included.  2 means
   *  one retry. */
  maxAttempts: number;
  /** Named for the `turn.retrying` event, in the same vocabulary
   *  drivers/retry.ts's classifyError uses for CLI engines. */
  reason: "timeout" | "rate_limited" | "server_error";
  /** Present only when the provider named its own cool-down. */
  retryAfterMs?: number;
}

/** How many attempts a failed HTTP round is worth.  `undefined` = none:
 *  the failure is terminal and the loop classifies it exactly as it does
 *  today.
 *
 *  400/401/403/404/413/422 are never retried — a malformed body, a bad
 *  key, a missing model and an oversized request all fail again
 *  identically, and retrying an auth failure only delays the setup
 *  affordance the person actually needs.
 *
 *  429 is the one status whose budget depends on the response: WITH a
 *  `Retry-After` the provider has told us when it will serve us, so the
 *  full schedule is worth spending honouring it; WITHOUT one, a 429 is
 *  much more often a real quota wall than a momentary burst, so it gets
 *  exactly one polite retry and then classifies as
 *  `quota_or_region_restriction` — which is what puts it on the
 *  model-fallback ladder instead of into a backoff nobody's balance will
 *  outlast. */
export function httpRetryPolicy(failure: HttpFailure): HttpRetryPolicy | undefined {
  const { status, retryAfterMs } = failure;
  // A provider that named a cool-down is honoured whatever the status —
  // a 503 with a `Retry-After` knows when it will be back, and retrying a
  // second earlier than it asked only meets the same outage again.
  const cooldown = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 408) return { maxAttempts: RETRY_MAX_ATTEMPTS, reason: "timeout", ...cooldown };
  if (status === 429) {
    return retryAfterMs === undefined
      ? { maxAttempts: UNHINTED_RATE_LIMIT_ATTEMPTS, reason: "rate_limited" }
      : { maxAttempts: RETRY_MAX_ATTEMPTS, reason: "rate_limited", retryAfterMs };
  }
  if (RETRYABLE_SERVER_STATUSES.has(status)) {
    return { maxAttempts: RETRY_MAX_ATTEMPTS, reason: "server_error", ...cooldown };
  }
  return undefined;
}
