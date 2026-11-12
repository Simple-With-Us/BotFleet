import { describe, expect, it } from "vitest";

import {
  normalizeWebhookPayloadForDedupe,
  sameWebhookPayloadDedupeIdentity,
  webhookPayloadDedupeHash,
  webhookPayloadDedupeIdentity,
  webhookPayloadDedupeSource,
} from "./webhook-payload-dedupe.ts";

describe("webhook payload normalization", () => {
  it("strips delivery ids and timestamps and ignores key order", () => {
    const left = {
      timestamp: "2026-11-12T03:00:00Z",
      delivery_id: "one",
      task: "review",
      meta: { requestId: "abc", createdAt: "2026-11-12T03:00:01.000Z", note: "keep" },
    };
    const right = {
      task: "review",
      "x-github-delivery": "two",
      meta: { note: "keep", updated_at: 1_700_000_000, "idempotency-key": "zzz" },
      sent_at: "2026-11-12T04:00:00+00:00",
    };
    expect(webhookPayloadDedupeHash(left)).toBe(webhookPayloadDedupeHash(right));
    expect(normalizeWebhookPayloadForDedupe(left)).toEqual({ task: "review", meta: { note: "keep" } });
  });

  it("keeps a record id, an event id, and text that merely mentions a time", () => {
    const first = webhookPayloadDedupeHash({
      id: "record-1",
      event_id: "evt-1",
      message: "shipped at 2026-11-12T03:00:00Z",
      time: "morning",
    });
    const second = webhookPayloadDedupeHash({
      id: "record-2",
      event_id: "evt-1",
      message: "shipped at 2026-11-12T03:00:00Z",
      time: "morning",
    });
    const third = webhookPayloadDedupeHash({
      id: "record-1",
      event_id: "evt-2",
      message: "shipped at 2026-11-12T09:00:00Z",
      time: "evening",
    });
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
  });

  it("keeps array order and a non-timestamp clock suffix", () => {
    expect(webhookPayloadDedupeHash({ labels: ["a", "b"] })).not.toBe(webhookPayloadDedupeHash({ labels: ["b", "a"] }));
    expect(webhookPayloadDedupeHash({ completed_at: "not-a-date", action: "opened" })).not.toBe(
      webhookPayloadDedupeHash({ action: "opened" }),
    );
    expect(webhookPayloadDedupeHash({ completed_at: "2026-11-12T03:00:00Z", action: "opened" })).toBe(
      webhookPayloadDedupeHash({ action: "opened" }),
    );
  });

  it("builds the source from the trigger and the event name", () => {
    expect(webhookPayloadDedupeSource("trig-1", " push ")).toBe("trig-1:push");
    expect(webhookPayloadDedupeSource("trig-1", "issues")).toBe("trig-1:issues");
    expect(webhookPayloadDedupeSource("trig-1", "   ")).toBe("trig-1");
    const left = webhookPayloadDedupeIdentity("bot-a", "trig-1", "push", { n: 1 });
    const right = webhookPayloadDedupeIdentity("bot-b", "trig-1", "push", { n: 1 });
    const otherEvent = webhookPayloadDedupeIdentity("bot-a", "trig-1", "issues", { n: 1 });
    expect(sameWebhookPayloadDedupeIdentity(left, left)).toBe(true);
    expect(sameWebhookPayloadDedupeIdentity(left, right)).toBe(false);
    expect(sameWebhookPayloadDedupeIdentity(left, otherEvent)).toBe(false);
  });
});
