// The wire shape Usage Monitor actually receives.
//
// Three things go wrong quietly here, and each one costs money rather than
// throwing.  A driver's `input` figure already contains the cached tokens
// (reads AND writes), so a naive sum bills the cache twice.  The turn must be
// reported once:  Usage Monitor sums `ai.tokens` across events, so a repeat
// on a sibling event is a double count.  And the v2 event schema is
// `.strict()`, including the `ai` block, so one unrecognised key rejects the
// whole event rather than dropping the key.
//
// These tests are pure: `buildTurnEvents` never touches the network, so the
// arithmetic is checked without a fetch stub anywhere near it.
import { describe, expect, it } from "vitest";

import {
  buildAuxEvent,
  buildTurnEvents,
  inferProviderAndService,
  turnUsageDetail,
  type TelemetryTurnParams,
} from "./telemetry.ts";

/** Every top-level key the v2 event schema accepts
 * (`congress-trading-shared@2.8.1` `UsageTelemetryV2EventSchema`, which is
 * `.strict()`).  Anything outside this set takes the event down with it. */
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "eventId",
  "environment",
  "provider",
  "service",
  "project",
  "label",
  "producerKeyRef",
  "providerConnectionRef",
  "billingAccountRef",
  "coverage",
  "billingMode",
  "metricType",
  "quantity",
  "unit",
  "costUsd",
  "requests",
  "credits",
  "limit",
  "limitWindow",
  "tier",
  "confidence",
  "windowStart",
  "windowEnd",
  "occurredAt",
  "providerRequestId",
  "metadata",
  "ai",
]);

/** The `ai` block's own strict key sets (`aiUsage.ts`, UM-1592). */
const ALLOWED_AI_KEYS = new Set(["model", "harness", "seat", "tokens", "durationMs", "ttftMs", "billingMode", "costSource"]);
const ALLOWED_AI_MODEL_KEYS = new Set(["requested", "served"]);
const ALLOWED_AI_TOKEN_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "reasoning"]);

/** Everything the receiver's strict `ai` schema checks, as one assertion. */
function expectValidAiBlock(ai: Record<string, any> | undefined) {
  expect(ai).toBeDefined();
  for (const key of Object.keys(ai!)) expect(ALLOWED_AI_KEYS.has(key), `unexpected ai key: ${key}`).toBe(true);
  for (const key of Object.keys(ai!.model ?? {})) expect(ALLOWED_AI_MODEL_KEYS.has(key), `unexpected ai.model key: ${key}`).toBe(true);
  for (const [key, value] of Object.entries(ai!.tokens ?? {})) {
    expect(ALLOWED_AI_TOKEN_KEYS.has(key), `unexpected ai.tokens key: ${key}`).toBe(true);
    expect(Number.isInteger(value) && (value as number) >= 0).toBe(true);
  }
  for (const value of [ai!.model?.requested, ai!.model?.served]) {
    if (value !== undefined) expect(value.length >= 1 && value.length <= 160).toBe(true);
  }
  for (const value of [ai!.harness, ai!.seat]) {
    if (value !== undefined) expect(value.length >= 1 && value.length <= 80).toBe(true);
  }
  for (const value of [ai!.durationMs, ai!.ttftMs]) {
    if (value !== undefined) expect(Number.isFinite(value) && value >= 0).toBe(true);
  }
  if (ai!.billingMode !== undefined) expect(["subscription", "payg", "free"]).toContain(ai!.billingMode);
  if (ai!.costSource !== undefined) expect(["billed", "estimated"]).toContain(ai!.costSource);
}

const BASE: TelemetryTurnParams = {
  botId: "bot_1",
  botName: "Scout",
  threadId: "thread_1",
  instanceId: "claude",
  driverKind: "claudeAgent",
  modelId: "claude-sonnet-5",
  taskTitle: "Ship the thing",
  cwd: "/work/some-repo",
};

function build(overrides: Partial<TelemetryTurnParams> = {}) {
  return buildTurnEvents({ ...BASE, ...overrides }, { now: 1_757_000_000_000 });
}

describe("token arithmetic", () => {
  // The one that costs real money.  drivers/claude.ts folds
  // cache_read_input_tokens into `input` before it ever reaches telemetry,
  // so subtracting the cache back out is what keeps the buckets honest.
  it("reports a turn as ONE event whose buckets sum to what the slices summed to", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.tokens).toEqual({ input: 600, output: 200, cacheRead: 400 });
    expect(events[0]?.quantity).toBe(1200);
    expect(events[0]?.requests).toBe(1);
    expect(events[0]?.metadata.usageReported).toBe(true);
  });

  // BF-2435 gap 1: Claude's cache writes used to be folded into plain input
  // and billed at the input rate, with the 5 minute / 1 hour split lost.
  it("splits cache writes out of input by TTL, so each bucket is priced once at its own rate", () => {
    const [event] = build({
      inputTokens: 1000,
      cachedInputTokens: 400,
      cacheWrite5mTokens: 150,
      cacheWrite1hTokens: 50,
      outputTokens: 200,
    });

    expect(event?.ai?.tokens).toEqual({ input: 400, output: 200, cacheRead: 400, cacheWrite5m: 150, cacheWrite1h: 50 });
    expect(event?.quantity).toBe(1200);
    expect(event?.metadata.cacheWriteTokens).toBe(150);
    expect(event?.metadata.cacheWriteOneHourTokens).toBe(50);
  });

  it("keeps the raw driver figures in metadata untouched", () => {
    const [first] = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    expect(first.metadata.inputTokens).toBe(1000);
    expect(first.metadata.cachedInputTokens).toBe(400);
    expect(first.metadata.outputTokens).toBe(200);
  });

  it("leaves out a bucket with nothing in it rather than sending a zero", () => {
    const [event] = build({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 120 });

    expect(event?.ai?.tokens).toEqual({ input: 500, output: 120 });
    expect(event?.quantity).toBe(620);
  });

  it("survives a cache figure larger than the input figure", () => {
    const [event] = build({ inputTokens: 100, cachedInputTokens: 400, outputTokens: 0 });

    expect(event?.ai?.tokens).toEqual({ cacheRead: 400 });
    expect(event?.quantity).toBe(400);
  });

  it("rounds and clamps the driver's figures", () => {
    const [event] = build({ inputTokens: 10.6, cachedInputTokens: -5, outputTokens: 2.2 });

    expect(event?.ai?.tokens).toEqual({ input: 11, output: 2 });
    expect(event?.quantity).toBe(13);
  });

  it("carries reasoning as a share of output, never on top of it", () => {
    const [event] = build({ inputTokens: 100, outputTokens: 300, reasoningTokens: 120 });

    expect(event?.ai?.tokens).toEqual({ input: 100, output: 300, reasoning: 120 });
    expect(event?.quantity).toBe(400);
    expect(build({ inputTokens: 100, outputTokens: 50, reasoningTokens: 900 })[0]?.ai?.tokens?.reasoning).toBe(50);
    expect(build({ inputTokens: 100, outputTokens: 50, reasoningTokens: 0 })[0]?.ai?.tokens).not.toHaveProperty("reasoning");
  });
});

describe("the ai block", () => {
  it("names the harness, the requested and served model, the seat and the timing", () => {
    const [event] = build({
      inputTokens: 100,
      outputTokens: 40,
      servedModelId: "claude-sonnet-5-20261001",
      seat: "BF-PLUMBER",
      latencyMs: 4200,
      ttftMs: 650,
    });

    expect(event?.ai).toEqual({
      model: { requested: "claude-sonnet-5", served: "claude-sonnet-5-20261001" },
      harness: "botfleet",
      seat: "BF-PLUMBER",
      tokens: { input: 100, output: 40 },
      durationMs: 4200,
      ttftMs: 650,
    });
    expectValidAiBlock(event?.ai);
    expect(event?.metadata).toMatchObject({ servedModel: "claude-sonnet-5-20261001", seat: "BF-PLUMBER", ttftMs: 650 });
  });

  it("omits what the turn did not say instead of fabricating it", () => {
    const [event] = build({ inputTokens: 10, outputTokens: 5, modelId: undefined });

    expect(event?.ai).toEqual({ harness: "botfleet", tokens: { input: 10, output: 5 } });
    expectValidAiBlock(event?.ai);
    for (const key of ["servedModel", "seat", "ttftMs", "latencyMs", "cacheWriteTokens", "reasoningTokens"]) {
      expect(event?.metadata).not.toHaveProperty(key);
    }
  });

  it("says a subscription turn is subscription-billed and its cost an estimate", () => {
    const [event] = build({ inputTokens: 10, outputTokens: 5, costUsd: 0.04, billingMode: "estimated" });

    expect(event?.ai).toMatchObject({ billingMode: "subscription", costSource: "estimated" });
    expectValidAiBlock(event?.ai);
  });

  it("says a pay-as-you-go turn is payg and its cost billed", () => {
    const [event] = build({ inputTokens: 10, outputTokens: 5, costUsd: 0.04, billingMode: "actual" });

    expect(event?.ai).toMatchObject({ billingMode: "payg", costSource: "billed" });
    expectValidAiBlock(event?.ai);
  });

  it("names no billing mode for an engine that priced nothing", () => {
    const [event] = build({ inputTokens: 10, outputTokens: 5 });

    expect(event?.ai).not.toHaveProperty("billingMode");
    expect(event?.ai).not.toHaveProperty("costSource");
  });

  it("clips the strings the strict schema caps, and drops an unusable timing", () => {
    const [event] = build({
      inputTokens: 10,
      modelId: "m".repeat(400),
      servedModelId: "s".repeat(400),
      seat: "x".repeat(400),
      latencyMs: Number.NaN,
      ttftMs: -5,
    });

    expect(event?.ai?.model?.requested).toHaveLength(160);
    expect(event?.ai?.model?.served).toHaveLength(160);
    expect(event?.ai?.seat).toHaveLength(80);
    expect(event?.ai).not.toHaveProperty("durationMs");
    expect(event?.ai).not.toHaveProperty("ttftMs");
    expectValidAiBlock(event?.ai);
  });

  it("is built from the same figures the legacy keys carry, so the two readers agree", () => {
    const [event] = build({ inputTokens: 1000, cachedInputTokens: 400, cacheWrite5mTokens: 100, outputTokens: 200 });
    const ai = event!.ai!.tokens!;

    // Usage Monitor's legacy mapping computes uncached input as
    // inputTokens - cachedInputTokens - cacheWriteTokens.
    expect(ai.input).toBe((event!.metadata.inputTokens as number) - (event!.metadata.cachedInputTokens as number) - (event!.metadata.cacheWriteTokens as number));
  });
});

describe("money lands exactly once", () => {
  it("puts the turn's cost and its one request on the one event", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, costUsd: 0.0421 });

    expect(events).toHaveLength(1);
    expect(events[0]?.costUsd).toBe(0.0421);
    expect(events[0]?.requests).toBe(1);
    expect(events[0]?.billingMode).toBe("actual");
    expect(events[0]?.confidence).toBe("actual");
  });

  it("still counts one request when the turn reports no cost", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    expect(events.reduce((sum, event) => sum + event.requests, 0)).toBe(1);
    for (const event of events) {
      expect(Object.hasOwn(event, "costUsd")).toBe(false);
      expect(event.billingMode).toBe("estimated");
    }
  });

  it("keeps subscription-equivalent cost out of actual spend while retaining estimate metadata", () => {
    const events = build({
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      costUsd: 0.0421,
      billingMode: "estimated",
    });

    expect(events.map((event) => event.metadata.estimatedCostUsd)).toEqual([0.0421]);
    for (const event of events) {
      expect(Object.hasOwn(event, "costUsd")).toBe(false);
      expect(event.billingMode).toBe("estimated");
      expect(event.confidence).toBe("estimated");
    }
  });

  it("drops a cost that is not a finite, non-negative number", () => {
    for (const costUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const events = build({ inputTokens: 10, outputTokens: 5, costUsd });
      expect(Object.hasOwn(events[0] ?? {}, "costUsd")).toBe(false);
      expect(events[0]?.billingMode).toBe("estimated");
    }
  });
});

describe("event identity", () => {
  it("gives the turn one id under the shared prefix", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });
    const ids = events.map((event) => event.eventId);

    expect(ids).toHaveLength(1);
    expect(ids[0]?.endsWith(":turn")).toBe(true);
    expect(ids[0]?.startsWith("bf:anthropic:bot_1:1757000000000:")).toBe(true);
  });

  it("carries the model on producerKeyRef and in metadata, never as a top-level key", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    for (const event of events) {
      expect(event.producerKeyRef).toBe("claude-sonnet-5");
      expect(event.metadata.model).toBe("claude-sonnet-5");
      expect(event.metadata.instanceId).toBe("claude");
    }
  });

  it("omits producerKeyRef when there is no model to name", () => {
    const events = build({ modelId: "   ", inputTokens: 10, outputTokens: 5 });

    for (const event of events) {
      expect(Object.hasOwn(event, "producerKeyRef")).toBe(false);
      expect(event.metadata.model).toBeNull();
    }
  });
});

describe("a turn that reported no usage", () => {
  // Every boxAgent turn lands here, and so does any ACP engine that does not
  // report usage, and every turn that failed before a usage frame arrived
  // (BF-2435: 3,947 such rows in 30 days, 90% of them failed turns or DSH
  // turns that streamed no context figure).  A phantom one-token row would
  // read as real spend; a zero row with the flag and the reason reads as what
  // it is.
  it("emits one zero-quantity event flagged as unreported, with no ai block", () => {
    const events = build({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

    expect(events).toHaveLength(1);
    expect(events[0]?.quantity).toBe(0);
    expect(events[0]?.requests).toBe(1);
    expect(events[0]?.metadata.tokenType).toBe("unknown");
    expect(events[0]?.metadata.usageReported).toBe(false);
    expect(events[0]?.eventId.endsWith(":none")).toBe(true);
    // a tokenless `ai` block would become an empty row in the per-request view
    expect(events[0]).not.toHaveProperty("ai");
  });

  it("says why: a failed turn is a failure, a good turn with no figure is unreported", () => {
    const failed = build({ success: false, stopReason: "api_error" })[0];
    expect(failed?.metadata).toMatchObject({ usageGap: "failed", stopReason: "api_error", success: false });

    const unreported = build({ success: true, stopReason: "end_turn" })[0];
    expect(unreported?.metadata).toMatchObject({ usageGap: "unreported", stopReason: "end_turn", success: true });

    expect(build({ stopReason: null })[0]?.metadata).not.toHaveProperty("stopReason");
    expect(build({ stopReason: "x".repeat(300) })[0]?.metadata.stopReason).toHaveLength(80);
  });

  it("marks a turn that did report usage as reported, and never as a gap", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, stopReason: "end_turn" });

    for (const event of events) {
      expect(event.metadata.usageReported).toBe(true);
      expect(event.metadata).not.toHaveProperty("usageGap");
      expect(event.metadata).not.toHaveProperty("tokenType");
      expect(event.metadata).not.toHaveProperty("stopReason");
    }
  });

  it("still reports the cost of a turn with no token figures", () => {
    const events = build({ costUsd: 0.02 });

    expect(events).toHaveLength(1);
    expect(events[0]?.costUsd).toBe(0.02);
    expect(events[0]?.quantity).toBe(0);
  });
});

describe("room turns", () => {
  it("stamps the room on the event of that turn", () => {
    const events = build({
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      roomId: "room_7",
      roomName: "Launch Room",
    });

    expect(events).toHaveLength(1);
    for (const event of events) {
      expect(event.metadata.roomId).toBe("room_7");
      expect(event.metadata.roomName).toBe("Launch Room");
    }
  });

  it("stamps nothing on a 1:1 turn", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    for (const event of events) {
      expect(Object.hasOwn(event.metadata, "roomId")).toBe(false);
      expect(Object.hasOwn(event.metadata, "roomName")).toBe(false);
    }
  });
});

describe("wire shape", () => {
  const turnKinds = [
    { name: "split turn", params: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, costUsd: 0.04 } },
    {
      name: "cache-write turn",
      params: { inputTokens: 1000, cachedInputTokens: 400, cacheWrite5mTokens: 100, cacheWrite1hTokens: 50, outputTokens: 200, servedModelId: "claude-sonnet-5-20261001", seat: "BF-FIXER", ttftMs: 300, latencyMs: 900, billingMode: "estimated", costUsd: 0.5 },
    },
    { name: "zero-usage turn", params: { inputTokens: 0, outputTokens: 0 } },
    {
      name: "room turn",
      params: { inputTokens: 10, outputTokens: 5, roomId: "room_7", roomName: "Launch Room" },
    },
  ] satisfies Array<{ name: string; params: Partial<TelemetryTurnParams> }>;

  for (const turnKind of turnKinds) {
    it(`uses only schema-allowed top-level keys for a ${turnKind.name}`, () => {
      for (const event of build(turnKind.params)) {
        for (const key of Object.keys(event)) {
          expect(ALLOWED_TOP_LEVEL_KEYS.has(key), `unexpected top-level key: ${key}`).toBe(true);
        }
        if (event.ai) expectValidAiBlock(event.ai);
        // The two keys that get reached for by instinct. `.strict()` would
        // reject the entire event, not just the stray field.
        expect(Object.hasOwn(event, "model")).toBe(false);
        expect(Object.hasOwn(event, "keyRef")).toBe(false);
      }
    });
  }

  it("keeps the nine metadata keys that were already being sent", () => {
    const [first] = build({ inputTokens: 10, outputTokens: 5, latencyMs: 1234, success: false });

    expect(first?.metadata.botName).toBe("Scout");
    expect(first?.metadata.botId).toBe("bot_1");
    expect(first?.metadata.threadId).toBe("thread_1");
    expect(first?.metadata.inputTokens).toBe(10);
    expect(first?.metadata.outputTokens).toBe(5);
    expect(first?.metadata.cachedInputTokens).toBe(0);
    expect(first?.metadata.cwd).toBe("/work/some-repo");
    expect(first?.metadata.latencyMs).toBe(1234);
    expect(first?.metadata.success).toBe(false);
  });

  it("carries the prompt halves' byte counts as two flat numbers, and omits them when the prompt was not split", () => {
    // Upstream PR #1758's promptBytes {stable, volatile}, flattened: the v2
    // metadata bag is a `z.record` of primitives, so a nested object would
    // reject the whole event.
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, promptBytes: { stable: 4096, volatile: 128 } });
    expect(events).toHaveLength(1);
    for (const event of events) {
      expect(event.metadata.promptStableBytes).toBe(4096);
      expect(event.metadata.promptVolatileBytes).toBe(128);
      for (const value of Object.values(event.metadata)) {
        expect(value === null || typeof value !== "object").toBe(true);
      }
    }
    for (const event of build({ inputTokens: 10 })) {
      expect(event.metadata).not.toHaveProperty("promptStableBytes");
      expect(event.metadata).not.toHaveProperty("promptVolatileBytes");
    }
    // a size is a non-negative integer or nothing
    expect(build({ promptBytes: { stable: 12.6, volatile: -3 } })[0]?.metadata).toMatchObject({ promptStableBytes: 13, promptVolatileBytes: 0 });
    expect(build({ promptBytes: { stable: NaN, volatile: 1 } })[0]?.metadata).not.toHaveProperty("promptStableBytes");
  });

  it("omits unavailable or invalid latency instead of reporting a fabricated zero", () => {
    for (const latencyMs of [undefined, NaN, -1, Infinity]) {
      const [event] = build({ latencyMs });
      expect(event?.metadata).not.toHaveProperty("latencyMs");
    }
    expect(build({ latencyMs: 0 })[0]?.metadata.latencyMs).toBe(0);
  });

  it("fills the fixed fields every event needs", () => {
    for (const event of build({ inputTokens: 10, outputTokens: 5 })) {
      expect(event.metricType).toBe("usage");
      expect(event.unit).toBe("token");
      expect(event.provider).toBe("anthropic");
      expect(event.service).toBe("claude-sonnet-5");
      expect(event.project).toBe("some-repo");
      expect(event.label).toBe("Ship the thing");
      expect(event.occurredAt).toBe(new Date(1_757_000_000_000).toISOString());
    }
  });

  it("classifies the project with the operator's own rules", () => {
    const events = buildTurnEvents(
      { ...BASE, inputTokens: 10, outputTokens: 5 },
      { projects: [{ slug: "storefront", match: ["some-repo"] }], now: 1_757_000_000_000 },
    );

    expect(events[0]?.project).toBe("storefront");
  });

  it("clips every capped string so one long value cannot reject the event", () => {
    // The schema is `.strict()` and every string field is capped, so an
    // over-long model id or working directory would take the whole turn's
    // spend down with it rather than being trimmed.
    const events = build({
      taskTitle: "x".repeat(400),
      botName: "y".repeat(400),
      cwd: `/work/${"z".repeat(400)}`,
      instanceId: "i".repeat(400),
      modelId: "m".repeat(400),
      driverKind: undefined,
      inputTokens: 10,
      outputTokens: 5,
    });

    for (const event of events) {
      expect(event.eventId.length).toBeLessThanOrEqual(200);
      expect(event.provider.length).toBeLessThanOrEqual(80);
      expect(event.service.length).toBeLessThanOrEqual(120);
      expect(event.project.length).toBeLessThanOrEqual(120);
      expect(event.label).toHaveLength(160);
      expect(event.producerKeyRef?.length).toBeLessThanOrEqual(160);
      expect(event.environment.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("turnUsageDetail", () => {
  it("reads what a settled turn said and nothing it did not", () => {
    expect(
      turnUsageDetail(
        { usage: { cacheWrite5m: 3, cacheWrite1h: 4, reasoning: 9 }, servedModel: "m-1", stopReason: "end_turn" },
        { ttftMs: 250 },
        "BF-ORACLE",
      ),
    ).toEqual({
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 4,
      reasoningTokens: 9,
      servedModelId: "m-1",
      ttftMs: 250,
      seat: "BF-ORACLE",
      stopReason: "end_turn",
    });
    expect(turnUsageDetail({}, undefined, null)).toEqual({});
  });
});

describe("spend outside chat turns", () => {
  const NOW = 1_757_000_000_000;

  it("reports a synthesized clip as one request with its characters in metadata", () => {
    const event = buildAuxEvent(
      { kind: "tts", provider: "minimax", service: "speech-2.8-turbo", label: "BotFleet speech", metadata: { characters: 412, characterSource: "provider" } },
      { now: NOW },
    );

    expect(event).toMatchObject({
      provider: "minimax",
      service: "speech-2.8-turbo",
      metricType: "usage",
      unit: "request",
      quantity: 1,
      requests: 1,
      billingMode: "estimated",
      confidence: "estimated",
      metadata: { kind: "tts", success: true, characters: 412, characterSource: "provider" },
    });
    // the model rides the producer's key reference, the same way a turn's does
    expect(event.producerKeyRef).toBe(event.service);
    expect(event).not.toHaveProperty("costUsd");
    expect(event).not.toHaveProperty("ai");
    for (const key of Object.keys(event)) expect(ALLOWED_TOP_LEVEL_KEYS.has(key), key).toBe(true);
    expect(event.eventId.length).toBeLessThanOrEqual(200);
  });

  it("reports a token-billed call (the speech summary) with the ai block as its measure", () => {
    const event = buildAuxEvent(
      {
        kind: "speech-summary",
        provider: "deepseek",
        service: "deepseek-flash",
        label: "BotFleet speech summary",
        unit: "token",
        ai: { model: { requested: "deepseek-flash", served: "deepseek-v4.1-flash" }, tokens: { input: 40, output: 300, cacheRead: 960 }, durationMs: 800, billingMode: "payg" },
      },
      { now: NOW },
    );

    expect(event.unit).toBe("token");
    expect(event.quantity).toBe(1300);
    expect(event.ai).toEqual({
      model: { requested: "deepseek-flash", served: "deepseek-v4.1-flash" },
      harness: "botfleet",
      tokens: { input: 40, output: 300, cacheRead: 960 },
      durationMs: 800,
      billingMode: "payg",
    });
    expectValidAiBlock(event.ai);
  });

  it("puts a charged cost on costUsd and an estimate in metadata, and drops an unusable one", () => {
    const base = { kind: "avatar-image", provider: "openai", service: "gpt-image-2", label: "BotFleet avatar image" } as const;
    expect(buildAuxEvent({ ...base, costUsd: 0.01, billingMode: "actual" }, { now: NOW })).toMatchObject({ costUsd: 0.01, billingMode: "actual", confidence: "actual" });
    const estimated = buildAuxEvent({ ...base, costUsd: 0.01, billingMode: "estimated" }, { now: NOW });
    expect(estimated).not.toHaveProperty("costUsd");
    expect(estimated.metadata.estimatedCostUsd).toBe(0.01);
    for (const costUsd of [Number.NaN, -1]) {
      const dropped = buildAuxEvent({ ...base, costUsd, billingMode: "actual" }, { now: NOW });
      expect(dropped).not.toHaveProperty("costUsd");
      expect(dropped.billingMode).toBe("estimated");
    }
  });

  it("reports a voice-call session as one request with nothing measured but that it began", () => {
    const event = buildAuxEvent(
      { kind: "sts-session", provider: "google-ai", service: "gemini-3.8-live", label: "BotFleet voice call" },
      { now: NOW },
    );

    expect(event).toMatchObject({ provider: "google-ai", unit: "request", quantity: 1, requests: 1, metadata: { kind: "sts-session" } });
    expect(event).not.toHaveProperty("ai");
    expect(event).not.toHaveProperty("costUsd");
  });

  it("clips capped strings and carries only flat metadata", () => {
    const event = buildAuxEvent(
      { kind: "tts", provider: "p".repeat(200), service: "s".repeat(300), label: "l".repeat(300), latencyMs: 12 },
      { now: NOW },
    );

    expect(event.provider).toHaveLength(80);
    expect(event.service).toHaveLength(120);
    expect(event.label).toHaveLength(160);
    expect(event.metadata.latencyMs).toBe(12);
  });
});

describe("provider naming stays inside Usage Monitor's canon", () => {
  it("prefers the engine over an operator-chosen instance id", () => {
    expect(inferProviderAndService("my-box", "gpt-5", "boxAgent").provider).toBe("box");
    expect(inferProviderAndService("computer", undefined, "boxAgent").provider).toBe("box");
  });

  it("keeps the two-argument form working exactly as before", () => {
    expect(inferProviderAndService("claude", "claude-sonnet-5")).toEqual({
      provider: "anthropic",
      service: "claude-sonnet-5",
    });
    expect(inferProviderAndService("codex", "gpt-5")).toEqual({ provider: "openai", service: "gpt-5" });
    expect(inferProviderAndService("grok", "grok-4")).toEqual({ provider: "xai", service: "grok-4" });
  });
});
