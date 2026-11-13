// Generic per-turn cost math for chat-completions drivers.  Owns none of a
// driver's own numbers — a driver supplies its own price table (see
// server/drivers/minimax.ts) — so this file has nothing MiniMax-specific in
// it and is ready for whichever driver PR 11's shared base moves onto next.
import type { TurnUsage } from "./loop.ts";

/** One price tier for a model.  `maxInputTokens` bounds when this tier
 *  applies to a round — MiniMax-M3 doubles its rate once a turn's prompt
 *  passes 512K input tokens — and is left out on a model's LAST tier,
 *  meaning "no upper bound".  Tiers are checked in array order, so a
 *  model's list must be sorted ascending by `maxInputTokens`. */
export interface ChatCompletionsPriceTier {
  maxInputTokens?: number;
  /** USD per 1,000,000 non-cached input tokens. */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** USD per 1,000,000 cached input tokens.  Left out when the endpoint has
   *  not published a cached-read discount for this tier — cached tokens are
   *  then billed at the tier's own input rate rather than assumed free. */
  cachedInput?: number;
}

/** A catalog model's price, or `null` for a model this table cannot yet
 *  price — a new model landing in a driver's catalog with no row here reads
 *  as unpriced, never as free. */
export type ChatCompletionsPriceTable = Record<string, ChatCompletionsPriceTier[] | null>;

/** Price one turn's summed usage against a model's price table.
 *
 * Returns `null` — never `0` — when `model` is absent from `prices` or is
 * explicitly priced `null`: a hard-coded zero reads as "this turn was
 * free", which is a worse lie than an honest blank every consumer (the
 * chat-header cost chip, the bot-panel Cost cell, Usage Monitor's
 * pricing-coverage metric) already knows how to render.
 *
 * `usage.cachedInput` is a SUBSET of `usage.input`, never additional to it
 * — it is clamped into `[0, usage.input]` here so a driver bug upstream
 * (or a provider that double-counts) cannot produce a negative non-cached
 * remainder. */
export function costUsd(
  usage: TurnUsage,
  prices: ChatCompletionsPriceTable,
  model: string,
): number | null {
  const tiers = prices[model];
  if (!tiers || tiers.length === 0) return null;
  const tier =
    tiers.find((t) => t.maxInputTokens === undefined || usage.input <= t.maxInputTokens) ??
    tiers[tiers.length - 1];
  const cached = Math.min(Math.max(usage.cachedInput ?? 0, 0), usage.input);
  const uncached = usage.input - cached;
  const cachedRate = tier.cachedInput ?? tier.input;
  return (uncached * tier.input + cached * cachedRate + usage.output * tier.output) / 1_000_000;
}
