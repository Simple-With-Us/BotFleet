// The per-reply voice-clip bound is the only guard on the work one reply can
// cause.  The Personal Voice path returns early — before synthesis, before a
// MiniMax key, before anything that would naturally stop it — and forwards the
// whole reply text into a spawned helper process, so the bound has to be
// evaluated above that early return or a Personal Voice owner gets an
// unbounded spawn that a MiniMax owner would have been refused.
//
// The route's rules live in server/tts/message-audio.ts, where
// message-audio.test.ts exercises them against fakes.  This file pins the
// ORDER of the three checks in the source as well, because the order is what
// regressed before and a reordering can still pass a behavioral test that
// happens not to cover it:
//   1. the clip bound (413),
//   2. the Personal Voice early return (on-device speech, no key needed),
//   3. the hosted-voice credential check (409).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_SPEAKABLE_CHARS, MAX_UTTERANCES, MAX_UTTERANCES_PROGRESSIVE, MessageAudio } from "./message-audio.ts";
import { toUtterances } from "./speech-text.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "message-audio.ts"), "utf8");

/** The POST body: from the utterance split to the synthesis job. */
function postSource(): string {
  const start = source.indexOf("const utterances = toUtterances(textToSpeak);");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("this.ensureJob(", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Personal Voice reply bounds", () => {
  it("evaluates the clip bound before the Personal Voice early return", () => {
    const route = postSource();
    const bound = route.indexOf("reply exceeds voice clip limit");
    const personalVoice = route.indexOf("isPersonalVoiceId(voice)");
    expect(bound).toBeGreaterThan(-1);
    expect(personalVoice).toBeGreaterThan(-1);
    expect(bound).toBeLessThan(personalVoice);
  });

  it("returns Personal Voice speech before the hosted-voice credential check", () => {
    const route = postSource();
    const personalVoice = route.indexOf("isPersonalVoiceId(voice)");
    const credential = route.indexOf("this.deps.credentialPending()");
    expect(credential).toBeGreaterThan(-1);
    expect(personalVoice).toBeLessThan(credential);
  });

  it("keeps the empty-reply rejection in force for every voice owner", () => {
    const route = postSource();
    const emptyBound = route.indexOf("!utterances.length");
    const personalVoice = route.indexOf("isPersonalVoiceId(voice)");
    expect(emptyBound).toBeGreaterThan(-1);
    expect(emptyBound).toBeLessThan(personalVoice);
    // The empty check must reject, not soft-return: a 200 sends `voiceText`
    // to the on-device speaker.
    expect(route.slice(emptyBound, personalVoice)).toMatch(/status: 413/);
    expect(route.match(/reply exceeds voice clip limit/g)).toHaveLength(1);
  });

  it("refuses an over-long reply for a Personal Voice owner, legacy or progressive", async () => {
    const tooManyUtterances = Array.from({ length: MAX_UTTERANCES_PROGRESSIVE + 10 }, (_, i) => `Sentence number ${i} here.`).join(" ");
    expect(toUtterances(tooManyUtterances).length).toBeGreaterThan(MAX_UTTERANCES_PROGRESSIVE);
    const tooLong = "word ".repeat(MAX_SPEAKABLE_CHARS + 100);
    expect(toUtterances(tooLong).join(" ").length).toBeGreaterThan(MAX_SPEAKABLE_CHARS);

    for (const text of [tooManyUtterances, tooLong]) {
      const audio = new MessageAudio({
        message: () => ({ id: "m", text }),
        patchMessage: () => {},
        summarize: async (_t, _m, value) => value,
        speak: () => Promise.reject(new Error("must not synthesize")),
        saveClip: () => ({ path: "/api/attachments/x.mp3", mime: "audio/mpeg" }),
        clipExists: () => false,
        readClip: () => null,
        defaultVoice: () => "",
        credentialPending: () => false,
        isNoVoiceConfigured: () => false,
      });
      for (const body of [{}, { progressive: true }]) {
        const result = await audio.post({ threadId: "t", messageId: "m", owner: { voice: "personal:x", voiceSummaryMode: "off" }, body });
        expect(result.status).toBe(413);
      }
    }
    expect(MAX_UTTERANCES).toBeLessThan(MAX_UTTERANCES_PROGRESSIVE);
  });
});
