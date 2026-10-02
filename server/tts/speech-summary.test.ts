import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  summarizeForVoice,
  normalizeDeepSeekChatUrl,
  resolveDeepSeekKey,
  DEEPSEEK_FLASH_TTS_PROMPT,
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
});

