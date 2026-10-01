import { describe, expect, it } from "vitest";
import { effectiveFallbackTiers } from "./model-fallback.ts";
import type { ModelSelection } from "./contracts.ts";

const at = (instanceId: string, model: string): ModelSelection => ({ instanceId, model });

describe("effectiveFallbackTiers", () => {
  it("counts a plain chain as configured", () => {
    const chain = [at("grok", "grok-4.7"), at("dsh", "MiniMax-M3"), at("claude", "claude-sonnet-5")];
    expect(effectiveFallbackTiers(at("antigravity", "gemini-3.1-pro"), chain)).toMatchObject({
      total: 4,
      redundant: [],
    });
  });

  it("names a fallback that is a second copy of the primary", () => {
    // The state two live bots were in: a third fallback configured as the
    // primary itself. The runtime skips it — `sameEngine()` drops any
    // candidate equal to the engine that just failed — so the chain has two
    // real tiers, not three, and the settings panel said three.
    const primary = at("grok", "grok-4.6");
    const chain = [at("minimax", "MiniMax-M3"), primary];
    const verdict = effectiveFallbackTiers(primary, chain);
    expect(verdict.total).toBe(3);
    expect(verdict.effective).toBe(2);
    expect(verdict.redundant).toEqual([{ instanceId: "grok", model: "grok-4.6", reason: "same-as-primary" }]);
  });

  it("also names a fallback that repeats an earlier fallback", () => {
    // `sameEngine` skips those too, for the same reason and at the same moment.
    const primary = at("antigravity", "gemini-3.1-pro");
    const chain = [at("dsh", "MiniMax-M3"), at("dsh", "MiniMax-M3"), at("grok", "grok-4.7")];
    const verdict = effectiveFallbackTiers(primary, chain);
    expect(verdict.total).toBe(4);
    expect(verdict.effective).toBe(3);
    expect(verdict.redundant).toEqual([{ instanceId: "dsh", model: "MiniMax-M3", reason: "duplicate" }]);
  });

  it("treats a different model on one engine as a real tier", () => {
    // Same instance, different model is a different thing to fail over to, and
    // the runtime does keep it.
    const primary = at("antigravity", "gemini-3.1-pro");
    const chain = [at("antigravity", "gemini-flash-high")];
    expect(effectiveFallbackTiers(primary, chain)).toMatchObject({ total: 2, effective: 2, redundant: [] });
  });

  it("reports an empty chain as itself", () => {
    const primary = at("grok", "grok-4.7");
    expect(effectiveFallbackTiers(primary, [])).toMatchObject({ total: 1, effective: 1, redundant: [] });
  });

  it("does not mutate the chain it was handed", () => {
    const primary = at("grok", "grok-4.6");
    const chain = [at("minimax", "MiniMax-M3"), primary];
    const before = JSON.stringify(chain);
    effectiveFallbackTiers(primary, chain);
    expect(JSON.stringify(chain)).toBe(before);
  });
});
