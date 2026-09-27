// Engine plan presets, model display name formatting, and fallback mappings.
// Extracted to a pure library module to isolate plan resolution and model name
// formatting from React component rendering and UI asset resolution.
import { ENGINE_CAPABILITIES } from "@/lib/engine-capabilities";

export interface EnginePlanOption {
  label: string;
  planName: string;
  costPerMonth: number | null;
}

export const ENGINE_PLAN_OPTIONS: Record<string, EnginePlanOption[]> = {
  minimax: [
    { label: "Token Plan Max ($132/mo)", planName: "MiniMax Token Plan Max", costPerMonth: 132 },
    { label: "Token Plan Pro ($55/mo)", planName: "MiniMax Token Plan Pro", costPerMonth: 55 },
    { label: "Token Plan Starter ($15/mo)", planName: "MiniMax Token Plan Starter", costPerMonth: 15 },
    { label: "API Pay-as-you-go", planName: "MiniMax API Pay-as-you-go", costPerMonth: null },
  ],
  claude: [
    { label: "Claude Max 20× ($213.20/mo)", planName: "Claude Max 20×", costPerMonth: 213.2 },
    { label: "Claude Max 5× ($100/mo)", planName: "Claude Max 5×", costPerMonth: 100 },
    { label: "Claude Pro ($20/mo)", planName: "Claude Pro", costPerMonth: 20 },
    { label: "API Pay-as-you-go", planName: "API Pay-as-you-go", costPerMonth: null },
  ],
  codex: [
    { label: "ChatGPT Pro Lite ($100/mo)", planName: "ChatGPT Pro Lite", costPerMonth: 100 },
    { label: "ChatGPT Pro ($200/mo)", planName: "ChatGPT Pro", costPerMonth: 200 },
    { label: "ChatGPT Plus ($20/mo)", planName: "ChatGPT Plus", costPerMonth: 20 },
    { label: "API Pay-as-you-go", planName: "API Pay-as-you-go", costPerMonth: null },
  ],
  grok: [
    { label: "xAI SuperGrok Heavy ($99/mo)", planName: "xAI SuperGrok Heavy", costPerMonth: 99 },
    { label: "xAI SuperGrok ($30/mo)", planName: "xAI SuperGrok", costPerMonth: 30 },
    { label: "xAI Premium+ ($16/mo)", planName: "xAI Premium+", costPerMonth: 16 },
    { label: "API Pay-as-you-go", planName: "API Pay-as-you-go", costPerMonth: null },
  ],
  antigravity: [
    { label: "Google AI Ultra ($105.79/mo)", planName: "Google AI Ultra", costPerMonth: 105.79 },
    { label: "Google One AI Premium ($19.99/mo)", planName: "Google One AI Premium", costPerMonth: 19.99 },
    { label: "API Pay-as-you-go", planName: "API Pay-as-you-go", costPerMonth: null },
  ],
  cursor: [
    { label: "Cursor Ultra", planName: "Cursor Ultra", costPerMonth: null },
    { label: "Cursor Pro ($20/mo)", planName: "Cursor Pro", costPerMonth: 20 },
    { label: "Included / Bundled", planName: "Cursor Included / Bundled", costPerMonth: null },
  ],
  "deepseek-harness": [
    { label: "Pay-as-you-go (API)", planName: "Pay-as-you-go (API)", costPerMonth: null },
  ],
};

export const FALLBACK_MODEL_NAMES: Record<string, string> = {
  "minimax-m3": "MiniMax M3",
  "minimax-h3": "MiniMax H3",
  "minimax-m2.7-highspeed": "MiniMax M2.7 Highspeed",
  "minimax-m2.7": "MiniMax M2.7",
  "grok-4.7-build-fast": "Grok 4.7 Build Fast",
  "grok-4.7": "Grok 4.7",
  "grok-4.6": "Grok 4.6",
  "grok-3-mini": "Grok 3 mini",
  "grok-4": "Grok 4",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-reasoner": "DeepSeek Reasoner",
  "claude-opus-4": "Claude Opus 4",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4": "Claude Haiku 4",
  "claude-3-7-sonnet": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5": "GPT-5",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "cursor-default": "Cursor Default",
};

/** Map model ID to clean human-readable display name, preserving raw ID in tooltips. */
export function modelDisplayName(
  modelId: string,
  instances?: Array<{ models?: { options?: Array<{ id: string; label: string }> } }>,
): string {
  if (!modelId) return modelId;
  if (instances) {
    for (const inst of instances) {
      const match = inst.models?.options?.find(
        (o) => o.id === modelId || o.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (match?.label) return match.label;
    }
  }
  for (const entry of Object.values(ENGINE_CAPABILITIES)) {
    for (const m of entry.defaultModels ?? []) {
      if (m.id === modelId || m.id.toLowerCase() === modelId.toLowerCase()) {
        if (m.display.includes("(via ")) {
          return m.display.replace(/\s*\(via[^)]*\)/, "");
        }
        return m.display;
      }
    }
  }
  const fallback = FALLBACK_MODEL_NAMES[modelId.toLowerCase()];
  if (fallback) return fallback;
  return modelId;
}

export function defaultEnginePlan(id: string): { planName: string; costPerMonth: number | null } {
  const entry = ENGINE_CAPABILITIES[id];
  if (!entry) return { planName: "Standard", costPerMonth: null };
  return {
    planName:
      entry.pricing.kind === "subscription" || entry.pricing.kind === "subscription+api"
        ? entry.pricing.subscription.tierLabel
        : entry.pricing.kind === "api"
          ? "Pay-as-you-go (API)"
          : entry.pricing.kind === "free"
            ? "Free"
            : "Standard",
    costPerMonth:
      entry.pricing.kind === "subscription" || entry.pricing.kind === "subscription+api"
        ? entry.pricing.subscription.costPerMonth
        : null,
  };
}

export function findMatchingPreset(
  engineId: string,
  planName?: string | null,
  costPerMonth?: number | null,
): EnginePlanOption | undefined {
  const options = ENGINE_PLAN_OPTIONS[engineId] ?? [];
  const norm = (s?: string | null) => (s ?? "").replace(/×/g, "x").trim().toLowerCase();

  // Backward compatibility: map stored legacy preset names/costs
  if (
    engineId === "deepseek-harness" &&
    (norm(planName) === "deepseek pay-as-you-go" || norm(planName) === "pay-as-you-go (api)")
  ) {
    return options.find((opt) => opt.planName === "Pay-as-you-go (API)");
  }
  if (
    engineId === "cursor" &&
    norm(planName) === "cursor ultra" &&
    (costPerMonth === 40 || costPerMonth === null)
  ) {
    return options.find((opt) => opt.planName === "Cursor Ultra");
  }

  return options.find((opt) => {
    const nameMatch = opt.planName === planName || norm(opt.planName) === norm(planName);
    const costMatch = (opt.costPerMonth ?? null) === (costPerMonth ?? null);
    return nameMatch && costMatch;
  });
}

export function getInitialEnginePlans(
  configuredEnginePlans?: Record<string, { planName?: string; costPerMonth?: number | null }>,
): Record<string, { planName: string; costPerMonth: number | null }> {
  const initial: Record<string, { planName: string; costPerMonth: number | null }> = {};
  for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
    const saved = configuredEnginePlans?.[id];
    if (saved) {
      let resolvedPlanName =
        saved.planName ??
        (entry.pricing.kind === "subscription" || entry.pricing.kind === "subscription+api"
          ? entry.pricing.subscription.tierLabel
          : entry.pricing.kind === "api"
            ? "Pay-as-you-go (API)"
            : "Free");
      let resolvedCost =
        saved.costPerMonth !== undefined
          ? saved.costPerMonth
          : entry.pricing.kind === "subscription" || entry.pricing.kind === "subscription+api"
            ? entry.pricing.subscription.costPerMonth
            : null;

      // Migrate legacy stored names to official presets
      if (
        id === "deepseek-harness" &&
        resolvedPlanName.trim().toLowerCase() === "deepseek pay-as-you-go"
      ) {
        resolvedPlanName = "Pay-as-you-go (API)";
        resolvedCost = null;
      }
      if (
        id === "cursor" &&
        resolvedPlanName.trim().toLowerCase() === "cursor ultra" &&
        resolvedCost === 40
      ) {
        resolvedCost = null;
      }

      initial[id] = {
        planName: resolvedPlanName,
        costPerMonth: resolvedCost,
      };
    } else {
      initial[id] = defaultEnginePlan(id);
    }
  }
  return initial;
}

