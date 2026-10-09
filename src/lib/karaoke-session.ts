// One message following its own voice: the highlighter over the rendered
// message (src/lib/karaoke-highlight.ts), lined up with the spoken script
// (shared/karaoke-align.ts) and driven by the speaker's karaoke feed
// (src/lib/tts/karaoke-feed.ts).
//
// - Display words are the rendered text, read from the DOM, not the markdown.
// - The script's spans guide the alignment when they index this message's
//   written text (same length as writtenReply(message.text)); otherwise (a
//   distilled script, the default) the aligner anchors on words that occur
//   once on each side and tolerates skipped, added and spelled-out words.
// - A script that does not line up with the message (a brief summary) gets
//   no highlight at all (alignment.followable, shared/karaoke-align.ts).
// - Hosted voice: display-word times come from clip windows, proportional to
//   character offsets within each clip, and the highlighter reads the audio
//   clock every animation frame.  New clip durations re-time the rest.
// - Personal Voice: each reported word is cued as it starts.  Words the voice
//   skipped (a code block, a URL) are swept through quickly by the cue.
// - Nothing pulses on at the start: unspoken words keep their normal ink
//   (dimAhead off), and only the word being spoken rolls in.

import {
  alignSpokenToDisplay,
  buildKaraokeTimeline,
  DEFAULT_MS_PER_CHAR,
  proportionalWordTimes,
  wordIndexAtOffset,
  type KaraokeAlignment,
} from "../../shared/karaoke-align";
import type { Pronunciation } from "../../shared/pronunciations";
import { createKaraokeHighlighter, type KaraokeHighlighter, type KaraokeHighlightOptions } from "./karaoke-highlight";
import type { KaraokeFeed } from "./tts/karaoke-feed";

/** How long the last word keeps its trail after the voice finishes. */
export const KARAOKE_LINGER_MS = 450;
/** A live word's first estimate; the next word's cue cuts it short. */
const LIVE_MIN_MS = 140;

export interface KaraokeSession {
  readonly highlighter: KaraokeHighlighter;
  readonly alignment: KaraokeAlignment | null;
  dispose(): void;
}

export interface AttachKaraokeOptions extends KaraokeHighlightOptions {
  /** setTimeout seam for the linger after a finished reply.  Returns a
   * function that cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The workspace pronunciation list (config tts.pronunciations), so a
   * respelled term pairs with the term on screen. */
  pronunciations?: readonly Pronunciation[] | null;
}

function scheduleTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/**
 * Follow `feed` over the message rendered in `container`.  `sourceText` is
 * the message's written text, writtenReply(message.text): what the script's
 * spans index into.
 */
export function attachKaraoke(
  container: Element,
  feed: KaraokeFeed,
  sourceText: string,
  options: AttachKaraokeOptions = {},
): KaraokeSession {
  const { schedule = scheduleTimeout, pronunciations, ...highlightOptions } = options;
  const highlighter = createKaraokeHighlighter(container, { dimAhead: false, ...highlightOptions });
  let disposed = false;
  let cancelLinger: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    cancelLinger?.();
    highlighter.dispose();
  };

  if (!highlighter.supported || highlighter.words.length === 0 || feed.ended) {
    return { highlighter, alignment: null, dispose };
  }

  const script = feed.script;
  const guided = script.segments.length > 0 && script.sourceLength === sourceText.length;
  const alignment = alignSpokenToDisplay({
    spokenText: script.spokenText,
    displayText: highlighter.text,
    segments: guided ? script.segments : null,
    sourceText: guided ? sourceText : null,
    displayWords: [...highlighter.words],
    pronunciations,
  });
  // Lighting scattered words would be worse than lighting none.
  if (!alignment.followable) return { highlighter, alignment, dispose };
  const { spokenWords, mapping } = alignment;

  const end = (reason: "finished" | "stopped"): void => {
    if (reason === "stopped") return dispose();
    // Let the last word settle instead of vanishing with the voice.
    cancelLinger = schedule(dispose, KARAOKE_LINGER_MS);
  };

  if (feed.mode === "clips") {
    const timeline = () => buildKaraokeTimeline(proportionalWordTimes(spokenWords, feed.clips), mapping);
    highlighter.play(timeline(), feed.clock);
    unsubscribe = feed.subscribe((event) => {
      if (event.type === "clips") highlighter.setTimeline(timeline());
      else if (event.type === "end") end(event.reason);
    });
  } else {
    const cueAt = (offset: number, atMs: number): void => {
      const s = wordIndexAtOffset(spokenWords, offset);
      if (s < 0) return;
      const d = mapping.spokenToDisplay[s];
      if (d < 0) return;
      const word = spokenWords[s];
      highlighter.cue(d, Math.max(LIVE_MIN_MS, (word.end - word.start) * DEFAULT_MS_PER_CHAR), atMs);
    };
    if (feed.lastRange) cueAt(feed.lastRange.offset, feed.lastRange.atMs);
    unsubscribe = feed.subscribe((event) => {
      if (event.type === "range") cueAt(event.offset, event.atMs);
      else if (event.type === "end") end(event.reason);
    });
  }

  return { highlighter, alignment, dispose };
}
