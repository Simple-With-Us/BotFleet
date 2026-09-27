import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as http2Constants, type ClientHttp2Session } from "node:http2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  alertIsBlocking,
  apnsJwt,
  apnsPayload,
  classifyHttpResponse,
  classifyTransportError,
  createApnsHttp2Fetch,
  deliveryForKind,
  diskKeyFaultStore,
  dropHttp2Sessions,
  getOrOpenSession,
  inspectTransportError,
  isTransportFailure,
  providerToken,
  resetProviderTokens,
  retryAfterMs,
  sendApnsAlert,
  startHttp2PingKeepalive,
  tokenIsDead,
  watchHarnessNotifications,
  APNS_CIRCUIT_WINDOW_MS,
  APNS_TRANSPORT_SUMMARY_MS,
  APNS_TRANSPORT_THRESHOLD,
  type ApnsConfig,
  type ApnsPayload,
  type Http2ApnsSession,
  type Http2SessionFactory,
  type KeyFaultStore,
  type PersistedKeyFault,
  watchHttp2SessionLifecycle,
} from "./apns.ts";

function testP8(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function testConfig(overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    keyId: "ABC123",
    teamId: "TEAMID1",
    bundleId: "app.botfleet",
    p8: testP8(),
    production: true,
    ...overrides,
  };
}

/** Never sleep for real in a test; record what the sender asked for. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const rejection = (status: number, reason: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ reason }), { status, headers });

/** Top-level frame helpers — the in-describe definitions are scoped, so the
 * failure-classification + circuit-breaker tests reuse these. */
const moduleNotifyFrame = (kind: string, body = "done") =>
  `data: ${JSON.stringify({
    kind: "notify",
    notification: { kind, title: "Scout finished", body, threadId: "t1", botId: "b1" },
  })}\n\n`;

/** A promise someone else finishes.  The resolver lives on the object
 * because a `let` only ever assigned inside a callback is narrowed to
 * `never` by the time the test tries to call it. */
function deferred() {
  const gate = {
    started: false,
    resolve: () => {},
    promise: Promise.resolve(),
  };
  gate.promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  return gate;
}

/** Spin until the condition holds or the budget runs out.  Returns what the
 * condition said last, so a caller can assert on it rather than on a
 * timeout. */
async function waitFor(condition: () => boolean, budgetMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (!condition() && Date.now() - started < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

/** A key-fault store that lives in memory, so a test never writes one and
 * never inherits another test's. */
function memoryKeyFaultStore(initial: PersistedKeyFault | null = null): KeyFaultStore & { current: PersistedKeyFault | null } {
  const store = {
    current: initial,
    load: () => store.current,
    save: (fault: PersistedKeyFault | null) => {
      store.current = fault;
    },
  };
  return store;
}

const transportFailure = (errorCode = "ECONNRESET") => ({
  ok: false as const,
  status: 0,
  reason: "SendFailed",
  attempts: 1,
  failureKind: "transport" as const,
  errorCode,
});

beforeEach(() => {
  resetProviderTokens();
});

describe("apnsJwt", () => {
  it("builds a three-part ES256 token from a p8", () => {
    const jwt = apnsJwt({ keyId: "ABC123", teamId: "TEAMID1", p8: testP8() }, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: "ABC123" });
    expect(payload.iss).toBe("TEAMID1");
    expect(payload.iat).toBe(1_700_000_000);
  });
});

describe("deliveryForKind", () => {
  it("breaks a Focus only for the kinds that are blocked on you", () => {
    expect(deliveryForKind("approval").interruptionLevel).toBe("time-sensitive");
    expect(deliveryForKind("question").interruptionLevel).toBe("time-sensitive");
    for (const kind of ["done", "routine-failed", "takeover", undefined, "something-new"]) {
      expect(deliveryForKind(kind).interruptionLevel).toBe("active");
    }
  });

  it("ranks approvals above every other kind", () => {
    const scores = (["approval", "question", "takeover", "routine-failed", "done"] as const).map(
      (kind) => deliveryForKind(kind).relevanceScore,
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(deliveryForKind("approval").relevanceScore).toBe(1);
    expect(deliveryForKind(undefined).relevanceScore).toBeLessThan(deliveryForKind("done").relevanceScore);
  });

  it("gives a question its own category, so it never offers Approve and Deny", () => {
    // Both kinds are blocking, but a question wants an answer rather than a
    // verdict — sharing the approval category put two meaningless buttons
    // on it, and either one sent a permission verdict for free text.
    expect(deliveryForKind("approval").category).toBe("BOTFLEET_APPROVAL");
    expect(deliveryForKind("question").category).toBe("BOTFLEET_QUESTION");
    expect(deliveryForKind("done").category).toBe("BOTFLEET_UPDATE");
    expect(deliveryForKind("routine-failed").category).toBe("BOTFLEET_UPDATE");
    expect(deliveryForKind("takeover").category).toBe("BOTFLEET_UPDATE");
    // It still breaks a Focus: it is a bot blocked on a person.
    expect(deliveryForKind("question").interruptionLevel).toBe("time-sensitive");
  });

  it("knows which kinds have someone blocked behind them", () => {
    expect(alertIsBlocking("approval")).toBe(true);
    expect(alertIsBlocking("question")).toBe(true);
    for (const kind of ["done", "routine-failed", "takeover", undefined, "something-new"]) {
      expect(alertIsBlocking(kind)).toBe(false);
    }
  });
});

describe("apnsPayload", () => {
  it("carries the same userInfo keys the in-app path uses", () => {
    const payload = apnsPayload({
      title: "Scout",
      body: "needs you",
      kind: "approval",
      threadId: "t1",
      botId: "b1",
      requestId: "req-7",
      tool: "Bash",
    });
    expect(payload.threadId).toBe("t1");
    expect(payload.botId).toBe("b1");
    expect(payload.kind).toBe("approval");
    expect(payload.requestId).toBe("req-7");
    expect(payload.tool).toBe("Bash");
  });

  it("leaves the request id absent when the harness did not send one", () => {
    // An older harness sends no identity, and the phone falls back to the
    // thread's pending card — so absent has to stay a real shape.
    const payload = apnsPayload({ title: "Scout", body: "done", kind: "done", threadId: "t1" });
    expect(payload.requestId).toBeUndefined();
    expect(payload.tool).toBeUndefined();
  });

  it("carries the harness frame's sequence, so the phone can drop the replayed twin", () => {
    // The sidecar pushes only to a phone whose stream is down; that push
    // wakes the app, the app reconnects and the harness replays the very
    // frame the push was built from.  The sequence is what lets the phone
    // recognise the replay as something it has already been shown.
    expect(apnsPayload({ title: "t", body: "b", kind: "approval", seq: 41 }).seq).toBe(41);
    expect(apnsPayload({ title: "t", body: "b", kind: "approval" }).seq).toBeUndefined();
  });

  it("stamps an approval as time-sensitive, top-ranked, and actionable", () => {
    const { aps } = apnsPayload({ title: "Scout", body: "needs you", kind: "approval", threadId: "t1" });
    expect(aps.category).toBe("BOTFLEET_APPROVAL");
    expect(aps["interruption-level"]).toBe("time-sensitive");
    expect(aps["relevance-score"]).toBe(1);
    expect(aps["thread-id"]).toBe("t1");
    expect(aps["content-available"]).toBe(1);
    expect(aps.alert).toEqual({ title: "Scout", body: "needs you" });
  });

  it("keeps a report quiet and in the update category", () => {
    const { aps } = apnsPayload({ title: "Scout", body: "done", kind: "done" });
    expect(aps.category).toBe("BOTFLEET_UPDATE");
    expect(aps["interruption-level"]).toBe("active");
    expect(aps["relevance-score"]).toBe(0.4);
  });
});

describe("providerToken", () => {
  it("reuses one token for twenty minutes and signs a new one after", () => {
    const config = testConfig();
    const first = providerToken(config, 1_000_000);
    expect(providerToken(config, 1_000_000 + 19 * 60_000)).toBe(first);
    expect(providerToken(config, 1_000_000 + 21 * 60_000)).not.toBe(first);
  });

  it("keeps a rotated key apart from the one it replaced", () => {
    const first = providerToken(testConfig(), 1_000_000);
    const second = providerToken(testConfig(), 1_000_000);
    expect(second).not.toBe(first);
  });
});

describe("sendApnsAlert", () => {
  it("posts an alert with content-available so a suspended app can reconnect", async () => {
    const config = testConfig();
    const token = "ab".repeat(32);
    let url = "";
    let headers: Headers | undefined;
    let body: Partial<ApnsPayload> = {};
    const result = await sendApnsAlert(
      config,
      token,
      { title: "Scout finished", body: "done", kind: "done", threadId: "t1", botId: "b1" },
      {
        fetchImpl: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          // SAFETY: the body is the JSON this very call just serialised, so
          // the assertion restates what was written rather than trusting
          // anything that came off a network.
          body = JSON.parse(String(init?.body ?? "{}")) as ApnsPayload;
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(result).toEqual({ ok: true, status: 200, attempts: 1, failureKind: "none" });
    expect(url).toBe(`https://api.push.apple.com/3/device/${token}`);
    expect(headers?.get("apns-push-type")).toBe("alert");
    expect(headers?.get("apns-topic")).toBe("app.botfleet");
    expect(body.aps?.alert).toEqual({ title: "Scout finished", body: "done" });
    expect(body.aps?.["content-available"]).toBe(1);
    expect(body.aps?.category).toBe("BOTFLEET_UPDATE");
    expect(body.threadId).toBe("t1");
    expect(body.botId).toBe("b1");
    expect(body.kind).toBe("done");
  });

  it("uses the sandbox host when production is off", async () => {
    let url = "";
    await sendApnsAlert(
      testConfig({ production: false }),
      "cd".repeat(32),
      { title: "Hi", body: "there" },
      {
        fetchImpl: async (input) => {
          url = String(input);
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(url.startsWith("https://api.sandbox.push.apple.com/3/device/")).toBe(true);
  });

  it("reuses the cached provider token across sends inside the window", async () => {
    const config = testConfig();
    const authorizations: string[] = [];
    const fetchImpl = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200 });
    };
    let clock = 5_000_000;
    await sendApnsAlert(config, "ab".repeat(32), { title: "a", body: "b" }, { fetchImpl, now: () => clock });
    clock += 10 * 60_000;
    await sendApnsAlert(config, "ab".repeat(32), { title: "a", body: "b" }, { fetchImpl, now: () => clock });
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).toBe(authorizations[1]);
  });

  it("re-signs immediately when Apple says the provider token expired", async () => {
    const config = testConfig();
    const authorizations: string[] = [];
    const { waits, sleep } = recordingSleep();
    let call = 0;
    const result = await sendApnsAlert(
      config,
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        now: () => 6_000_000,
        fetchImpl: async (_input, init) => {
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          call += 1;
          return call === 1 ? rejection(403, "ExpiredProviderToken") : new Response("{}", { status: 200 });
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(authorizations[0]).not.toBe(authorizations[1]);
    // A stale token is not congestion — the retry goes straight back out.
    expect(waits).toEqual([]);
  });

  it("does not re-sign for InvalidProviderToken — the key itself is refused", async () => {
    // Expiry is worth a fresh signature.  An invalid token means Apple
    // refuses the KEY — wrong team, revoked, a .p8 that does not match its
    // key id — and every new signature earns the identical rejection.
    const config = testConfig();
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      config,
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(403, "InvalidProviderToken");
        },
      },
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "InvalidProviderToken",
      attempts: 1,
      failureKind: "key_fault",
      errorTimestamp: undefined,
    });
  });

  it("retries a 429 after the Retry-After Apple asked for", async () => {
    const { waits, sleep } = recordingSleep();
    let call = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          call += 1;
          return call === 1
            ? rejection(429, "TooManyRequests", { "retry-after": "7" })
            : new Response("{}", { status: 200 });
        },
      },
    );
    expect(result).toEqual({ ok: true, status: 200, attempts: 2, failureKind: "none" });
    expect(waits).toEqual([7000]);
  });

  it("backs off exponentially on a 503 and gives up after the attempt budget", async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(503, "ServiceUnavailable");
        },
      },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(result).toEqual({
      ok: false,
      status: 503,
      reason: "ServiceUnavailable",
      attempts: 3,
      failureKind: "rate_limit",
      errorCode: undefined,
      errorTimestamp: undefined,
    });
  });

  it("retries a thrown fetch inside the attempt budget, the same as a 503", async () => {
    // A reset connection, a DNS blip, a Wi-Fi drop — the most common
    // transient failure on a home link, and the only one the status ladder
    // cannot see.  Before this it escaped on attempt 1 and the alert was
    // gone, while a 503 got three tries.
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "aa".repeat(32),
      { title: "Scout", body: "needs approval" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          if (calls < 3) throw new TypeError("fetch failed");
          return new Response("", { status: 200 });
        },
      },
    );
    expect(result).toEqual({ ok: true, status: 200, attempts: 3, failureKind: "none" });
    expect(waits).toEqual([1000, 2000]);
  });

  it("reports a transport failure only once the ladder is spent", async () => {
    const { waits, sleep } = recordingSleep();
    const result = await sendApnsAlert(
      testConfig(),
      "aa".repeat(32),
      { title: "Scout", body: "needs approval" },
      {
        sleep,
        fetchImpl: async () => {
          throw new Error("ECONNRESET");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      status: 0,
      reason: "SendFailed",
      attempts: 3,
      failureKind: "transport",
      errorCode: undefined,
      errorTimestamp: undefined,
    });
    expect(waits).toEqual([1000, 2000]);
  });

  it("does not retry a 400 — the same request fails the same way", async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(400, "BadDeviceToken");
        },
      },
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      attempts: 1,
      failureKind: "bad_token",
      errorTimestamp: undefined,
    });
  });

  it("returns a 410 with its reason so the caller can drop the token", async () => {
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        fetchImpl: async () => {
          calls += 1;
          return rejection(410, "Unregistered");
        },
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: false,
      status: 410,
      reason: "Unregistered",
      attempts: 1,
      failureKind: "bad_token",
    });
  });
});

describe("tokenIsDead", () => {
  it("treats the permanent 400 reasons exactly like a 410", () => {
    expect(tokenIsDead(410, "Unregistered")).toBe(true);
    expect(tokenIsDead(400, "BadDeviceToken")).toBe(true);
    expect(tokenIsDead(400, "DeviceTokenNotForTopic")).toBe(true);
    // A 400 about the payload says nothing about the token.
    expect(tokenIsDead(400, "PayloadTooLarge")).toBe(false);
    expect(tokenIsDead(400, undefined)).toBe(false);
    expect(tokenIsDead(429, "TooManyRequests")).toBe(false);
    expect(tokenIsDead(503, "ServiceUnavailable")).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds, caps them, and ignores anything else", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("99999")).toBe(30_000);
    expect(retryAfterMs("-1")).toBeNull();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("watchHarnessNotifications", () => {
  const notifyFrameWithBody = (kind: string, body: string) =>
    `data: ${JSON.stringify({
      kind: "notify",
      notification: { kind, title: "Scout finished", body, threadId: "t1", botId: "b1" },
    })}\n\n`;

  const notifyFrame = (kind: string, identity: { requestId?: string; tool?: string } = {}) =>
    `data: ${JSON.stringify({
      kind: "notify",
      notification: { kind, title: "Scout finished", body: "done", threadId: "t1", botId: "b1", ...identity },
    })}\n\n`;

  it("APNs-wakes disconnected phones on notify frames and drops 410 tokens", async () => {
    const sent: { token: string; title: string; kind?: string }[] = [];
    const forgotten: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => ["online"],
      tokensForDisconnected: () => [
        { deviceId: "online", token: "aa".repeat(32) },
        { deviceId: "offline", token: "bb".repeat(32) },
        { deviceId: "stale", token: "cc".repeat(32) },
      ],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token, alert) => {
        sent.push({ token, title: alert.title, kind: alert.kind });
        return token === "cc".repeat(32)
          ? { ok: false, status: 410, reason: "Unregistered", attempts: 1 }
          : { ok: true, status: 200, attempts: 1 };
      },
      forgetToken: (id) => forgotten.push(id),
    });
    const started = Date.now();
    while (sent.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent.map((row) => row.token).sort()).toEqual(["bb".repeat(32), "cc".repeat(32)].sort());
    expect(sent.every((row) => row.title === "Scout finished")).toBe(true);
    // The kind is what decides how the push lands; it has to survive the hop.
    expect(sent.every((row) => row.kind === "approval")).toBe(true);
    expect(forgotten).toEqual(["stale"]);
  });

  it("forwards the request identity from the harness frame to the alert", async () => {
    const sent: { requestId?: string; tool?: string; kind?: string }[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval", { requestId: "req-7", tool: "Bash" }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, _token, alert) => {
        sent.push({ requestId: alert.requestId, tool: alert.tool, kind: alert.kind });
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent[0]).toEqual({ requestId: "req-7", tool: "Bash", kind: "approval" });
  });

  it("reports health: configured, tokens, the last send and the last error", async () => {
    const tokens = [
      { deviceId: "offline", token: "bb".repeat(32) },
      { deviceId: "broken", token: "cc".repeat(32) },
    ];
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => tokens,
      config: testConfig(),
      now: () => 1_700_000_000_000,
      fetchImpl: async () =>
        new Response(notifyFrame("done"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        sends += 1;
        return token === "cc".repeat(32)
          ? { ok: false, status: 403, reason: "BadCollapseId", attempts: 1 }
          : { ok: true, status: 200, attempts: 1 };
      },
    });
    expect(watch.health().configured).toBe(true);
    expect(watch.health().production).toBe(true);
    expect(watch.health().tokensRegistered).toBe(2);
    const started = Date.now();
    while (sends < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    const health = watch.health();
    expect(health.sent).toBeGreaterThanOrEqual(1);
    expect(health.failed).toBeGreaterThanOrEqual(1);
    expect(health.lastSentAt).toBe(1_700_000_000_000);
    expect(health.lastError).toBe("403 BadCollapseId");
  });

  it("reports itself unconfigured when the key is missing, without sending", async () => {
    let streams = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      loadConfig: () => null,
      keyRecheckMs: 50,
      fetchImpl: async () => {
        streams += 1;
        return new Response(notifyFrame("done"), { status: 200 });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    watch.stop();
    expect(watch.health().configured).toBe(false);
    expect(watch.health().tokensRegistered).toBe(1);
    expect(streams).toBe(0);
  });

  it("starts working once a key that was missing at startup appears", async () => {
    let available: ApnsConfig | null = null;
    const sent: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      loadConfig: () => available,
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        sent.push(token);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watch.health().configured).toBe(false);
    available = testConfig();
    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent).toEqual(["bb".repeat(32)]);
    expect(watch.health().configured).toBe(true);
  });

  it("keeps one rate-limited phone from delaying any other", async () => {
    // Serial delivery meant a phone Apple was throttling could hold every
    // other phone behind its Retry-After — up to a minute of silence for
    // people whose own token was fine.
    const slow = deferred();
    const finished: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [
        { deviceId: "slow", token: "aa".repeat(32) },
        { deviceId: "quick", token: "bb".repeat(32) },
      ],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        if (token === "aa".repeat(32)) {
          slow.started = true;
          await slow.promise;
        }
        finished.push(token);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (finished.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The quick phone is done while the slow one is still in flight.
    expect(finished).toEqual(["bb".repeat(32)]);
    expect(slow.started).toBe(true);
    slow.resolve();
    while (finished.length < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(finished.sort()).toEqual(["aa".repeat(32), "bb".repeat(32)].sort());
  });

  it("bounds a stuck phone's backlog and drops its oldest notifications", async () => {
    const gate = deferred();
    const delivered: string[] = [];
    const frames = ["one", "two", "three", "four", "five"]
      .map((body) => notifyFrameWithBody("approval", body))
      .join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "stuck", token: "aa".repeat(32) }],
      config: testConfig(),
      maxQueuedPerDevice: 2,
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        if (delivered.length === 0) {
          gate.started = true;
          await gate.promise;
        }
        delivered.push(alert.body);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Give the reader time to hand every frame to the queue behind the
    // first, still-unfinished send.
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    while (delivered.length < 3 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    // The first went out; of the four that queued behind it only the two
    // newest survive, because the newest alerts are the ones worth keeping.
    expect(delivered).toEqual(["one", "four", "five"]);
    expect(watch.health().dropped).toBe(2);
  });

  it("drops a token Apple rejects with a permanent 400, not just a 410", async () => {
    const forgotten: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "dead", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => ({ ok: false, status: 400, reason: "BadDeviceToken", attempts: 1 }),
      forgetToken: (id) => forgotten.push(id),
    });
    const started = Date.now();
    while (forgotten.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(forgotten).toEqual(["dead"]);
  });

  it("stops sending when Apple refuses the key, and says so on the health", async () => {
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      loadConfig: () => testConfig(),
      keyStamp: () => "same-key",
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => {
        sends += 1;
        return { ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 };
      },
    });
    const started = Date.now();
    while (sends === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Long enough for several re-check intervals: a key Apple refuses must
    // not be retried just because the timer came round again.
    await new Promise((resolve) => setTimeout(resolve, 120));
    watch.stop();
    expect(sends).toBe(1);
    const health = watch.health();
    expect(health.keyRejected).toBe("InvalidProviderToken");
    expect(health.configured).toBe(false);
  });

  it("picks up a rotated key file and forgets the one it replaced", async () => {
    let stamp = "key-v1";
    let loads = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      loadConfig: () => {
        loads += 1;
        return testConfig();
      },
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      fetchImpl: async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const started = Date.now();
    while (loads === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Several re-checks against an unchanged file must not re-read it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(loads).toBe(1);

    stamp = "key-v2";
    while (loads < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(loads).toBe(2);
  });

  it("resumes the harness stream where it left off", async () => {
    // Without a cursor every notification raised during a harness restart,
    // or during our own retry, is simply never pushed.
    const cursors: (string | null)[] = [];
    let connections = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: testConfig(),
      fetchImpl: async (_input, init) => {
        connections += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        return new Response(`id: stream-1:${connections}\ndata: ${JSON.stringify({ kind: "hello" })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const started = Date.now();
    while (connections < 2 && Date.now() - started < 12_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    watch.stop();
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("stream-1:1");
  }, 15_000);

  it("sends a queued approval before reports that were queued first", async () => {
    // The delay this queue exists to prevent: an approval arriving behind a
    // report whose retry ladder is mid-backoff waits out that whole ladder.
    const gate = deferred();
    const delivered: (string | undefined)[] = [];
    const frames = [
      notifyFrameWithBody("done", "first"),
      notifyFrameWithBody("done", "second"),
      notifyFrameWithBody("done", "third"),
      notifyFrameWithBody("approval", "urgent"),
    ].join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        if (delivered.length === 0) {
          gate.started = true;
          await gate.promise;
        }
        delivered.push(alert.body);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    while (delivered.length < 4 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    // "first" was already in flight; the approval jumps the two reports
    // that queued behind it.
    expect(delivered).toEqual(["first", "urgent", "second", "third"]);
  });

  it("drops a report before an approval when a phone's backlog is full", async () => {
    const gate = deferred();
    const delivered: (string | undefined)[] = [];
    const frames = [
      notifyFrameWithBody("done", "block"),
      notifyFrameWithBody("approval", "needs you"),
      notifyFrameWithBody("done", "report one"),
      notifyFrameWithBody("done", "report two"),
    ].join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      maxQueuedPerDevice: 2,
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        if (delivered.length === 0) {
          gate.started = true;
          await gate.promise;
        }
        delivered.push(alert.body);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    while (delivered.length < 3 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    // Three queued behind "block" with room for two: the approval survives
    // and the oldest report is the one that goes.
    expect(delivered).toEqual(["block", "needs you", "report two"]);
    expect(watch.health().dropped).toBe(1);
  });

  it("names the rejected token when it retires one", async () => {
    // A phone can register a replacement while an older send is in flight;
    // the registry compares before clearing, and cannot unless it is told
    // which token was actually refused.
    const retired: { deviceId: string; token: string }[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => ({ ok: false, status: 410, reason: "Unregistered", attempts: 1 }),
      forgetToken: (deviceId, token) => retired.push({ deviceId, token }),
    });
    const started = Date.now();
    while (retired.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(retired).toEqual([{ deviceId: "phone", token: "aa".repeat(32) }]);
  });

  it("notices a rotated key while the stream stays open", async () => {
    // The re-check used to ride on the reconnect, so a sidecar whose harness
    // stays up for days never looked at the key file again.
    let stamp = "key-v1";
    let loads = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      loadConfig: () => {
        loads += 1;
        return testConfig();
      },
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      // A stream that never ends and never errors: without the timer there
      // is no second trip through the key check at all.
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* stays open */
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const started = Date.now();
    while (loads === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stamp = "key-v2";
    while (loads < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(loads).toBe(2);
  });

  it("resumes from the hello frame's cursor when the link drops before any event", async () => {
    // The harness opens with `{"kind":"hello","cursor":…}` and no `id:` line
    // of its own.  Without taking that cursor the reconnect carries no
    // Last-Event-ID at all, and every notification raised during the
    // four-second retry is silently skipped.
    const cursors: (string | null)[] = [];
    let connections = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: testConfig(),
      fetchImpl: async (_input, init) => {
        connections += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        // Baseline only, then the stream ends — exactly the shape a harness
        // restart leaves behind.
        return new Response(`data: ${JSON.stringify({ kind: "hello", cursor: "abc12345:41", resumed: false })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const started = Date.now();
    while (connections < 2 && Date.now() - started < 12_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    watch.stop();
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("abc12345:41");
  }, 15_000);

  it("ignores a key rejection signed with a key that has already been replaced", async () => {
    // A rotation can land while a request signed with the old key is still
    // in flight.  Reading that request's answer as a verdict on the new key
    // disables the new key, and keeps it disabled: the fault clears only for
    // a key file that differs from the recorded stamp, and the file on disk
    // is already the new one.
    const keyA = testConfig({ keyId: "KEYAAA" });
    const keyB = testConfig({ keyId: "KEYBBB" });
    let stamp = "key-a";
    const gate = deferred();
    const signedWith: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      loadConfig: () => (stamp === "key-a" ? keyA : keyB),
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval") + notifyFrame("done"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (config) => {
        signedWith.push(config.keyId);
        if (signedWith.length > 1) return { ok: true, status: 200, attempts: 1 };
        gate.started = true;
        await gate.promise;
        return { ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Rotate under the in-flight request, and give the key timer time to
    // notice before that request comes back refused.
    stamp = "key-b";
    await new Promise((resolve) => setTimeout(resolve, 80));
    gate.resolve();
    while (signedWith.length < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    // The replacement is what the next send signs with, and nothing on the
    // health says the key was refused.
    expect(signedWith).toEqual(["KEYAAA", "KEYBBB"]);
    const health = watch.health();
    expect(health.keyRejected).toBeNull();
    expect(health.configured).toBe(true);
  });

  it("forwards the harness frame's sequence number to the alert", async () => {
    const seqs: (number | undefined)[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(
          `data: ${JSON.stringify({
            kind: "notify",
            seq: 77,
            notification: { kind: "approval", title: "Scout", body: "done", threadId: "t1", botId: "b1" },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      send: async (_config, _token, alert) => {
        seqs.push(alert.seq);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (seqs.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(seqs[0]).toBe(77);
  });

  it("keeps a key-faulted phone's queue intact and restarts it when the key comes back", async () => {
    // Two findings in one sequence.  The drain used to shift the next alert
    // off the lane BEFORE asking whether a key was usable, so the alert
    // queued behind the send that faulted the key was discarded — unsent,
    // unqueued and uncounted.  And nothing restarted a queue the fault left
    // behind: only a later notification for that same phone would, so a
    // blocking approval arrived hours late or not at all.
    const gate = deferred();
    const delivered: string[] = [];
    let stamp = "key-v1";
    const frames = ["one", "two", "three"].map((body) => notifyFrameWithBody("approval", body)).join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      loadConfig: () => testConfig(),
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        delivered.push(alert.body);
        if (delivered.length > 1) return { ok: true, status: 200, attempts: 1 };
        gate.started = true;
        await gate.promise;
        return { ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Long enough for the reader to hand both remaining frames to the queue
    // behind the still-unfinished first send.
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    // The fault lands, the key is replaced, and the queue has to notice on
    // its own — no further notification arrives for this phone.
    while (watch.health().keyRejected === null && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stamp = "key-v2";
    const rotated = Date.now();
    // Well inside the four-second stream retry, so a reconnect cannot be
    // what delivers these.
    while (delivered.length < 3 && Date.now() - rotated < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(delivered.slice(0, 3)).toEqual(["one", "two", "three"]);
    expect(watch.health().dropped).toBe(0);
  });

  it("treats a key rewritten with the same bytes as the same key, not a rotation", async () => {
    // A secrets sync or a backup restore rewrites the .p8 with identical
    // contents: the file stamp changes and so does the config object, but
    // the KEY does not.  Comparing objects rather than keys read Apple's
    // verdict on the key still in use as a verdict on a key already
    // replaced, waved it through, and went on signing with a key Apple
    // refuses while the health page still said pushes were on.
    const p8 = testP8();
    const gate = deferred();
    let stamp = "key-a";
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      // A fresh object on every load, always the same key material.
      loadConfig: () => testConfig({ p8 }),
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => {
        sends += 1;
        gate.started = true;
        await gate.promise;
        return { ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Rewrite the file under the in-flight request, and give the key timer
    // time to reload it before that request comes back refused.
    stamp = "key-a-rewritten";
    await new Promise((resolve) => setTimeout(resolve, 80));
    gate.resolve();
    const resolved = Date.now();
    // Bounded well inside the four-second stream retry: the verdict has to
    // come from THIS send, not from a reconnect signing with the reloaded
    // config, which would read as a fault either way.
    while (watch.health().keyRejected === null && Date.now() - resolved < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sends).toBe(1);
    expect(watch.health().keyRejected).toBe("InvalidProviderToken");
    expect(watch.health().configured).toBe(false);
  });

  it("survives a forgetToken that throws instead of taking the sidecar down", async () => {
    // `forgetToken` writes the device registry to disk.  It runs outside the
    // send's own guard, on a chain started with `void`, so on a full or
    // read-only disk it used to become an unhandled rejection — and Node's
    // default `--unhandled-rejections=throw` turns that into an exit of the
    // proxy every paired phone depends on.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const delivered: string[] = [];
    const frames = notifyFrameWithBody("approval", "one") + notifyFrameWithBody("approval", "two");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        delivered.push(alert.body);
        return delivered.length === 1
          ? { ok: false, status: 410, reason: "Unregistered", attempts: 1 }
          : { ok: true, status: 200, attempts: 1 };
      },
      forgetToken: () => {
        throw new Error("device registry write failed");
      },
    });
    try {
      const started = Date.now();
      while (delivered.length < 2 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      watch.stop();
      // Give any rejection a turn of the loop to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(delivered).toEqual(["one", "two"]);
    expect(rejections).toEqual([]);
  });

  it("leaves the cursor alone on a resumed stream, so the replay is not skipped", async () => {
    // On a RESUMED stream the harness's hello cursor is the tip and the gap
    // is replayed after it.  Adopting it there jumps the sidecar past
    // everything it missed the moment the link dies before a replayed frame
    // is read — those approvals are then never pushed, though the harness
    // still holds them.  The iOS client makes exactly this distinction.
    const cursors: (string | null)[] = [];
    let connections = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: testConfig(),
      fetchImpl: async (_input, init) => {
        connections += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        const hello =
          connections === 1
            ? { kind: "hello", cursor: "stream-1:30", resumed: false }
            : { kind: "hello", cursor: "stream-1:100", resumed: true };
        return new Response(`data: ${JSON.stringify(hello)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const started = Date.now();
    while (connections < 3 && Date.now() - started < 16_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    watch.stop();
    expect(cursors[0]).toBeNull();
    // Cold: the hello IS the baseline, so take it.
    expect(cursors[1]).toBe("stream-1:30");
    // Resumed: 31..100 are still ours to receive.
    expect(cursors[2]).toBe("stream-1:30");
  }, 20_000);

  it("stays off, and stays quiet, when the sender is pinned off", () => {
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: null,
      fetchImpl: async () => {
        throw new Error("must not stream");
      },
    });
    expect(watch.health().configured).toBe(false);
    expect(watch.health().production).toBeNull();
    watch.stop();
  });
});

// --- Failure classification + circuit breaker -----------------------------
//
// The native `fetch` HTTP/2 path swallows every transport error under a
// generic "fetch failed" message.  These tests pin down the bucketed shape
// the health page renders: a DNS blip is `transport`, an HTTP/2 GOAWAY is
// `http2_protocol`, a 410 is `bad_token`.  They also pin down the
// consecutive-failure run that opens the circuit and the skip-while-open
// behaviour that keeps a hot loop from burning provider-token re-signs.

describe("inspectTransportError", () => {
  it("reads every field Node attaches to a thrown error", () => {
    const info = inspectTransportError(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", name: "Error" }),
    );
    expect(info.code).toBe("ECONNRESET");
    expect(info.message).toContain("ECONNRESET");
    expect(info.name).toBe("Error");
  });

  it("falls back to a string when the error is not an object", () => {
    const info = inspectTransportError("socket hang up");
    expect(info.message).toBe("socket hang up");
    expect(info.code).toBe("");
  });
});

describe("classifyTransportError", () => {
  it("buckets an HTTP/2 GOAWAY as http2_protocol", () => {
    const kind = classifyTransportError({
      name: "Error",
      code: "ERR_HTTP2_GOAWAY",
      message: "http2: received GOAWAY",
    });
    expect(kind).toBe("http2_protocol");
  });

  it("buckets a TCP RST as socket_closed", () => {
    const kind = classifyTransportError({
      name: "Error",
      code: "ECONNRESET",
      message: "read ECONNRESET",
    });
    expect(kind).toBe("socket_closed");
  });

  it("buckets a DNS failure as transport", () => {
    const kind = classifyTransportError({
      name: "Error",
      code: "ENOTFOUND",
      message: "getaddrinfo ENOTFOUND api.push.apple.com",
    });
    expect(kind).toBe("transport");
  });

  it("buckets the request deadline (ETIMEDOUT / TimeoutError) as timeout, not transport", () => {
    expect(classifyTransportError({ name: "TimeoutError", code: "ETIMEDOUT", message: "deadline" })).toBe("timeout");
    expect(classifyTransportError({ name: "Error", code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe("timeout");
    expect(classifyTransportError({ name: "TimeoutError", code: "", message: "timed out" })).toBe("timeout");
  });

  it("buckets a cancelled PING and a session EOF as timeout, not http2_protocol", () => {
    expect(classifyTransportError({ name: "Error", code: "ERR_HTTP2_PING_CANCEL", message: "ping cancelled" })).toBe("timeout");
    expect(classifyTransportError({ name: "Error", code: "ERR_HTTP2_SESSION_EOF", message: "session closed" })).toBe("timeout");
    // Real protocol errors still land in the protocol bucket.
    expect(classifyTransportError({ name: "Error", code: "ERR_HTTP2_STREAM_ERROR", message: "stream error" })).toBe("http2_protocol");
  });
});

describe("classifyHttpResponse", () => {
  it("maps 410 to bad_token", () => {
    expect(classifyHttpResponse(410, "Unregistered")).toBe("bad_token");
  });
  it("maps 400 BadDeviceToken to bad_token", () => {
    expect(classifyHttpResponse(400, "BadDeviceToken")).toBe("bad_token");
  });
  it("maps 403 ExpiredProviderToken to expired_token", () => {
    expect(classifyHttpResponse(403, "ExpiredProviderToken")).toBe("expired_token");
  });
  it("maps 403 InvalidProviderToken to key_fault", () => {
    expect(classifyHttpResponse(403, "InvalidProviderToken")).toBe("key_fault");
  });
  it("maps 429 to rate_limit", () => {
    expect(classifyHttpResponse(429, undefined)).toBe("rate_limit");
  });
  it("maps a 503 to rate_limit", () => {
    expect(classifyHttpResponse(503, undefined)).toBe("rate_limit");
  });
  it("maps a generic 500 to server", () => {
    expect(classifyHttpResponse(500, undefined)).toBe("server");
  });
});

describe("sendApnsAlert — transport error capture", () => {
  it("maps ECONNRESET to failureKind=socket_closed and surfaces the code", async () => {
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      fetchImpl: async () => {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", name: "Error" });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.reason).toBe("SendFailed");
    expect(result.attempts).toBe(1);
    expect(result.failureKind).toBe("socket_closed");
    expect(result.errorCode).toBe("ECONNRESET");
  });

  it("maps an HTTP/2 GOAWAY stream error to failureKind=http2_protocol", async () => {
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      fetchImpl: async () => {
        throw Object.assign(new Error("http2: received GOAWAY"), {
          code: "ERR_HTTP2_GOAWAY",
          name: "Error",
        });
      },
    });
    expect(result.failureKind).toBe("http2_protocol");
    expect(result.errorCode).toBe("ERR_HTTP2_GOAWAY");
  });

  it("clears a stale transport code once an HTTP response arrives", async () => {
    let calls = 0;
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", name: "Error" });
        }
        return new Response(JSON.stringify({ reason: "ServiceUnavailable" }), { status: 503 });
      },
    });
    expect(result.status).toBe(503);
    expect(result.failureKind).toBe("rate_limit");
    expect(result.errorCode).toBeUndefined();
  });

  it("parses Apple's timestamp field from a 403 InvalidProviderToken body", async () => {
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ reason: "InvalidProviderToken", timestamp: 1_700_000_000_000 }), {
          status: 403,
        }),
    });
    expect(result.reason).toBe("InvalidProviderToken");
    expect(result.errorTimestamp).toBe(1_700_000_000_000);
  });

  it("falls back to undefined timestamp when Apple omits the field", async () => {
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ reason: "InvalidProviderToken" }), { status: 403 }),
    });
    expect(result.errorTimestamp).toBeUndefined();
  });

  it("parses Apple's invalidation timestamp from a 410 Unregistered body", async () => {
    const result = await sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ reason: "Unregistered", timestamp: 1_700_000_000_000 }), { status: 410 }),
    });
    expect(result.status).toBe(410);
    expect(result.failureKind).toBe("bad_token");
    expect(result.errorTimestamp).toBe(1_700_000_000_000);
  });
});

describe("HTTP/2 session cache", () => {
  beforeEach(() => {
    dropHttp2Sessions();
  });

  /** A fake session stand-in: the cache test only cares about identity and
   * `closed` / `destroyed` flags, never about a real socket.  A bare object
   * with those two boolean fields is enough — `getOrOpenSession` reads them
   * and `dropHttp2Sessions` checks them before calling `.close()`.  The
   * `as unknown as ClientHttp2Session` cast is the same shape `apns.ts` uses
   * to define `Http2ApnsSession.raw`: tests do not exercise the wire, so
   * the wider interface contract does not apply. */
  const fakeSession = (): Http2ApnsSession =>
    ({ raw: { closed: false, destroyed: false, close() {} } }) as unknown as Http2ApnsSession;
  const fakeFactory = (): Http2SessionFactory => () => fakeSession();

  it("reuses a session while the keyId is unchanged", () => {
    const f = fakeFactory();
    const sessionA = getOrOpenSession("api.push.apple.com", "K1", f);
    const sessionB = getOrOpenSession("api.push.apple.com", "K1", f);
    expect(sessionA).toBe(sessionB);
    dropHttp2Sessions();
  });

  it("drops the cached session when the keyId rotates", () => {
    const f = fakeFactory();
    const sessionA = getOrOpenSession("api.push.apple.com", "K1", f);
    const sessionB = getOrOpenSession("api.push.apple.com", "K2", f);
    expect(sessionA).not.toBe(sessionB);
    dropHttp2Sessions();
  });
});

describe("createApnsHttp2Fetch", () => {
  beforeEach(() => {
    dropHttp2Sessions();
  });

  /** A fake ClientHttp2Stream: an EventEmitter with the methods `sendOver`
   * calls.  It emits nothing unless the test drives it, which is exactly
   * the stalled-stream shape the request deadline exists for. */
  const fakeStream = () => {
    const stream = new EventEmitter() as EventEmitter & {
      setEncoding: (enc: string) => void;
      end: (body?: string) => void;
      close: (code?: number) => void;
      closedWith?: number;
      rstCode?: number;
    };
    stream.setEncoding = () => {};
    stream.end = () => {};
    stream.close = (code?: number) => {
      stream.closedWith = code;
    };
    return stream;
  };

  const fakeSessionFor = (stream: ReturnType<typeof fakeStream>): Http2ApnsSession =>
    ({
      raw: {
        closed: false,
        destroyed: false,
        close() {},
        request: () => stream,
      },
    }) as unknown as Http2ApnsSession;

  const respond200 = (stream: ReturnType<typeof fakeStream>) => {
    stream.emit("response", { ":status": 200 });
    stream.emit("data", "");
    stream.emit("end");
  };

  it("keys sessions by keyId, not by the device token in the URL", async () => {
    let factoryCalls = 0;
    const stream = fakeStream();
    const factory: Http2SessionFactory = () => {
      factoryCalls += 1;
      return fakeSessionFor(stream);
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory });
    const first = fetchImpl(`https://api.push.apple.com/3/device/${"aa".repeat(32)}`, { method: "POST", body: "{}" });
    respond200(stream);
    expect((await first).status).toBe(200);
    const second = fetchImpl(`https://api.push.apple.com/3/device/${"bb".repeat(32)}`, { method: "POST", body: "{}" });
    respond200(stream);
    expect((await second).status).toBe(200);
    // One session served both phones; the device token in the URL must not
    // force a fresh TLS handshake per push.
    expect(factoryCalls).toBe(1);
  });

  it("cancels a stalled stream at the request deadline and rejects as a timeout", async () => {
    const stream = fakeStream(); // never responds
    const factory: Http2SessionFactory = () => fakeSessionFor(stream);
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 20 });
    await expect(
      fetchImpl(`https://api.push.apple.com/3/device/${"aa".repeat(32)}`, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT", name: "TimeoutError" });
    expect(stream.closedWith).not.toBeUndefined();
  });

  it("sendApnsAlert opens its default transport through options.http2SessionFactory", async () => {
    let factoryCalls = 0;
    let seenKeyId = "";
    const stream = fakeStream();
    const factory: Http2SessionFactory = (_host, keyId) => {
      factoryCalls += 1;
      seenKeyId = keyId;
      return fakeSessionFor(stream);
    };
    const pending = sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 1,
      http2SessionFactory: factory,
    });
    respond200(stream);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(factoryCalls).toBe(1);
    // The factory received the signing key id, never the device token.
    expect(seenKeyId).toBe("ABC123");
  });

  /** A fake session that emits error / goaway / close like a real one and
   * runs the production lifecycle wiring, so the per-session pending sweep
   * is exercised end to end. */
  const lifecycleSession = (host: string, stream: ReturnType<typeof fakeStream>) => {
    const raw = new EventEmitter() as EventEmitter & {
      closed: boolean;
      destroyed: boolean;
      close: () => void;
      destroy: () => void;
      request: () => ReturnType<typeof fakeStream>;
    };
    raw.closed = false;
    raw.destroyed = false;
    raw.close = () => {};
    raw.destroy = () => {
      raw.destroyed = true;
    };
    raw.request = () => stream;
    watchHttp2SessionLifecycle(host, raw as unknown as ClientHttp2Session);
    return raw;
  };

  const DEVICE_URL = `https://api.push.apple.com/3/device/${"aa".repeat(32)}`;

  it("a replacement session's failure does not reject the evicted session's draining streams", async () => {
    const streamA = fakeStream();
    const streamB = fakeStream();
    const sessions: ReturnType<typeof lifecycleSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const raw = lifecycleSession(host, sessions.length === 0 ? streamA : streamB);
      sessions.push(raw);
      return { raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const onA = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    // Apple sends GOAWAY on A: evicted, but its stream keeps draining.
    sessions[0].emit("goaway");
    const onB = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    // The replacement dies.  Only its own send may reject.
    sessions[1].emit("error", Object.assign(new Error("boom"), { code: "ECONNRESET" }));
    await expect(onB).rejects.toMatchObject({ code: "ECONNRESET" });
    let settledA = false;
    void onA.then(() => {
      settledA = true;
    }, () => {
      settledA = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settledA).toBe(false);
    // A's stream then finishes normally — one delivery, no retry.
    respond200(streamA);
    expect((await onA).status).toBe(200);
  });

  it("an evicted session's own close still rejects its pending streams", async () => {
    const streamA = fakeStream();
    const streamB = fakeStream();
    const sessions: ReturnType<typeof lifecycleSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const raw = lifecycleSession(host, sessions.length === 0 ? streamA : streamB);
      sessions.push(raw);
      return { raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const onA = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    sessions[0].emit("goaway");
    // A replacement is now cached and serving; A is no longer the cached session.
    const onB = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    // A closes with its stream still open: that send must fail now, not
    // wait out the deadline.
    sessions[0].emit("close");
    await expect(onA).rejects.toMatchObject({ code: "ERR_HTTP2_SESSION_EOF" });
    // B is untouched and still completes.
    respond200(streamB);
    expect((await onB).status).toBe(200);
  });

  /** Like `lifecycleSession`, but every request gets its own stream so
   * several sends can be in flight on one session at once. */
  const multiStreamSession = (host: string) => {
    const streams: ReturnType<typeof fakeStream>[] = [];
    const raw = new EventEmitter() as EventEmitter & {
      closed: boolean;
      destroyed: boolean;
      destroyCalls: number;
      close: () => void;
      destroy: () => void;
      request: () => ReturnType<typeof fakeStream>;
    };
    raw.closed = false;
    raw.destroyed = false;
    raw.destroyCalls = 0;
    raw.close = () => {};
    raw.destroy = () => {
      raw.destroyCalls += 1;
      raw.destroyed = true;
    };
    raw.request = () => {
      const stream = fakeStream();
      streams.push(stream);
      return stream;
    };
    watchHttp2SessionLifecycle(host, raw as unknown as ClientHttp2Session);
    return { raw, streams };
  };

  it("evicts and destroys a session whose request hit the deadline, so the next send opens a fresh one", async () => {
    const sessions: ReturnType<typeof multiStreamSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = multiStreamSession(host);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 20 });
    // Half-open connection: the stream never answers.
    await expect(fetchImpl(DEVICE_URL, { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "ETIMEDOUT",
      name: "TimeoutError",
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].raw.destroyCalls).toBe(1);
    // The retry must not be written to the dead session.
    const retry = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    expect(sessions[0].streams.length).toBe(1);
    respond200(sessions[1].streams[0]);
    expect((await retry).status).toBe(200);
  });

  it("a deadline expiry fails the other sends pending on that session, never the replacement's", async () => {
    const sessions: ReturnType<typeof multiStreamSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = multiStreamSession(host);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    // Same key and factory, so both transports share the cached session;
    // only the deadlines differ.
    const slow = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const fast = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 20 });
    const started = Date.now();
    const bystander = slow(DEVICE_URL, { method: "POST", body: "{}" });
    const expiring = fast(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(1);
    expect(sessions[0].streams.length).toBe(2);
    await expect(expiring).rejects.toMatchObject({ code: "ETIMEDOUT" });
    // The bystander is on the same dead connection: it fails now, with the
    // eviction, instead of waiting out its own 5s deadline.
    await expect(bystander).rejects.toMatchObject({ code: "ETIMEDOUT", name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sessions[0].raw.destroyCalls).toBe(1);
    // A send on the replacement is untouched by the old session's sweep,
    // including the late close the destroyed session emits.
    const onReplacement = slow(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    sessions[0].raw.emit("close");
    let settled = false;
    void onReplacement.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    respond200(sessions[1].streams[0]);
    expect((await onReplacement).status).toBe(200);
  });

  it("a stream reset before any response rejects as a protocol error, and the retry reuses the healthy session", async () => {
    const sessions: ReturnType<typeof multiStreamSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = multiStreamSession(host);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const started = Date.now();
    const first = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    // APNs sends RST_STREAM ahead of any headers: the send fails now, not
    // after the full request deadline.
    sessions[0].streams[0].rstCode = http2Constants.NGHTTP2_REFUSED_STREAM;
    sessions[0].streams[0].emit("close");
    const err = await first.catch((e) => e);
    expect(err).toMatchObject({ code: "ERR_HTTP2_STREAM_ERROR", name: "HTTP2StreamError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(classifyTransportError(inspectTransportError(err))).toBe("http2_protocol");
    // An RST_STREAM kills one stream, not the connection: no eviction, no
    // destroy, and the retry is written to this same session.
    expect(sessions[0].raw.destroyCalls).toBe(0);
    const retry = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(1);
    expect(sessions[0].streams.length).toBe(2);
    respond200(sessions[0].streams[1]);
    expect((await retry).status).toBe(200);
  });

  it("a stream that closes with no response and no RST_STREAM rejects as a dropped socket", async () => {
    const sessions: ReturnType<typeof multiStreamSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = multiStreamSession(host);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const first = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    // rstCode stays NO_ERROR: the stream went away without a reset frame.
    sessions[0].streams[0].emit("close");
    const err = await first.catch((e) => e);
    expect(err).toMatchObject({ code: "ECONNRESET" });
    expect(classifyTransportError(inspectTransportError(err))).toBe("socket_closed");
    // No evidence the connection is dead either, so the session survives.
    expect(sessions[0].raw.destroyCalls).toBe(0);
  });

  it("sendApnsAlert retries a pre-response reset right away on the same session", async () => {
    const sessions: ReturnType<typeof multiStreamSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = multiStreamSession(host);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const started = Date.now();
    const pending = sendApnsAlert(testConfig(), "aa".repeat(32), { title: "t", body: "b" }, {
      maxAttempts: 2,
      sleep: async () => {},
      http2SessionFactory: factory,
    });
    await waitFor(() => sessions.length > 0 && sessions[0].streams.length > 0);
    sessions[0].streams[0].rstCode = http2Constants.NGHTTP2_REFUSED_STREAM;
    sessions[0].streams[0].emit("close");
    // The retry lands on the same session — the reset never evicted it.
    await waitFor(() => sessions[0].streams.length > 1);
    respond200(sessions[0].streams[1]);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sessions.length).toBe(1);
    expect(sessions[0].raw.destroyCalls).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  /** A multi-stream session that also answers `ping`, running the
   * production PING keepalive on short timers.  Each PING's callback is
   * held so the test decides whether it succeeds, fails, or never returns. */
  const pingingSession = (host: string, deadlineMs: number) => {
    const s = multiStreamSession(host);
    const pings: Array<(err: Error | null, duration?: number, payload?: Buffer) => void> = [];
    (s.raw as unknown as { ping: (cb: (err: Error | null) => void) => boolean }).ping = (cb) => {
      pings.push(cb);
      return true;
    };
    const stop = startHttp2PingKeepalive(host, s.raw as unknown as ClientHttp2Session, {
      intervalMs: 10,
      deadlineMs,
    });
    return { ...s, pings, stop };
  };

  const waitFor = async (cond: () => boolean, ms = 2_000) => {
    const started = Date.now();
    while (!cond() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 5));
  };

  it("an error delivered to the PING callback evicts and destroys the session and fails its pending sends", async () => {
    const sessions: ReturnType<typeof pingingSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = pingingSession(host, 5_000);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const started = Date.now();
    const pending = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    await waitFor(() => sessions[0].pings.length > 0);
    expect(sessions[0].pings.length).toBe(1);
    sessions[0].pings[0](Object.assign(new Error("ping failed"), { code: "ERR_HTTP2_PING_CANCEL" }));
    // The send on the dead session fails now, not after its 5s deadline.
    await expect(pending).rejects.toMatchObject({ code: "ERR_HTTP2_PING_CANCEL" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sessions[0].raw.destroyCalls).toBe(1);
    // The next send opens a fresh session instead of reusing the dead one.
    const next = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    respond200(sessions[1].streams[0]);
    expect((await next).status).toBe(200);
    sessions[1].stop();
  });

  it("an unanswered PING hits its deadline: the idle session is evicted and destroyed before the next send", async () => {
    const sessions: ReturnType<typeof pingingSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = pingingSession(host, 20);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const first = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    respond200(sessions[0].streams[0]);
    expect((await first).status).toBe(200);
    // The session is idle and cached.  Its PING never comes back.
    await waitFor(() => sessions[0].raw.destroyCalls > 0);
    expect(sessions[0].raw.destroyCalls).toBe(1);
    // One PING at a time: the keepalive did not stack PINGs while one was out.
    expect(sessions[0].pings.length).toBe(1);
    // The next send goes straight to a fresh session instead of burning a
    // full request deadline on the half-open one.
    const started = Date.now();
    const next = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    expect(sessions[0].streams.length).toBe(1);
    respond200(sessions[1].streams[0]);
    expect((await next).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    sessions[1].stop();
  });

  it("a PING deadline fails only that session's pending sends, as a timeout", async () => {
    const sessions: ReturnType<typeof pingingSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = pingingSession(host, 20);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const pending = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    await expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT", name: "TimeoutError" });
    expect(classifyTransportError(inspectTransportError(await pending.catch((e) => e)))).toBe("timeout");
    // The replacement is untouched, including by the destroyed session's late close.
    const onReplacement = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(2);
    sessions[1].stop();
    sessions[0].raw.emit("close");
    let settled = false;
    void onReplacement.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    respond200(sessions[1].streams[0]);
    expect((await onReplacement).status).toBe(200);
  });

  it("an answered PING keeps the session cached and the keepalive running", async () => {
    const sessions: ReturnType<typeof pingingSession>[] = [];
    const factory: Http2SessionFactory = (host) => {
      const s = pingingSession(host, 50);
      sessions.push(s);
      return { raw: s.raw } as unknown as Http2ApnsSession;
    };
    const fetchImpl = createApnsHttp2Fetch({ keyId: "K1", factory, requestDeadlineMs: 5_000 });
    const first = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    respond200(sessions[0].streams[0]);
    expect((await first).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => sessions[0].pings.length > i);
      sessions[0].pings[i](null, 1, Buffer.alloc(8));
    }
    expect(sessions[0].pings.length).toBeGreaterThanOrEqual(3);
    expect(sessions[0].raw.destroyCalls).toBe(0);
    const next = fetchImpl(DEVICE_URL, { method: "POST", body: "{}" });
    expect(sessions.length).toBe(1);
    respond200(sessions[0].streams[1]);
    expect((await next).status).toBe(200);
    sessions[0].stop();
  });

  it("the PING keepalive stops when the session closes", async () => {
    const s = pingingSession("api.push.apple.com", 5_000);
    await waitFor(() => s.pings.length > 0);
    s.pings[0](null, 1, Buffer.alloc(8));
    s.raw.emit("close");
    const count = s.pings.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.pings.length).toBe(count);
    expect(s.raw.destroyCalls).toBe(0);
  });
});

describe("watchHarnessNotifications — circuit breaker", () => {
  beforeEach(() => {
    dropHttp2Sessions();
  });

  it("opens the circuit after 20 consecutive transport failures and holds the rest on the lane", async () => {
    let clock = 1_700_000_000_000;
    const sent: number[] = [];
    const frames = Array.from({ length: 30 }, (_, i) => moduleNotifyFrame("done", String(i))).join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      now: () => clock,
      maxQueuedPerDevice: 32,
      // A fake clock never reaches the end of the window, so the retry must
      // never fire on its own here.
      scheduleRetry: () => () => {},
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => {
        sent.push(clock);
        return transportFailure();
      },
    });
    expect(await waitFor(() => watch.health().circuitOpenUntil !== null, 5000)).toBe(true);
    const h = watch.health();
    expect(sent.length).toBe(20);
    expect(h.consecutiveTransportFailures).toBe(20);
    expect(h.circuitOpenUntil).toBe(clock + APNS_CIRCUIT_WINDOW_MS);
    expect(h.failureKind).toBe("transport");
    expect(h.lastErrorCode).toBe("ECONNRESET");
    // Pushes are off, and the health says so in the one word the phone can
    // render without guessing from `lastSentAt`.
    expect(h.pushesOff).toBe(true);
    expect(h.pushesOffReason).toBe("unreachable");

    // The ten notifications behind the trip are HELD, not destroyed: the
    // drain leaves them on the lane and stops rather than shifting each one
    // off and discarding it, which used to empty a whole backlog — blocking
    // approvals included — in a single loop.
    expect(await waitFor(() => (watch.health().devices[0]?.queued ?? 0) === 10)).toBe(true);
    const final = watch.health();
    expect(final.devices).toHaveLength(1);
    expect(final.devices[0].deviceId).toBe("offline");
    expect(final.devices[0].queued).toBe(10);
    expect(final.devices[0].circuitOpenUntil).toBe(clock + APNS_CIRCUIT_WINDOW_MS);
    // An open circuit is Apple being unreachable, not a full local queue:
    // nothing may land on the queue-full counter.
    expect(final.dropped).toBe(0);
    expect(final.devices[0].dropped).toBe(0);
    // The hold path does not increment `failed` — the 20 sends did.
    expect(final.failed).toBe(20);
    // And it does not send anything more: the circuit is what stops the hot
    // loop burning provider-token re-signs against an unreachable gateway.
    expect(final.circuitDropped).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(20);
    watch.stop();
  });

  const failingWatch = (count: number, failureKind: "timeout" | "http2_protocol", errorCode: string) => {
    const frames = Array.from({ length: count }, (_, i) => moduleNotifyFrame("done", String(i))).join("");
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      maxQueuedPerDevice: 32,
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => {
        sends += 1;
        return { ok: false, status: 0, reason: "SendFailed", attempts: 1, failureKind, errorCode };
      },
    });
    return { watch, sends: () => sends };
  };

  it("timeouts do not trip the 5-strike HTTP/2 protocol breaker", async () => {
    const { watch, sends } = failingWatch(8, "timeout", "ERR_HTTP2_PING_CANCEL");
    const started = Date.now();
    while (watch.health().failed + watch.health().circuitDropped < 8 && Date.now() - started < 3000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const h = watch.health();
    expect(sends()).toBe(8);
    expect(h.failureKind).toBe("timeout");
    expect(h.circuitOpenUntil).toBeNull();
    expect(h.circuitDropped).toBe(0);
    watch.stop();
  });

  it("five HTTP/2 protocol errors in a row still trip the protocol breaker", async () => {
    const { watch, sends } = failingWatch(8, "http2_protocol", "ERR_HTTP2_STREAM_ERROR");
    expect(await waitFor(() => watch.health().circuitOpenUntil !== null)).toBe(true);
    const h = watch.health();
    expect(sends()).toBe(5);
    expect(h.circuitOpenUntil).not.toBeNull();
    // The drain stops at the trip and holds what is left, so the hold is
    // counted once per stopped pass — not once per notification, because no
    // notification was skipped.
    expect(h.circuitDropped).toBeGreaterThanOrEqual(1);
    expect(h.devices[0].queued).toBe(3);
    expect(h.dropped).toBe(0);
    watch.stop();
  });

  it("counts an HTTP/2 protocol error toward the transport threshold", async () => {
    // `http2_protocol` incremented the shared run and was then excluded from
    // the branch that trips, so a GOAWAY landing on the twentieth failure of
    // a run skipped the trip entirely.  Nineteen socket drops and one GOAWAY
    // is that exact shape.
    expect(isTransportFailure("http2_protocol")).toBe(true);
    let sends = 0;
    const frames = Array.from({ length: 24 }, (_, i) => moduleNotifyFrame("done", String(i))).join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      maxQueuedPerDevice: 32,
      scheduleRetry: () => () => {},
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => {
        sends += 1;
        // Nineteen socket drops, then a GOAWAY as the twentieth.  Neither
        // alone reaches the 5-strike protocol threshold.
        return sends === 20
          ? { ok: false as const, status: 0, reason: "SendFailed", attempts: 1, failureKind: "http2_protocol" as const, errorCode: "ERR_HTTP2_GOAWAY" }
          : { ok: false as const, status: 0, reason: "SendFailed", attempts: 1, failureKind: "socket_closed" as const, errorCode: "ECONNRESET" };
      },
    });
    expect(await waitFor(() => watch.health().circuitOpenUntil !== null)).toBe(true);
    expect(sends).toBe(20);
    expect(watch.health().devices[0].consecutiveTransportFailures).toBe(20);
    watch.stop();
  });

  it("resets consecutiveTransportFailures on a successful send", async () => {
    let nextOk = true;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(moduleNotifyFrame("done"), { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => {
        if (nextOk) return { ok: true, status: 200, attempts: 1, failureKind: "none" };
        return {
          ok: false,
          status: 0,
          reason: "SendFailed",
          attempts: 1,
          failureKind: "transport",
          errorCode: "ECONNRESET",
        };
      },
    });
    // First frame → ok; counter never increments.
    const started = Date.now();
    while (watch.health().sent === 0 && Date.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(watch.health().consecutiveTransportFailures).toBe(0);
    expect(watch.health().failureKind).toBe("none");
    expect(watch.health().lastErrorCode).toBeNull();

    // Now let the next frame fail — counter should climb to 1.
    nextOk = false;
    const watch2 = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(moduleNotifyFrame("done"), { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => ({
        ok: false,
        status: 0,
        reason: "SendFailed",
        attempts: 1,
        failureKind: "transport",
        errorCode: "ECONNRESET",
      }),
    });
    const started2 = Date.now();
    while (watch2.health().failed === 0 && Date.now() - started2 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(watch2.health().consecutiveTransportFailures).toBeGreaterThanOrEqual(1);
    expect(watch2.health().failureKind).toBe("transport");
    expect(watch2.health().lastErrorCode).toBe("ECONNRESET");
    watch.stop();
    watch2.stop();
  });

  it("surfaces Apple's timestamp on the health page after a key fault", async () => {
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(moduleNotifyFrame("done"), { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => ({
        ok: false,
        status: 403,
        reason: "InvalidProviderToken",
        attempts: 1,
        failureKind: "key_fault",
        errorTimestamp: 1_700_000_000_000,
      }),
    });
    const started = Date.now();
    while (watch.health().failed === 0 && Date.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const h = watch.health();
    expect(h.keyRejected).toBe("InvalidProviderToken");
    expect(h.lastError).toContain("timestamp=1700000000000");
    watch.stop();
  });
});

describe("watchHarnessNotifications — transport failure noise", () => {
  const frames = (count: number) =>
    Array.from({ length: count }, (_, i) => moduleNotifyFrame("done", String(i))).join("");

  it("says a link is failing once, not once per attempt", async () => {
    // The harness log held 6,003 identical `APNs 0 SendFailed` lines over two
    // days — one every forty seconds — because transport failures were the
    // one outcome class that fell through `recordOutcome` with no dedupe.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const watch = watchHarnessNotifications({
        harnessPort: 1,
        connectedIds: () => [],
        tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
        config: testConfig(),
        now: () => 1_700_000_000_000,
        maxQueuedPerDevice: 32,
        scheduleRetry: () => () => {},
        fetchImpl: async () =>
          new Response(frames(15), { status: 200, headers: { "content-type": "text/event-stream" } }),
        send: async () => transportFailure(),
      });
      expect(await waitFor(() => watch.health().failed >= 15)).toBe(true);
      watch.stop();
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes("push connection is failing"))).toHaveLength(1);
      // And nothing else wrote a line per failure either.
      expect(lines.filter((line) => line.includes("APNs"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("summarises a link that keeps failing, with the count, every ten minutes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let clock = 1_700_000_000_000;
      const watch = watchHarnessNotifications({
        harnessPort: 1,
        connectedIds: () => [],
        tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
        config: testConfig(),
        now: () => clock,
        maxQueuedPerDevice: 32,
        scheduleRetry: () => () => {},
        fetchImpl: async () =>
          new Response(frames(5), { status: 200, headers: { "content-type": "text/event-stream" } }),
        send: async () => {
          clock += APNS_TRANSPORT_SUMMARY_MS + 1;
          return transportFailure();
        },
      });
      expect(await waitFor(() => watch.health().failed >= 5)).toBe(true);
      watch.stop();
      const summaries = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("transport failures for one phone"));
      // One line for the state change, then one summary per elapsed window.
      expect(summaries).toHaveLength(4);
      expect(summaries[summaries.length - 1]).toContain("5 transport failures");
    } finally {
      warn.mockRestore();
    }
  });

  it("says so once when the link comes back, and is ready to complain again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let sends = 0;
      const watch = watchHarnessNotifications({
        harnessPort: 1,
        connectedIds: () => [],
        tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
        config: testConfig(),
        maxQueuedPerDevice: 32,
        scheduleRetry: () => () => {},
        fetchImpl: async () =>
          new Response(frames(6), { status: 200, headers: { "content-type": "text/event-stream" } }),
        send: async () => {
          sends += 1;
          // Three failures, then the link comes back.
          return sends <= 3
            ? transportFailure()
            : { ok: true as const, status: 200, attempts: 1, failureKind: "none" as const };
        },
      });
      expect(await waitFor(() => watch.health().sent >= 1)).toBe(true);
      watch.stop();
      const recovered = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("delivery recovered"));
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toContain("3 transport failures");
      expect(
        warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("push connection is failing")),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe("watchHarnessNotifications — the breaker is per device", () => {
  it("one phone's dead token does not zero another phone's transport run", async () => {
    // `deliver` fans every notification out to every disconnected phone, so
    // a single shared counter was reset by any other phone's 400 before it
    // could ever reach twenty.  That is why a breaker that shipped in #525
    // never opened while the link was down for two days.
    const frames = Array.from({ length: 20 }, (_, i) => moduleNotifyFrame("done", String(i))).join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [
        { deviceId: "broken-link", token: "aa".repeat(32) },
        { deviceId: "dead-token", token: "bb".repeat(32) },
      ],
      config: testConfig(),
      maxQueuedPerDevice: 32,
      scheduleRetry: () => () => {},
      forgetToken: () => {},
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, token) =>
        token === "aa".repeat(32)
          ? transportFailure()
          : { ok: false as const, status: 400, reason: "BadDeviceToken", attempts: 1, failureKind: "bad_token" as const },
    });
    expect(await waitFor(() => watch.health().circuitOpenUntil !== null, 5000)).toBe(true);
    const h = watch.health();
    const broken = h.devices.find((device) => device.deviceId === "broken-link");
    const dead = h.devices.find((device) => device.deviceId === "dead-token");
    expect(broken?.consecutiveTransportFailures).toBe(20);
    expect(broken?.circuitOpenUntil).not.toBeNull();
    // The other phone's verdict is about its token, not about the link.
    expect(dead?.consecutiveTransportFailures).toBe(0);
    expect(dead?.circuitOpenUntil).toBeNull();
    // One broken phone is not the fleet: pushes are still on for the rest.
    expect(h.pushesOff).toBe(false);
    watch.stop();
  });

  it("logs the open circuit once per phone, and again only after a success", async () => {
    // The dedupe key used to embed the failure count, which only resets on
    // success — so no key ever matched, a warning was logged on every trip,
    // and the Set grew for as long as the link stayed down.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const frames = Array.from({ length: 40 }, (_, i) => moduleNotifyFrame("done", String(i))).join("");
      let clock = 1_700_000_000_000;
      const retries: (() => void)[] = [];
      const watch = watchHarnessNotifications({
        harnessPort: 1,
        connectedIds: () => [],
        tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
        config: testConfig(),
        now: () => clock,
        maxQueuedPerDevice: 64,
        scheduleRetry: (run) => {
          retries.push(run);
          return () => {};
        },
        fetchImpl: async () =>
          new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
        send: async () => transportFailure(),
      });
      expect(await waitFor(() => watch.health().circuitOpenUntil !== null, 5000)).toBe(true);
      // Let the window lapse five times over.  The failure run survives the
      // window, so the first send after each one trips the circuit again —
      // five more trips, each with a different count, which is exactly the
      // shape the old key could not dedupe.
      let seen = watch.health().failed;
      for (let round = 0; round < 5; round += 1) {
        clock += APNS_CIRCUIT_WINDOW_MS + 1;
        retries.splice(0).forEach((run) => run());
        expect(await waitFor(() => watch.health().failed > seen)).toBe(true);
        seen = watch.health().failed;
      }
      watch.stop();
      expect(seen).toBeGreaterThanOrEqual(25);
      const opens = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("circuit open"));
      expect(opens).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("watchHarnessNotifications — an open circuit defers, it does not drop", () => {
  it("holds a blocking approval through the window and delivers it after", async () => {
    let clock = 1_700_000_000_000;
    const retries: { run: () => void; ms: number }[] = [];
    const attempted: string[] = [];
    let failing = true;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      now: () => clock,
      maxQueuedPerDevice: 32,
      scheduleRetry: (run, ms) => {
        retries.push({ run, ms });
        return () => {};
      },
      fetchImpl: async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        attempted.push(alert.body);
        return failing
          ? transportFailure()
          : { ok: true as const, status: 200, attempts: 1, failureKind: "none" as const };
      },
    });
    controller.enqueue(
      encoder.encode(Array.from({ length: 20 }, (_, i) => moduleNotifyFrame("done", `report-${i}`)).join("")),
    );
    expect(await waitFor(() => watch.health().circuitOpenUntil !== null, 5000)).toBe(true);

    // The approval arrives while Apple is unreachable.  This is the one that
    // must not be lost: a bot is blocked on the answer.
    controller.enqueue(encoder.encode(moduleNotifyFrame("approval", "approve me")));
    expect(await waitFor(() => (watch.health().devices[0]?.queued ?? 0) === 1)).toBe(true);
    expect(attempted).not.toContain("approve me");
    expect(watch.health().dropped).toBe(0);
    expect(retries.length).toBeGreaterThan(0);
    // The retry is scheduled for the rest of the window, not for "never".
    expect(retries[0].ms).toBeLessThanOrEqual(APNS_CIRCUIT_WINDOW_MS);

    // The window passes and the link comes back.
    clock += APNS_CIRCUIT_WINDOW_MS + 1;
    failing = false;
    retries[retries.length - 1].run();
    expect(await waitFor(() => attempted.includes("approve me"))).toBe(true);
    const h = watch.health();
    expect(h.sent).toBe(1);
    expect(h.dropped).toBe(0);
    expect(h.circuitOpenUntil).toBeNull();
    expect(h.pushesOff).toBe(false);
    watch.stop();
  });

  it("caps a held lane and counts what it drops, per phone", async () => {
    // Holding is not hoarding: a window that outlasts the backlog cap drops
    // the oldest of what is waiting, and says how many, per phone.
    let clock = 1_700_000_000_000;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      config: testConfig(),
      now: () => clock,
      maxQueuedPerDevice: 4,
      scheduleRetry: () => () => {},
      fetchImpl: async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => transportFailure(),
    });
    // One at a time, so the lane never overflows before the circuit opens —
    // the cap is what is under test afterwards, not before.
    for (let i = 0; i < APNS_TRANSPORT_THRESHOLD; i += 1) {
      controller.enqueue(encoder.encode(moduleNotifyFrame("done", `report-${i}`)));
      expect(await waitFor(() => watch.health().failed >= i + 1, 5000)).toBe(true);
    }
    expect(watch.health().circuitOpenUntil).not.toBeNull();

    // Thirteen more arrive while Apple is unreachable.  Four are held; the
    // other nine are dropped, counted, and reported against this phone.
    controller.enqueue(
      encoder.encode(
        Array.from({ length: 12 }, (_, i) => moduleNotifyFrame("done", `held-${i}`)).join("") +
          moduleNotifyFrame("approval", "approve me"),
      ),
    );
    expect(await waitFor(() => watch.health().dropped === 9, 5000)).toBe(true);
    const h = watch.health();
    expect(h.devices[0].queued).toBe(4);
    expect(h.devices[0].dropped).toBe(9);
    expect(h.devices[0].dropped).toBe(h.dropped);
    // Held, not sent: nothing went out while the circuit was open.
    expect(h.failed).toBe(APNS_TRANSPORT_THRESHOLD);
    watch.stop();
  });
});

describe("watchHarnessNotifications — a refused key survives a restart", () => {
  const notify = moduleNotifyFrame("approval");

  const faultingWatch = (store: KeyFaultStore, stamp: () => string | null, onSend: () => void) =>
    watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      loadConfig: () => testConfig(),
      keyStamp: stamp,
      keyRecheckMs: 10,
      keyFaultStore: store,
      fetchImpl: async () =>
        new Response(notify, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => {
        onSend();
        return {
          ok: false as const,
          status: 403,
          reason: "InvalidProviderToken",
          attempts: 1,
          failureKind: "key_fault" as const,
          errorTimestamp: 1_700_000_000_000,
        };
      },
    });

  it("writes the verdict, and the next process does not send at all", async () => {
    const store = memoryKeyFaultStore();
    let firstRun = 0;
    const watch = faultingWatch(store, () => "key-v1", () => {
      firstRun += 1;
    });
    expect(await waitFor(() => watch.health().keyRejected !== null)).toBe(true);
    watch.stop();
    expect(firstRun).toBe(1);
    expect(store.current?.reason).toBe("InvalidProviderToken");
    expect(store.current?.keyStamp).toBe("key-v1");
    expect(store.current?.errorTimestamp).toBe(1_700_000_000_000);

    // A relaunch.  Nothing about the key file changed, so Apple's answer has
    // not changed either — and the old build resumed full-rate sends here.
    let secondRun = 0;
    const restarted = faultingWatch(store, () => "key-v1", () => {
      secondRun += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const h = restarted.health();
    restarted.stop();
    expect(secondRun).toBe(0);
    expect(h.keyRejected).toBe("InvalidProviderToken");
    expect(h.configured).toBe(false);
    expect(h.pushesOff).toBe(true);
    expect(h.pushesOffReason).toBe("key-rejected");
  });

  it("clears the verdict when the key file fingerprint changes", async () => {
    const store = memoryKeyFaultStore({
      reason: "InvalidProviderToken",
      at: 1_700_000_000_000,
      keyStamp: "key-v1",
    });
    let sends = 0;
    const watch = faultingWatch(store, () => "key-v2", () => {
      sends += 1;
    });
    // A different file: the verdict was about a key this process no longer
    // holds, so it is forgotten and the replacement gets its chance.
    expect(await waitFor(() => sends > 0)).toBe(true);
    watch.stop();
    expect(sends).toBeGreaterThan(0);
  });

  it("drops the refused key's provider token and http2 sessions, so a rotation is not signed against them", async () => {
    // The fault used to null `discovered`, so the key-identity comparison in
    // refreshConfig saw no previous key, skipped invalidateProviderToken and
    // dropHttp2Sessions, and signed the replacement .p8 against the cached
    // token minted for the key Apple had just refused.
    dropHttp2Sessions();
    const key = testConfig({ keyId: "ROTATE1" });
    const cached = providerToken(key, 1_000);
    const planted = getOrOpenSession(
      "api.push.apple.com",
      "ROTATE1",
      () => ({ raw: { closed: false, destroyed: false, close() {} } }) as unknown as Http2ApnsSession,
    );
    const store = memoryKeyFaultStore();
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "phone", token: "aa".repeat(32) }],
      loadConfig: () => key,
      keyStamp: () => "key-v1",
      keyRecheckMs: 10,
      keyFaultStore: store,
      fetchImpl: async () =>
        new Response(notify, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async () => ({
        ok: false as const,
        status: 403,
        reason: "InvalidProviderToken",
        attempts: 1,
        failureKind: "key_fault" as const,
      }),
    });
    expect(await waitFor(() => watch.health().keyRejected !== null)).toBe(true);
    watch.stop();
    // Same key, same clock: a surviving cache entry would hand back the very
    // same JWT.  A fresh signature is the proof it was dropped.
    expect(providerToken(key, 1_000)).not.toBe(cached);
    const rebuilt = getOrOpenSession(
      "api.push.apple.com",
      "ROTATE1",
      () => ({ raw: { closed: false, destroyed: false, close() {} } }) as unknown as Http2ApnsSession,
    );
    expect(rebuilt).not.toBe(planted);
    dropHttp2Sessions();
  });
});

describe("diskKeyFaultStore", () => {
  it("round-trips a fault through a file, and forgets it on request", () => {
    const dir = mkdtempSync(join(tmpdir(), "apns-fault-"));
    try {
      const store = diskKeyFaultStore(dir);
      expect(store.load()).toBeNull();
      store.save({ reason: "InvalidProviderToken", at: 42, keyStamp: "/k.p8:1:2", errorTimestamp: 7 });
      expect(store.load()).toEqual({
        reason: "InvalidProviderToken",
        at: 42,
        keyStamp: "/k.p8:1:2",
        errorTimestamp: 7,
      });
      // Nothing that could be turned back into a signing key is written.
      store.save(null);
      expect(store.load()).toBeNull();
      // A second clear is not an error: the file is already gone.
      store.save(null);
      expect(store.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a half-written or hand-edited file as no fault at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "apns-fault-"));
    try {
      const store = diskKeyFaultStore(dir);
      store.save({ reason: "InvalidProviderToken", at: 1, keyStamp: null });
      // A fault with no stamp can never match a key file, so it can never
      // hold pushes off — which is the safe direction for a torn file.
      expect(store.load()?.keyStamp).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
