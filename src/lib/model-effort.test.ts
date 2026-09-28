import { describe, expect, it } from "vitest";
import { modelEffortLevels, modelSupportsEffort } from "./model-effort";

describe("modelEffortLevels", () => {
  it("returns empty when engine has no effort capabilities", () => {
    const engine = { driverKind: "minimax", capabilities: {} };
    expect(modelEffortLevels(engine, { id: "MiniMax-M3" })).toEqual([]);
    expect(modelSupportsEffort(engine, { id: "MiniMax-M3" })).toBe(false);
  });

  it("respects explicit effortLevels on model option", () => {
    const engine = {
      driverKind: "codex",
      capabilities: { effortLevels: ["low", "medium", "high"] as const },
    };
    expect(
      modelEffortLevels(engine, { id: "custom-model", effortLevels: ["low", "high"] as const }),
    ).toEqual(["low", "high"]);
    expect(
      modelEffortLevels(engine, { id: "custom-no-effort", effortLevels: [] }),
    ).toEqual([]);
  });

  it("respects supportsEffort: false on model option", () => {
    const engine = {
      driverKind: "codex",
      capabilities: { effortLevels: ["low", "medium", "high"] as const },
    };
    expect(
      modelEffortLevels(engine, { id: "custom-model", supportsEffort: false }),
    ).toEqual([]);
  });

  it("gates DSH MiniMax models from effort", () => {
    const dsh = {
      driverKind: "dsh",
      capabilities: { effortLevels: ["none", "high", "max"] as const },
    };
    expect(modelEffortLevels(dsh, { id: "MiniMax-M3" })).toEqual([]);
    expect(modelSupportsEffort(dsh, { id: "MiniMax-M3" })).toBe(false);

    expect(modelEffortLevels(dsh, { id: "DeepSeek-V4.1-Flash" })).toEqual(["none", "high", "max"]);
    expect(modelSupportsEffort(dsh, { id: "DeepSeek-V4.1-Flash" })).toBe(true);
  });

  it("gates Claude haiku models from effort", () => {
    const claude = {
      driverKind: "claude",
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max"] as const },
    };
    expect(modelEffortLevels(claude, { id: "claude-haiku-4-5" })).toEqual([]);
    expect(modelSupportsEffort(claude, { id: "claude-haiku-4-5" })).toBe(false);

    expect(modelEffortLevels(claude, { id: "claude-sonnet-5" })).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("gates Codex legacy/non-reasoning GPT models from effort", () => {
    const codex = {
      driverKind: "codex",
      capabilities: { effortLevels: ["low", "medium", "high", "xhigh"] as const },
    };
    expect(modelEffortLevels(codex, { id: "gpt-4o" })).toEqual([]);
    expect(modelEffortLevels(codex, { id: "gpt-4o-mini" })).toEqual([]);
    expect(modelEffortLevels(codex, { id: "gpt-4" })).toEqual([]);
    expect(modelEffortLevels(codex, { id: "gpt-3.5-turbo" })).toEqual([]);

    expect(modelEffortLevels(codex, { id: "gpt-5.6-luna" })).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
