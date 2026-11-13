/** Reference API rates, USD per million tokens, verified 2026-09-13.
 * https://api-docs.deepseek.com/quick_start/pricing/
 * These display values do not establish historical or subscription charges. */
export const DEEPSEEK_PRICE_PER_MILLION = {
  flash: {
    offPeak: { input: 0.15, cache: 0.003, output: 0.6 },
    peak: { input: 0.3, cache: 0.006, output: 1.2 },
  },
  pro: {
    offPeak: { input: 0.66, cache: 0.022, output: 1.98 },
    peak: { input: 1.32, cache: 0.044, output: 3.96 },
  },
} as const;

export function formatPerMillionUsd(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  const hundredths = Math.round(usd * 100) / 100;
  if (Math.abs(hundredths - usd) < 1e-9) return `$${hundredths.toFixed(2)}`;
  return `$${usd.toFixed(3).replace(/0+$/, "")}`;
}

export type DeepSeekPriceRow = {
  model: string;
  provider: string;
  input: string;
  cache: string;
  output: string;
  badge: string;
};

export function deepSeekPriceRows(): DeepSeekPriceRow[] {
  const { flash, pro } = DEEPSEEK_PRICE_PER_MILLION;
  const range = (low: number, high: number) => `${formatPerMillionUsd(low)}–${formatPerMillionUsd(high)}`;
  return [
    {
      model: "DeepSeek V4.1 Flash",
      provider: "DeepSeek",
      input: range(flash.offPeak.input, flash.peak.input),
      cache: range(flash.offPeak.cache, flash.peak.cache),
      output: range(flash.offPeak.output, flash.peak.output),
      badge: "Off-Peak–Peak",
    },
    {
      model: "DeepSeek V4 Pro",
      provider: "DeepSeek",
      input: range(pro.offPeak.input, pro.peak.input),
      cache: range(pro.offPeak.cache, pro.peak.cache),
      output: range(pro.offPeak.output, pro.peak.output),
      badge: "Off-Peak–Peak",
    },
  ];
}
