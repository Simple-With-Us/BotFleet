// The spoken script a reply's voice reads, as the harness hands it to a
// client for karaoke.
//
// The harness projects a reply into utterances (server/tts/message-audio.ts).
// In the default "written" mode that projection is utterancesWithSpans() over
// writtenReply(message.text): deterministic, never paraphrased (board
// 8cc3c806), and every spoken character carries the span of the message text
// it came from.  A client that asks for them (`spans: true` on POST /audio)
// gets those spans next to the utterances, and uses them to line the voice up
// with the rendered message (shared/karaoke-align.ts).
//
// Wire format (`spans` on the /audio response), version SPOKEN_SPANS_FORMAT:
//   {
//     format: 1,
//     source: "written",          // the spans index writtenReply(message.text)
//     sourceLength: number,       // its length in UTF-16 code units
//     utterances: number[][]      // one entry per `utterances[i]`, in order
//   }
// Each utterance entry is a flat list of quintuples, one per segment:
//   [spokenStart, spokenEnd, srcStart, srcEnd, kind, ...]
// - spokenStart/spokenEnd are UTF-16 offsets LOCAL to `utterances[i]`, end
//   exclusive.
// - srcStart/srcEnd are UTF-16 offsets into the source text, end exclusive.
// - kind is 0 for a copy (spoken text equals the source slice) and 1 for an
//   insert (literal text the rules wrote in place of the source slice, such as
//   "(a code block)").
// All offsets are JavaScript string indices.  The Swift client converts them
// with SpeechSpans.stringRange(utf16:_:in:).
//
// A summary (an explicit Voice Summary mode) carries no spans: karaoke does not
// apply, and the response says `script: "summary"`.

import { utterancesWithSpans, type SpeechSpan, type SpokenUtterance } from "./speech-spans.ts";

export const SPOKEN_SPANS_FORMAT = 1;

/** What a voice reads.  Also stored on the message as `voiceTextKind`, next
 * to the `voiceText` its clips were made from:
 * - "written": voiceText is the exact written-mode script (the utterances
 *   joined with single spaces), span-aligned to the message.
 * - "summary": voiceText is a model summary (an explicit Voice Summary mode).
 * A row without voiceTextKind is from before karaoke; its voiceText may be a
 * model paraphrase or markdown, and it is never used for karaoke. */
export type SpokenScriptKind = "written" | "summary";

export interface SpokenSpansWire {
  format: typeof SPOKEN_SPANS_FORMAT;
  source: "written";
  sourceLength: number;
  utterances: number[][];
}

const KIND_CODE = { copy: 0, insert: 1 } as const;

/** The spans payload for `utterances` made from `sourceText`. */
export function encodeSpokenSpans(sourceText: string, utterances: readonly SpokenUtterance[]): SpokenSpansWire {
  return {
    format: SPOKEN_SPANS_FORMAT,
    source: "written",
    sourceLength: sourceText.length,
    utterances: utterances.map((u) => {
      const flat: number[] = [];
      for (const seg of u.segments) flat.push(seg.spokenStart, seg.spokenEnd, seg.srcStart, seg.srcEnd, KIND_CODE[seg.kind]);
      return flat;
    }),
  };
}

/** Everything a highlighter needs to line a voice up with the message. */
export interface KaraokeScript {
  /** The utterances joined with single spaces: exactly the words voiced, in
   * order.  Personal Voice groups and clip offsets both index into this. */
  spokenText: string;
  /** Where each utterance sits in `spokenText`. */
  utterances: Array<{ spokenStart: number; spokenEnd: number }>;
  /** Spans with spoken offsets in `spokenText` and source offsets in the
   * written reply.  Empty when the spans were absent or did not check out;
   * the aligner then anchors on words that occur once on each side. */
  segments: SpeechSpan[];
  /** Length of the source the spans index, or null without spans.  A client
   * whose own writtenReply(message.text) has another length drops the spans. */
  sourceLength: number | null;
}

/** Utterance offsets in the joined spoken text. */
function layout(utterances: readonly string[]): Array<{ spokenStart: number; spokenEnd: number }> {
  const out: Array<{ spokenStart: number; spokenEnd: number }> = [];
  let at = 0;
  for (const text of utterances) {
    out.push({ spokenStart: at, spokenEnd: at + text.length });
    at += text.length + 1;
  }
  return out;
}

/** Decode and check one utterance's segments; null when anything is off. */
function decodeSegments(flat: unknown, utteranceLength: number, offset: number, sourceLength: number): SpeechSpan[] | null {
  if (!Array.isArray(flat) || flat.length % 5 !== 0) return null;
  const out: SpeechSpan[] = [];
  let lastSpoken = 0;
  let lastSrc = 0;
  for (let i = 0; i < flat.length; i += 5) {
    const [spokenStart, spokenEnd, srcStart, srcEnd, kind] = flat.slice(i, i + 5) as number[];
    const ints = [spokenStart, spokenEnd, srcStart, srcEnd].every((n) => Number.isSafeInteger(n) && n >= 0);
    if (!ints || (kind !== 0 && kind !== 1)) return null;
    if (spokenStart < lastSpoken || spokenEnd < spokenStart || spokenEnd > utteranceLength) return null;
    if (srcStart < lastSrc || srcEnd < srcStart || srcEnd > sourceLength) return null;
    lastSpoken = spokenEnd;
    lastSrc = srcStart;
    out.push({
      spokenStart: spokenStart + offset,
      spokenEnd: spokenEnd + offset,
      srcStart,
      srcEnd,
      kind: kind === 0 ? "copy" : "insert",
    });
  }
  return out;
}

/**
 * The karaoke script for `utterances` as the harness returned them, with the
 * spans when they are present and consistent.  Bad spans are dropped rather
 * than trusted: the highlight then falls back to unguided alignment instead
 * of pointing at the wrong words.
 */
export function karaokeScriptFromWire(utterances: readonly string[], wire?: SpokenSpansWire | null): KaraokeScript {
  const placed = layout(utterances);
  const script: KaraokeScript = { spokenText: utterances.join(" "), utterances: placed, segments: [], sourceLength: null };
  if (!wire || wire.format !== SPOKEN_SPANS_FORMAT || wire.source !== "written") return script;
  if (!Number.isSafeInteger(wire.sourceLength) || wire.sourceLength < 0) return script;
  if (!Array.isArray(wire.utterances) || wire.utterances.length !== utterances.length) return script;
  const segments: SpeechSpan[] = [];
  for (let i = 0; i < utterances.length; i += 1) {
    const decoded = decodeSegments(wire.utterances[i], utterances[i].length, placed[i].spokenStart, wire.sourceLength);
    if (!decoded) return script;
    if (segments.length && decoded.length && decoded[0].srcStart < segments[segments.length - 1].srcStart) return script;
    segments.push(...decoded);
  }
  return { ...script, segments, sourceLength: wire.sourceLength };
}

/**
 * The written-mode script made here instead of by the harness (this Mac
 * speaks a Personal Voice reply itself when the harness cannot be asked).
 * Same rules, same spans.
 */
export function localKaraokeScript(sourceText: string): { utterances: string[]; script: KaraokeScript } {
  const spoken = utterancesWithSpans(sourceText);
  const utterances = spoken.map((u) => u.text);
  return { utterances, script: karaokeScriptFromWire(utterances, encodeSpokenSpans(sourceText, spoken)) };
}
