// The local `ai` block builders (BF-2435).  BotFleet emits the shared v2
// contract's shape without importing the shared package, so these pin the
// arithmetic that matters: every bucket priced once, whole numbers only, and
// nothing the receiver's strict schema would refuse.
import { describe, expect, it } from "vitest";

import { aiTokensFromChatUsage, aiTokensFromTurn, aiUsageTotalTokens, ChatUsageSchema, cleanAiUsage } from "./ai-usage.ts";

/** What the caller does with a provider response before the helper sees it. */
const chat = (raw: Parameters<typeof ChatUsageSchema.safeParse>[0]) => aiTokensFromChatUsage(ChatUsageSchema.safeParse(raw).data);

describe("aiTokensFromTurn", () => {
  it("splits BotFleet's whole-context input into uncached input and the cache buckets", () => {
    const tokens = aiTokensFromTurn({ input: 1000, output: 200, cachedInput: 400, cacheWrite5m: 150, cacheWrite1h: 50 });

    expect(tokens).toEqual({ input: 400, output: 200, cacheRead: 400, cacheWrite5m: 150, cacheWrite1h: 50 });
    expect(aiUsageTotalTokens(tokens)).toBe(1200);
  });

  it("never lets the cache buckets push input below zero", () => {
    expect(aiTokensFromTurn({ input: 100, cachedInput: 300, cacheWrite5m: 50 })).toEqual({ cacheRead: 300, cacheWrite5m: 50 });
  });

  it("keeps reasoning inside output: informational, never summed and never larger than output", () => {
    const tokens = aiTokensFromTurn({ input: 10, output: 40, reasoning: 90 });

    expect(tokens.reasoning).toBe(40);
    expect(aiUsageTotalTokens(tokens)).toBe(50);
  });

  it("rounds, and treats anything that is not a count as nothing", () => {
    expect(aiTokensFromTurn({ input: 10.6, output: Number.NaN, cachedInput: -2 })).toEqual({ input: 11 });
    expect(aiTokensFromTurn({})).toEqual({});
  });
});

describe("aiTokensFromChatUsage", () => {
  it("reads an OpenAI-style usage object, taking the cached share out of prompt_tokens", () => {
    const tokens = chat({
      prompt_tokens: 1000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 120 },
    });

    expect(tokens).toEqual({ input: 400, output: 300, cacheRead: 600, reasoning: 120 });
    expect(aiUsageTotalTokens(tokens)).toBe(1300);
  });

  it("reads DeepSeek's prompt_cache_hit_tokens", () => {
    expect(chat({ prompt_tokens: 500, completion_tokens: 50, prompt_cache_hit_tokens: 450 })).toEqual({
      input: 50,
      output: 50,
      cacheRead: 450,
    });
  });

  it("reads an OpenRouter cache write as a 5 minute write, out of input", () => {
    expect(
      chat({ prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 } }),
    ).toEqual({ input: 200, output: 5, cacheRead: 100, cacheWrite5m: 200 });
  });

  it("reads a malformed field as absent without losing the rest", () => {
    expect(chat({ prompt_tokens: "lots", completion_tokens: 12 })).toEqual({ output: 12 });
    expect(chat({ prompt_tokens: -4, completion_tokens: 12, prompt_tokens_details: "nope" })).toEqual({ output: 12 });
    expect(chat("not an object")).toEqual({});
  });

  it("is empty for a response with no usage", () => {
    expect(chat(undefined)).toEqual({});
    expect(chat({})).toEqual({});
  });
});

describe("cleanAiUsage", () => {
  it("drops empty strings, zero buckets and unusable timings, and is undefined when nothing is left", () => {
    expect(
      cleanAiUsage({ model: { requested: "  ", served: "" }, harness: "", tokens: { input: 0, output: Number.NaN }, durationMs: -1, ttftMs: Number.NaN }),
    ).toBeUndefined();
  });

  it("clips to the schema's caps", () => {
    const ai = cleanAiUsage({ model: { requested: "m".repeat(400) }, harness: "h".repeat(200), seat: "s".repeat(200) });

    expect(ai?.model?.requested).toHaveLength(160);
    expect(ai?.harness).toHaveLength(80);
    expect(ai?.seat).toHaveLength(80);
  });

  it("keeps a zero duration, which is a real measurement", () => {
    expect(cleanAiUsage({ durationMs: 0 })).toEqual({ durationMs: 0 });
  });
});
