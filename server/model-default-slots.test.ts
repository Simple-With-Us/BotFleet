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
    expect(models(applyFallbackSlots(existing, [set("x"), set("y"), set("z")]))).toEqual(["x", "y", "z"]);
  });

  it("puts a lone Fallback 2 on position 1 and leaves Fallback 1 alone", () => {
    // The old route compacted the filled slots, so this overwrote Fallback 1.
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(applyFallbackSlots(existing, [KEEP, set("y"), KEEP]))).toEqual(["a", "y", "c"]);
  });

  it("puts a lone Fallback 3 on position 2 when the bot has three", () => {
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(applyFallbackSlots(existing, [KEEP, KEEP, set("z")]))).toEqual(["a", "b", "z"]);
  });

  it("returns the chain unchanged when every place is left alone", () => {
    const existing = [sel("a"), sel("b")];
    expect(applyFallbackSlots(existing, [KEEP, KEEP, KEEP])).toEqual(existing);
  });

  it("does not mutate the chain it was given", () => {
    const existing = [sel("a"), sel("b")];
    const snapshot = JSON.parse(JSON.stringify(existing));
    applyFallbackSlots(existing, [set("x"), CLEAR, set("z")]);
    expect(existing).toEqual(snapshot);
  });

  it("appends a place past the end of a short chain instead of padding a hole", () => {
    // A bot with one fallback told "Fallback 3" ends up with two, the new one
    // last.  No empty entry, and no copy of the primary invented to fill it.
    expect(models(applyFallbackSlots([sel("a")], [KEEP, KEEP, set("z")]))).toEqual(["a", "z"]);
    expect(models(applyFallbackSlots([], [KEEP, set("y"), KEEP]))).toEqual(["y"]);
    expect(models(applyFallbackSlots([], [KEEP, set("y"), set("z")]))).toEqual(["y", "z"]);
  });

  it("never stores an empty entry", () => {
    const result = applyFallbackSlots([], [KEEP, KEEP, set("z")]);
    expect(result.every((entry) => entry.instanceId !== "" && entry.model !== "")).toBe(true);
  });

  it("clears the entry at a place and lets the ones after it move up", () => {
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(applyFallbackSlots(existing, [KEEP, CLEAR, KEEP]))).toEqual(["a", "c"]);
    expect(models(applyFallbackSlots(existing, [CLEAR, CLEAR, CLEAR]))).toEqual([]);
  });

  it("reads every place against the chain as it was", () => {
    // Set Fallback 1 and clear Fallback 2: exactly those two entries change.
    const existing = [sel("a"), sel("b"), sel("c")];
    expect(models(applyFallbackSlots(existing, [set("x"), CLEAR, KEEP]))).toEqual(["x", "c"]);
    expect(models(applyFallbackSlots(existing, [CLEAR, set("y"), KEEP]))).toEqual(["y", "c"]);
  });

  it("treats clearing a place the bot does not have as a no-op", () => {
    expect(models(applyFallbackSlots([sel("a")], [KEEP, CLEAR, CLEAR]))).toEqual(["a"]);
    expect(applyFallbackSlots([], [CLEAR, CLEAR, CLEAR])).toEqual([]);
  });

  it("leaves entries past the addressable places where they are", () => {
    // A chain over the cap keeps its tail; the request can only name 0..2.
    const existing = [sel("a"), sel("b"), sel("c"), sel("d"), sel("e")];
    expect(models(applyFallbackSlots(existing, [set("x"), KEEP, KEEP]))).toEqual(["x", "b", "c", "d", "e"]);
    expect(models(applyFallbackSlots(existing, [KEEP, KEEP, KEEP, set("ignored")]))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("never grows a chain past max(cap, what it had)", () => {
    expect(applyFallbackSlots([], [set("x"), set("y"), set("z"), set("w")]).length).toBe(3);
    expect(applyFallbackSlots([sel("a"), sel("b"), sel("c"), sel("d")], [set("x"), set("y"), set("z")]).length).toBe(4);
  });

  it("writes instance and model only, dropping the old entry's effort", () => {
    const existing: ModelSelection[] = [{ instanceId: "fake", model: "a", effort: "high" }];
    const [written] = applyFallbackSlots(existing, [set("x")]);
    expect(written).toEqual({ instanceId: "fake", model: "x" });
  });
});
