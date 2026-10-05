import { describe, expect, it } from "vitest";

import {
  CustomVoiceResponseSchema,
  parsePersonalVoiceList,
  parseTtsVoicesResponse,
  TtsAudioBodySchema,
} from "./schema";

describe("TtsAudioBodySchema", () => {
  it("accepts the on-device personal-voice response", () => {
    const parsed = TtsAudioBodySchema.safeParse({
      audio: [],
      voiceText: "Morning.  The tests went green.",
      utterances: ["Morning.", "The tests went green."],
      onDevice: true,
      personalVoice: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.onDevice).toBe(true);
  });

  it("accepts the cloud response with real clips", () => {
    const parsed = TtsAudioBodySchema.safeParse({
      audio: [{ path: "/api/attachments/a.mp3", mime: "audio/mpeg" }],
      voiceText: "Hello there.",
      utterances: ["Hello there."],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.audio).toHaveLength(1);
  });

  it("rejects a body whose fields are the wrong type", () => {
    // The pre-parse failure this exists to prevent: `onDevice` arriving as a
    // string used to be read as truthy and take the on-device branch.
    expect(TtsAudioBodySchema.safeParse({ audio: [], onDevice: "true" }).success).toBe(false);
    expect(TtsAudioBodySchema.safeParse({ audio: "none" }).success).toBe(false);
    expect(TtsAudioBodySchema.safeParse({ audio: [], utterances: [42] }).success).toBe(false);
  });

  it("rejects a clip whose fields are the wrong type", () => {
    expect(TtsAudioBodySchema.safeParse({ audio: [{ path: 7, mime: "audio/mpeg" }] }).success).toBe(false);
  });
});

describe("parsePersonalVoiceList", () => {
  it("accepts a well-formed list", () => {
    expect(parsePersonalVoiceList([{ id: "personal:x", name: "Jay", locale: "en-US" }])).toEqual([
      { id: "personal:x", name: "Jay", locale: "en-US" },
    ]);
  });

  it("accepts a voice with no locale", () => {
    expect(parsePersonalVoiceList([{ id: "personal:x", name: "Jay" }])).toEqual([
      { id: "personal:x", name: "Jay" },
    ]);
  });

  it("rejects a malformed list by throwing a validation error", () => {
    for (const bad of [null, undefined, {}, "personal:x", [{ id: "personal:x" }], 42]) {
      expect(() => parsePersonalVoiceList(bad)).toThrow();
    }
  });
});

describe("parseTtsVoicesResponse", () => {
  it("keeps a well-formed list and its error string", () => {
    expect(parseTtsVoicesResponse({
      voices: [{ id: "v1", label: "English", description: "Warm" }],
      error: "Voice key rejected",
    })).toEqual({
      voices: [{ id: "v1", label: "English", description: "Warm" }],
      error: "Voice key rejected",
    });
  });

  it("rejects a malformed response by throwing a validation error", () => {
    expect(() => parseTtsVoicesResponse({ voices: "nope" })).toThrow();
    expect(() => parseTtsVoicesResponse(null)).toThrow();
  });
});

describe("CustomVoiceResponseSchema", () => {
  it("accepts the live success body with description", () => {
    const parsed = CustomVoiceResponseSchema.safeParse({
      ok: true,
      voice: { id: "personal:com.apple.speech.voice.Jay", label: "Jay", description: "Custom" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && "voice" in parsed.data) {
      expect(parsed.data.voice.id).toBe("personal:com.apple.speech.voice.Jay");
    }
  });

  it("accepts a success body without description (fixture and route mock shape)", () => {
    const parsed = CustomVoiceResponseSchema.safeParse({
      ok: true,
      voice: { id: "v1", label: "Voice 1" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an error body", () => {
    const parsed = CustomVoiceResponseSchema.safeParse({ error: "Voice ID is required." });
    expect(parsed.success).toBe(true);
    if (parsed.success && "error" in parsed.data) {
      expect(parsed.data.error).toBe("Voice ID is required.");
    }
  });

  it("rejects a success body whose id is missing", () => {
    expect(
      CustomVoiceResponseSchema.safeParse({ ok: true, voice: { label: "x" } }).success,
    ).toBe(false);
  });

  it("rejects a success body whose id is empty", () => {
    expect(
      CustomVoiceResponseSchema.safeParse({ ok: true, voice: { id: "", label: "x" } }).success,
    ).toBe(false);
  });

  it("rejects a success body whose id is not a string", () => {
    expect(
      CustomVoiceResponseSchema.safeParse({ ok: true, voice: { id: 42, label: "x" } }).success,
    ).toBe(false);
  });

  it("rejects a success body that carries an unexpected extra field", () => {
    expect(
      CustomVoiceResponseSchema.safeParse({
        ok: true,
        voice: { id: "v1", label: "V1" },
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed response", () => {
    expect(CustomVoiceResponseSchema.safeParse(null).success).toBe(false);
    expect(CustomVoiceResponseSchema.safeParse({}).success).toBe(false);
    expect(
      CustomVoiceResponseSchema.safeParse({ voice: { id: "v1", label: "V1" } }).success,
    ).toBe(false);
    expect(
      CustomVoiceResponseSchema.safeParse({ ok: true, voice: { id: "v1", label: "V1", extra: 1 } }).success,
    ).toBe(false);
  });
});
