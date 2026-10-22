import { describe, expect, it } from "vitest";

import { normalizeStopReason, settleForStopReason } from "./core.ts";

describe("normalizeStopReason", () => {
  it("accepts both spellings of the same reason", () => {
    // The wire format is camelCase and several agents send endTurn; the
    // driver was written against the snake_case spelling and counted
    // everything else as a failure.
    expect(normalizeStopReason("endTurn")).toBe("end_turn");
    expect(normalizeStopReason("end_turn")).toBe("end_turn");
    expect(normalizeStopReason("maxTokens")).toBe("max_tokens");
    expect(normalizeStopReason("cancelled")).toBe("cancelled");
  });

  it("leaves an unknown reason recognisable rather than inventing success", () => {
    expect(normalizeStopReason("refusal")).toBe("refusal");
    expect(normalizeStopReason("some new reason")).toBe("some_new_reason");
  });

  it("returns undefined for anything that is not a string", () => {
    expect(normalizeStopReason(undefined)).toBeUndefined();
    expect(normalizeStopReason(null)).toBeUndefined();
    expect(normalizeStopReason(7)).toBeUndefined();
  });
});

describe("settleForStopReason", () => {
  it("keeps a plain end of turn nameless", () => {
    expect(settleForStopReason("end_turn")).toEqual({ ok: true, stopReason: null });
  });

  it("settles a truncated answer as ok but says so", () => {
    // max_tokens used to fold into the same null as end_turn, so a reply
    // cut short was indistinguishable from a whole one downstream.
    expect(settleForStopReason(normalizeStopReason("maxTokens"))).toEqual({ ok: true, stopReason: "max_tokens" });
    expect(settleForStopReason("max_tokens")).toEqual({ ok: true, stopReason: "max_tokens" });
  });

  it("treats the person's own cancel as a clean stop", () => {
    expect(settleForStopReason("cancelled")).toEqual({ ok: true, stopReason: "cancelled" });
  });

  it("fails anything else under its own name, and a missing reason as failed", () => {
    expect(settleForStopReason("refusal")).toEqual({ ok: false, stopReason: "refusal" });
    expect(settleForStopReason(undefined)).toEqual({ ok: false, stopReason: "failed" });
  });
});
