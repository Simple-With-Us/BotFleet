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

  describe("MiniMax M3.1 effort on mcode and the direct MiniMax engine", () => {
    // Both drivers declare M3.1's list as their engine-wide gate and give every
    // catalog row its own explicit list, which is what the picker reads.
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    const engines = [
      { name: "mcode", engine: { driverKind: "mcodeAgent", capabilities: { effortLevels: levels } }, m31: "MiniMax-M3.1-Flash-Preview-thinking", m27: "MiniMax-M2.7-highspeed-thinking" },
      { name: "minimax", engine: { driverKind: "minimax", capabilities: { effortLevels: levels } }, m31: "MiniMax-M3.1-Flash-Preview", m27: "MiniMax-M2.7-highspeed" },
    ];

    it.each(engines)("offers M3.1's levels and none for M2.7 on $name", ({ engine, m31, m27 }) => {
      expect(modelEffortLevels(engine, { id: m31, effortLevels: levels })).toEqual(levels);
      expect(modelSupportsEffort(engine, { id: m31, effortLevels: levels })).toBe(true);
      // An explicit `[]` wins over the engine-wide list: no picker for M2.7.
      expect(modelEffortLevels(engine, { id: m27, effortLevels: [] })).toEqual([]);
      expect(modelSupportsEffort(engine, { id: m27, effortLevels: [] })).toBe(false);
    });

    it.each(engines)("would hand a row with no list the engine-wide levels on $name, which is why drivers declare [] explicitly", ({ engine, m27 }) => {
      expect(modelEffortLevels(engine, { id: m27 })).toEqual(levels);
    });
  });

  it("keeps DSH MiniMax rows without effort, including M3.1", () => {
    // Harness declares no M3.1 yet, so its MiniMax rows stay hidden.
    const dsh = {
      driverKind: "dsh",
      capabilities: { effortLevels: ["none", "high", "max"] as const },
    };
    expect(modelEffortLevels(dsh, { id: "MiniMax-M3.1-Flash-Preview" })).toEqual([]);
    expect(modelEffortLevels(dsh, { id: "MiniMax-M2.7-highspeed" })).toEqual([]);
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

  it("shows the DSH MiniMax M3.1 picker only when its catalog row carries levels", () => {
    // The server folds Harness's per-model levels onto the DSH catalog, gated on
    // the install's settings.yaml, so the row's own list is the whole answer.
    const dsh = {
      driverKind: "dshAgent",
      capabilities: { effortLevels: ["none", "high", "max"] as const },
    };
    const m31Levels = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(modelEffortLevels(dsh, { id: "MiniMax-M3.1-Flash-Preview", effortLevels: m31Levels })).toEqual(m31Levels);
    expect(modelSupportsEffort(dsh, { id: "MiniMax-M3.1-Flash-Preview", effortLevels: m31Levels })).toBe(true);
    // An install whose entry declares no levels answers [] and hides it.
    expect(modelEffortLevels(dsh, { id: "MiniMax-M3.1-Flash-Preview", effortLevels: [] })).toEqual([]);
    // Other DSH MiniMax rows carry no list and stay hidden by the DSH rule.
    expect(modelEffortLevels(dsh, { id: "MiniMax-M2.7-highspeed" })).toEqual([]);
    // DeepSeek rows keep the engine-wide list.
    expect(modelEffortLevels(dsh, { id: "DeepSeek-V4.1-Flash" })).toEqual(["none", "high", "max"]);
  });
});
