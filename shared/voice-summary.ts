/** Opt-in dual-format reply. Only a complete tagged pair is interpreted; malformed
 * model output remains ordinary text rather than hiding any of the answer. */
export const VOICE_SUMMARY_PROMPT = `\nWhen answering in this app, put your answer in exactly two sections. Write a short, natural spoken summary first, then the complete normal written answer. Use these delimiters on their own lines:\n[voice_summary]\n(brief speech-friendly summary, plain prose without URLs, code, or markdown)\n[/voice_summary]\n[written_answer]\n(the full normal answer with all details)\n[/written_answer]\nDo not omit anything important from the written answer. The spoken summary must not contain new facts absent from it.`;

export type VoiceSummaryMode = "off" | "on_demand" | "always";

/**
 * Resolves the effective voice summary mode for a bot.
 *
 * Unset means "off": the voice reads the reply as written, through the
 * deterministic speakable pass (code blocks named, links by their label,
 * markdown dropped), so the spoken words line up with the message on screen
 * and the karaoke highlight can follow them.  The owner's ruling (board
 * 8cc3c806) is that the speech pass may not paraphrase or summarize, so a
 * model-written summary is only ever spoken when the owner picked one for the
 * bot: an explicit "on_demand" (summarize when played) or "always" (summarize
 * every reply ahead of time).
 */
export function resolveVoiceSummaryMode(bot?: {
  voiceSummaryMode?: VoiceSummaryMode;
} | null): VoiceSummaryMode {
  return bot?.voiceSummaryMode ?? "off";
}

/** What a bot's voice reads: the reply as written (span-aligned, so karaoke
 * applies) or a model-written summary (no karaoke). */
export type VoiceScriptKind = "written" | "summary";

export function voiceScriptKind(bot?: { voiceSummaryMode?: VoiceSummaryMode } | null): VoiceScriptKind {
  return resolveVoiceSummaryMode(bot) === "off" ? "written" : "summary";
}

/**
 * Strips bracketed voice summary tags and sections so written display
 * smoothly renders only the clean, normal written answer with zero brackets.
 * Protocol delimiters are only stripped when the reply begins with the protocol
 * structure, preventing incidental mentions in ordinary code/text from being truncated.
 */
export function stripVoiceSummaryTags(text: string): string {
  if (!text) return "";
  const split = splitVoiceSummary(text);
  if (split) return split.written;

  let clean = text;
// Only interpret when message begins with the protocol delimiter
  if (/^\s*\[voice_summary\]/i.test(clean)) {
    // If [written_answer] exists, prioritize everything after [written_answer]
    // The section runs to the final closing tag, so a literal "[/written_answer]" quoted
    // inside the answer does not cut the rest of it off.
    const writtenMatch = /\[written_answer\]([\s\S]*?)(?:\[\/written_answer\]\s*)?$/i.exec(clean);
    if (writtenMatch) {
      clean = writtenMatch[1];
    } else {
      // Otherwise, strip out [voice_summary]...[/voice_summary] block if present
      clean = clean.replace(/^\s*\[voice_summary\][\s\S]*?(?:\[\/voice_summary\]\s*|$)/i, "");
    }
    clean = clean
      .replace(/\[\/?voice_summary\]/gi, "")
      .replace(/\[\/?written_answer\]/gi, "")
      .trim();
    return clean || text;
  }

  return text;
}

export function writtenReply(text: string): string {
  if (!text) return "";
  const split = splitVoiceSummary(text);
  if (split) return split.written;
  return stripVoiceSummaryTags(text);
}

export function splitVoiceSummary(text: string): { voice: string; written: string } | null {
  if (!text) return null;
  const match = /\[voice_summary\]\s*([\s\S]*?)\s*\[\/voice_summary\]\s*\[written_answer\]\s*([\s\S]*?)(?:\[\/written_answer\])?\s*$/i.exec(text);
  if (!match?.[1]?.trim() || !match[2]?.trim()) return null;
  const voice = match[1].replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
  const written = match[2].replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
  if (!voice || !written) return null;
  return { voice, written };
}

export function spokenReply(text: string): string {
  if (!text) return "";
  const split = splitVoiceSummary(text);
  if (split) return split.voice;
  // If only [voice_summary] was partially produced, extract content inside tags
  const partialVoice = /\[voice_summary\]\s*([\s\S]*?)(?:\[\/voice_summary\]|\[written_answer\]|$)/i.exec(text);
  if (partialVoice?.[1]?.trim()) {
    return partialVoice[1].replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
  }
  // Fall back to clean text without any bracket tags
  return text.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
}
