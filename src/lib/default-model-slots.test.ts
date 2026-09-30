import { describe, expect, it } from "vitest";

import { MAX_MODEL_FALLBACKS } from "../../shared/model-limits";
import {
  applyDefaultsBody,
  emptyFallbackSlots,
  hasDefaults,
  withSlot,
  type DefaultModelSlot,
} from "./default-model-slots";

const sel = (model: string, instanceId = "codex"): DefaultModelSlot => ({ instanceId, model });

describe("emptyFallbackSlots", () => {
  it("has one empty place per allowed fallback", () => {
    expect(emptyFallbackSlots()).toEqual([null, null, null]);
    expect(emptyFallbackSlots()).toHaveLength(MAX_MODEL_FALLBACKS);
  });

  it("returns a fresh list each time", () => {
    const first = emptyFallbackSlots();
    first[0] = sel("x");
    expect(emptyFallbackSlots()[0]).toBeNull();
  });
});

describe("withSlot", () => {
  it("replaces exactly one place and leaves the others", () => {
    const next = withSlot(emptyFallbackSlots(), 1, sel("b"));
    expect(next).toEqual([null, sel("b"), null]);
  });

  it("does not mutate its input", () => {
    const before = emptyFallbackSlots();
    withSlot(before, 2, sel("c"));
    expect(before).toEqual([null, null, null]);
  });

  it("clears a place back to null", () => {
    const filled = withSlot(withSlot(emptyFallbackSlots(), 0, sel("a")), 2, sel("c"));
    expect(withSlot(filled, 0, null)).toEqual([null, null, sel("c")]);
  });

  it("ignores a place outside the cap instead of growing the list", () => {
    const base = emptyFallbackSlots();
    expect(withSlot(base, 3, sel("d"))).toEqual(base);
    expect(withSlot(base, -1, sel("d"))).toEqual(base);
  });
});

describe("hasDefaults", () => {
  it("is false for an untouched block", () => {
    expect(hasDefaults(null, emptyFallbackSlots())).toBe(false);
  });

  it("is true for a primary alone, or for any single fallback", () => {
    expect(hasDefaults(sel("p"), emptyFallbackSlots())).toBe(true);
    expect(hasDefaults(null, withSlot(emptyFallbackSlots(), 2, sel("c")))).toBe(true);
  });
});

describe("applyDefaultsBody", () => {
  it("sends fallbacks by fixed index, with null for an empty picker", () => {
    // Only "Fallback 3" chosen: position 2 carries it, positions 0 and 1 stay
    // null.  Nothing is compacted into position 0.
    const body = applyDefaultsBody(null, withSlot(emptyFallbackSlots(), 2, sel("c")));
    expect(body).toEqual({
      slots: { primary: null, fallbacks: [null, null, { instanceId: "codex", model: "c" }] },
    });
  });

  it("sends only Fallback 2 at position 1", () => {
    const body = applyDefaultsBody(sel("p", "claude"), withSlot(emptyFallbackSlots(), 1, sel("b")));
    expect(body.slots.primary).toEqual({ instanceId: "claude", model: "p" });
    expect(body.slots.fallbacks).toEqual([null, { instanceId: "codex", model: "b" }, null]);
  });

  it("always sends exactly one entry per place, however long the input", () => {
    expect(applyDefaultsBody(null, []).slots.fallbacks).toEqual([null, null, null]);
    const tooMany = [sel("a"), sel("b"), sel("c"), sel("d")];
    expect(applyDefaultsBody(null, tooMany).slots.fallbacks).toHaveLength(MAX_MODEL_FALLBACKS);
  });

  it("strips anything but instance and model from a slot", () => {
    const withEffort = { instanceId: "codex", model: "a", effort: "high" as const };
    const body = applyDefaultsBody(withEffort, [withEffort, null, null]);
    expect(body.slots.primary).toEqual({ instanceId: "codex", model: "a" });
    expect(body.slots.fallbacks[0]).toEqual({ instanceId: "codex", model: "a" });
  });
});
