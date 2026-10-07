import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  summarizeForVoice,
  summarizeForVoiceDetailed,
  summaryLooksTruncated,
  normalizeDeepSeekChatUrl,
  resolveDeepSeekKey,
  voiceSummaryMaxTokens,
  voiceSummaryWorthStoring,
  DEEPSEEK_FLASH_TTS_PROMPT,
  SUMMARY_MAX_TOKENS,
  SUMMARY_MIN_TOKENS,
  SUMMARY_RATIO_MIN_CHARS,
} from "./speech-summary.ts";

describe("summarizeForVoice", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("short-circuits on short non-technical text without calling fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const res = await summarizeForVoice("Hello, this is a short reply.", "fake-key");
    expect(res).toBe("Hello, this is a short reply.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not short-circuit when short text contains technical artifacts like commit hashes or paths", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Merged commit in server dot t s." } }],
      }),
    });
    globalThis.fetch = fetchSpy;
    const res = await summarizeForVoice("Merged f44865ae in src/server.ts", "fake-key");
    expect(res).toBe("Merged commit in server dot t s.");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("normalizes deepseek endpoints properly", () => {
    expect(normalizeDeepSeekChatUrl()).toBe("https://api.deepseek.com/chat/completions");
    expect(normalizeDeepSeekChatUrl("https://custom.proxy.com")).toBe("https://custom.proxy.com/chat/completions");
    expect(normalizeDeepSeekChatUrl("https://custom.proxy.com/v1")).toBe("https://custom.proxy.com/v1/chat/completions");
    expect(normalizeDeepSeekChatUrl("custom.proxy.com/chat/completions/")).toBe("https://custom.proxy.com/chat/completions");
  });

  it("honors custom baseUrl passed via options", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Custom endpoint summary." } }],
      }),
    });
    globalThis.fetch = fetchSpy;
    const res = await summarizeForVoice(
      "A long message requiring processing through a custom proxy or self-hosted endpoint with additional technical details to bypass short-circuit.",
      { key: "test-key", baseUrl: "https://proxy.example.com/v1" },
    );
    expect(res).toBe("Custom endpoint summary.");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://proxy.example.com/v1/chat/completions",
      expect.anything(),
    );
  });

  it("calls deepseek-flash with disabled thinking and returns cleaned summary", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "[voice_summary]Here is the spoken update.[/voice_summary]",
            },
          },
        ],
      }),
    });

    const input = "This is a longer message that describes the deployment of multiple services and contains details about commit hashes and technical jargon that needs summarization for voice playback.";
    const result = await summarizeForVoice(input, "test-key");

    expect(result).toBe("Here is the spoken update.");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"thinking":{"type":"disabled"}'),
      }),
    );
  });

  it("falls back to deepseek-chat if deepseek-flash returns empty content", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      callCount++;
      const body = JSON.parse(options.body);
      if (body.model === "deepseek-flash") {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "" } }] }),
        };
      }
      if (body.model === "deepseek-chat") {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "Fallback chat summary." } }] }),
        };
      }
      return { ok: false };
    });

    const input = "A long message with technical details about code and deployment that definitely requires post-processing into natural speech for the user.";
    const result = await summarizeForVoice(input, "test-key");

    expect(result).toBe("Fallback chat summary.");
    expect(callCount).toBe(2);
  });

  it("falls back to spokenReply on fetch failure or timeout", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const input =
      "[voice_summary]The fallback spoken text.[/voice_summary][written_answer]This is a longer written message with technical code details in src/app.ts that requires voice summarization but fails due to network.[/written_answer]";
    const result = await summarizeForVoice(input, "test-key");
    expect(result).toBe("The fallback spoken text.");
  });

  it("resolves DEEPSEEK_VOICE_API_KEY from environment with top priority", () => {
    const prevVoice = process.env.DEEPSEEK_VOICE_API_KEY;
    const prevGeneral = process.env.DEEPSEEK_API_KEY;
    try {
      process.env.DEEPSEEK_VOICE_API_KEY = "voice-key-priority";
      process.env.DEEPSEEK_API_KEY = "general-key";
      expect(resolveDeepSeekKey()).toBe("voice-key-priority");
    } finally {
      if (prevVoice !== undefined) process.env.DEEPSEEK_VOICE_API_KEY = prevVoice;
      else delete process.env.DEEPSEEK_VOICE_API_KEY;
      if (prevGeneral !== undefined) process.env.DEEPSEEK_API_KEY = prevGeneral;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });

  const LONG = "This is a longer message that describes the deployment of multiple services and contains details about commit hashes and technical jargon that needs summarization for voice playback.";

  it("without an explicit or environment key it never calls the provider", async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    const savedVoice = process.env.DEEPSEEK_VOICE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_VOICE_API_KEY;
    try {
      globalThis.fetch = vi.fn();
      const res = await summarizeForVoice(LONG);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(res).toContain("deployment of multiple services");
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
      else delete process.env.DEEPSEEK_API_KEY;
      if (savedVoice !== undefined) process.env.DEEPSEEK_VOICE_API_KEY = savedVoice;
      else delete process.env.DEEPSEEK_VOICE_API_KEY;
    }
  });

  it("uses the configured endpoint instead of the hardcoded host", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "Spoken." } }] }) });
    await summarizeForVoice(LONG, "k", undefined, { url: "https://proxy.example.test/" });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://proxy.example.test/chat/completions");
  });

  it("gives up after the request deadline and falls back to the deterministic text", async () => {
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const res = await summarizeForVoice(LONG, "k", undefined, { timeoutMs: 20 });
    expect(res).toContain("deployment of multiple services");
  });

  it("prompt contains expected negative constraints and XML tags", () => {
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<core_directive>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<rules_for_spoken_prose>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<pacing_and_punctuation>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("NO DASHES");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("NO ELLIPSES");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<#0.3#>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<text_normalization>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<negative_constraints>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("DO NOT read out raw git commit hashes");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("DO NOT use em-dashes");
  });

  it("sanitizes em-dashes, en-dashes, and floating hyphens on short replies", async () => {
    const res = await summarizeForVoice("Quick check—looks good - done... ready");
    expect(res).toBe("Quick check, looks good, done. ready");
  });

  it("sanitizes em-dashes and ellipses returned by model", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Here is your update—first step completed - and waiting... for you" } }] }),
    });
    const res = await summarizeForVoice(LONG, "test-key");
    expect(res).toBe("Here is your update, first step completed, and waiting. for you");
  });

  it("strips list markers and keeps paragraph pauses on short replies", async () => {
    // The acoustic pass collapses newlines, so the structure has to be
    // normalized first or "2. Deploy queued" survives as a run-on.
    const res = await summarizeForVoice("1. Build passed\n2. Deploy queued");
    expect(res).toBe("Build passed. Deploy queued");
  });

  it("strips trailing unclosed code fences without wiping the preceding text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Here is the summary of what changed. ```typescript\nconst x = 1;",
            },
          },
        ],
      }),
    });
    const res = await summarizeForVoice(LONG, "test-key");
    expect(res).toBe("Here is the summary of what changed.");
  });

  it("preserves closed code fences while handling speech normalization", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Done. ```typescript\nconsole.log(1);\n``` All clear.",
            },
          },
        ],
      }),
    });
    const res = await summarizeForVoice(LONG, "test-key");
    expect(res).toBe("Done. (a code block) All clear.");
  });

  it("handles malformed model responses by falling back to deterministic speech", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ invalid_payload: 123 }),
    });
    const res = await summarizeForVoice(LONG, "test-key");
    expect(res).toContain("deployment of multiple services");
  });

  it("falls back to deterministic speech when model returns an unclosed fence at position 0 resulting in empty cleaned text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "```typescript\nconst x = 1;",
            },
          },
        ],
      }),
    });
    const res = await summarizeForVoice(LONG, "test-key");
    expect(res).toContain("deployment of multiple services");
  });
});



describe("summarizeForVoiceDetailed: long replies are never cut short", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A long, plain reply: about 3,000 characters of prose with a link so it
   * is not short-circuited. */
  const longReply = Array.from(
    { length: 30 },
    (_, i) => `Paragraph ${i + 1} explains one more step of the deploy, and why it matters for the release.`,
  ).join("\n\n") + "\n\nDetails are at https://example.com/release.";

  const answer = (content: string, finish_reason: string | null = "stop") => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason }] }),
  });

  it("scales max_tokens with the reply, within a bound", () => {
    expect(voiceSummaryMaxTokens(100)).toBe(SUMMARY_MIN_TOKENS);
    expect(voiceSummaryMaxTokens(3_000)).toBe(1_000);
    expect(voiceSummaryMaxTokens(1_000_000)).toBe(SUMMARY_MAX_TOKENS);
  });

  it("sends the scaled budget to both models", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    globalThis.fetch = fetchSpy;
    await summarizeForVoiceDetailed(longReply, "fake-key");
    const budgets = fetchSpy.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).max_tokens);
    expect(budgets).toEqual([voiceSummaryMaxTokens(longReply.length), voiceSummaryMaxTokens(longReply.length)]);
    expect(budgets[0]).toBeGreaterThan(500);
  });

  it("uses a complete rewrite and marks it as a summary", async () => {
    const rewrite = longReply.replace("https://example.com/release", "example dot com slash release");
    globalThis.fetch = vi.fn().mockResolvedValue(answer(rewrite));
    const result = await summarizeForVoiceDetailed(longReply, "fake-key");
    expect(result.source).toBe("summary");
    expect(result.text).toContain("Paragraph 30");
    expect(voiceSummaryWorthStoring(result)).toBe(true);
  });

  it("falls back to the full deterministic text when the rewrite hit max_tokens", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(answer("Paragraph 1 explains one more step of the", "length"));
    globalThis.fetch = fetchSpy;
    const result = await summarizeForVoiceDetailed(longReply, "fake-key");
    expect(result).toMatchObject({ source: "fallback", reason: "truncated" });
    expect(result.text).toContain("Paragraph 30");
    expect(result.text).not.toBe("Paragraph 1 explains one more step of the");
    // A cut-off answer is not retried on the second model at the same budget.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The stand-in is the full text, so it is safe (and cheaper) to keep.
    expect(voiceSummaryWorthStoring(result)).toBe(true);
  });

  it("treats any finish other than stop as incomplete", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer("Paragraph one.", "content_filter"));
    const result = await summarizeForVoiceDetailed(longReply, "fake-key");
    expect(result).toMatchObject({ source: "fallback", reason: "incomplete" });
    expect(result.text).toContain("Paragraph 30");
  });

  it("falls back when the rewrite is far shorter than the reply", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer("The deploy has thirty steps.", "stop"));
    const result = await summarizeForVoiceDetailed(longReply, "fake-key");
    expect(result).toMatchObject({ source: "fallback", reason: "too-short" });
    expect(result.text).toContain("Paragraph 30");
  });

  it("accepts a short rewrite when the caller asked for a condensed summary", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer("The deploy has thirty steps.", "stop"));
    const result = await summarizeForVoiceDetailed(longReply, { key: "fake-key", condense: true });
    expect(result).toMatchObject({ source: "summary", text: "The deploy has thirty steps." });
  });

  it("does not store a transient provider failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await summarizeForVoiceDetailed(longReply, "fake-key");
    expect(result).toMatchObject({ source: "fallback", reason: "unavailable" });
    expect(result.text).toContain("Paragraph 30");
    expect(voiceSummaryWorthStoring(result)).toBe(false);
  });

  it("keeps storing the deterministic text when there is no key or the reply is short", async () => {
    vi.stubEnv("DEEPSEEK_VOICE_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    try {
      const noKey = await summarizeForVoiceDetailed(longReply, { key: "" });
      expect(noKey).toMatchObject({ source: "fallback", reason: "no-key" });
      expect(voiceSummaryWorthStoring(noKey)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const short = await summarizeForVoiceDetailed("A short plain reply.", "fake-key");
    expect(short.source).toBe("short");
    expect(voiceSummaryWorthStoring(short)).toBe(true);
  });

  it("only calls a rewrite too short on replies long enough to judge", () => {
    expect(summaryLooksTruncated("x".repeat(10), "y".repeat(SUMMARY_RATIO_MIN_CHARS - 1))).toBe(false);
    expect(summaryLooksTruncated("x".repeat(10), "y".repeat(SUMMARY_RATIO_MIN_CHARS))).toBe(true);
    expect(summaryLooksTruncated("x".repeat(400), "y".repeat(1_000))).toBe(false);
  });

  it("keeps summarizeForVoice returning plain text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(answer("Paragraph 1 explains one more step of the", "length"));
    const text = await summarizeForVoice(longReply, "fake-key");
    expect(typeof text).toBe("string");
    expect(text).toContain("Paragraph 30");
  });
});
