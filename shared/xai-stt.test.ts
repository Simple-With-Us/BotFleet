import { describe, expect, it } from "vitest";

import {
  XAI_STT_MODEL,
  XAI_STT_STREAM_URL,
  buildXaiSttStreamingUrl,
  cleanXaiKeyterms,
  normalizeXaiSttLanguage,
  parseXaiSttEvent,
  sttCostUsd,
  xaiPartialToTurn,
} from "./xai-stt.ts";

describe("xAI STT helpers", () => {
  it("cleans, caps, and dedupes keyterms", () => {
    expect(cleanXaiKeyterms(["  BotFleet  ", "", "BotFleet", "a".repeat(80)])).toEqual([
      "BotFleet",
      "a".repeat(50),
    ]);
    expect(cleanXaiKeyterms(Array.from({ length: 120 }, (_, i) => `term-${i}`))).toHaveLength(100);
  });

  it("normalizes language tags onto documented codes", () => {
    expect(normalizeXaiSttLanguage("en-US")).toBe("en");
    expect(normalizeXaiSttLanguage("es-MX")).toBe("es-MX");
    expect(normalizeXaiSttLanguage("pt_PT")).toBe("pt-PT");
    expect(normalizeXaiSttLanguage("zz")).toBeUndefined();
    expect(normalizeXaiSttLanguage("")).toBeUndefined();
  });

  it("builds the streaming URL with language, format, keyterms, and endpointing", () => {
    const url = buildXaiSttStreamingUrl({
      language: "en-US",
      keyterms: ["BotFleet", "Mavis"],
      endpointingMs: 850,
    });
    expect(url.startsWith(`${XAI_STT_STREAM_URL}?`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get("model")).toBe(XAI_STT_MODEL);
    expect(query.get("sample_rate")).toBe("16000");
    expect(query.get("encoding")).toBe("pcm");
    expect(query.get("interim_results")).toBe("true");
    expect(query.get("endpointing")).toBe("850");
    expect(query.get("language")).toBe("en");
    expect(query.get("format")).toBe("true");
    expect(query.getAll("keyterm")).toEqual(["BotFleet", "Mavis"]);
  });

  it("omits format=true when there is no language, so the request cannot 400", () => {
    const query = new URL(buildXaiSttStreamingUrl({ format: true })).searchParams;
    expect(query.get("language")).toBeNull();
    expect(query.get("format")).toBeNull();
  });

  it("prices REST and streaming by the hour", () => {
    expect(sttCostUsd(3600, "rest")).toBeCloseTo(0.10);
    expect(sttCostUsd(1800, "streaming")).toBeCloseTo(0.10);
    expect(sttCostUsd(0, "streaming")).toBe(0);
  });

  it("maps speech_final partials to a finished turn", () => {
    expect(xaiPartialToTurn({ type: "transcript.partial", text: "  Hello  ", speech_final: true })).toEqual({
      text: "Hello",
      final: true,
    });
    expect(xaiPartialToTurn({ type: "transcript.partial", text: "Hel", is_final: false })).toEqual({
      text: "Hel",
      final: false,
    });
    expect(parseXaiSttEvent({ type: "transcript.created" })).toEqual({ type: "transcript.created" });
    expect(parseXaiSttEvent({ no: "type" })).toBeNull();
  });
});
