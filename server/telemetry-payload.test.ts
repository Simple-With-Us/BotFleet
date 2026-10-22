// The wire shape Usage Monitor actually receives.
//
// Three things go wrong quietly here, and each one costs money rather than
// throwing.  A driver's `input` figure already contains the cached tokens,
// so a naive per-token-type split bills the cache twice.  `costUsd` repeated
// across a split turn trebles reported spend, because Usage Monitor sums
// producer cost into the pool that drives budget alerts.  And the v2 event
// schema is `.strict()`, so one unrecognised top-level key — `model` and
// `keyRef` are the two that keep getting reached for — rejects the whole
// event rather than dropping the key.
//
// These tests are pure: `buildTurnEvents` never touches the network, so the
// arithmetic is checked without a fetch stub anywhere near it.
import { describe, expect, it } from "vitest";

import { buildTurnEvents, inferProviderAndService, type TelemetryTurnParams } from "./telemetry.ts";

/** Every top-level key the v2 event schema accepts
 * (`congress-trading-shared@2.6.0` `UsageTelemetryV2EventSchema`, which is
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
]);

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
  // so subtracting the cache back out is what keeps the split honest.
  it("subtracts the cache out of input so nothing is counted twice", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.quantity)).toEqual([600, 400, 200]);
    expect(events.map((event) => event.metadata.tokenType)).toEqual(["input", "cacheRead", "output"]);

    const total = events.reduce((sum, event) => sum + event.quantity, 0);
    expect(total).toBe(1200);
  });

  it("keeps the raw driver figures in metadata untouched", () => {
    const [first] = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    expect(first.metadata.inputTokens).toBe(1000);
    expect(first.metadata.cachedInputTokens).toBe(400);
    expect(first.metadata.outputTokens).toBe(200);
  });

  it("drops a slice with nothing in it rather than sending a zero row", () => {
    const events = build({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 120 });

    expect(events.map((event) => event.metadata.tokenType)).toEqual(["input", "output"]);
    expect(events.map((event) => event.quantity)).toEqual([500, 120]);
  });

  it("survives a cache figure larger than the input figure", () => {
    const events = build({ inputTokens: 100, cachedInputTokens: 400, outputTokens: 0 });

    expect(events.map((event) => event.quantity)).toEqual([400]);
    expect(events[0]?.metadata.tokenType).toBe("cacheRead");
  });

  it("rounds and clamps the driver's figures", () => {
    const events = build({ inputTokens: 10.6, cachedInputTokens: -5, outputTokens: 2.2 });

    expect(events.map((event) => event.quantity)).toEqual([11, 2]);
  });
});

describe("money lands exactly once", () => {
  it("puts the turn's cost and its one request on the first event only", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, costUsd: 0.0421 });

    expect(events).toHaveLength(3);
    expect(events[0]?.costUsd).toBe(0.0421);
    for (const event of events.slice(1)) expect(event.costUsd).toBe(0);
    expect(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)).toBeCloseTo(0.0421, 10);

    const requests = events.reduce((sum, event) => sum + event.requests, 0);
    expect(requests).toBe(1);
  });

  // Usage Monitor reads pricing coverage off `_count.costUsd` against
  // `_count._all`: an event with the key absent is an unpriced event.  Send
  // two of the three slices without it and every priced turn reports
  // "partial" cost coverage — a pricing gap that does not exist — and the
  // monitor's own derivation stamps an estimate on the two thirds of a turn
  // whose real cost the producer already reported.
  it("marks every slice of a priced turn as priced, not just the one with the money", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, costUsd: 0.0421 });

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(Object.hasOwn(event, "costUsd")).toBe(true);
      expect(event.costUsd).not.toBeNull();
      expect(event.billingMode).toBe("actual");
      expect(event.confidence).toBe("actual");
    }
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

    expect(events.map((event) => event.metadata.estimatedCostUsd)).toEqual([0.0421, 0, 0]);
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
  it("gives every slice its own id under one shared prefix", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });
    const ids = events.map((event) => event.eventId);

    expect(new Set(ids).size).toBe(3);
    const prefix = ids[0]?.slice(0, ids[0].lastIndexOf(":"));
    expect(prefix).toBeTruthy();
    for (const id of ids) expect(id.startsWith(`${prefix}:`)).toBe(true);
    expect(ids.map((id) => id.slice(prefix!.length + 1))).toEqual(["in", "cache", "out"]);
    expect(prefix?.startsWith("bf:anthropic:bot_1:1757000000000:")).toBe(true);
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
  // report usage.  A phantom one-token row would read as real spend; a zero
  // row with the flag reads as what it is.
  it("emits one zero-quantity event flagged as unreported", () => {
    const events = build({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

    expect(events).toHaveLength(1);
    expect(events[0]?.quantity).toBe(0);
    expect(events[0]?.requests).toBe(1);
    expect(events[0]?.metadata.tokenType).toBe("unknown");
    expect(events[0]?.metadata.usageReported).toBe(false);
  });

  it("marks a turn that did report usage as reported", () => {
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 });

    for (const event of events) expect(event.metadata.usageReported).toBe(true);
  });

  it("still reports the cost of a turn with no token figures", () => {
    const events = build({ costUsd: 0.02 });

    expect(events).toHaveLength(1);
    expect(events[0]?.costUsd).toBe(0.02);
    expect(events[0]?.quantity).toBe(0);
  });
});

describe("room turns", () => {
  it("stamps the room on every event of that turn", () => {
    const events = build({
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      roomId: "room_7",
      roomName: "Launch Room",
    });

    expect(events).toHaveLength(3);
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
    // reject the whole event.  On every slice, like the token figures, so a
    // reader that filters by tokenType still sees them.
    const events = build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, promptBytes: { stable: 4096, volatile: 128 } });
    expect(events).toHaveLength(3);
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

describe("token types Usage Monitor can price", () => {
  // derive-ingest-cost.ts only prices these four strings; anything else is
  // silently treated as input, which is the gap this split closes.
  const PRICEABLE = new Set(["input", "output", "cacheRead", "cacheCreation"]);

  it("names a priceable token type on every event that carries tokens", () => {
    for (const event of build({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 })) {
      expect(PRICEABLE.has(String(event.metadata.tokenType))).toBe(true);
    }
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
