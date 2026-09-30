// Engine plan presets, model display name formatting, and fallback mappings.
// Extracted to a pure library module to isolate plan resolution and model name
// formatting from React component rendering and UI asset resolution.
import { ENGINE_CAPABILITIES } from "@/lib/engine-capabilities";
import { readableModelLabel } from "@/lib/model-label";

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
  mcode: [
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

/** Labels for usage rows whose model no catalog lists any more and whose id
 *  the generic formatter cannot read.  Claude, GPT, and Grok ids are not
 *  listed here: readableModelLabel (src/lib/model-label.ts) labels them from
 *  their model class, so this table cannot drift from the picker again.
 *  Display only — usage stays attributed to the raw id it was recorded
 *  under. */
export const FALLBACK_MODEL_NAMES: Record<string, string> = {
  "minimax-m3": "MiniMax M3",
  "minimax-h3": "MiniMax H3",
  "minimax-m2.7-highspeed": "MiniMax M2.7 Highspeed",
  "minimax-m2.7": "MiniMax M2.7",
  "grok-3-mini": "Grok 3 mini",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-reasoner": "DeepSeek Reasoner",
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
  return readableModelLabel(modelId);
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

export interface QuotaWindowLike {
  provider?: string | null;
  providerKey?: string | null;
  planName?: string | null;
  label?: string | null;
}

/**
 * Detect an engine's subscription plan from live quota windows read from
 * CodeCaps or Usage Monitor.
 */
export function detectEnginePlanFromWindows(
  engineId: string,
  windows?: QuotaWindowLike[] | null,
): EnginePlanOption | null {
  if (!windows || windows.length === 0) return null;
  const options = ENGINE_PLAN_OPTIONS[engineId] ?? [];
  if (options.length === 0) return null;

  const PROVIDER_ALIASES: Record<string, string[]> = {
    claude: ["anthropic", "claude"],
    codex: ["openai", "codex", "chatgpt"],
    cursor: ["cursor"],
    minimax: ["minimax"],
    mcode: ["minimax", "mcode"],
    grok: ["xai", "grok"],
    antigravity: ["google", "antigravity", "gemini"],
    "deepseek-harness": ["deepseek"],
  };

  const aliases = PROVIDER_ALIASES[engineId] ?? [engineId];
  const matchingWindows = windows.filter((w) => {
    const p = (w.providerKey ?? w.provider ?? "").toLowerCase();
    return aliases.some((a) => p.includes(a));
  });

  if (matchingWindows.length === 0) return null;

  for (const w of matchingWindows) {
    const raw = `${w.planName ?? ""} ${w.label ?? ""}`.toLowerCase();
    if (!raw.trim()) continue;

    if (engineId === "cursor") {
      if (/\bultra\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("ultra")) ?? null;
      if (/\bpro\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("pro")) ?? null;
    }
    if (engineId === "claude") {
      if (/20x|20×|max_20|\b20\b/i.test(raw)) {
        return options.find((o) => o.planName.toLowerCase().includes("20")) ?? null;
      }
      if (/5x|5×|max_5|\b5\b/i.test(raw)) {
        return options.find((o) => o.planName.toLowerCase().includes("5")) ?? null;
      }
      if (/\bpro\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("pro")) ?? null;
      if (/\bteam\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("team")) ?? null;
    }
    if (engineId === "codex") {
      if (/lite|pro_lite/i.test(raw)) {
        return options.find((o) => o.planName.toLowerCase().includes("lite")) ?? null;
      }
      if (/\bpro\b/i.test(raw)) return options.find((o) => o.planName === "ChatGPT Pro") ?? null;
      if (/\bplus\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("plus")) ?? null;
    }
    if (engineId === "minimax" || engineId === "mcode") {
      if (/\bstarter\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("starter")) ?? null;
      if (/\bpro\b/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("pro")) ?? null;
      if (/\bplan max\b|\bmax\b/i.test(raw.replace(/minimax/gi, ""))) {
        return options.find((o) => o.planName.toLowerCase().includes("max")) ?? null;
      }
    }
    if (engineId === "grok") {
      if (/heavy/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("heavy")) ?? null;
      if (/super/i.test(raw)) return options.find((o) => o.planName === "xAI SuperGrok") ?? null;
      if (/premium/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("premium")) ?? null;
    }
    if (engineId === "antigravity") {
      if (/ultra/i.test(raw)) return options.find((o) => o.planName.toLowerCase().includes("ultra")) ?? null;
      if (/premium|one/i.test(raw)) {
        return options.find((o) => o.planName.toLowerCase().includes("premium")) ?? null;
      }
    }
  }

  return null;
}

/**
 * Scan all windows from CodeCaps / Usage Monitor and auto-detect plans across all engines.
 */
export function autoDetectAllEnginePlans(
  windows?: QuotaWindowLike[] | null,
): Record<string, EnginePlanOption> {
  const result: Record<string, EnginePlanOption> = {};
  if (!windows || windows.length === 0) return result;
  for (const engineId of Object.keys(ENGINE_PLAN_OPTIONS)) {
    const detected = detectEnginePlanFromWindows(engineId, windows);
    if (detected) result[engineId] = detected;
  }
  return result;
}

