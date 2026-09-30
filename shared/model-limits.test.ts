import { describe, expect, it } from "vitest";

import {
  canAddFallback,
  fallbackCountAllowed,
  fallbackSlotCount,
  MAX_MODEL_FALLBACKS,
} from "./model-limits";

describe("MAX_MODEL_FALLBACKS", () => {
  it("is the owner's three", () => {
    expect(MAX_MODEL_FALLBACKS).toBe(3);
  });
});

describe("fallbackSlotCount", () => {
  it("draws at least the cap, so an empty chain still offers every place", () => {
    expect(fallbackSlotCount(0)).toBe(3);
    expect(fallbackSlotCount(2)).toBe(3);
    expect(fallbackSlotCount(3)).toBe(3);
  });

  it("never draws fewer places than the bot stores", () => {
    expect(fallbackSlotCount(4)).toBe(4);
    expect(fallbackSlotCount(7)).toBe(7);
  });
});

describe("canAddFallback", () => {
  it("offers Add below the cap and stops at it", () => {
    expect(canAddFallback(0)).toBe(true);
    expect(canAddFallback(2)).toBe(true);
    expect(canAddFallback(3)).toBe(false);
  });

  it("offers nothing to a chain already over the cap", () => {
    expect(canAddFallback(4)).toBe(false);
  });
});

describe("fallbackCountAllowed", () => {
  it("allows up to the cap with no stored chain, and refuses past it", () => {
    expect(fallbackCountAllowed(0)).toBe(true);
    expect(fallbackCountAllowed(3)).toBe(true);
    expect(fallbackCountAllowed(4)).toBe(false);
    expect(fallbackCountAllowed(4, 0)).toBe(false);
  });

  it("refuses growth past the cap from a chain that was under it", () => {
    expect(fallbackCountAllowed(4, 2)).toBe(false);
    expect(fallbackCountAllowed(4, 3)).toBe(false);
  });

  it("lets a chain that is already over the cap be re-sent unchanged", () => {
    // Changing only the primary re-sends the whole chain.
    expect(fallbackCountAllowed(4, 4)).toBe(true);
    expect(fallbackCountAllowed(6, 6)).toBe(true);
  });

  it("lets an over-cap chain shrink, but not grow", () => {
    expect(fallbackCountAllowed(3, 5)).toBe(true);
    expect(fallbackCountAllowed(4, 5)).toBe(true);
    expect(fallbackCountAllowed(6, 5)).toBe(false);
  });
});
