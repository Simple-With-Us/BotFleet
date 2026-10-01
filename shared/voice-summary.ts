/** Opt-in dual-format reply. Only a complete tagged pair is interpreted; malformed
 * model output remains ordinary text rather than hiding any of the answer. */
export const VOICE_SUMMARY_PROMPT = `\nWhen answering in this app, put your answer in exactly two sections. Write a short, natural spoken summary first, then the complete normal written answer. Use these delimiters on their own lines:\n[voice_summary]\n(brief speech-friendly summary, plain prose without URLs, code, or markdown)\n[/voice_summary]\n[written_answer]\n(the full normal answer with all details)\n[/written_answer]\nDo not omit anything important from the written answer. The spoken summary must not contain new facts absent from it.`;

/**
 * Strips bracketed voice summary tags and sections so written display
 * smoothly renders only the clean, normal written answer with zero brackets.
 */
export function stripVoiceSummaryTags(text: string): string {
  if (!text) return "";
  let clean = text;
  // If [written_answer] exists, prioritize everything after [written_answer]
  const writtenMatch = /\[written_answer\]([\s\S]*?)(\[\/written_answer\]|$)/i.exec(clean);
  if (writtenMatch) {
    clean = writtenMatch[1];
  } else {
    // Otherwise, strip out [voice_summary]...[/voice_summary] block if present
    clean = clean.replace(/^\s*\[voice_summary\][\s\S]*?(?:\[\/voice_summary\]\s*|$)/i, "");
  }
  // Strip any remaining bracket delimiters
  clean = clean
    .replace(/\[\/?voice_summary\]/gi, "")
    .replace(/\[\/?written_answer\]/gi, "")
    .trim();
  return clean || text.replace(/\[\/?(?:voice_summary|written_answer)\]/gi, "").trim();
}

export function splitVoiceSummary(text: string): { voice: string; written: string } | null {
  if (!text) return null;
  const match = /\[voice_summary\]\s*([\s\S]*?)\s*\[\/voice_summary\]\s*\[written_answer\]\s*([\s\S]*?)(?:\[\/written_answer\]|\s*$)/i.exec(text);
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
