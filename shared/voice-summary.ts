/** Opt-in dual-format reply. Only a complete tagged pair is interpreted; malformed
 * model output remains ordinary text rather than hiding any of the answer. */
export const VOICE_SUMMARY_PROMPT = `\nWhen answering in this app, put your answer in exactly two sections. Write a short, natural spoken summary first, then the complete normal written answer. Use these delimiters on their own lines:\n[voice_summary]\n(brief speech-friendly summary, plain prose without URLs, code, or markdown)\n[/voice_summary]\n[written_answer]\n(the full normal answer with all details)\n[/written_answer]\nDo not omit anything important from the written answer. The spoken summary must not contain new facts absent from it.`;

export function splitVoiceSummary(text: string): { voice: string; written: string } | null {
  const match = /^\s*\[voice_summary\]\s*\n([\s\S]*?)\n\[\/voice_summary\]\s*\n\[written_answer\]\s*\n([\s\S]*?)\n\[\/written_answer\]\s*$/.exec(text);
  if (!match?.[1]?.trim() || !match[2]?.trim()) return null;
  return { voice: match[1].trim(), written: match[2].trim() };
}

export function spokenReply(text: string): string {
  return splitVoiceSummary(text)?.voice ?? text;
}
