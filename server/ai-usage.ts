// The canonical `ai` block of a Usage Monitor v2 event (UM-1592, shared
// contract `@jaywedgeworth22/congress-trading-shared` >= 2.8.1,
// docs/ai-usage-schema.md).
//
// BotFleet does not import the shared package: it is a GitHub-hosted private
// dependency, and the harness ships as a self-contained server bundle that
// installs without GitHub credentials.  This file emits the same shape with
// the same field names instead, and `ai-usage.test.ts` pins the rules the
// receiver's strict schema enforces (integer tokens, 1-80 / 1-160 character
// strings, no unknown keys), so a drift is a failing test here rather than a
// rejected event in production.
//
// Token semantics are the shared contract's, and every bucket is priced
// once:
//   input         UNCACHED input tokens only
//   output        every billed output token, reasoning included
//   cacheRead     input served from the prompt cache
//   cacheWrite5m  input written to a 5 minute cache, or to a cache whose TTL
//                 the provider does not report
//   cacheWrite1h  input written to a 1 hour cache
//   reasoning     the reasoning share of `output`; informational, never added

import { z } from "zod";

export interface AiUsageTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  reasoning?: number;
}

export interface AiUsageBlock {
  model?: { requested?: string; served?: string };
  harness?: string;
  seat?: string;
  tokens?: AiUsageTokens;
  durationMs?: number;
  ttftMs?: number;
  billingMode?: "subscription" | "payg" | "free";
  costSource?: "billed" | "estimated";
}

/** A finite, positive whole number, or 0 for anything that is not one. */
export function tokenCount(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A finite, non-negative number of milliseconds, or undefined. */
export function milliseconds(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tag(value: string | null | undefined, max: number): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Total billed tokens: the sum of the five billed buckets.  `reasoning` is a
 * subset of `output` and is never added.  This is the event `quantity`. */
export function aiUsageTotalTokens(tokens: AiUsageTokens | undefined): number {
  if (!tokens) return 0;
  return (
    tokenCount(tokens.input) +
    tokenCount(tokens.output) +
    tokenCount(tokens.cacheRead) +
    tokenCount(tokens.cacheWrite5m) +
    tokenCount(tokens.cacheWrite1h)
  );
}

/** What a driver reports for one turn, in BotFleet's own convention:
 * `input` is the WHOLE context sent, and the cache figures are subsets of it
 * (server/contracts.ts, `turn.completed.usage`). */
export interface TurnTokenReport {
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  reasoning?: number;
}

/** The canonical tokens for one turn: BotFleet's whole-context `input` split
 * into uncached input, cache reads and cache writes, so each bucket is priced
 * at its own rate and none twice. */
export function aiTokensFromTurn(report: TurnTokenReport): AiUsageTokens {
  const total = tokenCount(report.input);
  const cacheRead = tokenCount(report.cachedInput);
  const cacheWrite5m = tokenCount(report.cacheWrite5m);
  const cacheWrite1h = tokenCount(report.cacheWrite1h);
  const output = tokenCount(report.output);
  const reasoning = Math.min(tokenCount(report.reasoning), output);
  const tokens: AiUsageTokens = {};
  const input = Math.max(0, total - cacheRead - cacheWrite5m - cacheWrite1h);
  if (input > 0) tokens.input = input;
  if (output > 0) tokens.output = output;
  if (cacheRead > 0) tokens.cacheRead = cacheRead;
  if (cacheWrite5m > 0) tokens.cacheWrite5m = cacheWrite5m;
  if (cacheWrite1h > 0) tokens.cacheWrite1h = cacheWrite1h;
  if (reasoning > 0) tokens.reasoning = reasoning;
  return tokens;
}

// A provider's `usage` object is an external response, so it is parsed at the
// door.  Each field is lenient on its own (`.catch`): a provider that sends a
// string or a negative where a count belongs loses that field, not the whole
// object, and an unexpected shape reads as "no usage" rather than as zeros.
const count = z.number().finite().nonnegative().optional().catch(undefined);
export const ChatUsageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_cache_hit_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count, cache_write_tokens: count }).optional().catch(undefined),
  completion_tokens_details: z.object({ reasoning_tokens: count }).optional().catch(undefined),
});

/** A provider `usage` object that has been through `ChatUsageSchema`. */
export type ChatUsage = z.output<typeof ChatUsageSchema>;

/** The canonical tokens of an OpenAI Chat Completions style `usage` object
 * (also DeepSeek, MiniMax, xAI, OpenRouter): `prompt_tokens` includes the
 * cached share, `completion_tokens` includes reasoning.  The caller parses the
 * provider response with `ChatUsageSchema` first. */
export function aiTokensFromChatUsage(raw: ChatUsage | undefined): AiUsageTokens {
  if (!raw) return {};
  const prompt = tokenCount(raw.prompt_tokens);
  const cacheRead = Math.min(
    prompt,
    tokenCount(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens),
  );
  const cacheWrite5m = Math.min(
    Math.max(0, prompt - cacheRead),
    tokenCount(raw.prompt_tokens_details?.cache_write_tokens),
  );
  return aiTokensFromTurn({
    input: prompt,
    output: tokenCount(raw.completion_tokens),
    cachedInput: cacheRead,
    cacheWrite5m,
    reasoning: tokenCount(raw.completion_tokens_details?.reasoning_tokens),
  });
}

/** Drop empty strings and out-of-range numbers so the receiver's strict
 * schema never sees a value it would refuse, and return undefined when
 * nothing is left.  An `ai` block that is wrong rejects its whole event, and
 * that costs the row, so the block is built conservatively. */
export function cleanAiUsage(block: AiUsageBlock): AiUsageBlock | undefined {
  const out: AiUsageBlock = {};
  const requested = tag(block.model?.requested, 160);
  const served = tag(block.model?.served, 160);
  if (requested || served) {
    out.model = {};
    if (requested) out.model.requested = requested;
    if (served) out.model.served = served;
  }
  const harness = tag(block.harness, 80);
  if (harness) out.harness = harness;
  const seat = tag(block.seat, 80);
  if (seat) out.seat = seat;
  if (block.tokens) {
    const tokens: AiUsageTokens = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "reasoning"] as const) {
      const value = tokenCount(block.tokens[key]);
      if (value > 0) tokens[key] = value;
    }
    if (Object.keys(tokens).length > 0) out.tokens = tokens;
  }
  const durationMs = milliseconds(block.durationMs);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const ttftMs = milliseconds(block.ttftMs);
  if (ttftMs !== undefined) out.ttftMs = ttftMs;
  if (block.billingMode) out.billingMode = block.billingMode;
  if (block.costSource) out.costSource = block.costSource;
  return Object.keys(out).length > 0 ? out : undefined;
}
