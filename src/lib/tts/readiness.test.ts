import { describe, expect, it } from "vitest";

import { callVoiceReadiness, effectiveVoice, PLAY_PERSONAL_UNAVAILABLE, speakButtonState, speakReadiness } from "./readiness";

const noKey = { configured: false, ready: false, voice: "" };
const minimax = { configured: true, ready: true, voice: "minimax-default" };

describe("effectiveVoice", () => {
  it("uses the bot's voice for this Mac, else the workspace default", () => {
    expect(effectiveVoice("personal:mac", minimax)).toBe("personal:mac");
    expect(effectiveVoice(undefined, minimax)).toBe("minimax-default");
    expect(effectiveVoice("  ", minimax)).toBe("minimax-default");
    expect(effectiveVoice(undefined, noKey)).toBe("");
  });
});

describe("speakReadiness", () => {
  it("plays a Personal Voice on this Mac without a MiniMax key", () => {
    expect(speakReadiness({ voiceId: "personal:mac", tts: noKey, personalVoiceAvailable: true })).toEqual({
      ready: true,
      reason: "ready",
      personal: true,
    });
  });

  it("refuses a Personal Voice where the capability is off, even with saved clips", () => {
    expect(speakReadiness({ voiceId: "personal:mac", tts: minimax, personalVoiceAvailable: false, hasAudio: true })).toEqual({
      ready: false,
      reason: "personal-unavailable",
      personal: true,
    });
  });

  it("needs a voice engine for a hosted voice unless clips are already saved", () => {
    expect(speakReadiness({ voiceId: "minimax-warm", tts: noKey, personalVoiceAvailable: true }).reason).toBe("no-engine");
    expect(speakReadiness({ voiceId: "minimax-warm", tts: noKey, personalVoiceAvailable: true, hasAudio: true }).ready).toBe(true);
    expect(speakReadiness({ voiceId: "minimax-warm", tts: minimax, personalVoiceAvailable: false }).ready).toBe(true);
  });

  it("asks for a voice when neither the bot nor the workspace has one", () => {
    expect(speakReadiness({ voiceId: "", tts: { configured: true, voice: "" }, personalVoiceAvailable: true }).reason).toBe("no-voice");
  });

  it("treats a Personal Voice workspace default as a Personal Voice", () => {
    expect(speakReadiness({ tts: { configured: false, voice: "personal:mac" }, personalVoiceAvailable: true }).ready).toBe(true);
  });
});

describe("callVoiceReadiness", () => {
  it("offers a call for a bot that only uses a Personal Voice on a Mac with no MiniMax key", () => {
    expect(
      callVoiceReadiness({ voices: ["personal:mac"], tts: noKey, personalVoiceAvailable: true, requireExplicitVoices: false }),
    ).toEqual({ engineAvailable: true, needsHostedEngine: false, ready: true, personalVoiceChosen: true });
  });

  it("hides the call button with no engine at all", () => {
    expect(
      callVoiceReadiness({ voices: ["minimax-warm"], tts: noKey, personalVoiceAvailable: true, requireExplicitVoices: false })
        .engineAvailable,
    ).toBe(false);
    expect(
      callVoiceReadiness({ voices: ["personal:mac"], tts: noKey, personalVoiceAvailable: false, requireExplicitVoices: false })
        .engineAvailable,
    ).toBe(false);
  });

  it("keeps a Personal Voice that cannot speak here from reading as ready", () => {
    const readiness = callVoiceReadiness({
      voices: ["personal:mac"],
      tts: minimax,
      personalVoiceAvailable: false,
      requireExplicitVoices: false,
    });
    expect(readiness.engineAvailable).toBe(true);
    expect(readiness.ready).toBe(false);
    expect(readiness.personalVoiceChosen).toBe(true);
  });

  it("needs the MiniMax key for the hosted members of a mixed room", () => {
    const room = { voices: ["personal:mac", "minimax-warm"], personalVoiceAvailable: true, requireExplicitVoices: true };
    expect(callVoiceReadiness({ ...room, tts: noKey })).toMatchObject({ needsHostedEngine: true, ready: false, engineAvailable: false });
    expect(callVoiceReadiness({ ...room, tts: minimax })).toMatchObject({ needsHostedEngine: true, ready: true, engineAvailable: true });
  });

  it("requires every room member to have a voice of its own", () => {
    expect(
      callVoiceReadiness({ voices: ["minimax-warm", undefined], tts: minimax, personalVoiceAvailable: true, requireExplicitVoices: true })
        .ready,
    ).toBe(false);
  });

  it("lets a single bot fall back to the workspace default voice", () => {
    expect(
      callVoiceReadiness({ voices: [undefined], tts: minimax, personalVoiceAvailable: false, requireExplicitVoices: false }).ready,
    ).toBe(true);
    expect(
      callVoiceReadiness({ voices: [undefined], tts: { configured: true, ready: false, voice: "" }, personalVoiceAvailable: false, requireExplicitVoices: false })
        .ready,
    ).toBe(false);
  });
});

describe("speakButtonState", () => {
  const idle = { status: "idle" as const };
  const base = { tts: noKey, personalVoiceAvailable: true, messageId: "m1", speech: idle };

  it("plays this Mac's Personal Voice without a MiniMax key, using the store's bot over the caller's voice", () => {
    const state = speakButtonState({
      ...base,
      owner: { voice: "minimax-shared", voices: { mac: "personal:mac-voice" } },
      voiceId: "minimax-shared",
    });
    expect(state).toMatchObject({ macVoice: "personal:mac-voice", ready: true, label: "Play (Speak Aloud)" });
  });

  it("says a Personal Voice cannot play where the capability is off", () => {
    const state = speakButtonState({
      ...base,
      personalVoiceAvailable: false,
      owner: { voices: { mac: "personal:mac-voice" } },
    });
    expect(state).toMatchObject({ ready: false, label: PLAY_PERSONAL_UNAVAILABLE });
  });

  it("still needs a voice engine key for a hosted voice, and replays saved clips without one", () => {
    expect(speakButtonState({ ...base, owner: { voice: "minimax-shared" } }).label).toBe(
      "Add a voice engine key in settings to play audio",
    );
    expect(speakButtonState({ ...base, owner: { voice: "minimax-shared" }, hasAudio: true })).toMatchObject({
      ready: true,
      label: "Play Audio",
    });
  });

  it("falls back to the caller's voice when the bot is not in the store", () => {
    expect(speakButtonState({ ...base, tts: minimax, voiceId: "minimax-warm" }).macVoice).toBe("minimax-warm");
  });

  it("carries the reason the last attempt at this message failed, and only on this message", () => {
    const speech = { status: "idle" as const, messageId: "m1", error: "This bot's Personal Voice is not on this Mac." };
    expect(speakButtonState({ ...base, owner: { voices: { mac: "personal:x" } }, speech })).toMatchObject({
      failed: true,
      label: "Play (Speak Aloud) failed: This bot's Personal Voice is not on this Mac.",
    });
    expect(speakButtonState({ ...base, owner: { voice: "minimax-shared" }, hasAudio: true, speech }).label).toBe(
      "Play Audio failed: This bot's Personal Voice is not on this Mac.",
    );
    expect(speakButtonState({ ...base, messageId: "m2", owner: { voices: { mac: "personal:x" } }, speech }).failed).toBe(false);
  });

  it("is a stop button while this message is preparing or speaking", () => {
    const preparing = speakButtonState({ ...base, owner: { voices: { mac: "personal:x" } }, speech: { status: "preparing", messageId: "m1" } });
    expect(preparing).toMatchObject({ mine: true, preparing: true, label: "Stop Speaking" });
    const replaying = speakButtonState({ ...base, tts: minimax, owner: { voice: "minimax-warm" }, hasAudio: true, speech: { status: "speaking", messageId: "m1" } });
    expect(replaying.label).toBe("Stop Audio");
  });
});
