import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { summarizeForVoice, DEEPSEEK_FLASH_TTS_PROMPT } from "./speech-summary.ts";

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

  it("falls back to spokenReply on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const input = "A long message with [written_answer]The fallback written text.[/written_answer]";
    const result = await summarizeForVoice(input, "test-key");
    expect(result).toBe("The fallback written text.");
  });

  it("prompt contains expected negative constraints and XML tags", () => {
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<core_directive>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<rules_for_spoken_prose>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<text_normalization>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("<negative_constraints>");
    expect(DEEPSEEK_FLASH_TTS_PROMPT).toContain("DO NOT read out raw git commit hashes");
  });
});
