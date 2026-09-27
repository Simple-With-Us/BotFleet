import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOOL_ROUNDS, effectiveToolRounds, MAX_TOOL_ROUNDS, toolBudgetPrompt } from "./bot-profile.ts";

describe("effectiveToolRounds", () => {
  it("defaults to a budget that lets ordinary work finish", () => {
    // Twelve was the floor that stops a runaway loop, not a budget for a CI
    // investigation or a TestFlight build — and these bots run unattended with
    // auto-approve on, so a tight ceiling stops half-finished work.
    expect(effectiveToolRounds(undefined).rounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBeGreaterThan(12);
  });

  it("reports that a default was used, so the prompt can say so", () => {
    expect(effectiveToolRounds(undefined).explicit).toBe(false);
    expect(effectiveToolRounds(60).explicit).toBe(true);
  });

  it("honours an owner-set budget", () => {
    expect(effectiveToolRounds(60).rounds).toBe(60);
    expect(effectiveToolRounds(1).rounds).toBe(1);
    expect(effectiveToolRounds(MAX_TOOL_ROUNDS).rounds).toBe(MAX_TOOL_ROUNDS);
  });

  it("falls back rather than trusting nonsense or an out-of-range number", () => {
    for (const bad of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TOOL_ROUNDS + 1, "40" as never]) {
      expect(effectiveToolRounds(bad).rounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    }
  });
});

describe("toolBudgetPrompt", () => {
  it("names the budget so the model can plan against it", () => {
    // A model that does not know its ceiling spends it badly — one call per
    // round — and discovers the limit on the last round with work unfinished.
    const text = toolBudgetPrompt({ rounds: 40, explicit: false });
    expect(text).toContain("40");
    expect(text).toContain("default");
    expect(text).toMatch(/batch/i);
  });

  it("distinguishes an owner-set budget from the default", () => {
    expect(toolBudgetPrompt({ rounds: 40, explicit: true })).toContain("set for this bot");
    expect(toolBudgetPrompt({ rounds: 40, explicit: false })).toContain("default for this bot");
  });

  it("says nothing when there is effectively no budget to describe", () => {
    expect(toolBudgetPrompt({ rounds: 1, explicit: true })).toBe("");
  });
});
