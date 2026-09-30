import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import {
  applyFallbackSlots,
  KEEP_FALLBACK_SLOT,
  touchesFallbacks,
  type FallbackSlot,
} from "./model-default-slots.ts";

const sel = (model: string, instanceId = "fake"): ModelSelection => ({ instanceId, model });
const set = (model: string): FallbackSlot => ({ kind: "set", selection: sel(model) });
const CLEAR: FallbackSlot = { kind: "clear" };
const KEEP = KEEP_FALLBACK_SLOT;
const models = (chain: ModelSelection[]) => chain.map((entry) => entry.model);
/** The new chain for a request the bot accepts; fails the test if it refuses. */
const chainOf = (existing: ModelSelection[], slots: FallbackSlot[]): ModelSelection[] => {
  const result = applyFallbackSlots(existing, slots);
  if (!result.ok) throw new Error(`expected the bot to accept the request: ${result.reason}`);
  return result.fallbacks;
};
/** The reason a bot refuses a request; fails the test if it accepts. */
const refusalOf = (existing: ModelSelection[], slots: FallbackSlot[]): string => {
  const result = applyFallbackSlots(existing, slots);
  if (result.ok) throw new Error(`expected the bot to refuse, got ${JSON.stringify(models(result.fallbacks))}`);
  return result.reason;
};

describe("touchesFallbacks", () => {
  it("is false when every place is left alone", () => {
    expect(touchesFallbacks([KEEP, KEEP, KEEP])).toBe(false);
    expect(touchesFallbacks([])).toBe(false);
  });

  it("is true when any place writes or clears", () => {
    expect(touchesFallbacks([KEEP, set("x"), KEEP])).toBe(true);
    expect(touchesFallbacks([KEEP, KEEP, CLEAR])).toBe(true);
  });
});

describe("applyFallbackSlots", () => {
  it("writes each place at its own position", () => {
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(chainOf(existing, [set("x"), set("y"), set("z")]))).toEqual(["x", "y", "z"]);
  });

  it("puts a lone Fallback 2 on position 1 and leaves Fallback 1 alone", () => {
    // The old route compacted the filled slots, so this overwrote Fallback 1.
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(chainOf(existing, [KEEP, set("y"), KEEP]))).toEqual(["a", "y", "c"]);
  });

  it("puts a lone Fallback 3 on position 2 when the bot has three", () => {
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(chainOf(existing, [KEEP, KEEP, set("z")]))).toEqual(["a", "b", "z"]);
  });

  it("returns the chain unchanged when every place is left alone", () => {
    const existing = [sel("a"), sel("b")];
    expect(chainOf(existing, [KEEP, KEEP, KEEP])).toEqual(existing);
  });

  it("does not mutate the chain it was given", () => {
    const existing = [sel("a"), sel("b")];
    const snapshot = JSON.parse(JSON.stringify(existing));
    applyFallbackSlots(existing, [set("x"), CLEAR, KEEP]);
    applyFallbackSlots(existing, [set("x"), CLEAR, set("z")]);
    expect(existing).toEqual(snapshot);
  });

  it("extends a chain by one when the place is the first one past its end", () => {
    // That is still the place's own position: Fallback 2 on a bot with one
    // fallback is a Fallback 2, and Fallback 1 on a bot with none is a Fallback 1.
    expect(models(chainOf([sel("a")], [KEEP, set("y"), KEEP]))).toEqual(["a", "y"]);
    expect(models(chainOf([], [set("x"), KEEP, KEEP]))).toEqual(["x"]);
    expect(models(chainOf([sel("a"), sel("b")], [KEEP, KEEP, set("z")]))).toEqual(["a", "b", "z"]);
  });

  it("fills places in turn, so setting several at once never leaves a gap", () => {
    expect(models(chainOf([], [set("x"), set("y"), set("z")]))).toEqual(["x", "y", "z"]);
    expect(models(chainOf([sel("a")], [KEEP, set("y"), set("z")]))).toEqual(["a", "y", "z"]);
  });

  it("refuses a place that would leave an empty one before it, naming the empty place", () => {
    // The Sentry finding on #737: "Fallback 3" on a bot with one fallback used
    // to be pushed to the end, so it landed on Fallback 2 — the wrong place.
    // A chain cannot hold a hole and padding would invent a fallback nobody
    // chose, so the bot is refused instead and keeps what it had.
    expect(refusalOf([sel("a")], [KEEP, KEEP, set("z")])).toBe("Fallback 2 is empty, so Fallback 3 cannot be set");
    expect(refusalOf([], [KEEP, KEEP, set("z")])).toBe("Fallback 1 is empty, so Fallback 3 cannot be set");
    expect(refusalOf([], [KEEP, set("y"), KEEP])).toBe("Fallback 1 is empty, so Fallback 2 cannot be set");
    // The hole can be made by the same request: Fallback 2 is left empty.
    expect(refusalOf([], [set("x"), KEEP, set("z")])).toBe("Fallback 2 is empty, so Fallback 3 cannot be set");
  });

  it("names the first empty place, not the last", () => {
    expect(refusalOf([], [KEEP, set("y"), set("z")])).toBe("Fallback 1 is empty, so Fallback 2 cannot be set");
  });

  it("never returns a chain with an empty entry", () => {
    const requests: [ModelSelection[], FallbackSlot[]][] = [
      [[], [KEEP, KEEP, set("z")]],
      [[sel("a")], [KEEP, KEEP, set("z")]],
      [[], [set("x"), KEEP, set("z")]],
      [[sel("a"), sel("b"), sel("c")], [CLEAR, KEEP, set("z")]],
      [[], [set("x"), set("y"), set("z")]],
    ];
    for (const [existing, slots] of requests) {
      const result = applyFallbackSlots(existing, slots);
      if (!result.ok) continue;
      expect(result.fallbacks.every((entry) => entry.instanceId !== "" && entry.model !== "")).toBe(true);
    }
  });

  it("clears the entry at a place and lets the ones after it move up", () => {
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(chainOf(existing, [KEEP, CLEAR, KEEP]))).toEqual(["a", "c"]);
    expect(models(chainOf(existing, [CLEAR, CLEAR, CLEAR]))).toEqual([]);
  });

  it("reads every place against the chain as it was", () => {
    // Set Fallback 1 and clear Fallback 2: exactly those two entries change.
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(chainOf(existing, [set("x"), CLEAR, KEEP]))).toEqual(["x", "c"]);
  });

  it("refuses a place that a clear before it would pull out from under", () => {
    // Clear Fallback 1 and set Fallback 2: the new entry would move up onto
    // Fallback 1, so it would not be where the request put it.
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(refusalOf(existing, [CLEAR, set("y"), KEEP])).toBe("Fallback 1 is empty, so Fallback 2 cannot be set");
    expect(refusalOf(existing, [set("x"), CLEAR, set("z")])).toBe("Fallback 2 is empty, so Fallback 3 cannot be set");
    // A clear AFTER the set moves nothing the set wrote.
    expect(models(chainOf(existing, [set("x"), set("y"), CLEAR]))).toEqual(["x", "y"]);
  });

  it("treats clearing a place the bot does not have as a no-op", () => {
    expect(models(chainOf([sel("a")], [KEEP, CLEAR, CLEAR]))).toEqual(["a"]);
    expect(chainOf([], [CLEAR, CLEAR, CLEAR])).toEqual([]);
  });

  it("leaves entries past the addressable places where they are", () => {
    // A chain over the cap keeps its tail; the request can only name 0..2.
    const existing = [sel("a"), sel("b"), sel("c"), sel("d"), sel("e")];
    expect(models(chainOf(existing, [set("x"), KEEP, KEEP]))).toEqual(["x", "b", "c", "d", "e"]);
    expect(models(chainOf(existing, [KEEP, KEEP, KEEP, set("ignored")]))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("never grows a chain past max(cap, what it had)", () => {
    expect(chainOf([], [set("x"), set("y"), set("z"), set("w")]).length).toBe(3);
    expect(chainOf([sel("a"), sel("b"), sel("c"), sel("d")], [set("x"), set("y"), set("z")]).length).toBe(4);
  });

  it("writes instance and model only, dropping the old entry's effort", () => {
    const existing: ModelSelection[] = [{ instanceId: "fake", model: "a", effort: "high" }];
    const [written] = chainOf(existing, [set("x")]);
    expect(written).toEqual({ instanceId: "fake", model: "x" });
  });
});
