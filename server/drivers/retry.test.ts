import { describe, expect, it } from "vitest";

import { BACKOFF_BASE_MS, RETRY_MAX_ATTEMPTS, classifyError, computeBackoff, type ErrorClassification } from "./retry.ts";

describe("classifyError", () => {
  it("calls provider rate limits transient", () => {
    expect(classifyError(new Error("xAI HTTP 429: Too Many Requests"))).toEqual({
      transient: true,
      reason: "rate_limited",
    });
    expect(classifyError({ text: "rate limit exceeded, slow down" })).toEqual({
      transient: true,
      reason: "rate_limited",
    });
  });

  it("calls 5xx and overloaded transient", () => {
    expect(classifyError(new Error("xAI HTTP 503: Service Unavailable"))).toEqual({
      transient: true,
      reason: "server_error",
    });
    expect(classifyError(new Error("Internal Server Error"))).toEqual({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("The API is temporarily overloaded"))).toEqual({
      transient: true,
      reason: "overloaded",
    });
    expect(classifyError(new Error("upstream error (529 overloaded)"))).toEqual({
      transient: true,
      reason: "overloaded",
    });
  });

  it("calls connection failures and timeouts transient", () => {
    expect(classifyError(new Error("fetch failed"))).toMatchObject({ transient: true });
    expect(classifyError(new Error("read ECONNRESET"))).toMatchObject({ transient: true, reason: "connection_reset" });
    expect(classifyError(new Error("request timed out after 120000ms"))).toMatchObject({
      transient: true,
      reason: "timeout",
    });
  });

  it("never retries auth, quota, unknown model, or invalid request", () => {
    expect(classifyError(new Error("unexpected status 401 Unauthorized: Missing bearer"))).toEqual({
      transient: false,
      reason: "auth",
    });
    expect(classifyError(new Error("invalid api key"))).toEqual({ transient: false, reason: "auth" });
    expect(classifyError(new Error("quota exceeded for this plan"))).toEqual({ transient: false, reason: "quota" });
    expect(classifyError(new Error("You've hit your session limit · resets 12:10am (America/Chicago)"))).toEqual({
      transient: false,
      reason: "quota",
    });
    expect(classifyError(new Error("usage cap reached"))).toEqual({ transient: false, reason: "quota" });
    expect(classifyError(new Error("You've hit your usage limit. Upgrade to Plus to continue using Codex"))).toEqual({
      transient: false,
      reason: "quota",
    });
    expect(classifyError(new Error("You've reached your 5-hour usage limit"))).toEqual({
      transient: false,
      reason: "quota",
    });
    expect(classifyError(new Error("429 RESOURCE_EXHAUSTED"))).toEqual({ transient: false, reason: "quota" });
    expect(classifyError(new Error("model not found: grok-99"))).toEqual({
      transient: false,
      reason: "unknown_model",
    });
    expect(classifyError(new Error("400 invalid request body"))).toEqual({
      transient: false,
      reason: "invalid_request",
    });
  });

  it("treats a bare nonzero CLI exit as terminal", () => {
    expect(classifyError({ exitCode: 3 })).toEqual({ transient: false, reason: "terminal_exit" });
  });

  it("never retries a signal kill or interrupt", () => {
    expect(classifyError({ exitCode: -1 })).toEqual({ transient: false, reason: "interrupted" });
    expect(classifyError(new Error("interrupted by user"))).toEqual({ transient: false, reason: "interrupted" });
    expect(classifyError(new Error("turn cancelled by user"))).toEqual({ transient: false, reason: "interrupted" });
  });

  it("no longer terminal-interrupts on the bare word alone", () => {
    // Narrowed to the drivers' own stop-path phrases ("interrupted by
    // user"/"cancelled by user") so a transient reconnect message that
    // merely contains the word "interrupted" isn't swallowed into a
    // permanent give-up before the transient vocabulary gets a look at it.
    expect(classifyError(new Error("stream interrupted"))).not.toEqual({ transient: false, reason: "interrupted" });
  });

  it("prefers the transient reading when stderr carries both shapes", () => {
    // a crash whose stderr mentions throttling is worth one more try
    expect(classifyError({ exitCode: 1, stderr: "error: 429 too many requests" })).toEqual({
      transient: true,
      reason: "rate_limited",
    });
  });

  it("classifies unrecognizable input as terminal", () => {
    expect(classifyError(null)).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error(""))).toEqual({ transient: false, reason: "unknown" });
  });

  // The 2026-09-24 efficiency audit caught the old regex set firing the
  // wrong reason on substrings that appear in benign prose: bare "402",
  // "billing" without a verb near it, "subscription" alone, "5.3 of the
  // spec" matching 5xx.  Each of these must now land as `unknown` rather
  // than the pattern-specific terminal reason — a successful call still
  // proceeds and gets retried/dropped by the calling driver, instead of
  // being treated as a permanent give-up.
  it("does not fire quota on bare substrings the audit caught", () => {
    expect(classifyError(new Error("page 402 of the changelog"))).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error("billing address field is required"))).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error("subscribe to our newsletter for 402 reasons"))).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error("free-tier limit on signup"))).toEqual({ transient: false, reason: "unknown" });
  });

  it("does not fire rate_limit/server_error on bare 5xx/4xx fragments", () => {
    expect(classifyError(new Error("see section 503 of the spec for details"))).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error("we shipped 429 widgets today"))).toEqual({ transient: false, reason: "unknown" });
  });

  it("does not fire auth on bare 401/403 in benign contexts", () => {
    expect(classifyError(new Error("free range 401 chickens for sale"))).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error("issue 403 was marked wontfix last week"))).toEqual({ transient: false, reason: "unknown" });
  });

  it("still recognizes real error shapes with the tightened patterns", () => {
    // The textual cues the existing tests rely on keep working.
    expect(classifyError(new Error("xAI HTTP 429: Too Many Requests"))).toEqual({ transient: true, reason: "rate_limited" });
    expect(classifyError(new Error("OpenAI HTTP 402 Payment Required"))).toMatchObject({ transient: false, reason: "quota" });
    expect(classifyError(new Error("status: 503 Service Unavailable"))).toMatchObject({ transient: true, reason: "server_error" });
    // The Claude CLI's own shape: status in parens, "temporarily" in the phrase.
    expect(classifyError(new Error("claude: API error (503): service temporarily unavailable"))).toMatchObject({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("API error (502)"))).toMatchObject({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("status [504]"))).toMatchObject({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("error(500)"))).toMatchObject({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("service temporarily unavailable"))).toMatchObject({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("error: 401 Unauthorized: missing bearer"))).toMatchObject({ transient: false, reason: "auth" });
  });
  // 2026-09-25 fix: classifyError used to check transient-before-terminal for
  // a CliExit but terminal-before-transient for an Error/{text} — so the same
  // failure message classified differently purely because of which shape a
  // driver happened to wrap it in.  Every string below must now land on the
  // identical verdict whether it arrives as a thrown Error, a bare
  // `{ text }`, or a CLI exit report (`{ exitCode, stderr }`).
  const SHAPE_INVARIANT_CASES: Array<[string, ErrorClassification]> = [
    ["unexpected status 503", { transient: true, reason: "server_error" }],
    ["unexpected status 429", { transient: true, reason: "rate_limited" }],
    ["unexpected status 401", { transient: false, reason: "auth" }],
    ["rate limit reached for this month", { transient: false, reason: "quota" }],
    ["RESOURCE_EXHAUSTED capacity", { transient: false, reason: "quota" }],
    ["overloaded", { transient: true, reason: "overloaded" }],
    ["stream interrupted", { transient: false, reason: "unknown" }],
    ["interrupted by user", { transient: false, reason: "interrupted" }],
    ["ECONNRESET", { transient: true, reason: "connection_reset" }],
    ["timeout waiting for response", { transient: true, reason: "timeout" }],
    ["Invalid params", { transient: false, reason: "unknown" }],
  ];

  it.each(SHAPE_INVARIANT_CASES)("classifies %j identically as Error / {text} / CliExit", (text, expected) => {
    expect(classifyError(new Error(text))).toEqual(expected);
    expect(classifyError({ text })).toEqual(expected);
    expect(classifyError({ exitCode: 1, stderr: text })).toEqual(expected);
  });
});

describe("computeBackoff", () => {
  it("follows the capped exponential schedule", () => {
    expect(BACKOFF_BASE_MS).toHaveLength(RETRY_MAX_ATTEMPTS);
    for (const [attempt, base] of BACKOFF_BASE_MS.entries()) {
      const mid = computeBackoff(attempt, () => 0.5);
      expect(mid).toBe(base);
    }
  });

  it("jitter stays within ±25% of the schedule", () => {
    for (const attempt of [0, 1, 2, 5]) {
      const low = computeBackoff(attempt, () => 0);
      const high = computeBackoff(attempt, () => 1);
      const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)];
      expect(low).toBeGreaterThanOrEqual(base * 0.75);
      expect(high).toBeLessThanOrEqual(base * 1.25 + 1);
    }
  });
});
