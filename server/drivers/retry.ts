// Transient-failure classification + capped backoff for turn drivers
// (plan v2 §3.4). Pure functions — no timers, no events — so the drivers
// keep owning process lifetime while sharing one policy: a provider hiccup
// (429/5xx/overloaded/reset) gets up to MAX_ATTEMPTS tries, an auth or
// request-shape problem never does.
import type { ProviderErrorCode } from "../contracts.ts";

export const RETRY_MAX_ATTEMPTS = 3;

/** Backoff schedule before attempt N (N is 1-based over retries): 1s / 3s / 8s. */
export const BACKOFF_BASE_MS = [1_000, 3_000, 8_000] as const;

export type TransientReason =
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "connection_reset"
  | "timeout";

export type TerminalReason =
  | "auth"
  | "quota"
  | "unknown_model"
  | "invalid_request"
  | "not_found"
  | ProviderErrorCode
  | "terminal_exit"
  | "interrupted"
  | "unknown";

export interface ErrorClassification {
  transient: boolean;
  reason: string;
}

// `retry.ts` is a P0 classifier — everything downstream (auto-retry vs.
// give-up) keys off the result.  The 2026-09-24 efficiency audit caught
// the old version of these patterns matching benign substrings:
// `\bbilling\b` fired on "billing address", `\bsubscription\b` fired on
// "subscribe to the newsletter", `\b402\b` fired on "page 402 of the
// changelog", and the bare 5xx pattern fired on "section 5.3 of the
// spec".  Each of those turned into a "permanent quota give-up" or
// "permanent rate-limit retry" classification for a turn that was
// actually fine.
//
// The fix is to require the numeric codes and quota-noun terms to appear
// in a recognizable error-context before they count:
//
//   HTTP_STATUS_CONTEXT is the cue that has to be within a few characters
//     of the digits: "HTTP ", "status", "code:", "error:".  Anything
//     further away is body text, not a status.  The digits may sit in
//     parens or brackets right after the cue: "API error (503)", "status [502]".
//
// The looser "rate limit exceeded", "RESOURCE_EXHAUSTED", "free tier
// limit", "out of credits", "insufficient balance" phrases stay as
// explicit disjunction arms — every test case in retry.test.ts still
// matches one of them.
//
// "status" is already one of the cue words below, so "unexpected status 503"
// / "unexpected status 429" / "unexpected status 401" already read as
// status-code cues on their own (verified: hasHttpStatusCode matches all
// three against their respective codes without any change here) — no
// separate "unexpected status" cue needs adding for the Unit 2 fix.
const HTTP_STATUS_CONTEXT = "\\b(?:https?://|status|http|code|error)\\b[^\\s\\n]{0,4}(?:[:=\\s]\\s*[(\\[]?|[(\\[])";

function hasHttpStatusCode(text: string, code: RegExp): boolean {
  // Matches "<context> <digits>": "HTTP 503", "status: 503",
  // "code=503", "error 503: …", or the digits at the very start of input.
  // The `${code.source}` has to live INSIDE a non-capturing group, or
  // the alternative in `code.source` (e.g. /401|403/) leaks out and the
  // second arm matches a bare 403 anywhere — a precedence footgun that
  // an earlier draft hit ("issue 403 was marked wontfix" classified as
  // auth until the (?:...) wrap landed).
  const probe = new RegExp(`(?:^|${HTTP_STATUS_CONTEXT})(?:${code.source})\\b`, "i");
  return probe.test(text);
}

const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: TransientReason }> = [
  // Status-code driven 429, plus the textual rate-limit vocabulary.
  // "section 429 of the legalese" no longer matches; "HTTP 429" still does.
  { pattern: /\b(?:rate.?limit|too many requests)\b/i, reason: "rate_limited" },
  { pattern: /\boverloaded\b|\bcapacity\b/i, reason: "overloaded" },
  // Numeric 5xx codes land in classifyByStatusCode (where they're
  // anchored to a status-code cue) — leaving `\b5\d{2}\b` here would
  // otherwise fire on "section 503 of the changelog", exactly the kind
  // of false positive the audit flagged.
  { pattern: /\binternal server error\b|\bbad gateway\b|\bservice (?:temporarily )?unavailable\b/i, reason: "server_error" },
  {
    pattern:
      /\b(?:econnreset|econnrefused|epipe|etimedout|eai_again|connection reset|connection refused|socket hang up|network error|fetch failed)\b/i,
    reason: "connection_reset",
  },
  { pattern: /\btimeout(ed)?\b|\btimed? out\b/i, reason: "timeout" },
];

// Terminal arms that must win over everything else — including a
// transient-looking phrase elsewhere in the same text — because they are
// unrecoverable by definition: no retry count fixes a bad key or an empty
// wallet.  Checked first, in both the CliExit and Error/text shapes, so a
// message that is both quota-shaped and mentions "capacity" (RESOURCE_EXHAUSTED
// bodies do) always classifies as quota, never as the transient "overloaded"
// reading.  See classifyError's single ordered pass below (2026-09-25 fix for
// "classifyError verdict depends on input shape").
const PRIORITY_TERMINAL_PATTERNS: Array<{ pattern: RegExp; reason: TerminalReason }> = [
  {
    // Auth-shaped words OR a status-code-driven 401/403.  "free range
    // 401 chickens" no longer triggers the auth path; "401 Unauthorized"
    // still does.
    pattern:
      /\b(?:unauthorized|forbidden|invalid api key|missing bearer|authentication required|not logged in|logged out)\b/i,
    reason: "auth",
  },
  {
    // Quota / billing.  Two arms: named phrases the existing tests
    // rely on (session limit, usage cap, RESOURCE_EXHAUSTED, …), plus
    // verb-anchored variants for "billing disabled" / "subscription
    // expired" / "out of credits".  Bare "billing", "subscription",
    // "402", and "quota" no longer match — those substrings appear
    // in too many benign contexts (an audit finding).
    pattern:
      /\bsession limit\b|\busage cap\b|\busage limit\b|\bquota exceeded\b|\brate limit reached\b|\bplan limit\b|(?<!-)\btier limit\b|\bmonthly limit\b|\bfree\s*tier\s+limit\b|\bspend limit\b|\bbudget exceeded\b|\bcredits?\b[^.\n]{0,30}\b(?:exhausted|depleted|empty|insufficient|zero)\b|\bout of (?:usage|credits)\b|\binsufficient.?balance\b|\binsufficient.?funds\b|\bzero balance\b|\bresource.?exhausted\b|\bresource_exhausted\b|\bexhausted your.*quota\b|\bdaily quota\b|\bslow pool\b|\bpayment required\b|\bsubscription\b[^.\n]{0,30}\b(?:expired|inactive|disabled|ended|past due)\b|\bbilling\b[^.\n]{0,30}\b(?:expired|inactive|disabled|ended|past due|not active|failed)\b/i,
    reason: "quota",
  },
];

// Remaining terminal arms — checked AFTER the transient vocabulary, so a
// transient-looking status code or phrase is never shadowed by a coincidental
// terminal word later in the same message.  "unexpected status" used to live
// here (matching regardless of the digits that followed), which is exactly
// the shape-dependent bug this file fixes: a CliExit's "unexpected status
// 503" and an Error's "unexpected status 503" now both fall through to
// `classifyByStatusCode`, which reads the digits instead of the word.
const TERMINAL_PATTERNS: Array<{ pattern: RegExp; reason: TerminalReason }> = [
  { pattern: /\bmodel not found\b|\bunknown model\b|\bdoes not exist for model\b|\bunsupported model\b/i, reason: "unknown_model" },
  { pattern: /\b(?:invalid request|malformed)\b/i, reason: "invalid_request" },
  { pattern: /\b(?:no such thread|thread gone)\b/i, reason: "not_found" },
  // Narrowed to the drivers' own stop-path phrases (interrupted BY USER,
  // cancelled by user) — a turn the user stopped must never come back as an
  // auto-retry.  Bare "interrupted" used to match here too, which meant a
  // transient reconnect message like "stream interrupted: connection lost"
  // was swallowed into a permanent give-up before the transient vocabulary
  // ever got a look at it.
  { pattern: /\b(?:interrupted by user|cancelled by user)\b/i, reason: "interrupted" },
];

/** A CLI exit report, as drivers assemble it from a child process's close
 * event: the numeric exit code plus whatever stderr survived. */
interface CliExit {
  exitCode: number | null;
  stderr?: string;
}

/** A bare failure message, wrapped so the classifier's inputs stay named
 * domain values rather than unparsed primitives. */
interface FailureText {
  text: string;
}

/** The failure shapes drivers actually hand the classifier. */
type FailureInput = Error | CliExit | FailureText | null;

const messageOf = (err: FailureInput): string => {
  if (!err) return "";
  if (err instanceof Error) return `${err.message}${err.cause ? ` ${String(err.cause)}` : ""}`;
  if ("text" in err) return err.text;
  return [err.stderr ?? "", ""].join(" ").trim();
};

/** Classify a numeric HTTP status code into the right reason.  Called
 *  only after the loose terminal/transient patterns have run, so a
 *  textual rate-limit or quota phrase always wins over the digits alone.
 *  Returns undefined when the text doesn't show the digits with a
 *  status-code cue nearby — in that case the caller falls through to
 *  the "unknown" reason.  The 2026-09-24 efficiency audit called this
 *  out as a false-positive source ("page 402 of the changelog" used
 *  to fire the quota path). */
function classifyByStatusCode(text: string): ErrorClassification | undefined {
  // 401/403 first — auth/quota overlap on a status-only signal, and the
  // textual quota patterns are already matched before this runs, so any
  // 401/403 we see here is genuinely auth-shaped (the test suite covers
  // "401 Unauthorized: …" with the textual cue and we don't want to
  // regress it).
  if (hasHttpStatusCode(text, /401|403/)) return { transient: false, reason: "auth" };
  if (hasHttpStatusCode(text, /402/)) return { transient: false, reason: "quota" };
  if (hasHttpStatusCode(text, /404/)) return { transient: false, reason: "not_found" };
  if (hasHttpStatusCode(text, /400|422/)) return { transient: false, reason: "invalid_request" };
  if (hasHttpStatusCode(text, /429/)) return { transient: true, reason: "rate_limited" };
  if (hasHttpStatusCode(text, /5\d{2}/)) return { transient: true, reason: "server_error" };
  return undefined;
}

/** Classify a thrown error or a CLI exit into retry-worthy vs terminal.
 *
 * One order, for every input shape (Error, `{text}`, or a CLI exit report):
 *   1. a signal kill (negative exit code) is never retried;
 *   2. the priority terminal arms (auth, quota) — unrecoverable, so they
 *      outrank a transient-looking word elsewhere in the same text;
 *   3. the transient vocabulary;
 *   4. the remaining terminal arms (unknown_model, invalid_request,
 *      not_found, interrupted);
 *   5. the numeric HTTP status code, when the text carries one with a
 *      recognizable cue nearby.
 * Before this fix, a CliExit checked transient before terminal while an
 * Error/text checked terminal before transient — so the same message could
 * classify differently depending only on which shape carried it in (board:
 * "classifyError verdict depends on input shape").
 *
 * Exit-report shape only: a nonzero exit with NO error text at all is
 * terminal (`terminal_exit`) — drivers only reach it after the CLI already
 * reported its own protocol-level failure with nothing on stderr to classify.
 * A nonzero exit whose stderr just doesn't match anything above falls
 * through to `unknown`, same as the other two shapes, so the reason a caller
 * sees for the same text never depends on whether it arrived as an Error, a
 * `{text}`, or a CLI exit report.
 */
export function classifyError(err: FailureInput): ErrorClassification {
  const text = messageOf(err);
  const exit = err && typeof err === "object" && "exitCode" in err ? err : null;
  if (exit && exit.exitCode !== null && exit.exitCode < 0) return { transient: false, reason: "interrupted" };

  for (const { pattern, reason } of PRIORITY_TERMINAL_PATTERNS) {
    if (pattern.test(text)) return { transient: false, reason };
  }
  for (const { pattern, reason } of TRANSIENT_PATTERNS) {
    if (pattern.test(text)) return { transient: true, reason };
  }
  for (const { pattern, reason } of TERMINAL_PATTERNS) {
    if (pattern.test(text)) return { transient: false, reason };
  }
  const byCode = classifyByStatusCode(text);
  if (byCode) return byCode;
  if (exit && exit.exitCode !== null && exit.exitCode !== 0 && !text.trim()) {
    return { transient: false, reason: "terminal_exit" };
  }
  return { transient: false, reason: "unknown" };
}

/** Capped exponential delay with jitter, in milliseconds. Attempt 0 (the
 * first retry) waits ~1s, then ~3s, then ~8s; beyond that the cap holds.
 * Jitter stays within ±25% so tests can bound it and a thundering herd of
 * bots doesn't re-sync on the same tick. */
export function computeBackoff(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS[Math.min(Math.max(attempt, 0), BACKOFF_BASE_MS.length - 1)];
  const jitter = base * 0.25;
  return Math.round(base - jitter + random() * jitter * 2);
}

/** A cancellable backoff sleep. An interrupt during the wait resolves at
 * once with "cancelled" — the caller settles the turn as interrupted
 * instead of relaunching, so no zombie process outlives the user's stop. */
export interface BackoffWait {
  promise: Promise<"elapsed" | "cancelled">;
  cancel: () => void;
}

export function interruptibleDelay(ms: number, signal?: AbortSignal): BackoffWait {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onCancel: (() => void) | null = null;
  const promise = new Promise<"elapsed" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), Math.max(1, ms));
    timer.unref?.();
    if (signal?.aborted) return resolve("cancelled");
    onCancel = () => {
      clearTimeout(timer!);
      resolve("cancelled");
    };
    signal?.addEventListener("abort", onCancel, { once: true });
  });
  return {
    promise,
    cancel: () => onCancel?.(),
  };
}
