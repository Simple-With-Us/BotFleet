import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import {
  collectLocalModels,
  filterLocalModelGroups,
  isInjectedLocalModel,
  localModelCount,
  opensOnLocalModels,
} from "./local-models";

type Option = InstanceInfo["models"]["options"][number];

const OLLAMA_QWEN: Option = { id: "ollama::qwen3:8b", label: "qwen3:8b (Ollama)", custom: true };
const OMLX_LLAMA: Option = { id: "omlx::llama-3.3-70b", label: "llama-3.3-70b (oMLX)", custom: true, loaded: true };

function engine(
  instanceId: string,
  driverKind: string,
  options: Option[],
  extra: Partial<InstanceInfo> = {},
): InstanceInfo {
  return {
    instanceId,
    driverKind,
    displayName: instanceId,
    snapshot: { state: "available" },
    models: { default: options[0]?.id ?? "", options },
    ...extra,
  } as InstanceInfo;
}

const CLAUDE_CLOUD: Option = { id: "sonnet", label: "Claude Sonnet" };

describe("isInjectedLocalModel", () => {
  it("recognises host::model rows and nothing else", () => {
    expect(isInjectedLocalModel(OLLAMA_QWEN)).toBe(true);
    expect(isInjectedLocalModel({ id: "lmstudio::google/gemma-3n" })).toBe(true);
    expect(isInjectedLocalModel(CLAUDE_CLOUD)).toBe(false);
    expect(isInjectedLocalModel({ id: "openrouter/some-model" })).toBe(false);
    expect(isInjectedLocalModel({ id: "unknownhost::qwen" })).toBe(false);
  });
});

describe("collectLocalModels", () => {
  it("is empty when no local model is configured, so the picker shows no entry", () => {
    const groups = collectLocalModels([
      engine("claude", "claudeAgent", [CLAUDE_CLOUD]),
      engine("codex", "codex", [{ id: "gpt-5.4", label: "GPT-5.4" }]),
      engine("computer", "boxAgent", [{ id: "claude-fable-5", label: "Claude Fable 5" }]),
    ]);
    expect(groups).toEqual([]);
  });

  it("lists an injected model once, even though every agent offers it", () => {
    const groups = collectLocalModels([
      engine("grok", "grokAgent", [{ id: "grok-4", label: "Grok 4" }, OLLAMA_QWEN]),
      engine("claude", "claudeAgent", [CLAUDE_CLOUD, OLLAMA_QWEN]),
      engine("codex", "codex", [OLLAMA_QWEN]),
    ]);
    expect(groups.map((group) => group.instance.instanceId)).toEqual(["claude"]);
    expect(groups[0].options.map((option) => option.id)).toEqual([OLLAMA_QWEN.id]);
    expect(localModelCount(groups)).toBe(1);
  });

  it("gives an injected model to a Local-group engine before a cloud one", () => {
    const groups = collectLocalModels([
      engine("claude", "claudeAgent", [OLLAMA_QWEN]),
      engine("pi", "piAgent", [OLLAMA_QWEN], { access: "custom" }),
    ]);
    expect(groups.map((group) => group.instance.instanceId)).toEqual(["pi"]);
  });

  it("keeps a bot that is already on an injected model listed under the engine it uses", () => {
    const instances = [
      engine("claude", "claudeAgent", [OLLAMA_QWEN]),
      engine("codex", "codex", [OLLAMA_QWEN]),
    ];
    const groups = collectLocalModels(instances, { instanceId: "codex", model: OLLAMA_QWEN.id });
    expect(groups.map((group) => group.instance.instanceId)).toEqual(["codex"]);
  });

  it("lists the models configured on a Local-group engine, and only the custom ones", () => {
    const groups = collectLocalModels([
      engine(
        "ollama-local",
        "openai-compat",
        [
          { id: "llama3.2", label: "llama3.2", custom: true },
          { id: "llama3.2-vision", label: "llama3.2-vision", custom: true },
          { id: "default-catalog-row", label: "Catalog Row" },
        ],
        { access: "custom", displayName: "Ollama Local" },
      ),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].instance.displayName).toBe("Ollama Local");
    expect(groups[0].options.map((option) => option.id)).toEqual(["llama3.2", "llama3.2-vision"]);
  });

  it("does not call a cloud provider configured in a subscription engine a local model", () => {
    const groups = collectLocalModels([
      engine("codex", "codex", [
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "openrouter::some/model", label: "Some Model", custom: true },
      ]),
      engine("claude", "claudeAgent", [CLAUDE_CLOUD, { id: "bedrock-sonnet", label: "Bedrock Sonnet", custom: true }]),
    ]);
    expect(groups).toEqual([]);
  });

  it("ignores engines that are switched off, uninstalled, or missing", () => {
    const groups = collectLocalModels([
      engine("claude", "claudeAgent", [OLLAMA_QWEN], { enabled: false }),
      engine("codex", "codex", [OLLAMA_QWEN], { snapshot: { state: "unavailable", reason: "not installed" } }),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not need the engine's cloud sign-in", () => {
    const groups = collectLocalModels([
      engine("claude", "claudeAgent", [OLLAMA_QWEN], { snapshot: { state: "available", authenticated: false } }),
    ]);
    expect(localModelCount(groups)).toBe(1);
  });

  it("pins models the host already has in memory first", () => {
    const groups = collectLocalModels([engine("claude", "claudeAgent", [OLLAMA_QWEN, OMLX_LLAMA])]);
    expect(groups[0].options.map((option) => option.id)).toEqual([OMLX_LLAMA.id, OLLAMA_QWEN.id]);
  });
});

describe("filterLocalModelGroups", () => {
  const groups = collectLocalModels([
    engine("claude", "claudeAgent", [OLLAMA_QWEN, OMLX_LLAMA]),
    engine("pi", "piAgent", [{ id: "local-only", label: "Local Only", custom: true }], { access: "custom" }),
  ]);

  it("returns everything for an empty query", () => {
    expect(localModelCount(filterLocalModelGroups(groups, "  "))).toBe(3);
  });

  it("drops rows and then whole groups that do not match", () => {
    const filtered = filterLocalModelGroups(groups, "qwen");
    expect(filtered.map((group) => group.instance.instanceId)).toEqual(["claude"]);
    expect(filtered[0].options.map((option) => option.id)).toEqual([OLLAMA_QWEN.id]);
    expect(filterLocalModelGroups(groups, "zzz")).toEqual([]);
  });
});

describe("opensOnLocalModels", () => {
  const instances = [engine("claude", "claudeAgent", [CLAUDE_CLOUD, OLLAMA_QWEN])];
  const selection = { instanceId: "claude", model: OLLAMA_QWEN.id };

  it("opens on Local Models for a bot on an injected model of a cloud engine", () => {
    const groups = collectLocalModels(instances, selection);
    expect(opensOnLocalModels(groups, instances[0], selection)).toBe(true);
  });

  it("opens on the engine itself for a bot on a cloud model", () => {
    const groups = collectLocalModels(instances);
    expect(opensOnLocalModels(groups, instances[0], { instanceId: "claude", model: "sonnet" })).toBe(false);
  });

  it("keeps a Local-group engine opening on itself", () => {
    const pi = engine("pi", "piAgent", [OLLAMA_QWEN], { access: "custom" });
    const piSelection = { instanceId: "pi", model: OLLAMA_QWEN.id };
    expect(opensOnLocalModels(collectLocalModels([pi], piSelection), pi, piSelection)).toBe(false);
  });

  it("never opens on an entry that is not on the rail", () => {
    expect(opensOnLocalModels([], instances[0], selection)).toBe(false);
  });
});
