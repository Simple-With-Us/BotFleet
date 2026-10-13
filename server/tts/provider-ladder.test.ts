import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { speakWithFallback, TtsProviderExhausted } from "./provider-ladder.ts";

const MP3_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

describe("speakWithFallback", () => {
  it("synthesizes through xAI when it is the only configured hosted provider", async () => {
    const cfg: AppConfig = {
      tts: { voice: "eve", provider: "xai", ladder: ["xai"] },
      xai: { key: "xai-good" },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(MP3_BYTES, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
    try {
      const audio = await speakWithFallback(cfg, "hello");
      expect(audio.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when every hosted provider fails", async () => {
    const cfg: AppConfig = {
      tts: { key: "mm-bad", voice: "v", ladder: ["minimax"] },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("nope", { status: 502 });
    try {
      await expect(speakWithFallback(cfg, "hello")).rejects.toBeInstanceOf(TtsProviderExhausted);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
