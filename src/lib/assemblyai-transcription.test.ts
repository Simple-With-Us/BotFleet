import { describe, expect, it } from "vitest";

import {
  buildAssemblyAIStreamingUrl,
  mergeAssemblyAITurn,
  pcm16FromFloat32,
  type AssemblyAITranscript,
} from "./assemblyai-transcription";

const empty = (): AssemblyAITranscript => ({ turns: new Map(), finalText: "", partialText: "" });

describe("AssemblyAI streaming transcription", () => {
  it("replaces a partial with the formatted final turn instead of duplicating it", () => {
    const partial = mergeAssemblyAITurn(empty(), { order: 0, text: "open settings", final: false });
    const final = mergeAssemblyAITurn(partial, { order: 0, text: "Open Settings.", final: true });
    expect(final.finalText).toBe("Open Settings.");
    expect(final.partialText).toBe("");
  });

  it("keeps finalized turns ordered when updates arrive out of order", () => {
    const second = mergeAssemblyAITurn(empty(), { order: 1, text: "Then save.", final: true });
    const first = mergeAssemblyAITurn(second, { order: 0, text: "Choose the file.", final: true });
    expect(first.finalText).toBe("Choose the file. Then save.");
  });

  it("resamples and clamps browser floats as signed little-endian PCM16", () => {
    const bytes = pcm16FromFloat32(new Float32Array([-2, 0, 2, 0]), 32_000, 16_000);
    const samples = new Int16Array(bytes);
    expect([...samples]).toEqual([-32768, 32767]);
  });
});

describe("buildAssemblyAIStreamingUrl", () => {
  const tokenUrl = (url: string): URL => new URL(url);

  it("sends the v3 default speech model, sample rate, format_turns, and token", () => {
    const url = buildAssemblyAIStreamingUrl({ token: "abc123" });
    const parsed = tokenUrl(url);
    expect(parsed.protocol).toBe("wss:");
    expect(parsed.host + parsed.pathname).toBe("streaming.assemblyai.com/v3/ws");
    expect(parsed.searchParams.get("sample_rate")).toBe("16000");
    expect(parsed.searchParams.get("speech_model")).toBe("u3-rt-pro");
    expect(parsed.searchParams.get("format_turns")).toBe("true");
    expect(parsed.searchParams.get("token")).toBe("abc123");
  });

  it("honours a speech-model override", () => {
    const url = buildAssemblyAIStreamingUrl({ token: "t", speechModel: "universal-3-5-pro" });
    expect(tokenUrl(url).searchParams.get("speech_model")).toBe("universal-3-5-pro");
  });

  it("emits one `keyterms_prompt` query parameter per term, trimmed, dropping blanks", () => {
    const url = buildAssemblyAIStreamingUrl({
      token: "t",
      keyterms: ["  BotFleet ", "", "MiniMax-M3", "BotFleet"],
    });
    const parsed = tokenUrl(url);
    const terms = parsed.searchParams.getAll("keyterms_prompt");
    expect(terms).toEqual(["BotFleet", "MiniMax-M3", "BotFleet"]);
  });

  it("caps the keyterms vocabulary at 100 entries", () => {
    const keyterms = Array.from({ length: 137 }, (_, i) => `term-${i}`);
    const url = buildAssemblyAIStreamingUrl({ token: "t", keyterms });
    const terms = tokenUrl(url).searchParams.getAll("keyterms_prompt");
    expect(terms).toHaveLength(100);
    expect(terms[0]).toBe("term-0");
    expect(terms[99]).toBe("term-99");
  });

  it("rounds min_turn_silence to an integer when given a finite value", () => {
    const url = buildAssemblyAIStreamingUrl({ token: "t", minTurnSilenceMs: 850.4 });
    expect(tokenUrl(url).searchParams.get("min_turn_silence")).toBe("850");
  });

  it("omits min_turn_silence for non-positive or non-finite values", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const url = buildAssemblyAIStreamingUrl({ token: "t", minTurnSilenceMs: value });
      expect(tokenUrl(url).searchParams.has("min_turn_silence")).toBe(false);
    }
  });
});
