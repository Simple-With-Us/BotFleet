import { describe, expect, it } from "vitest";

import { buildObservabilityConfigPatch, initialSendDiagnostics, isSentryDsn } from "./observability-config";

describe("isSentryDsn", () => {
  it("accepts a well-formed https Sentry DSN", () => {
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io/1")).toBe(true);
    expect(isSentryDsn("  https://abc123@o0.ingest.sentry.io/1  ")).toBe(true);
  });

  it("rejects http://", () => {
    expect(isSentryDsn("http://abc123@o0.ingest.sentry.io/1")).toBe(false);
  });

  it("rejects an https URL with no key", () => {
    expect(isSentryDsn("https://o0.ingest.sentry.io/1")).toBe(false);
  });

  it("rejects an https URL with no project id", () => {
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io/")).toBe(false);
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io")).toBe(false);
  });

  it("rejects blank and unparsable input", () => {
    expect(isSentryDsn("")).toBe(false);
    expect(isSentryDsn("   ")).toBe(false);
    expect(isSentryDsn("not a url")).toBe(false);
  });

  // @sentry/core matches a DSN against its own `DSN_REGEX` (public key
  // `\w+`) and answers a string that fails it by printing the whole DSN,
  // public key included, through `console.error` before discarding it.  A
  // card that accepts a shape the SDK refuses therefore hands the harness a
  // credential to log and a client that captures nothing.
  it("rejects the shapes @sentry/core's own parser would print and then discard", () => {
    expect(isSentryDsn("https://a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@o123.ingest.sentry.io/456")).toBe(false);
    expect(isSentryDsn("https://abc.123@o0.ingest.sentry.io/1")).toBe(false);
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io/not-a-project")).toBe(false);
  });

  it("keeps the shapes that stay legal", () => {
    expect(isSentryDsn("https://abc_123@o0.ingest.sentry.io/1")).toBe(true);
    expect(isSentryDsn("https://abc123@o0.ingest.sentry.io:9000/1")).toBe(true);
    expect(isSentryDsn("https://abc123@sentry.example.com/sentry/42")).toBe(true);
  });
});

describe("buildObservabilityConfigPatch", () => {
  const base = { sentryDsn: "", enabled: true, environment: "", tracesSampleRate: 0.2, logsEnabled: true };

  it("omits a blank DSN so Save cannot wipe a stored key", () => {
    expect(buildObservabilityConfigPatch(base)).toEqual({
      ok: true,
      patch: { enabled: true, environment: "", tracesSampleRate: 0.2, logsEnabled: true },
    });
  });

  it("includes a valid typed DSN and trims it", () => {
    expect(
      buildObservabilityConfigPatch({ ...base, sentryDsn: "  https://abc123@o0.ingest.sentry.io/1  " }),
    ).toEqual({
      ok: true,
      patch: {
        sentryDsn: "https://abc123@o0.ingest.sentry.io/1",
        enabled: true,
        environment: "",
        tracesSampleRate: 0.2,
        logsEnabled: true,
      },
    });
  });

  it("rejects http:// with a readable message", () => {
    expect(buildObservabilityConfigPatch({ ...base, sentryDsn: "http://abc123@o0.ingest.sentry.io/1" })).toEqual({
      ok: false,
      error: "The diagnostics key must be an https:// Sentry DSN with a key and a numeric project id.",
    });
  });

  it("rejects a keyless https DSN with a readable message", () => {
    expect(buildObservabilityConfigPatch({ ...base, sentryDsn: "https://o0.ingest.sentry.io/1" })).toEqual({
      ok: false,
      error: "The diagnostics key must be an https:// Sentry DSN with a key and a numeric project id.",
    });
  });

  it("rejects a UUID-shaped key the SDK would refuse and print", () => {
    expect(
      buildObservabilityConfigPatch({
        ...base,
        sentryDsn: "https://a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@o123.ingest.sentry.io/456",
      }),
    ).toEqual({
      ok: false,
      error: "The diagnostics key must be an https:// Sentry DSN with a key and a numeric project id.",
    });
  });

  it("round-trips environment and traces sample rate", () => {
    const result = buildObservabilityConfigPatch({ ...base, environment: "staging", tracesSampleRate: 0.5 });
    expect(result).toEqual({
      ok: true,
      patch: { environment: "staging", enabled: true, tracesSampleRate: 0.5, logsEnabled: true },
    });
  });

  it("sends a blank environment explicitly while keeping a blank DSN write-only", () => {
    expect(buildObservabilityConfigPatch({ ...base, environment: "   " })).toEqual({
      ok: true,
      patch: { enabled: true, environment: "", tracesSampleRate: 0.2, logsEnabled: true },
    });
  });

  it("rejects a sample rate outside 0..1", () => {
    expect(buildObservabilityConfigPatch({ ...base, tracesSampleRate: 1.5 })).toEqual({
      ok: false,
      error: "Traces sample rate must be between 0 and 1.",
    });
    expect(buildObservabilityConfigPatch({ ...base, tracesSampleRate: -0.1 })).toEqual({
      ok: false,
      error: "Traces sample rate must be between 0 and 1.",
    });
  });

  it("rejects an environment over 80 characters", () => {
    expect(buildObservabilityConfigPatch({ ...base, environment: "e".repeat(81) })).toEqual({
      ok: false,
      error: "Environment must be 80 characters or fewer.",
    });
  });

  it("carries enabled: false and logsEnabled: false through untouched", () => {
    expect(buildObservabilityConfigPatch({ ...base, enabled: false, logsEnabled: false })).toEqual({
      ok: true,
      patch: { enabled: false, environment: "", tracesSampleRate: 0.2, logsEnabled: false },
    });
  });

  it("round-trips separate trace sample rates for AI, HTTP, and UI", () => {
    const result = buildObservabilityConfigPatch({
      ...base,
      aiTracesSampleRate: 1.0,
      httpTracesSampleRate: 0.05,
      uiTracesSampleRate: 0.15,
    });
    expect(result).toEqual({
      ok: true,
      patch: {
        enabled: true,
        environment: "",
        tracesSampleRate: 0.2,
        aiTracesSampleRate: 1.0,
        httpTracesSampleRate: 0.05,
        uiTracesSampleRate: 0.15,
        logsEnabled: true,
      },
    });
  });

  it("rejects separate trace sample rates outside 0..1", () => {
    expect(buildObservabilityConfigPatch({ ...base, aiTracesSampleRate: 1.2 })).toEqual({
      ok: false,
      error: "AI traces sample rate must be between 0 and 1.",
    });
    expect(buildObservabilityConfigPatch({ ...base, httpTracesSampleRate: -0.05 })).toEqual({
      ok: false,
      error: "HTTP traces sample rate must be between 0 and 1.",
    });
    expect(buildObservabilityConfigPatch({ ...base, uiTracesSampleRate: 2 })).toEqual({
      ok: false,
      error: "UI traces sample rate must be between 0 and 1.",
    });
  });
});

describe("initialSendDiagnostics", () => {
  it("shows the switch on when no DSN is configured yet, so the first Save does not turn diagnostics off", () => {
    expect(initialSendDiagnostics(undefined)).toBe(true);
    expect(initialSendDiagnostics({ configured: false, enabled: false })).toBe(true);
  });

  it("keeps an explicit packaged-build opt-out visible even without a runtime DSN", () => {
    expect(initialSendDiagnostics({ configured: false, enabled: false, requestedEnabled: false })).toBe(false);
    expect(initialSendDiagnostics({ configured: false, enabled: false, requestedEnabled: true })).toBe(true);
  });

  it("follows the stored flag once a DSN is configured", () => {
    expect(initialSendDiagnostics({ configured: true, enabled: false })).toBe(false);
    expect(initialSendDiagnostics({ configured: true, enabled: true })).toBe(true);
  });

  it("keeps a freshly pasted DSN reporting: the patch from an untouched form does not carry enabled false", () => {
    const enabled = initialSendDiagnostics({ configured: false, enabled: false });
    const built = buildObservabilityConfigPatch({ sentryDsn: "https://abc123@o0.ingest.sentry.io/1", enabled, environment: "", tracesSampleRate: 0.2, logsEnabled: true });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.patch.enabled).toBe(true);
  });
});
