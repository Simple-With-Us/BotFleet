import { describe, expect, it } from "vitest";

import type { InstanceInfo, ModelSelection } from "@/state/store";
import { contextCapLabel, parseMaxOutputInput, selectionSupportsMaxOutput, selectionWithMaxOutput, pickedSelection, selectionContextCaps, selectionWithContextCap, selectionEffortLevels, selectionForPick, selectionWithEffort } from "./model-pick";

const CLAUDE = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available" },
  capabilities: { effortLevels: ["low", "medium", "high"] },
  models: {
    default: "sonnet",
    options: [
      { id: "sonnet", label: "Claude Sonnet" },
      { id: "ollama::qwen3:8b", label: "qwen3:8b (Ollama)", custom: true, effortLevels: [] },
    ],
  },
} as unknown as InstanceInfo;

describe("selectionForPick", () => {
  it("saves the engine that runs the model and the model id", () => {
    const next = selectionForPick({ instanceId: "codex", model: "gpt-5.4" }, CLAUDE, "ollama::qwen3:8b");
    expect(next).toEqual({ instanceId: "claude", model: "ollama::qwen3:8b" });
  });

  it("keeps the bot's effort when the new model still offers it", () => {
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", effort: "high" };
    expect(selectionForPick(current, CLAUDE, "sonnet").effort).toBe("high");
  });

  it("drops the effort a local model does not offer", () => {
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", effort: "high" };
    expect(selectionForPick(current, CLAUDE, "ollama::qwen3:8b").effort).toBeUndefined();
  });

  it("keeps the fallback chain when the primary changes", () => {
    const fallbacks: ModelSelection[] = [{ instanceId: "codex", model: "gpt-5.4" }];
    const next = selectionForPick({ instanceId: "claude", model: "sonnet", fallbacks }, CLAUDE, "ollama::qwen3:8b");
    expect(next.fallbacks).toEqual(fallbacks);
  });
});

describe("pickedSelection", () => {
  it("floats a Latest row pick on its class, with the slug it runs now", () => {
    const current: ModelSelection = { instanceId: "codex", model: "gpt-5.4" };
    expect(pickedSelection(current, CLAUDE, "sonnet", "sonnet")).toEqual({
      instanceId: "claude",
      model: "sonnet",
      latest: "sonnet",
    });
  });

  it("pins a plain row pick with an explicit null, even over a saved float", () => {
    // The null is what stops the harness from carrying the saved float
    // forward onto a model the person just pinned.
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", latest: "sonnet" };
    expect(pickedSelection(current, CLAUDE, "sonnet")).toEqual({ instanceId: "claude", model: "sonnet", latest: null });
  });

  it("keeps the chain and the effort the new model offers", () => {
    const fallbacks: ModelSelection[] = [{ instanceId: "codex", model: "gpt-5.4", latest: "luna" }];
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", effort: "high", fallbacks };
    const next = pickedSelection(current, CLAUDE, "sonnet", "sonnet");
    expect(next.effort).toBe("high");
    expect(next.fallbacks).toEqual(fallbacks);
  });
});

describe("selectionWithEffort", () => {
  it("changes only the effort, keeping a floating Latest class and the fallback chain", () => {
    const fallbacks: ModelSelection[] = [{ instanceId: "codex", model: "gpt-5.4" }];
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", latest: "sonnet", fallbacks };
    expect(selectionWithEffort(current, "high")).toEqual({
      instanceId: "claude",
      model: "sonnet",
      latest: "sonnet",
      fallbacks,
      effort: "high",
    });
  });

  it("leaves a pinned selection's explicit null alone", () => {
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", latest: null };
    expect(selectionWithEffort(current, "low").latest).toBeNull();
  });

  it("clears the effort for Default", () => {
    const current: ModelSelection = { instanceId: "claude", model: "sonnet", effort: "high" };
    expect(selectionWithEffort(current, undefined).effort).toBeUndefined();
  });

  it("does not mutate the selection it was given", () => {
    const current: ModelSelection = { instanceId: "claude", model: "sonnet" };
    selectionWithEffort(current, "high");
    expect(current).toEqual({ instanceId: "claude", model: "sonnet" });
  });
});

describe("selectionEffortLevels", () => {
  it("offers the engine's levels for a plain model", () => {
    expect(selectionEffortLevels(CLAUDE, { model: "sonnet" })).toEqual(["low", "medium", "high"]);
  });

  it("offers none for a row that declares none", () => {
    expect(selectionEffortLevels(CLAUDE, { model: "ollama::qwen3:8b" })).toEqual([]);
  });

  it("offers none when there is no engine to ask", () => {
    expect(selectionEffortLevels(undefined, { model: "sonnet" })).toEqual([]);
  });
});

describe("context cap", () => {
  const MM: InstanceInfo = {
    instanceId: "minimax",
    driverKind: "minimax",
    displayName: "MiniMax",
    snapshot: { state: "available" },
    models: {
      default: "m31",
      options: [
        { id: "m31", label: "M3.1", contextWindow: 1_000_000, contextCaps: [524_288] },
        { id: "m27", label: "M2.7", contextWindow: 204_800 },
      ],
    },
  };

  it("offers only what the model's row lists", () => {
    expect(selectionContextCaps(MM, { model: "m31" })).toEqual([524_288]);
    expect(selectionContextCaps(MM, { model: "m27" })).toEqual([]);
    expect(selectionContextCaps(undefined, { model: "m31" })).toEqual([]);
  });

  it("saves only the cap and keeps the rest of the selection", () => {
    const current: ModelSelection = { instanceId: "minimax", model: "m31", effort: "high" };
    expect(selectionWithContextCap(current, 524_288)).toEqual({ ...current, contextCap: 524_288 });
    // Clearing sends an explicit null: the harness keeps a saved cap for a
    // client that omits the key (the shipped iOS app), so a dropped key would
    // not clear it.
    expect(selectionWithContextCap({ ...current, contextCap: 524_288 }, undefined).contextCap).toBeNull();
    expect(JSON.parse(JSON.stringify(selectionWithContextCap({ ...current, contextCap: 524_288 }, undefined)))).toHaveProperty("contextCap", null);
  });

  it("keeps the cap on a model pick only when the new model offers a cap", () => {
    const current: ModelSelection = { instanceId: "minimax", model: "m31", contextCap: 524_288 };
    expect(selectionForPick(current, MM, "m31").contextCap).toBe(524_288);
    expect(selectionForPick({ ...current, contextCap: 300_000 }, MM, "m31").contextCap).toBe(300_000);
    expect(selectionForPick(current, MM, "m27").contextCap).toBeUndefined();
  });

  it("drops a cap the new model would not send: past its window, or not in its list when the window is unknown", () => {
    const inst: InstanceInfo = {
      ...MM,
      models: {
        default: "big",
        options: [
          { id: "big", label: "Big", contextWindow: 1_000_000, contextCaps: [524_288] },
          { id: "small", label: "Small", contextWindow: 262_144, contextCaps: [131_072] },
          { id: "open", label: "Open", contextCaps: [131_072] },
        ],
      },
    };
    const current: ModelSelection = { instanceId: "minimax", model: "big", contextCap: 524_288 };
    expect(selectionForPick(current, inst, "small").contextCap).toBeUndefined();
    expect(selectionForPick(current, inst, "open").contextCap).toBeUndefined();
    expect(selectionForPick({ ...current, contextCap: 131_072 }, inst, "small").contextCap).toBe(131_072);
    expect(selectionForPick({ ...current, contextCap: 131_072 }, inst, "open").contextCap).toBe(131_072);
  });

  it("labels caps the way MiniMax Code does", () => {
    expect(contextCapLabel(524_288)).toBe("512K");
    expect(contextCapLabel(1_000_000)).toBe("1M");
  });
});

describe("max output tokens", () => {
  it("parses the field: empty is Default, k is thousands, junk and over-window are invalid", () => {
    expect(parseMaxOutputInput("")).toBeUndefined();
    expect(parseMaxOutputInput("  ")).toBeUndefined();
    expect(parseMaxOutputInput("8192")).toBe(8192);
    expect(parseMaxOutputInput("64k")).toBe(64_000);
    expect(parseMaxOutputInput("1,024")).toBe(1024);
    for (const bad of ["0", "-5", "1.5", "lots", "12 k"]) expect(parseMaxOutputInput(bad)).toBeNull();
    expect(parseMaxOutputInput("300000", 204_800)).toBeNull();
    expect(parseMaxOutputInput("200000", 204_800)).toBe(200_000);
  });

  it("is offered only where the row says the driver sends it, and carries over only to such a row", () => {
    const inst: InstanceInfo = {
      instanceId: "mm", driverKind: "minimax", displayName: "MiniMax", snapshot: { state: "available" },
      models: { default: "a", options: [{ id: "a", label: "A", supportsMaxOutput: true }, { id: "b", label: "B" }] },
    };
    expect(selectionSupportsMaxOutput(inst, { model: "a" })).toBe(true);
    expect(selectionSupportsMaxOutput(inst, { model: "b" })).toBe(false);
    const cur: ModelSelection = { instanceId: "mm", model: "a", maxOutputTokens: 8192 };
    expect(selectionForPick(cur, inst, "a").maxOutputTokens).toBe(8192);
    expect(selectionForPick(cur, inst, "b").maxOutputTokens).toBeUndefined();
    expect(selectionWithMaxOutput(cur, undefined).maxOutputTokens).toBeNull();
    expect(JSON.parse(JSON.stringify(selectionWithMaxOutput(cur, undefined)))).toHaveProperty("maxOutputTokens", null);
  });

  it("does not carry a limit over to a model whose window is smaller than it", () => {
    const inst: InstanceInfo = {
      instanceId: "mm", driverKind: "minimax", displayName: "MiniMax", snapshot: { state: "available" },
      models: {
        default: "big",
        options: [
          { id: "big", label: "Big", contextWindow: 1_000_000, supportsMaxOutput: true },
          { id: "small", label: "Small", contextWindow: 204_800, supportsMaxOutput: true },
          { id: "unknown", label: "Unknown", supportsMaxOutput: true },
        ],
      },
    };
    const cur: ModelSelection = { instanceId: "mm", model: "big", maxOutputTokens: 300_000 };
    expect(selectionForPick(cur, inst, "small").maxOutputTokens).toBeUndefined();
    expect(selectionForPick({ ...cur, maxOutputTokens: 204_800 }, inst, "small").maxOutputTokens).toBe(204_800);
    // A model with no known window cannot say the limit is too big, so it stays.
    expect(selectionForPick(cur, inst, "unknown").maxOutputTokens).toBe(300_000);
  });
});
