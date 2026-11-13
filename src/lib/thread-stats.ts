// Turning a task's banked usage and timing aggregates into the two footer
// chips under the composer.  Pure — every function returns `undefined` for a
// figure the engine never reported, so the UI can omit the row instead of
// showing a misleading 0.
import type { TaskStats, TaskUsage } from "@/state/store";
import { cachedInput, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** 850 → "850ms", 7_300 → "7.3s", 42_000 → "42s", 280_000 → "4m40s",
 *  1_336_000 → "22m16s", 3_900_000 → "1h05m".  Undefined for a non-finite or
 *  negative input. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  // round first: 999.6ms is "1s", never "1000ms"
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole}ms`;
  if (ms < 10_000) {
    // whole tenths, so 9_960ms promotes to "10s" through the branch below
    const seconds = Math.round(ms / 100) / 10;
    if (seconds < 10) return `${seconds}s`;
  }
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h${pad(m)}m` : `${m}m${pad(s)}s`;
}

/** "92 tok/s"; one decimal below 10 so a slow engine isn't rounded to "0".
 *  Below a tenth of a token a second there is no honest figure to print — it
 *  would round to "0" — and no engine streams that slowly, so it is a rate
 *  polluted by time that was not generation (a wait), and is left out. */
export function formatRate(tokPerSec: number | undefined): string | undefined {
  if (!positive(tokPerSec) || tokPerSec < 0.1) return undefined;
  return tokPerSec < 10 ? `${tokPerSec.toFixed(1).replace(/\.0$/, "")} tok/s` : `${Math.round(tokPerSec)} tok/s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface SessionStatsView {
  /** "2 turns" */
  turns: string;
  /** "27 steps" — absent when no step ran, and when this task's timing does
   *  not cover every turn (turns from before timing was recorded have no step
   *  count, so a total would be a guess). */
  steps?: string;
  /** "92 tok/s" */
  rate?: string;
  /** Popover rows, already formatted; only those with real data. */
  rows: Array<{ label: string; value: string }>;
  /** Set when the rows cover only some of the thread's turns. */
  note?: string;
}

/** The stats chip.  Undefined when the task has no timing at all. */
export function deriveSessionStats(
  stats: TaskStats | undefined,
  usage: TaskUsage | undefined,
): SessionStatsView | undefined {
  if (!stats || !positive(stats.turns)) return undefined;
  const banked = usage?.turns ?? 0;
  // stats only cover turns since the field existed; a thread with older
  // turns must not claim a step count for the whole of it
  const covers = stats.turns >= banked;
  const turns = Math.max(stats.turns, banked);
  const rate = positive(stats.tpsTokens) && positive(stats.tpsMs) ? stats.tpsTokens / (stats.tpsMs / 1000) : undefined;
  const avgTtft = positive(stats.ttftSamples) && typeof stats.ttftMsSum === "number"
    ? stats.ttftMsSum / stats.ttftSamples
    : undefined;
  const rows: SessionStatsView["rows"] = [];
  const addRow = (label: string, value: string | undefined) => {
    if (value !== undefined) rows.push({ label, value });
  };
  if (positive(stats.modelMs)) addRow("Model time", formatDuration(stats.modelMs));
  // a tool that ran for under a millisecond is still a step worth a row
  if (positive(stats.steps) || positive(stats.toolMs)) addRow("Tool time", formatDuration(stats.toolMs));
  addRow("Avg time to first token", formatDuration(avgTtft));
  const rateText = formatRate(rate);
  addRow("Tokens per second", rateText?.replace(/ tok\/s$/, ""));
  return {
    turns: plural(turns, "turn"),
    ...(covers && positive(stats.steps) ? { steps: plural(stats.steps, "step") } : {}),
    ...(rateText ? { rate: rateText } : {}),
    rows,
    ...(covers ? {} : { note: `Timing covers ${stats.turns} of ${turns} turns` }),
  };
}

export interface TokenUsageView {
  /** "645k tok" — everything the model processed. */
  total: string;
  /** "91%" — share of input served from the prompt cache. */
  cacheHit?: string;
  /** Popover header, e.g. "645k tokens". */
  headline: string;
  rows: Array<{ label: string; value: string }>;
}

/** Cache hit as a whole percent.  Never rounds a partial hit up to "100%". */
export function cacheHitPercent(usage: TaskUsage): number | undefined {
  if (!hasFiniteCost(usage.cachedInput) || !positive(usage.input)) return undefined;
  const cached = cachedInput(usage);
  const pct = Math.round((cached / usage.input) * 100);
  return cached < usage.input ? Math.min(pct, 99) : pct;
}

/** The token chip.  Undefined when nothing has been spent. */
export function deriveTokenUsage(usage: TaskUsage | undefined): TokenUsageView | undefined {
  if (!usage) return undefined;
  const total = (positive(usage.input) ? usage.input : 0) + (positive(usage.output) ? usage.output : 0);
  if (total <= 0) return undefined;
  const totalText = formatTokens(total);
  const pct = cacheHitPercent(usage);
  const rows: TokenUsageView["rows"] = [];
  if (pct !== undefined) {
    const cached = cachedInput(usage);
    rows.push({ label: "Cache hit", value: `${pct}%` });
    rows.push({ label: "Uncached input", value: formatTokens(usage.input - cached) });
    rows.push({ label: "Cached input", value: formatTokens(cached) });
  } else if (positive(usage.input)) {
    rows.push({ label: "Input", value: formatTokens(usage.input) });
  }
  // an engine that reports no output (DSH) banks 0 — that is "unknown", not "none"
  if (positive(usage.output)) rows.push({ label: "Output", value: formatTokens(usage.output) });
  if (hasFiniteCost(usage.costUsd)) rows.push({ label: "Cost", value: formatUsd(usage.costUsd) });
  return {
    total: `${totalText} tok`,
    ...(pct !== undefined ? { cacheHit: `${pct}%` } : {}),
    headline: `${totalText} tokens`,
    rows,
  };
}
