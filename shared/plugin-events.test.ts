import { describe, expect, it } from "vitest";

import {
  pluginEventEnvelopeSchema,
  pluginRoutingDecisionSchema,
  stablePluginEventId,
  subscriptionMatchesEvent,
} from "./plugin-events.ts";

function envelope(): Record<string, unknown> {
  return {
    eventId: "zulip:BF-Plumber:42",
    type: "zulip.message",
    source: { platform: "zulip", accountId: "BF-Plumber" },
    occurredAt: "2026-10-15T12:00:00.000Z",
    receivedAt: "2026-10-15T12:00:01.000Z",
    refs: { messageId: 42, conversationKey: "dm:7", channel: undefined, topic: undefined },
    mentions: ["BF-Plumber"],
    context: { botId: "bot-plumber", wakeReason: "dm", senderKind: "owner" },
  };
}

describe("plugin event envelope", () => {
  it("accepts a minimal valid envelope", () => {
    expect(pluginEventEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const parsed = pluginEventEnvelopeSchema.safeParse({ ...envelope(), webhookToken: "x" });
    expect(parsed.success).toBe(false);
  });

  it("rejects oversized content text", () => {
    const parsed = pluginEventEnvelopeSchema.safeParse({
      ...envelope(),
      content: { text: "x".repeat(8193), format: "text" },
    });
    expect(parsed.success).toBe(false);
  });

  it("caps chat summaries at 20", () => {
    const summaries = Array.from({ length: 21 }, (_, i) => ({
      botId: `b${i}`, botName: `B${i}`, threadId: `t${i}`, title: "t",
      lastActiveAt: "2026-10-15T12:00:00.000Z", messageCount: 1,
    }));
    const parsed = pluginEventEnvelopeSchema.safeParse({
      ...envelope(),
      context: { botId: "b", wakeReason: "dm", senderKind: "peer", chatSummaries: summaries },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("routing decisions", () => {
  it("accepts a wake request with a target", () => {
    expect(pluginRoutingDecisionSchema.safeParse({
      action: "requestWake", targetBotId: "bot-director", rationale: "owner DM",
    }).success).toBe(true);
  });

  it("rejects a wake request with no target", () => {
    const parsed = pluginRoutingDecisionSchema.safeParse({ action: "requestWake" });
    expect(parsed.success).toBe(false);
  });

  it("caps reply hints at 2000 chars", () => {
    const parsed = pluginRoutingDecisionSchema.safeParse({
      action: "requestWake", targetBotId: "b", replyHint: "x".repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("stable event ids and matching", () => {
  it("builds stable ids", () => {
    expect(stablePluginEventId("zulip", "BF-Plumber", 42)).toBe("zulip:BF-Plumber:42");
  });

  it("matches subscriptions by source and kind", () => {
    const sub = { source: "zulip" as const, kinds: ["message" as const] };
    expect(subscriptionMatchesEvent(sub, {
      type: "zulip.message", source: { platform: "zulip" as const, accountId: "X" },
    })).toBe(true);
    expect(subscriptionMatchesEvent({ ...sub, source: "zulip" as const }, {
      type: "zulip.message", source: { platform: "zulip" as const, accountId: "X" },
    })).toBe(true);
  });
});
