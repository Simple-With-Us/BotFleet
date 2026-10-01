import { describe, expect, it } from "vitest";

import type { InstanceInfo, ModelSelection } from "@/state/store";
import { pickedSelection, selectionForPick } from "./model-pick";

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
