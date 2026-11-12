import { describe, expect, it } from "vitest";
import { readableModelLabel } from "./model-label";

describe("readableModelLabel", () => {
  it.each([
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ["openai::gpt-6-sol", "GPT-6 Sol"],
    ["gpt-5.5", "GPT-5.5"],
  ])("labels saved GPT selection %s as %s", (id, label) => {
    expect(readableModelLabel(id)).toBe(label);
  });

  it.each([
    ["claude-3-7-sonnet", "Claude Sonnet 3.7"],
    ["claude-opus-4-1", "Claude Opus 4.1"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["grok-4.6", "Grok 4.6"],
    ["grok-4.7-build-fast", "Grok 4.7 Build Fast"],
  ])("labels a saved Claude or Grok selection %s as %s", (id, label) => {
    expect(readableModelLabel(id)).toBe(label);
  });

  it("leaves other ids as saved, minus any provider prefix", () => {
    expect(readableModelLabel("MiniMax-M3")).toBe("MiniMax-M3");
    expect(readableModelLabel("claude-sonnet-5-custom")).toBe("claude-sonnet-5-custom");
    expect(readableModelLabel("omlx::qwen3-coder")).toBe("qwen3-coder");
  });
});
