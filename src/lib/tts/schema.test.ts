import { describe, expect, it } from "vitest";

import {
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

  it("treats a malformed list as empty rather than throwing", () => {
    // `[]` is the normal answer from a Mac that cannot build the helper, so a
    // shape change must read the same as "no personal voices", not crash.
    for (const bad of [null, undefined, {}, "personal:x", [{ id: "personal:x" }], 42]) {
      expect(parsePersonalVoiceList(bad)).toEqual([]);
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

  it("treats a malformed response as empty", () => {
    expect(parseTtsVoicesResponse({ voices: "nope" })).toEqual({});
    expect(parseTtsVoicesResponse(null)).toEqual({});
  });
});
