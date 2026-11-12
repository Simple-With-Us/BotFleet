// Model safety and risk evaluation for autonomous execution and permission bypass.
//
// Smaller, faster, or lightweight models (e.g. Haiku, Mini, Flash, Nano, 7B/8B/14B)
// have lower reasoning fidelity and are substantially more prone to hallucinating
// shell commands, misinterpreting file boundaries, and running destructive actions
// without stopping to ask.
//
// This module provides the central evaluation of model risk when operators consider
// bypassing permissions or granting full unprompted auto execution.

export type ModelRiskTier = "high_risk" | "standard" | "frontier";

export interface ModelRiskEvaluation {
  model: string;
  isDangerous: boolean;
  tier: ModelRiskTier;
  warningTitle: string | null;
  warningBody: string | null;
  recommendation: string | null;
}

const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\bhaiku\b/i,
  /\bmini\b/i,
  /\bflash(-lite)?\b/i,
  /\bnano\b/i,
  /\bmicro\b/i,
  /\bsmall\b/i,
  /\blite\b/i,
  /\binstant\b/i,
  /\bgpt-3\.5/i,
  /\bgpt-4-0[36]1[34]\b/i,
  /\bclaude-2\b/i,
  /\b(?:1|3|7|8|14)b\b/i,
];

const FRONTIER_PATTERNS: readonly RegExp[] = [
  /\bsonnet\b/i,
  /\bopus\b/i,
  /\bgpt-4o(?!-mini)\b/i,
  /\bgpt-4\.5\b/i,
  /\bo1(?!-mini)\b/i,
  /\bo3\b/i,
  /\bdeepseek-(?:chat|coder|v3|r1)\b/i,
  /\bgrok-[23]\b/i,
  /\bminimax-m3/i,
  /\babab\b/i,
];

/**
 * Evaluates whether a given model is dangerous for unprompted permission bypass.
 */
export function evaluateModelRiskForBypass(
  model: string | undefined,
  _engineId?: string,
): ModelRiskEvaluation {
  const modelName = (model ?? "").trim();
  const lower = modelName.toLowerCase();

  // An unknown model is not a known-safe model: warn rather than stay silent.
  if (!lower) {
    return {
      model: "unknown",
      isDangerous: true,
      tier: "standard",
      warningTitle: "Unknown Model: Permission Bypass Warning",
      warningBody: "This bot has no verifiable model selection, so the risk of unprompted permission bypass cannot be assessed.  Continue with extreme caution.",
      recommendation: "Select a known frontier reasoning model before enabling permission bypass.",
    };
  }

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        model: modelName,
        isDangerous: true,
        tier: "high_risk",
        warningTitle: "High-Risk Model Warning",
        warningBody: `${modelName} is a lightweight or compact model.  Bypassing permissions on this model is dangerous because smaller models exhibit lower reasoning fidelity and are significantly more prone to hallucinating shell flags, misinterpreting file paths, or executing unintended destructive actions without stopping to ask.  Continue with extreme caution.`,
        recommendation: "For unprompted permission bypass, consider using a frontier reasoning model (such as Claude Sonnet, GPT-4o, or DeepSeek R1) with higher instruction-following fidelity.",
      };
    }
  }

  for (const pattern of FRONTIER_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        model: modelName,
        isDangerous: false,
        tier: "frontier",
        warningTitle: null,
        warningBody: null,
        recommendation: null,
      };
    }
  }

  return {
    model: modelName,
    isDangerous: false,
    tier: "standard",
    warningTitle: null,
    warningBody: null,
    recommendation: null,
  };
}
