/** Published MiniMax API rates, USD per million tokens, STANDARD service
 *  tier — the driver never sends `service_tier: "priority"`.  Source:
 *  https://platform.minimax.io/docs/guides/pricing-paygo, verified
 *  Tue, Sep 8, 2026.  MiniMax-M3.1-Flash-Preview's listed rates already reflect MiniMax's
 *  own "Permanent 50% off" discount, and it is the one model here with a
 *  published tier for prompts over 512K input tokens, at double the base
 *  rate — the tier with no `maxInputTokens` is the catch-all.
 *
 * Keyed by the SAME model ids as server/drivers/minimax.ts's own catalog
 * and price table, on purpose: this is a separately maintained display copy
 * of that driver's numbers (the Vite client cannot import server code — it
 * reads local files with node:fs), the same relationship this file's
 * DeepSeek sibling has with its own driver, and using identical keys is
 * what lets minimax-prices.test.ts assert the two never drift apart.
 *
 * `null` means "this catalog model has no price yet" — never omit a model
 * outright, or the coverage test below cannot tell "unpriced on purpose"
 * from "somebody forgot". */
export interface MinimaxPriceTier {
  /** This tier applies while a round's prompt token count is at most this
   *  many; left out on a model's LAST tier, meaning "no upper bound". */
  maxInputTokens?: number;
  input: number;
  output: number;
  /** Left out when MiniMax has not published a cached-read rate for this
   *  tier. */
  cachedInput?: number;
}

export type MinimaxPriceTable = Record<string, MinimaxPriceTier[] | null>;

export const MINIMAX_PRICE_PER_MILLION = {
  "MiniMax-M3.1-Flash-Preview": [
    { maxInputTokens: 512_000, input: 0.3, output: 1.2, cachedInput: 0.06 },
    { input: 0.6, output: 2.4, cachedInput: 0.12 },
  ],
  "MiniMax-M2.7-highspeed": [{ input: 0.6, output: 2.4, cachedInput: 0.06 }],
} satisfies MinimaxPriceTable;

/** Same formatting rule as this file's DeepSeek sibling — kept duplicated
 *  rather than imported so this module has zero cross-driver coupling. */
export function formatPerMillionUsd(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  const hundredths = Math.round(usd * 100) / 100;
  if (Math.abs(hundredths - usd) < 1e-9) return `$${hundredths.toFixed(2)}`;
  return `$${usd.toFixed(3).replace(/0+$/, "")}`;
}

export type MinimaxPriceRow = {
  model: string;
  provider: string;
  input: string;
  cache: string;
  output: string;
  badge: string;
};

type MinimaxDisplayLabel = { model: string; badge: string };

// DISPLAY is looked up by a general `string` (a catalog model id read back
// out of MINIMAX_PRICE_PER_MILLION), so it genuinely needs an index
// signature rather than the narrow literal-keyed type `satisfies` would
// infer — the same boundary shape decodeMinimaxConfig's own suppression in
// server/drivers/minimax.ts documents.
// oxlint-disable-next-line anti-slop/no-known-value-widening
const DISPLAY: Record<string, MinimaxDisplayLabel> = {
  "MiniMax-M3.1-Flash-Preview": { model: "MiniMax M3.1 Flash Preview", badge: "Default · ≤512K ctx" },
  "MiniMax-M2.7-highspeed": { model: "MiniMax M2.7 Highspeed", badge: "API" },
};

/** One row per PRICED catalog model, cheapest (first) tier only — a single
 *  reference table has no room to show MiniMax-M3.1-Flash-Preview's >512K tier, so the
 *  badge says which tier the number is.  A model priced `null` is left out
 *  of the table rather than shown as "—" everywhere, matching how every
 *  other unpriced-model gap in this fleet reads (nothing shown beats a
 *  wall of dashes). */
export function minimaxPriceRows(): MinimaxPriceRow[] {
  const rows: MinimaxPriceRow[] = [];
  for (const [id, tiers] of Object.entries(MINIMAX_PRICE_PER_MILLION)) {
    if (!tiers || tiers.length === 0) continue;
    const base = tiers[0];
    const label = DISPLAY[id] ?? { model: id, badge: "API" };
    rows.push({
      model: label.model,
      provider: "MiniMax",
      input: formatPerMillionUsd(base.input),
      cache: base.cachedInput !== undefined ? formatPerMillionUsd(base.cachedInput) : "—",
      output: formatPerMillionUsd(base.output),
      badge: label.badge,
    });
  }
  return rows;
}
