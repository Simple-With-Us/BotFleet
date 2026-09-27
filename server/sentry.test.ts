import { afterEach, describe, expect, it } from "vitest";
import {
  applySentryConfig,
  initSentry,
  isSentryActive,
  isSentryInitialized,
  isWebhookIngressPath,
  resetSentryForTests,
  safeScrubHook,
  scrubSentryPayload,
  scrubWebhookSecrets,
  sentryDsnFromEnv,
  setSentryLoaderForTests,
} from "./sentry.ts";

afterEach(() => {
  resetSentryForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
  delete process.env.SENTRY_AI_DATA_COLLECTION;
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

describe("Sentry AI data collection kill-switch", () => {
  it("defaults ON and accepts 0/false/off/no as OFF", async () => {
    const { isGenAiDataCollectionEnabled, genAiDataCollectionOptions } = await import("./sentry.ts");
    expect(isGenAiDataCollectionEnabled({})).toBe(true);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "1" })).toBe(true);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "0" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "false" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "OFF" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "no" })).toBe(false);
    expect(genAiDataCollectionOptions({ SENTRY_AI_DATA_COLLECTION: "1" })).toEqual({
      genAI: { inputs: true, outputs: true },
    });
    expect(genAiDataCollectionOptions({ SENTRY_AI_DATA_COLLECTION: "0" })).toEqual({
      genAI: { inputs: false, outputs: false },
    });
  });

  it("passes streamGenAiSpans and dataCollection into Sentry.init", async () => {
    let initOpts: Record<string, unknown> | null = null;
    const sdk = {
      init(opts: Record<string, unknown>) {
        initOpts = opts;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
    process.env.SENTRY_AI_DATA_COLLECTION = "1";
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: false,
      source: "config",
    });
    expect(initOpts).toMatchObject({
      streamGenAiSpans: true,
      dataCollection: { genAI: { inputs: true, outputs: true } },
    });

    resetSentryForTests();
    setSentryLoaderForTests(async () => sdk);
    process.env.SENTRY_AI_DATA_COLLECTION = "0";
    initOpts = null;
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: false,
      source: "config",
    });
    expect(initOpts).toMatchObject({
      streamGenAiSpans: true,
      dataCollection: { genAI: { inputs: false, outputs: false } },
    });
    delete process.env.SENTRY_AI_DATA_COLLECTION;
  });
});

describe("Sentry tracesSampler dynamic rates", () => {
  it("samples AI spans with aiRate and routine HTTP spans with httpRate", async () => {
    let initOpts: Record<string, unknown> | null = null;
    const sdk = {
      init(opts: Record<string, unknown>) {
        initOpts = opts;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      aiTracesSampleRate: 1.0,
      httpTracesSampleRate: 0.05,
      uiTracesSampleRate: 0.1,
      logsEnabled: false,
      source: "config",
    });
    expect(initOpts).toBeTruthy();
    const sampler = (initOpts as unknown as { tracesSampler: (ctx: Record<string, unknown>) => number | boolean }).tracesSampler;
    expect(typeof sampler).toBe("function");

    // Parent sampled decision inherited
    expect(sampler({ parentSampled: true })).toBe(true);
    expect(sampler({ parentSampled: false })).toBe(false);

    // AI operations sampled at aiRate (1.0)
    expect(sampler({ attributes: { "sentry.op": "gen_ai.chat" } })).toBe(1.0);
    expect(sampler({ attributes: { "sentry.op": "gen_ai.invoke_agent" } })).toBe(1.0);
    expect(sampler({ attributes: { "sentry.op": "gen_ai.execute_tool" } })).toBe(1.0);
    expect(sampler({ name: "gen_ai.chat" })).toBe(1.0);

    // HTTP server endpoints sampled at httpRate (0.05)
    expect(sampler({ attributes: { "sentry.op": "http.server" }, name: "POST /api/chat" })).toBe(0.05);
    expect(sampler({ name: "GET /api/bots" })).toBe(0.05);

    // Routine health check endpoints heavily sampled / throttled
    expect(sampler({ name: "GET /healthz" })).toBe(0.01);
    expect(sampler({ name: "GET /api/telemetry/status" })).toBe(0.01);

    // Outbound HTTP requests sampled at httpRate
    expect(sampler({ attributes: { "sentry.op": "http.client" } })).toBe(0.05);

    // Other / fallback spans sampled at general rate (0.2)
    expect(sampler({ name: "custom.operation" })).toBe(0.2);
  });
});

describe("webhook secrets never reach Sentry", () => {
  // Fake values in the real shapes: an endpoint id and a whsec_ secret.
  const endpoint = "wh_abc";
  const secret = "whsec_xyz0123456789";

  type ScrubHooks = {
    beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
    beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>;
    beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown>;
    integrations: Array<{ name: string; options?: { ignoreIncomingRequests?: (url: string) => boolean } }>;
  };

  async function initWithStandIn(): Promise<ScrubHooks> {
    let initOpts: ScrubHooks | null = null;
    const sdk = {
      init(opts: ScrubHooks) {
        initOpts = opts;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      httpIntegration(options: { ignoreIncomingRequests?: (url: string) => boolean }) {
        return { name: "Http", options };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 1,
      logsEnabled: true,
      source: "config",
    });
    expect(initOpts).not.toBeNull();
    return initOpts as unknown as ScrubHooks;
  }

  function leakyEvent(): Record<string, unknown> {
    return {
      transaction: `POST /hooks/${endpoint}/${secret}`,
      culprit: `POST /hooks/${endpoint}/${secret}`,
      request: { url: `http://127.0.0.1:8800/hooks/${endpoint}/${secret}?x=1`, method: "POST" },
      tags: { url: `/hooks/${endpoint}/${secret}`, transaction: `POST /hooks/${endpoint}/${secret}` },
      spans: [
        {
          description: `POST /hooks/${endpoint}/${secret}`,
          data: {
            "http.url": `http://127.0.0.1:8800/hooks/${endpoint}/${secret}`,
            "url.full": `http://127.0.0.1:8800/hooks/${endpoint}/${secret}`,
          },
        },
      ],
      breadcrumbs: [{ category: "console", message: `delivery rejected for bearer ${secret}` }],
      exception: { values: [{ type: "Error", value: `boom at /hooks/${endpoint}/${secret}` }] },
    };
  }

  it("rewrites the path secret and keeps the endpoint id", () => {
    expect(scrubWebhookSecrets(`POST /hooks/${endpoint}/${secret}`)).toBe(`POST /hooks/${endpoint}/:secret`);
    expect(scrubWebhookSecrets(`/hooks/${endpoint}/plain-secret?a=b`)).toBe(`/hooks/${endpoint}/:secret?a=b`);
    expect(scrubWebhookSecrets(`token ${secret} leaked`)).toBe("token whsec_[redacted] leaked");
    expect(scrubWebhookSecrets("nothing to see")).toBe("nothing to see");
    // A bare endpoint path with no secret segment is left as it is.
    expect(scrubWebhookSecrets(`/hooks/${endpoint}`)).toBe(`/hooks/${endpoint}`);
  });

  it("scrubs every field of an event passed through the init hooks", async () => {
    const hooks = await initWithStandIn();
    for (const hook of [hooks.beforeSend, hooks.beforeSendTransaction]) {
      const out = hook(leakyEvent());
      const wire = JSON.stringify(out);
      expect(wire).not.toContain("whsec_xyz");
      expect(wire).not.toContain(secret);
      expect(wire).toContain(`/hooks/${endpoint}/:secret`);
      expect(out.transaction).toBe(`POST /hooks/${endpoint}/:secret`);
      expect((out.request as { url: string }).url).toBe(
        `http://127.0.0.1:8800/hooks/${endpoint}/:secret?x=1`,
      );
      expect(wire).toContain("whsec_[redacted]");
    }
    const log = hooks.beforeSendLog({ level: "warn", message: `retrying ${secret}`, attributes: {} });
    expect(JSON.stringify(log)).not.toContain(secret);
  });

  it("drops the incoming /hooks/* server span", async () => {
    const hooks = await initWithStandIn();
    const http = hooks.integrations.find((integration) => integration.name === "Http");
    expect(http?.options?.ignoreIncomingRequests?.(`/hooks/${endpoint}/${secret}`)).toBe(true);
    expect(http?.options?.ignoreIncomingRequests?.("/api/bots")).toBe(false);
    expect(hooks.integrations.some((integration) => integration.name === "ConsoleLogs")).toBe(true);
    expect(isWebhookIngressPath("/health")).toBe(false);
  });

  it("survives cycles and leaves non-string values alone", () => {
    const event: Record<string, unknown> = { count: 3, ok: true, nothing: null, url: `/hooks/${endpoint}/${secret}` };
    event.self = event;
    const out = scrubSentryPayload(event);
    expect(out.url).toBe(`/hooks/${endpoint}/:secret`);
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
    expect(out.nothing).toBeNull();
    expect(out.self).toBe(out);
  });

  it("never writes into class instances, getters or sdkProcessingMetadata", () => {
    class LiveScope {
      get $(): string[] {
        return [`/hooks/${endpoint}/${secret}`];
      }
    }
    const scope = new LiveScope();
    const meta = { note: `/hooks/${endpoint}/${secret}` };
    const holder = {};
    Object.defineProperty(holder, "fresh", { enumerable: true, get: () => ({ url: `/hooks/${endpoint}/${secret}` }) });
    const event = { scope, sdkProcessingMetadata: meta, holder, message: `/hooks/${endpoint}/${secret}` };
    expect(() => scrubSentryPayload(event)).not.toThrow();
    expect(event.message).toBe(`/hooks/${endpoint}/:secret`);
    expect(event.scope).toBe(scope);
    expect(meta.note).toContain(secret);
  });

  it("drops the payload rather than throwing out of a before-send hook", () => {
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("getter blew up");
      },
    });
    expect(safeScrubHook({ nested: hostile })).toBeNull();
  });
});
