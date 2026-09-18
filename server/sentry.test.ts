import { afterEach, describe, expect, it } from "vitest";
import {
  applySentryConfig,
  initSentry,
  isSentryActive,
  isSentryInitialized,
  resetSentryForTests,
  sentryDsnFromEnv,
  setSentryLoaderForTests,
} from "./sentry.ts";

afterEach(() => {
  resetSentryForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
});

describe("server Sentry init", () => {
  it("stays inert without a DSN", async () => {
    expect(sentryDsnFromEnv({})).toBeUndefined();
    expect(await initSentry({})).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("stays inert under vitest even when a DSN is present", async () => {
    expect(await initSentry({ VITEST: "true", SENTRY_DSN: "https://example.invalid/1" })).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("reads SENTRY_DSN then BOTFLEET_SENTRY_DSN", async () => {
    expect(sentryDsnFromEnv({ SENTRY_DSN: " https://example.invalid/1 " })).toBe("https://example.invalid/1");
    expect(sentryDsnFromEnv({ BOTFLEET_SENTRY_DSN: "https://example.invalid/2" })).toBe(
      "https://example.invalid/2",
    );
  });

  it("serializes concurrent applies so the same fingerprint inits once", async () => {
    let inits = 0;
    let inflight = 0;
    let maxInflight = 0;
    const sdk = {
      init() {
        inits += 1;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inflight -= 1;
      return sdk;
    });
    const input = {
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: true,
      source: "config" as const,
    };
    const [first, second] = await Promise.all([applySentryConfig(input), applySentryConfig(input)]);
    expect(maxInflight).toBe(1);
    expect(inits).toBe(1);
    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
    expect(isSentryActive()).toBe(true);
  });
});
