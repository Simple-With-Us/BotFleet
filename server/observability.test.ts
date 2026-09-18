import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observabilitySettings, type AppConfig } from "./config.ts";
import { observability, observabilityBootLine } from "./observability.ts";
import { isSentryActive, resetSentryForTests, setSentryLoaderForTests } from "./sentry.ts";

// Obviously fake.  Nothing in this suite may ever reach a real ingest host,
// and the key halves below are what the leak assertions search for.
const CONFIG_DSN = "https://config0key@o0.ingest.sentry.io/1";
const ENV_DSN = "https://env0key@o9.ingest.sentry.io/2";
/** Same ingest host, same project id, rotated public key — the shape a
 * host-and-project comparison cannot tell apart from CONFIG_DSN. */
const ROTATED_DSN = "https://rotated0key@o0.ingest.sentry.io/1";
/** Passes a "non-empty username, non-empty last segment" check and fails
 * @sentry/core's own `DSN_REGEX`, whose public key is `\w+` — no hyphens.
 * The SDK answers a DSN it cannot parse by printing the whole string,
 * public key included, through `console.error`, so this shape has to be
 * refused before it ever reaches `Sentry.init`. */
const UUID_KEY_DSN = "https://a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c@o123.ingest.sentry.io/456";
const KEY_FRAGMENTS = ["config0key", "env0key", "rotated0key", "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c"];

type SentryNode = typeof import("@sentry/node");
type SentryInitOptions = Parameters<SentryNode["init"]>[0];

interface FakeSentryRecord {
  inits: SentryInitOptions[];
  closes: number;
  flushes: number;
  messages: string[];
  tags: Array<[string, string]>;
}

/** A stand-in for @sentry/node.  Records what the runtime asked it to do so
 * a test can assert on init, close, and flush without a real client. */
function fakeSentry(options: { acceptsDsn?: boolean } = {}) {
  const record: FakeSentryRecord = {
    inits: [],
    closes: 0,
    flushes: 0,
    messages: [],
    tags: [],
  };
  // SAFETY: an empty object is a legitimate starting point for a stand-in —
  // the runtime reaches for only the seven members stamped on below, and any
  // other member it grew would fail loudly here rather than silently pass.
  const sdk = Object.assign({} as SentryNode, {
    init(options: SentryInitOptions) {
      record.inits.push(options);
    },
    close() {
      record.closes += 1;
      return Promise.resolve(true);
    },
    flush() {
      record.flushes += 1;
      return Promise.resolve(true);
    },
    addIntegration() {},
    consoleLoggingIntegration(options?: Parameters<SentryNode["consoleLoggingIntegration"]>[0]) {
      return { name: "ConsoleLogs", options };
    },
    withScope<T>(callback: (scope: { setTag(key: string, value: string): void }) => T): T {
      return callback({
        setTag: (key, value) => {
          record.tags.push([key, value]);
        },
      });
    },
    captureMessage(message: string) {
      record.messages.push(message);
      return "evt0000000000000000000000000000ab";
    },
  });
  // Only stamped when a test asks for it: the real SDK answers a DSN its own
  // parser refused by building a client that kept none, and `init` never
  // throws.  A stand-in without `getClient` stands for "cannot tell", which
  // is what the runtime has to treat as fine.
  if (options.acceptsDsn !== undefined) {
    Object.assign(sdk, {
      getClient: () => ({ getDsn: () => (options.acceptsDsn ? { host: "o0.ingest.sentry.io" } : undefined) }),
    });
  }
  return { record, loader: () => sdk };
}

function useConfig(cfg: AppConfig): void {
  observability.configure(() => observabilitySettings(cfg));
}

beforeEach(() => {
  resetSentryForTests();
  observability.resetForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
  delete process.env.SENTRY_ENV;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});

afterEach(() => {
  resetSentryForTests();
  observability.resetForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
  delete process.env.SENTRY_ENV;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});

describe("observability status resolution", () => {
  it("reports an unconfigured install as off rather than pretending", async () => {
    useConfig({});
    const status = observability.getStatus();
    expect(status).toMatchObject({
      enabled: false,
      requestedEnabled: true,
      configured: false,
      source: "none",
      host: null,
      projectId: null,
    });
    expect(observability.effectiveDsn()).toBeNull();
    expect(observabilityBootLine(status)).toBe(
      "[sentry] disabled: no DSN configured (set one in Settings > Observability)",
    );
  });

  it("lets an environment DSN win over the stored one and says so", async () => {
    process.env.SENTRY_DSN = ENV_DSN;
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });
    const status = observability.getStatus();
    expect(status.source).toBe("env");
    expect(status.host).toBe("o9.ingest.sentry.io");
    expect(status.projectId).toBe("2");
    expect(observability.effectiveDsn()).toBe(ENV_DSN);
  });

  it("uses the stored DSN when the environment has none", async () => {
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });
    const status = observability.getStatus();
    expect(status).toMatchObject({
      source: "config",
      configured: true,
      enabled: true,
      requestedEnabled: true,
      host: "o0.ingest.sentry.io",
      projectId: "1",
    });
  });

  it("reports an explicit zero trace sample rate as zero, not as the default", async () => {
    useConfig({ observability: { sentryDsn: CONFIG_DSN, tracesSampleRate: 0 } });
    const status = observability.getStatus();
    expect(status.tracesSampleRate).toBe(0);
    expect(observabilityBootLine(status)).toContain("traces=0 ");
  });

  it("falls back to the shipped sample rate when nothing is stored", async () => {
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });
    expect(observability.getStatus().tracesSampleRate).toBe(0.2);
  });
});

describe("observability kill switch", () => {
  it("keeps Sentry off when diagnostics are turned off, DSN or no DSN", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    useConfig({ observability: { sentryDsn: CONFIG_DSN, enabled: false } });

    const status = await observability.apply();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.requestedEnabled).toBe(false);
    expect(isSentryActive()).toBe(false);
    expect(record.inits).toHaveLength(0);
    expect(observabilityBootLine(status)).toBe(
      "[sentry] disabled by settings: a DSN is stored, diagnostics are turned off",
    );
  });

  it("starts the client when the switch is on and stops it the moment it flips", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    const cfg: AppConfig = { observability: { sentryDsn: CONFIG_DSN } };
    useConfig(cfg);

    expect((await observability.apply()).enabled).toBe(true);
    expect(isSentryActive()).toBe(true);
    expect(record.inits).toHaveLength(1);
    expect(record.inits[0]).toMatchObject({ dsn: CONFIG_DSN, sendDefaultPii: false, enableLogs: true });

    cfg.observability = { ...cfg.observability, enabled: false };
    expect((await observability.apply()).enabled).toBe(false);
    expect(isSentryActive()).toBe(false);
    expect(record.closes).toBe(1);
  });

  it("re-initialises on a changed DSN and leaves an unchanged one alone", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    const cfg: AppConfig = { observability: { sentryDsn: CONFIG_DSN } };
    useConfig(cfg);

    await observability.apply();
    await observability.apply();
    expect(record.inits).toHaveLength(1);
    expect(record.closes).toBe(0);

    cfg.observability = { sentryDsn: ENV_DSN };
    await observability.apply();
    expect(record.inits).toHaveLength(2);
    expect(record.closes).toBe(1);
  });

  // A credential rotation keeps the ingest host and the project id, so a
  // fingerprint built from those alone reports the new configuration as
  // active while the harness quietly goes on using the revoked key.
  it("re-initialises when only the public key changes", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    const cfg: AppConfig = { observability: { sentryDsn: CONFIG_DSN } };
    useConfig(cfg);

    await observability.apply();
    expect(record.inits).toHaveLength(1);
    expect(record.inits[0]).toMatchObject({ dsn: CONFIG_DSN });

    cfg.observability = { sentryDsn: ROTATED_DSN };
    const status = await observability.apply();
    expect(record.closes).toBe(1);
    expect(record.inits).toHaveLength(2);
    expect(record.inits[1]).toMatchObject({ dsn: ROTATED_DSN });
    expect(isSentryActive()).toBe(true);

    // The host and the project id are unchanged, which is exactly why the
    // digest had to carry the difference — and neither key may surface.
    expect(status.host).toBe("o0.ingest.sentry.io");
    expect(status.projectId).toBe("1");
    const serialized = JSON.stringify(status);
    for (const fragment of KEY_FRAGMENTS) expect(serialized).not.toContain(fragment);
  });

  it("reaches the SDK when only the sample rate changes", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    const cfg: AppConfig = { observability: { sentryDsn: CONFIG_DSN } };
    useConfig(cfg);

    await observability.apply();
    cfg.observability = { sentryDsn: CONFIG_DSN, tracesSampleRate: 0 };
    await observability.apply();
    expect(record.inits).toHaveLength(2);
    expect(record.inits[1]).toMatchObject({ tracesSampleRate: 0 });
  });

  it("forwards warnings and errors as logs only when logs are on", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    const cfg: AppConfig = { observability: { sentryDsn: CONFIG_DSN } };
    useConfig(cfg);

    await observability.apply();
    expect(record.inits.at(0)?.integrations).toHaveLength(1);

    cfg.observability = { sentryDsn: CONFIG_DSN, logsEnabled: false };
    await observability.apply();
    expect(record.inits.at(1)?.integrations).toHaveLength(0);
  });
});

describe("observability leak boundaries", () => {
  it("never puts the DSN key in a status field or a log line", async () => {
    const { loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    process.env.SENTRY_DSN = ENV_DSN;
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });

    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
    try {
      const status = await observability.apply();
      logged.push(observabilityBootLine(status));
      const serialized = JSON.stringify(status);
      for (const fragment of KEY_FRAGMENTS) {
        expect(serialized).not.toContain(fragment);
        expect(logged.join("\n")).not.toContain(fragment);
      }
      expect(serialized).not.toContain("@");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("hands the full DSN to the renderer route and only there", async () => {
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });
    expect(observability.effectiveDsn()).toBe(CONFIG_DSN);
    expect(JSON.stringify(observability.getStatus())).not.toContain("config0key");
  });
});

describe("observability probe", () => {
  it("does not start the SDK when the install has no DSN", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    useConfig({});

    const result = await observability.probe();
    expect(result).toEqual({ ok: false, error: "Set a Sentry DSN first.", eventId: null });
    expect(record.inits).toHaveLength(0);
    expect(isSentryActive()).toBe(false);
  });

  it("refuses to send while diagnostics are turned off", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    useConfig({ observability: { sentryDsn: CONFIG_DSN, enabled: false } });

    const result = await observability.probe();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("turned off");
    expect(record.inits).toHaveLength(0);
  });

  it("sends one tagged event and counts it", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });

    const result = await observability.probe();
    expect(result.ok).toBe(true);
    expect(result.eventId).toBe("evt0000000000000000000000000000ab");
    expect(record.messages).toEqual(["BotFleet observability test"]);
    expect(record.tags).toContainEqual(["botfleet.probe", "true"]);
    expect(record.flushes).toBe(1);
    expect(observability.getStatus().totalCaptured).toBe(1);
    expect(observability.getStatus().lastEventAt).not.toBeNull();
  });

  it("counts captures reported by the AI sink", async () => {
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });
    observability.noteCapture();
    observability.noteCapture();
    expect(observability.getStatus().totalCaptured).toBe(2);
  });
});

describe("observability malformed DSN", () => {
  it("propagates a stored non-DSN so the runtime can name it, rather than dropping it as unconfigured", async () => {
    useConfig({ observability: { sentryDsn: "https://o0.ingest.sentry.io/1" } });
    const status = observability.getStatus();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.source).toBe("config");
    expect(status.host).toBeNull();
    expect(status.lastError).toBe("The stored DSN is not a Sentry https:// DSN.");

    const line = observabilityBootLine(status);
    expect(line).toBe("[sentry] misconfigured (config): The stored DSN is not a Sentry https:// DSN.");
    expect(line).not.toContain("enabled");
  });

  // The boot line is what an operator (and this plan's own verification
  // steps) greps for the word "enabled".  A DSN that never started the SDK
  // must not produce a line that opens with it, however honest the suffix.
  it("names the problem when the environment pins a non-DSN", async () => {
    process.env.SENTRY_DSN = "http://key@o0.ingest.sentry.io/1";
    useConfig({});
    const status = await observability.apply();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.host).toBeNull();
    expect(status.lastError).toBe("The stored DSN is not a Sentry https:// DSN.");

    const line = observabilityBootLine(status);
    expect(line).toBe("[sentry] misconfigured (env): The stored DSN is not a Sentry https:// DSN.");
    expect(line).not.toContain("enabled");
  });

  it("says the same thing before any apply() has run", async () => {
    process.env.SENTRY_DSN = "http://key@o0.ingest.sentry.io/1";
    useConfig({});
    const status = observability.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.lastError).toBe("The stored DSN is not a Sentry https:// DSN.");
  });

  // @sentry/core's DSN grammar is stricter than "has a username and a last
  // path segment": the public key is `\w+`, so a UUID-shaped key (common on
  // self-hosted Sentry-compatible ingest, and a routine copy-paste artifact)
  // fails it.  When it does, the SDK prints the complete DSN through its own
  // console.error and then captures nothing — so accepting one here both
  // leaks the key to the harness log and reports a fleet as watched when it
  // is not.
  it("refuses a DSN the SDK itself would reject, before init can print it", async () => {
    const { record, loader } = fakeSentry();
    setSentryLoaderForTests(loader);
    process.env.SENTRY_DSN = UUID_KEY_DSN;
    useConfig({});

    const logged: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args.join(" "));
      }),
    );
    try {
      const status = await observability.apply();
      logged.push(observabilityBootLine(status));

      expect(record.inits).toHaveLength(0);
      expect(isSentryActive()).toBe(false);
      expect(status.configured).toBe(true);
      expect(status.enabled).toBe(false);
      expect(status.host).toBeNull();
      expect(status.projectId).toBeNull();
      expect(status.lastError).toBe("The stored DSN is not a Sentry https:// DSN.");
      expect(observabilityBootLine(status)).toBe(
        "[sentry] misconfigured (env): The stored DSN is not a Sentry https:// DSN.",
      );

      const transcript = `${logged.join("\n")}\n${JSON.stringify(status)}`;
      for (const fragment of KEY_FRAGMENTS) expect(transcript).not.toContain(fragment);
      expect(transcript).not.toContain(UUID_KEY_DSN);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuses a project id that is not a number", async () => {
    process.env.SENTRY_DSN = "https://abc123@o0.ingest.sentry.io/not-a-project";
    useConfig({});
    const status = observability.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.host).toBeNull();
  });
});

describe("observability SDK-side DSN rejection", () => {
  // Defence in depth for the day the SDK's grammar moves past ours: init
  // does not throw on a DSN it discarded, it just builds a client holding
  // none.  Reporting that as running is the failure this whole module exists
  // to prevent, so the client is asked what it kept.
  it("reports a client that kept no DSN as inactive, not as running", async () => {
    const { record, loader } = fakeSentry({ acceptsDsn: false });
    setSentryLoaderForTests(loader);
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });

    const status = await observability.apply();
    expect(record.inits).toHaveLength(1);
    expect(isSentryActive()).toBe(false);
    expect(status.lastError).toContain("Sentry refused this DSN");
    expect(observabilityBootLine(status)).toContain("[sentry] misconfigured (config)");
  });

  it("leaves a client that kept its DSN alone", async () => {
    const { loader } = fakeSentry({ acceptsDsn: true });
    setSentryLoaderForTests(loader);
    useConfig({ observability: { sentryDsn: CONFIG_DSN } });

    const status = await observability.apply();
    expect(isSentryActive()).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.lastError).toBeNull();
  });
});
