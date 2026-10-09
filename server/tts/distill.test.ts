// distillReply: when a stored distilled script is reused, when it is
// distilled again because the pronunciation list changed, and why a voiced
// reply or a stand-in never replaces it.
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PRONUNCIATIONS, pronunciationsFingerprint, type Pronunciation } from "../../shared/pronunciations.ts";
import { distillReply } from "./distill.ts";
import type { AudioMessage } from "./message-audio.ts";
import type { VoiceSummaryResult } from "./speech-summary.ts";

const REPLY = "Convert the GIF with the CLI, then store it as JSON in the database and tell me when it is done.";
const WITH_GIF: Pronunciation[] = [...DEFAULT_PRONUNCIATIONS, { term: "GIF", say: "jif" }];
const OLD = "Convert the G I F with the C L I, then store it as Jason in the database.";
const NEW = "Convert the jif with the C L I, then store it as Jason in the database.";

function run(row: AudioMessage | undefined, result: VoiceSummaryResult | Error, list: readonly Pronunciation[] = WITH_GIF) {
  const patches: Array<Partial<AudioMessage>> = [];
  const summarize = vi.fn(async (_input: string, _list: readonly Pronunciation[]) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const done = distillReply({
    row,
    text: REPLY,
    pronunciations: list,
    summarize,
    redact: (text) => text,
    patch: (patch) => patches.push(patch),
  });
  return { done, summarize, patches };
}

const stored = (extra: Partial<AudioMessage> = {}): AudioMessage => ({
  id: "m",
  text: REPLY,
  voiceText: OLD,
  voiceTextKind: "summary",
  voiceTextPronunciations: pronunciationsFingerprint(DEFAULT_PRONUNCIATIONS),
  ...extra,
});

describe("distillReply", () => {
  it("distills a first script with the list in force and records that list", async () => {
    const { done, summarize, patches } = run({ id: "m", text: REPLY }, { text: NEW, source: "summary" });
    expect(await done).toEqual({ text: NEW, retry: false });
    expect(summarize).toHaveBeenCalledWith(REPLY, WITH_GIF);
    expect(patches).toEqual([{
      voiceText: NEW,
      voiceTextKind: "summary",
      voiceTextPronunciations: pronunciationsFingerprint(WITH_GIF),
      audio: undefined,
      audioVoice: undefined,
      audioByVoice: undefined,
    }]);
  });

  it("reuses a script made with the list in force, without asking the distiller", async () => {
    const { done, summarize, patches } = run(stored(), { text: NEW, source: "summary" }, DEFAULT_PRONUNCIATIONS);
    expect(await done).toEqual({ text: OLD });
    expect(summarize).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it("distills again when the list changed and no clip was made, so the new term is said", async () => {
    // The owner added GIF after hearing "G I F": the stored script spells it
    // out, which the engine-side pass cannot match.
    const { done, summarize, patches } = run(stored(), { text: NEW, source: "summary" });
    expect(await done).toEqual({ text: NEW, retry: false });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(patches[0]).toMatchObject({ voiceText: NEW, voiceTextPronunciations: pronunciationsFingerprint(WITH_GIF) });
  });

  it("treats a script from before the list as made with no list", async () => {
    const legacy = stored({ voiceTextPronunciations: undefined, voiceTextKind: undefined });
    const empty = run(legacy, { text: NEW, source: "summary" }, []);
    expect(await empty.done).toEqual({ text: OLD });
    expect(empty.summarize).not.toHaveBeenCalled();
    const seeded = run(legacy, { text: NEW, source: "summary" });
    expect(await seeded.done).toEqual({ text: NEW, retry: false });
  });

  it("never distills a voiced reply again, so a list edit bills no clip twice", async () => {
    for (const clips of [
      { audio: [{ path: "/api/attachments/a.mp3", mime: "audio/mpeg" }] },
      { audioByVoice: { other: [{ path: "/api/attachments/b.mp3", mime: "audio/mpeg" }] } },
    ]) {
      const { done, summarize, patches } = run(stored(clips), { text: NEW, source: "summary" });
      expect(await done).toEqual({ text: OLD });
      expect(summarize).not.toHaveBeenCalled();
      expect(patches).toEqual([]);
    }
  });

  it("speaks the older distilled script, never a stand-in, when distilling again does not give a rewrite", async () => {
    const fallback = (reason: VoiceSummaryResult["reason"]): VoiceSummaryResult => ({ text: "Convert the GIF.", source: "fallback", reason });
    // A stand-in that would come back the same settles the older script for
    // this list, so it is not asked for on every play.
    for (const reason of ["no-key", "timeout", "truncated", "incomplete"] as const) {
      const { done, patches } = run(stored(), fallback(reason));
      expect(await done).toEqual({ text: OLD });
      expect(patches).toEqual([{ voiceTextPronunciations: pronunciationsFingerprint(WITH_GIF) }]);
    }
    // A passing failure is asked again next time.
    const passing = run(stored(), fallback("unavailable"));
    expect(await passing.done).toEqual({ text: OLD });
    expect(passing.patches).toEqual([]);
    const thrown = run(stored(), new Error("network down"));
    expect(await thrown.done).toEqual({ text: OLD });
    expect(thrown.patches).toEqual([]);
  });

  it("stores a rewrite that is the reply word for word when it replaces an older script", async () => {
    const { done, patches } = run(stored(), { text: REPLY, source: "summary" });
    expect(await done).toEqual({ text: REPLY, retry: false });
    expect(patches[0]).toMatchObject({ voiceText: REPLY, voiceTextPronunciations: pronunciationsFingerprint(WITH_GIF) });
    // Without an older script it is still not stored, as before.
    const first = run({ id: "m", text: REPLY }, { text: REPLY, source: "summary" });
    expect(await first.done).toEqual({ text: REPLY, retry: false });
    expect(first.patches).toEqual([]);
  });

  it("distills a written-mode script, and falls back to the reply as written when the distiller throws", async () => {
    const written = stored({ voiceTextKind: "written", voiceText: REPLY });
    const ok = run(written, { text: NEW, source: "summary" });
    expect(await ok.done).toEqual({ text: NEW, retry: false });
    const failed = run(written, new Error("down"));
    const answer = await failed.done;
    expect(answer.retry).toBe(true);
    expect(answer.text).toContain("Convert the GIF");
  });
});
