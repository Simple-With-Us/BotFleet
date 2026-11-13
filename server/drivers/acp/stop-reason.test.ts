import { describe, expect, it } from "vitest";

import { normalizeStopReason } from "./core.ts";

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
