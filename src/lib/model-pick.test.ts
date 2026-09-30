import { describe, expect, it } from "vitest";

import type { InstanceInfo, ModelSelection } from "@/state/store";
import { selectionForPick } from "./model-pick";

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
