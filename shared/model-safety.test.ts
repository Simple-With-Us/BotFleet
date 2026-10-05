import { describe, expect, it } from "vitest";
import { evaluateModelRiskForBypass } from "./model-safety.ts";

describe("evaluateModelRiskForBypass", () => {
  it("flags lightweight models as dangerous for permission bypass", () => {
    const dangerous = [
      "claude-3-haiku-20240307",
      "claude-3-5-haiku-20241022",
      "gpt-4o-mini",
      "o1-mini",
      "o3-mini",
      "gemini-1.5-flash",
      "gemini-2.0-flash-lite",
      "qwen-2.5-7b",
      "llama-3.1-8b-instruct",
      "deepseek-flash",
      "gpt-3.5-turbo",
      "claude-instant-1.2",
    ];

    for (const model of dangerous) {
      const evaluation = evaluateModelRiskForBypass(model);
      expect(evaluation.isDangerous, `Expected ${model} to be dangerous`).toBe(true);
      expect(evaluation.tier).toBe("high_risk");
      expect(evaluation.warningTitle).toBe("High-Risk Model Warning");
      expect(evaluation.warningBody).toContain("is a lightweight or compact model");
      expect(evaluation.warningBody).toContain("Continue with extreme caution.");
    }
  });

  it("identifies frontier reasoning models as safe from high-risk warning", () => {
    const frontier = [
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet",
      "claude-3-opus-20240229",
      "gpt-4o",
      "o1",
      "o3",
      "deepseek-chat",
      "deepseek-r1",
      "grok-2",
      "grok-3",
      "minimax-m3",
    ];

    for (const model of frontier) {
      const evaluation = evaluateModelRiskForBypass(model);
      expect(evaluation.isDangerous, `Expected ${model} not to be dangerous`).toBe(false);
      expect(evaluation.tier).toBe("frontier");
      expect(evaluation.warningTitle).toBeNull();
      expect(evaluation.warningBody).toBeNull();
    }
  });

  it("defaults unknown generic models to standard tier without false alarms", () => {
    const evaluation = evaluateModelRiskForBypass("custom-enterprise-agent-v1");
    expect(evaluation.isDangerous).toBe(false);
    expect(evaluation.tier).toBe("standard");
    expect(evaluation.warningTitle).toBeNull();
  });
});
