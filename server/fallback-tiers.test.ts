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

  it("does NOT call a trailing repeat of the primary redundant", () => {
    // A correction to an earlier reading of this code, and the reason the
    // original analysis was wrong. `selectTurnFallback` compares a candidate
    // with `input.current` — the engine that JUST failed — and not with
    // everything walked. So in A -> f1 -> A the trailing A is compared with f1,
    // differs, and is selected. Three hops, all reachable.
    //
    // Two live bots are configured exactly this way and I had reported them as
    // broken. They are not. Only an ADJACENT repeat is dead weight.
    const primary = at("grok", "grok-4.6");
    const chain = [at("minimax", "MiniMax-M3"), primary];
    expect(effectiveFallbackTiers(primary, chain)).toMatchObject({ total: 3, effective: 3, redundant: [] });
  });

  it("names an ADJACENT repeat, and only an adjacent one", () => {
    // `selectTurnFallback` compares a candidate with the engine that just
    // failed, not with everything seen. So B after B is dead weight, while A
    // after B is a real hop: the first failure picks B, B then fails, and the
    // trailing A is exactly what the walk reaches next.
    const primary = at("antigravity", "gemini-3.1-pro");
    expect(effectiveFallbackTiers(primary, [at("dsh", "MiniMax-M3"), at("dsh", "MiniMax-M3"), at("grok", "grok-4.7")]))
      .toMatchObject({ total: 4, effective: 3 });
  });

  it("counts A -> B -> A as fully reachable", () => {
    // A regression this caught: an earlier, global dedup reported this as two
    // usable tiers out of four, which would have told the owner to fix a chain
    // the runtime walks end to end.
    const primary = at("grok", "grok-4.6");
    const chain = [at("dsh", "MiniMax-M3"), primary];
    expect(effectiveFallbackTiers(primary, chain)).toMatchObject({ total: 3, effective: 3, redundant: [] });
  });

  it("reports the primary repeated straight after itself", () => {
    const primary = at("grok", "grok-4.6");
    expect(effectiveFallbackTiers(primary, [primary])).toMatchObject({
      total: 2,
      effective: 1,
      redundant: [{ instanceId: "grok", model: "grok-4.6", reason: "same-as-primary" }],
    });
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

  it("collapses a retired id to its live replacement on the same engine", () => {
    // The primary is the retired id and the fallback is its already-rewritten
    // replacement. selectTurnFallback rewrites both sides before comparing, so
    // they are the same engine from the runtime's point of view; the chain has
    // no real second tier. The redundant entry still names the configured
    // (unrewritten) model string, not whatever rewriteRetiredModelId would map
    // it onto, so Settings shows the owner what they actually typed.
    const primary = at("dsh", "MiniMax-M3");
    const chain = [at("dsh", "MiniMax-M3.1-Flash-Preview")];
    expect(effectiveFallbackTiers(primary, chain)).toMatchObject({
      total: 2,
      effective: 1,
      redundant: [{ instanceId: "dsh", model: "MiniMax-M3.1-Flash-Preview", reason: "same-as-primary" }],
    });
  });
});
