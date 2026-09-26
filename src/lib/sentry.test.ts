import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachFeedbackEventDetails,
  buildFallbackIssueUrl,
  captureException,
  captureMessage,
  initSentry,
  initSentryFromRuntime,
  isSentryFeedbackAvailable,
  refreshSentryFromRuntime,
  resetSentryForTests,
  setActiveFeedbackDetailsForTests,
  setObservabilityReaderForTests,
  setSentryModuleLoaderForTests,
  setSentryPortForTests,
  type ObservabilityReader,
  type RuntimeObservability,
  type SentryBrowserPort,
  type SentryClientOptions,
  type SentryModule,
} from "./sentry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Obviously fake.  Nothing in this suite may ever reach a real ingest host.
const RUNTIME_DSN = "https://abc123@o0.ingest.sentry.io/1";
// Same host, same project, rotated key — the shape a host-and-project
// comparison would wrongly call "unchanged".
const ROTATED_DSN = "https://def456@o0.ingest.sentry.io/1";
const BUILD_DSN = "https://build0key@o1.ingest.sentry.io/2";

interface FakeSentryRecord {
  inits: SentryClientOptions[];
  closes: number;
  running: boolean;
}

interface FakeSentry {
  record: FakeSentryRecord;
  port: SentryBrowserPort;
}

/** A stand-in for the browser SDK.  Records what the module asked it to do
 * so a test can assert on the close-and-re-init path without a real client
 * and without mocking the @sentry/react module. */
function fakeSentryPort(): FakeSentry {
  const record: FakeSentryRecord = { inits: [], closes: 0, running: false };
  const close = (): Promise<boolean> => {
    record.closes += 1;
    record.running = false;
    return Promise.resolve(true);
  };
  return {
    record,
    port: {
      init(options: SentryClientOptions): void {
        record.inits.push(options);
        record.running = true;
      },
      close,
      getClient: () => (record.running ? { close } : undefined),
    },
  };
}

interface FakeHarness {
  /** Script the next answer from `GET /api/observability`. */
  answer(next: RuntimeObservability | null): void;
  /** How many times the renderer has asked. */
  calls(): number;
  read: ObservabilityReader;
}

/** The harness answering `GET /api/observability`, scripted per test. */
function fakeHarness(): FakeHarness {
  let scripted: RuntimeObservability | null = null;
  let seen = 0;
  return {
    answer(next: RuntimeObservability | null): void {
      scripted = next;
    },
    calls: () => seen,
    read: async () => {
      seen += 1;
      return scripted;
    },
  };
}

describe("browser Sentry", () => {
  it("keeps Replay 100% on error / 10% session, Feedback, and mask-all privacy", () => {
    const src = readFileSync(join(ROOT, "src/lib/sentry.ts"), "utf8");
    expect(src).toMatch(/VITE_SENTRY_DSN/);
    expect(src).toMatch(/replaysSessionSampleRate[\s\S]*\?\? "0\.1"/);
    expect(src).toMatch(/replaysOnErrorSampleRate[\s\S]*\?\? "1\.0"/);
    expect(src).toMatch(/maskAllText:\s*true/);
    expect(src).toMatch(/blockAllMedia:\s*true/);
    expect(src).toMatch(/feedbackIntegration\(/);
    expect(src).toMatch(/autoInject:\s*false/);
    expect(src).toMatch(/enableLogs:\s*true/);
    expect(src).toMatch(/sendDefaultPii:\s*false/);
    expect(src).toMatch(/genAI:\s*\{\s*inputs:\s*false,\s*outputs:\s*false/);
  });

  it("iOS Cocoa reads SENTRY_DSN from Info.plist only", () => {
    const swift = readFileSync(join(ROOT, "ios/App/SentryTelemetry.swift"), "utf8");
    expect(swift).toMatch(/forInfoDictionaryKey: "SENTRY_DSN"/);
    expect(swift).toMatch(/profilesSampleRate = 0\.1/);
    expect(swift).toMatch(/sessionReplay\.onErrorSampleRate = 0\.1/);
    expect(swift).not.toMatch(/ingest\.sentry\.io/);
    expect(swift).not.toMatch(/\?\? "https:\/\//);
    const yml = readFileSync(join(ROOT, "ios/project.yml"), "utf8");
    expect(yml).toMatch(/^\s+SENTRY_DSN:\s*""\s*$/m);
    expect(yml).toMatch(/^\s+SENTRY_DSN:\s*\$\(SENTRY_DSN\)\s*$/m);
    expect(yml).not.toMatch(/SENTRY_DSN:\s*"https:\/\//);
  });
});

// The renderer has its own Sentry client, and it used to be resolved exactly
// once at startup.  Disabling, removing, or replacing diagnostics in
// Settings reconfigured only the harness, so this window went on sending
// traces and replays to the DSN it booted with until someone reloaded it.
describe("renderer diagnostics refresh", () => {
  let sentry = fakeSentryPort();
  let harness = fakeHarness();

  beforeEach(() => {
    resetSentryForTests();
    sentry = fakeSentryPort();
    harness = fakeHarness();
    setSentryPortForTests(sentry.port);
    setObservabilityReaderForTests(harness.read);
    // The module refuses to touch the SDK outside a window.
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetSentryForTests();
  });

  it("closes the old client and re-inits when the harness answers differently", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({
      dsn: RUNTIME_DSN,
      environment: "production",
      tracesSampleRate: 0.2,
    });

    harness.answer({ enabled: true, dsn: ROTATED_DSN, environment: "staging", tracesSampleRate: 0.5 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(2);
    expect(sentry.record.inits[1]).toMatchObject({
      dsn: ROTATED_DSN,
      environment: "staging",
      tracesSampleRate: 0.5,
    });
  });

  it("prefers uiTracesSampleRate over tracesSampleRate when reported by the runtime", async () => {
    harness.answer({
      enabled: true,
      dsn: RUNTIME_DSN,
      environment: "production",
      tracesSampleRate: 0.2,
      uiTracesSampleRate: 0.05,
    });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({
      dsn: RUNTIME_DSN,
      environment: "production",
      tracesSampleRate: 0.05,
    });
  });

  it("closes the client when the kill switch goes off, and starts nothing", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);

    harness.answer({ enabled: false, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);

    // Still off, and a second look does not re-open it.
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
  });

  it("closes the client when the diagnostics key is removed", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();

    harness.answer({ enabled: true, dsn: null, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
  });

  it("does nothing at all when the answer is unchanged", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);

    await refreshSentryFromRuntime();
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
  });

  it("starts reporting when a DSN is added after boot", async () => {
    harness.answer({ enabled: true, dsn: null });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({ dsn: RUNTIME_DSN });
    expect(sentry.record.closes).toBe(0);
  });

  it("applies the runtime kill switch to a packaged build and can re-enable with a changed key", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    vi.stubEnv("VITE_SENTRY_ENV", "production");
    vi.stubEnv("VITE_SENTRY_TRACES_SAMPLE_RATE", "0.2");
    vi.stubEnv("VITE_SENTRY_REPLAY_ENABLED", "false");
    initSentry();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({
      dsn: BUILD_DSN,
      replayEnabled: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });

    harness.answer({ enabled: false, requestedEnabled: false, dsn: null });
    await initSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);

    harness.answer({ enabled: false, requestedEnabled: true, dsn: null, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(2);
    expect(sentry.record.inits[1]).toMatchObject({ dsn: BUILD_DSN });

    harness.answer({ enabled: true, requestedEnabled: true, dsn: ROTATED_DSN, environment: "staging", tracesSampleRate: 0.5 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(2);
    expect(sentry.record.inits).toHaveLength(3);
    expect(sentry.record.inits[2]).toMatchObject({
      dsn: ROTATED_DSN,
      environment: "staging",
      tracesSampleRate: 0.5,
      replayEnabled: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });

    harness.answer({ enabled: false, requestedEnabled: true, dsn: null });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(3);
    expect(sentry.record.inits).toHaveLength(4);
    expect(sentry.record.inits[3]).toMatchObject({ dsn: BUILD_DSN });
    expect(harness.calls()).toBe(4);
  });

  it("does not start the packaged client before the saved opt-out is known", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    let finishBoot: ((value: RuntimeObservability) => void) | undefined;
    setObservabilityReaderForTests(() => new Promise((resolve) => { finishBoot = resolve; }));

    const boot = initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    finishBoot?.({ enabled: false, requestedEnabled: false, dsn: null });
    await boot;
    expect(sentry.record.inits).toHaveLength(0);
    expect(sentry.record.closes).toBe(0);
  });

  it("starts the packaged default only after a successful enabled runtime read", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    harness.answer({ enabled: false, requestedEnabled: true, dsn: null });

    await initSentryFromRuntime();

    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({ dsn: BUILD_DSN });
  });

  it("keeps a packaged client running when the runtime status is unavailable", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    harness.answer(null);

    await initSentryFromRuntime();

    expect(harness.calls()).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
    expect(sentry.record.running).toBe(true);
  });

  it("keeps normal packaged diagnostics when the harness is merely unconfigured", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    harness.answer({ enabled: false, requestedEnabled: true, dsn: null });

    await initSentryFromRuntime();

    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
    expect(sentry.record.running).toBe(true);
  });

  it("ignores a stale boot answer when a newer Settings refresh finishes first", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    let finishBoot: ((value: RuntimeObservability) => void) | undefined;
    setObservabilityReaderForTests(() => new Promise((resolve) => { finishBoot = resolve; }));
    const boot = initSentryFromRuntime();

    setObservabilityReaderForTests(async () => ({ enabled: false, requestedEnabled: false, dsn: null }));
    await refreshSentryFromRuntime();
    finishBoot?.({ enabled: true, requestedEnabled: true, dsn: RUNTIME_DSN });
    await boot;

    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.running).toBe(false);
  });

  it("stays inert when the harness will not answer", async () => {
    harness.answer(null);
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);
    expect(sentry.record.closes).toBe(0);
  });

  it("buildFallbackIssueUrl bounds total encoded length and safely handles surrogate pairs and lone surrogates", () => {
    const hugeMessageWithEmoji = "Error: 🔥 something crashed 🚨 " + "x".repeat(10000) + " 💥";
    const url = buildFallbackIssueUrl("Error in Bot", hugeMessageWithEmoji, 2000);
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(url).toContain("https://github.com/jaywedgeworth22/BotFleet/issues/new?title=");
    expect(url).toContain("Error%20in%20Bot");
    // Verify decodeURIComponent does not throw (meaning surrogate pairs were not split)
    expect(() => decodeURIComponent(url)).not.toThrow();

    // Lone surrogate string
    const loneSurrogate = "Broken surrogate: \uD800 invalid character";
    expect(() => buildFallbackIssueUrl("Issue \uD800", loneSurrogate)).not.toThrow();
    const loneUrl = buildFallbackIssueUrl("Issue \uD800", loneSurrogate);
    expect(() => decodeURIComponent(loneUrl)).not.toThrow();

    // Verify without native toWellFormed (Safari < 16.4 fallback path)
    const orig = (String.prototype as unknown as Record<string, unknown>).toWellFormed;
    try {
      delete (String.prototype as unknown as Record<string, unknown>).toWellFormed;
      const fallbackUrl = buildFallbackIssueUrl("Fallback \uD800", "Lone \uDC00 and pair \uD83D\uDE00");
      expect(() => decodeURIComponent(fallbackUrl)).not.toThrow();
      expect(fallbackUrl).toContain(encodeURIComponent("\uFFFD"));
      expect(fallbackUrl).toContain(encodeURIComponent("😀"));
    } finally {
      (String.prototype as unknown as Record<string, unknown>).toWellFormed = orig;
    }
  });

  it("isSentryFeedbackAvailable reflects client initialization state", () => {
    // When reset/uninitialized
    expect(isSentryFeedbackAvailable()).toBe(false);
  });

  it("attachFeedbackEventDetails binds diagnostic details strictly to feedback events", () => {
    setActiveFeedbackDetailsForTests("Diagnostic crash stack trace");

    // Standard exception or message event (not feedback)
    const errorEvent = { message: "Network timeout" } as import("@sentry/react").Event;
    const processedError = attachFeedbackEventDetails(errorEvent);
    expect(processedError.contexts).toBeUndefined();

    // Feedback event
    const feedbackEvent = { type: "feedback", contexts: { user_tag: { value: "user" } } } as import("@sentry/react").Event;
    const processedFeedback = attachFeedbackEventDetails(feedbackEvent);
    expect(processedFeedback.contexts).toEqual({
      user_tag: { value: "user" },
      reported_problem: {
        error_details: "Diagnostic crash stack trace",
      },
    });

    // When details cleared
    setActiveFeedbackDetailsForTests(null);
    const clearedFeedback = attachFeedbackEventDetails({ type: "feedback" } as import("@sentry/react").Event);
    expect(clearedFeedback.contexts).toBeUndefined();
  });

  // UI3: @sentry/react is a dynamic import now, so a capture made before
  // anything ever asked to load it (no init() this session) must not throw
  // and must not pretend an event was sent.
  it("captureException/captureMessage drop and report nothing when the SDK was never asked to load", () => {
    expect(captureException(new Error("boom"))).toBeUndefined();
    expect(captureMessage("boom")).toBeUndefined();
  });
});

// The capture functions and the init/close race below drive the REAL
// browserPort (sentryPort is left as its default), with the dynamic
// `import("@sentry/react")` itself swapped for a stand-in — so these cover
// the loader-and-queue behavior UI3 added without ever loading the real SDK,
// the same non-goal the fakeSentryPort suite above already keeps.
describe("browser Sentry capture gate and queue", () => {
  // Kept as separate typed vi.fn() references, asserted on directly — a
  // fake cast through `as unknown as SentryModule` would re-type these
  // members as the real SDK's plain function signatures on the way out,
  // losing the Mock-only matchers (toHaveBeenCalled, toHaveBeenCalledWith).
  let fakeInit: ReturnType<typeof vi.fn>;
  let fakeCaptureException: ReturnType<typeof vi.fn>;
  let fakeModule: SentryModule;
  let resolveLoad: ((module: SentryModule) => void) | undefined;

  beforeEach(() => {
    resetSentryForTests();
    vi.stubGlobal("window", {});
    resolveLoad = undefined;
    fakeInit = vi.fn();
    fakeCaptureException = vi.fn(() => "fake-event-id");
    fakeModule = {
      init: fakeInit,
      close: () => Promise.resolve(true),
      getClient: () => undefined,
      browserTracingIntegration: () => ({}),
      feedbackIntegration: () => ({}),
      replayIntegration: () => ({}),
      ErrorBoundary: () => null,
      captureException: fakeCaptureException,
      captureMessage: vi.fn(() => "fake-event-id"),
      addEventProcessor: vi.fn(),
      getFeedback: () => undefined,
    } as unknown as SentryModule;
    setSentryModuleLoaderForTests(() => new Promise((resolve) => { resolveLoad = resolve; }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setSentryModuleLoaderForTests(null);
    resetSentryForTests();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("queues a capture made while the SDK is loading and delivers it once init() resolves", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://fake@o0.ingest.sentry.io/1");
    initSentry(); // real browserPort.init() — routed through the fake loader above, not a network import

    const eventId = captureException(new Error("boom"));
    expect(eventId).toBeUndefined(); // nothing to hand back yet — queued, not sent
    expect(fakeCaptureException).not.toHaveBeenCalled();

    resolveLoad?.(fakeModule);
    await settle();

    expect(fakeInit).toHaveBeenCalledTimes(1); // the client actually started
    expect(fakeCaptureException).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it("cancels a pending init() when an opt-out closes the client before the load resolves", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://fake@o0.ingest.sentry.io/1");
    setObservabilityReaderForTests(async () => ({ requestedEnabled: false, enabled: false, dsn: null }));

    initSentry(); // begins loading via the fake loader; sets runtimeIdentity synchronously
    // requestedEnabled: false → applyRuntimeObservability → closeClient() →
    // the real browserPort.close(), which bumps the generation synchronously.
    await refreshSentryFromRuntime();

    resolveLoad?.(fakeModule);
    await settle();

    // The import resolved AFTER close() asked to cancel it — init() must
    // never reach the real SDK, or a "closed" client would silently return.
    expect(fakeInit).not.toHaveBeenCalled();
  });
});
