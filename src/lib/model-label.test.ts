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

  it("leaves non-GPT ids as saved, minus any provider prefix", () => {
    expect(readableModelLabel("claude-opus-4-1")).toBe("claude-opus-4-1");
    expect(readableModelLabel("omlx::qwen3-coder")).toBe("qwen3-coder");
  });
});
