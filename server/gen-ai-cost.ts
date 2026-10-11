// Catalog USD estimates for engines that report tokens but no charge.
//
// MiniMax HTTP already prices each round from the driver's own table.
// ACP MiniMax Code, DSH, and DeepSeek report `cost: null`, which left
// Sentry gen_ai.usage.cost blank and Usage Monitor unpriced.  This module
// is the shared fallback: the same published rates, marked estimated at
// the ACP settle, and stamped onto gen_ai.usage.cost so those engines
// show dollars.  Claude subscription equivalents stay out of this table
// on purpose — sentry-ai parks those on botfleet.cost.estimated_usd.
//
// Lives here, not in sentry-ai.ts or minimax.ts, so neither file has to
// import the other.  Numbers must stay in lockstep with
// server/drivers/minimax.ts and src/lib/deepseek-prices.ts; the test file
// pins that.
import { costUsd, type ChatCompletionsPriceTable } from "./drivers/chat-completions/pricing.ts";

export type CatalogUsage = {
  input?: number;
  output?: number;
  cachedInput?: number;
};

/** Same published MiniMax pay-as-you-go rates as the HTTP driver.  The
 *  retired MiniMax-M2.7 row stays so a saved picker id still prices. */
export const CATALOG_MINIMAX_PRICES: ChatCompletionsPriceTable = {
  "MiniMax-M3.1-Flash-Preview": [
    { maxInputTokens: 512_000, input: 0.3, output: 1.2, cachedInput: 0.06 },
    { input: 0.6, output: 2.4, cachedInput: 0.12 },
  ],
  "MiniMax-M2.7": [{ input: 0.3, output: 1.2, cachedInput: 0.06 }],
  "MiniMax-M2.7-highspeed": [{ input: 0.6, output: 2.4, cachedInput: 0.06 }],
};

/** DeepSeek official peak rates (USD / 1M tokens).  Peak is the published
 *  upper bound; a catalog estimate that understates spend is worse than
 *  one that is a little high.  Off-peak is half of these input/output
 *  figures — see src/lib/deepseek-prices.ts. */
const DEEPSEEK_PEAK = {
  flash: { input: 0.3, output: 1.2, cachedInput: 0.006 },
  pro: { input: 1.32, output: 3.96, cachedInput: 0.044 },
} as const;

const DEEPSEEK_PRICES: ChatCompletionsPriceTable = {
  flash: [DEEPSEEK_PEAK.flash],
  pro: [DEEPSEEK_PEAK.pro],
};

function normalizeModel(model: string | null | undefined): string {
  return (model ?? "").trim();
}

/** Map a picker / wire / thinking-suffix id onto a MiniMax price key. */
export function catalogMinimaxPriceKey(model: string | null | undefined): string | null {
  const raw = normalizeModel(model);
  if (!raw) return null;
  if (CATALOG_MINIMAX_PRICES[raw]) return raw;
  const stripped = raw.replace(/-thinking$/i, "");
  if (CATALOG_MINIMAX_PRICES[stripped]) return stripped;
  const lower = raw.toLowerCase();
  if (!lower.includes("minimax") && !lower.includes("m3.1") && !lower.includes("m2.7")) {
    return null;
  }
  if (lower.includes("m3.1") || lower.includes("m3-1")) return "MiniMax-M3.1-Flash-Preview";
  if (lower.includes("highspeed")) return "MiniMax-M2.7-highspeed";
  if (lower.includes("m2.7")) return "MiniMax-M2.7";
  if (lower.includes("minimax")) return "MiniMax-M3.1-Flash-Preview";
  return null;
}

/** Map a DeepSeek catalog / DSH id onto flash or pro. */
export function catalogDeepSeekFamily(model: string | null | undefined): "flash" | "pro" | null {
  const lower = normalizeModel(model).toLowerCase();
  if (!lower.includes("deepseek")) return null;
  if (lower.includes("pro")) return "pro";
  return "flash";
}

/** True when this model id has a MiniMax or DeepSeek catalog row. */
export function isCatalogPricedModel(model: string | null | undefined): boolean {
  return catalogMinimaxPriceKey(model) != null || catalogDeepSeekFamily(model) != null;
}

/** API-equivalent USD for one turn's tokens, or null when the model is
 *  unknown or usage is missing.  Never returns 0 for "could not price" —
 *  a hard zero reads as free. */
export function estimateCatalogCost(
  model: string | null | undefined,
  usage: CatalogUsage | null | undefined,
): number | null {
  if (!usage) return null;
  const input = usage.input;
  if (input == null || !Number.isFinite(input) || input < 0) return null;
  const output = usage.output == null || !Number.isFinite(usage.output) || usage.output < 0 ? 0 : usage.output;
  const cachedInput =
    usage.cachedInput == null || !Number.isFinite(usage.cachedInput) || usage.cachedInput < 0
      ? undefined
      : usage.cachedInput;
  const tokens = { input, output, cachedInput };

  const minimaxKey = catalogMinimaxPriceKey(model);
  if (minimaxKey) return costUsd(tokens, CATALOG_MINIMAX_PRICES, minimaxKey);

  const family = catalogDeepSeekFamily(model);
  if (family) return costUsd(tokens, DEEPSEEK_PRICES, family);

  return null;
}
