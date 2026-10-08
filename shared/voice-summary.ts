/** Opt-in dual-format reply. Only a complete tagged pair is interpreted; malformed
 * model output remains ordinary text rather than hiding any of the answer. */
export const VOICE_SUMMARY_PROMPT = `\nWhen answering in this app, put your answer in exactly two sections. Write a short, natural spoken summary first, then the complete normal written answer. Use these delimiters on their own lines:\n[voice_summary]\n(brief speech-friendly summary, plain prose without URLs, code, or markdown)\n[/voice_summary]\n[written_answer]\n(the full normal answer with all details)\n[/written_answer]\nDo not omit anything important from the written answer. The spoken summary must not contain new facts absent from it.`;

export type VoiceSummaryMode = "off" | "on_demand" | "always";

/**
 * Resolves the effective voice summary mode for a bot.
 *
 * An explicit voiceSummaryMode ("off" | "on_demand" | "always") always wins.
 * Unset, a bot with voice replies on (speakReplies or speechDevices) is
 * "always": every reply is distilled for speech ahead of time.  A text-only
 * bot is "on_demand": a reply is distilled when it is played.
 *
 * Distilled means the DeepSeek pass (server/tts/speech-summary.ts): the reply
 * rewritten for the ear, with numbers, codes, acronyms and links spelled out
 * and code skipped.  That is what the owner wants spoken (owner correction,
 * 2026-10-08: "Why would I want to spend a bunch of time and energy and money
 * having an llm distill speech to optimize for spoken word if I didn't want
 * to use it", and "I never said I wanted it read word for word").  It
 * reverses #952, which had made "off" the default citing board 8cc3c806.
 * "off" reads the reply as written, through the deterministic speakable
 * pass.  Karaoke
 * follows the main message text in every mode (shared/karaoke-align.ts).
 */
export function resolveVoiceSummaryMode(bot?: {
  voiceSummaryMode?: VoiceSummaryMode;
  speakReplies?: boolean;
  speechDevices?: string[];
} | null): VoiceSummaryMode {
  if (bot?.voiceSummaryMode) return bot.voiceSummaryMode;
  if (bot?.speakReplies || (bot?.speechDevices && bot.speechDevices.length > 0)) {
    return "always";
  }
  return "on_demand";
}

/** What a bot's voice reads: the reply as written ("off": the deterministic
 * speakable pass, span-aligned) or the distilled spoken rewrite (the default).
 * The karaoke highlight follows the message either way; only the written
 * script carries spans to guide it. */
export type VoiceScriptKind = "written" | "summary";

export function voiceScriptKind(bot?: {
  voiceSummaryMode?: VoiceSummaryMode;
  speakReplies?: boolean;
  speechDevices?: string[];
} | null): VoiceScriptKind {
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
