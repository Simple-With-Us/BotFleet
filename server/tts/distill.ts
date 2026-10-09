// The distilled script for one reply: reuse the stored one, or ask the
// distiller (speech-summary.ts) and store what it says.  server/index.ts
// voiceSummaryFor runs this once per reply at a time; message-audio.ts asks
// for it only when reusableSummary() says the stored script will not do.
//
// The pronunciation list (shared/pronunciations.ts) is part of the script:
// the distiller writes each listed term the way the list says, and spells
// every other acronym out letter by letter ("G I F"), which no later pass
// can match.  So each stored script records the list it was made with
// (`voiceTextPronunciations`, a pronunciationsFingerprint), and:
// - A script made with the list in force is reused, as before.
// - A script made with another list (or before the list existed) is
//   distilled again, one DeepSeek call, unless a clip was already made from
//   it.  Distilling again drops every clip list on the row, so a reply that
//   has been voiced keeps its script and its sound, and a list edit never
//   bills MiniMax again.
// - The owner's ruling is that the distilled script is what is spoken, so a
//   stand-in (the distiller has no key, timed out, or cut off) never
//   replaces a distilled script made with an older list.  The older script
//   is spoken instead, and kept as settled for this list unless the failure
//   was a passing one.
import { pronunciationsFingerprint, type Pronunciation } from "../../shared/pronunciations.ts";
import { spokenReply } from "../../shared/voice-summary.ts";
import { isWrittenScript, reusableSummary, type AudioMessage, type SummarizedSpeech } from "./message-audio.ts";
import { deterministicSpokenText, voiceSummaryWorthStoring, type VoiceSummaryResult } from "./speech-summary.ts";

export interface DistillReplyInput {
  /** A fresh read of the stored reply, or undefined if it is gone. */
  row: AudioMessage | undefined;
  /** The reply's text. */
  text: string;
  /** The workspace pronunciation list in force. */
  pronunciations: readonly Pronunciation[];
  /** The distiller (summarizeForVoiceDetailed), handed the redacted reply. */
  summarize(input: string, pronunciations: readonly Pronunciation[]): Promise<VoiceSummaryResult>;
  /** redactSecretsInText. */
  redact(text: string): string;
  patch(patch: Partial<AudioMessage>): void;
}

export async function distillReply(input: DistillReplyInput): Promise<SummarizedSpeech> {
  const { row, text, pronunciations } = input;
  const listName = pronunciationsFingerprint(pronunciations);
  // A distilled script stored before or after karaoke (no voiceTextKind, or
  // "summary") is reused as it is when it was made with this list, or when a
  // clip was made from it: no second paid rewrite, and its clips stay valid.
  // A written-mode script (voiceTextKind "written", the "off" mode, or any
  // reply played while #952 made that the default) is the reply as written,
  // so it is distilled now.
  const reusable = row ? reusableSummary(row, listName) : undefined;
  if (reusable !== undefined) return { text: reusable };
  /** A distilled script made with another list, and no clip made from it. */
  const older = row?.voiceText && row.voiceTextKind !== "written" ? row.voiceText : undefined;
  let summary: VoiceSummaryResult;
  let safeSummary: string;
  try {
    summary = await input.summarize(input.redact(text), pronunciations);
    safeSummary = summary.text ? input.redact(summary.text) : "";
  } catch {
    if (older !== undefined) return { text: older };
    // The deterministic script, as the summarizer's own fallback is, so the
    // karaoke highlight still gets its spans.
    return { text: deterministicSpokenText(spokenReply(text)), retry: true };
  }
  const worthStoring = voiceSummaryWorthStoring(summary);
  if (older !== undefined && (summary.source !== "summary" || !safeSummary)) {
    // Only a real rewrite replaces a distilled script.  A stand-in that would
    // come back the same next time settles the older script for this list,
    // so it is not asked for again on every play; a passing failure does not.
    if (worthStoring) input.patch({ voiceTextPronunciations: listName });
    return { text: older };
  }
  // A rewrite that is the reply word for word is not stored, as before,
  // unless it replaces an older script, which would otherwise be asked for
  // again on every play.
  if (worthStoring && safeSummary && (safeSummary !== text || older !== undefined)) {
    if (safeSummary === row?.voiceText && isWrittenScript(text, safeSummary)) {
      // The very script the stored written-mode clips speak (a short plain
      // reply, or a stand-in, played while #952 was the default or while the
      // distiller was down): keep the clips, and say the text is now settled
      // as the distilled script.
      input.patch({ voiceTextKind: "summary", voiceTextPronunciations: listName });
    } else {
      // Stored clips were made from another script (the written one, or a
      // row's raw text), so they go with it: voiceText always names the
      // script of the clips beside it (server/tts/message-audio.ts).
      input.patch({
        voiceText: safeSummary,
        voiceTextKind: "summary",
        voiceTextPronunciations: listName,
        audio: undefined,
        audioVoice: undefined,
        audioByVoice: undefined,
      });
    }
  }
  // A passing provider failure is spoken now but not kept, so the next play
  // asks the distiller again.
  return { text: safeSummary || deterministicSpokenText(spokenReply(text)), retry: !worthStoring };
}
