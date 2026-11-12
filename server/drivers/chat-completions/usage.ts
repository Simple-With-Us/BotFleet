import type { TurnUsage } from "./loop.ts";

/** Cached reads are included in prompt_tokens, never additional tokens. */
export function toTurnUsage(raw: any): TurnUsage {
  const finiteCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  const usage: TurnUsage = { input: finiteCount(raw?.prompt_tokens), output: finiteCount(raw?.completion_tokens) };
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens;
  if (typeof cached === "number" && Number.isFinite(cached) && cached >= 0) usage.cachedInput = Math.min(usage.input, Math.round(cached));
  const reasoning = Number(raw?.completion_tokens_details?.reasoning_tokens);
  if (Number.isFinite(reasoning) && reasoning > 0) usage.reasoning = Math.min(usage.output, Math.round(reasoning));
  return usage;
}

/** Sum completed request attempts without counting cache reads twice. */
export function addTurnUsage(total: TurnUsage | undefined, next: TurnUsage | null): TurnUsage | undefined {
  if (!next) return total;
  const sum: TurnUsage = { input: (total?.input ?? 0) + next.input, output: (total?.output ?? 0) + next.output };
  if (total?.cachedInput != null || next.cachedInput != null) sum.cachedInput = (total?.cachedInput ?? 0) + (next.cachedInput ?? 0);
  if (total?.reasoning != null || next.reasoning != null) sum.reasoning = (total?.reasoning ?? 0) + (next.reasoning ?? 0);
  return sum;
}
