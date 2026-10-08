// Karaoke over the rendered message, without touching its layout.
//
// The words are the message's own DOM text: this walks the text nodes inside a
// rendered message (the `.chat-md` container), tokenizes them with the same
// tokenizer the aligner uses (shared/karaoke-align.ts tokenizeWords), and keeps
// a DOM Range per word.  Highlighting goes through the CSS Custom Highlight API
// (CSS.highlights + ::highlight()), which paints over existing text and never
// changes glyph advances, so lines do not re-wrap and the thread does not jump.
// There is no font-weight change anywhere; "bold" is a text-shadow.
//
// The look, per frame:
//   - words not yet spoken are dimmed (karaoke-ahead);
//   - the current word rolls in left to right at grapheme granularity over its
//     duration in the accent color with a faux-bold shadow (karaoke-current);
//   - words just finished keep a softer accent briefly (karaoke-trail), then
//     return to their normal ink.
// With prefers-reduced-motion the current word steps in whole, there is no
// trail, and words swept past in under 80 ms are never shown as current.
//
// Two ways to drive it:
//   - play(timeline, clock): display-word times known up front (MiniMax clips,
//     from buildKaraokeTimeline); `clock()` returns the playback time in ms.
//   - cue(index, durationMs): live, for Personal Voice, whose ranges arrive as
//     they are spoken.  Jumping ahead sweeps the skipped words quickly.
// Where CSS.highlights is missing, the highlighter still tokenizes but paints
// nothing (`supported` is false).

import "./karaoke-highlight.css";

import { tokenizeWords, type WordToken } from "../../shared/karaoke-align.ts";

export const KARAOKE_HIGHLIGHT_NAMES = {
  ahead: "karaoke-ahead",
  current: "karaoke-current",
  trail: "karaoke-trail",
} as const;

/** Subtrees a voice never reads word by word: fenced code (spoken as "a code
 * block"), controls, and anything marked as decoration or opted out. */
export const KARAOKE_EXCLUDE =
  "pre, script, style, svg, button, input, textarea, select, [aria-hidden='true'], [data-karaoke-skip]";

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL",
  "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
/** Elements that separate the text around them even though they are inline. */
const BREAK_TAGS = new Set(["BR", "IMG", "HR", "WBR"]);

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

export interface DisplayText {
  /** Concatenated text of every readable text node, with "\n" between blocks.
   * This is the `displayText` the aligner wants. */
  text: string;
  words: WordToken[];
  /** Text nodes in order, with their offsets in `text`. */
  nodes: Text[];
  nodeStart: number[];
}

/**
 * Walk a rendered message and collect its readable text.  Text nodes are
 * concatenated as-is (so `**bo**ld` stays one word), with a newline wherever
 * the block changes or a line break sits between them (so "para" and "Next"
 * never merge).  `exclude` subtrees are skipped entirely.
 */
export function collectDisplayText(container: Element, exclude: string = KARAOKE_EXCLUDE): DisplayText {
  const doc = container.ownerDocument;
  const nodes: Text[] = [];
  const nodeStart: number[] = [];
  let text = "";
  let pendingBreak = false;
  let lastBlock: Element | null = null;
  const blockOf = (node: Node): Element => {
    let el = node.parentElement;
    while (el && el !== container) {
      if (BLOCK_TAGS.has(el.tagName.toUpperCase())) return el;
      el = el.parentElement;
    }
    return container;
  };
  const walker = doc.createTreeWalker(container, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === 1 && node !== container) {
        const el = node as Element;
        if (exclude && el.matches(exclude)) {
          pendingBreak = true;
          return FILTER_REJECT;
        }
      }
      return FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (BREAK_TAGS.has((node as Element).tagName.toUpperCase())) pendingBreak = true;
      continue;
    }
    const value = node.nodeValue ?? "";
    if (!value) continue;
    const block = blockOf(node);
    if (text && (pendingBreak || block !== lastBlock)) text += "\n";
    pendingBreak = false;
    lastBlock = block;
    nodes.push(node as Text);
    nodeStart.push(text.length);
    text += value;
  }
  return { text, words: tokenizeWords(text), nodes, nodeStart };
}

/** Node and offset for a position in DisplayText.text.  `edge` picks the
 * node a boundary belongs to: "start" prefers the node that begins there,
 * "end" the node that ends there. */
function locate(display: DisplayText, offset: number, edge: "start" | "end"): [Text, number] | null {
  const { nodes, nodeStart } = display;
  let lo = 0;
  let hi = nodes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = nodeStart[mid];
    if (edge === "start" ? start <= offset : start < offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const node = nodes[found];
  const within = offset - nodeStart[found];
  const length = node.nodeValue?.length ?? 0;
  if (within < 0 || within > length) return null;
  return [node, within];
}

/** A DOM Range over DisplayText.text offsets [start, end). */
export function rangeForOffsets(display: DisplayText, start: number, end: number): Range | null {
  if (!display.nodes.length || end <= start) return null;
  const a = locate(display, start, "start");
  const b = locate(display, end, "end");
  if (!a || !b) return null;
  const range = display.nodes[0].ownerDocument.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  return range;
}

/** Grapheme boundaries inside `text`, as UTF-16 offsets from 0 to length. */
export function graphemeBoundaries(text: string): number[] {
  const out = [0];
  if (typeof Intl.Segmenter === "function") {
    for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      out.push(part.index + part.segment.length);
    }
  } else {
    let i = 0;
    for (const ch of text) {
      i += ch.length;
      out.push(i);
    }
  }
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

// ── environment (injectable for tests) ─────────────────────────────────────

interface HighlightLike {
  priority: number;
  add(range: AbstractRange): void;
  delete(range: AbstractRange): boolean;
  clear(): void;
}

interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  get(name: string): HighlightLike | undefined;
  delete(name: string): boolean;
}

export interface KaraokeEnv {
  highlights: HighlightRegistryLike | null;
  createHighlight: (() => HighlightLike) | null;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  now: () => number;
  prefersReducedMotion: () => boolean;
}

function defaultEnv(): KaraokeEnv {
  const g = globalThis as {
    CSS?: { highlights?: HighlightRegistryLike };
    Highlight?: new () => HighlightLike;
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
    matchMedia?: (query: string) => { matches: boolean };
    performance?: { now(): number };
  };
  const HighlightCtor = g.Highlight;
  return {
    highlights: g.CSS?.highlights ?? null,
    createHighlight: HighlightCtor ? () => new HighlightCtor() : null,
    requestFrame: g.requestAnimationFrame
      ? (cb) => g.requestAnimationFrame!(cb)
      : (cb) => setTimeout(cb, 16) as unknown as number,
    cancelFrame: g.cancelAnimationFrame
      ? (handle) => g.cancelAnimationFrame!(handle)
      : (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    now: () => (g.performance ? g.performance.now() : Date.now()),
    prefersReducedMotion: () => {
      try {
        return Boolean(g.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
      } catch {
        return false;
      }
    },
  };
}

/** True when this document can paint ::highlight() ranges. */
export function supportsKaraokeHighlight(env: Partial<KaraokeEnv> = {}): boolean {
  const merged = { ...defaultEnv(), ...env };
  return Boolean(merged.highlights && merged.createHighlight);
}

// ── the highlighter ────────────────────────────────────────────────────────

export interface KaraokeHighlightOptions {
  /** Selector for subtrees that are not read aloud.  Default KARAOKE_EXCLUDE. */
  exclude?: string;
  /** Force reduced motion on or off; default follows the media query. */
  reducedMotion?: boolean;
  /** Dim words not yet spoken.  Default true. */
  dimAhead?: boolean;
  /** How long a finished word keeps the softer accent.  Default 220 ms. */
  trailMs?: number;
  /** Live mode: sweep step and ceiling for skipped words (as the timeline). */
  skipStepMs?: number;
  skipMaxMs?: number;
  env?: Partial<KaraokeEnv>;
}

export interface KaraokeHighlighter {
  /** False when CSS.highlights is unavailable; every method is then a no-op
   * apart from tokenization. */
  readonly supported: boolean;
  /** The display text and words the aligner should use (same tokenizer). */
  readonly text: string;
  readonly words: readonly WordToken[];
  /** Range over word `index`, or over its UTF-16 slice [from, to). */
  rangeFor(index: number, from?: number, to?: number): Range | null;
  /** Timeline mode.  `timeline` is flat [start0, end0, start1, end1, ...] per
   * display word in ms (buildKaraokeTimeline); `clock()` is playback time in
   * the same ms.  Starts the frame loop. */
  play(timeline: ArrayLike<number>, clock: () => number): void;
  /** Replace the timeline while playing (clip durations became known). */
  setTimeline(timeline: ArrayLike<number>): void;
  /** Live mode: word `index` starts at `atMs` (default: now) and lasts
   * `durationMs`.  Earlier unspoken words are swept quickly first.  Calling it
   * again for the same word extends it.
   *
   * `atMs` is in the highlighter's clock (`now()` of the environment, which
   * is performance.now() in the app).  Personal Voice ranges can arrive in a
   * batch (the main process polls the helper's output), so pass the time the
   * word really started: on the first range take
   * `t0 = performance.now() - range.elapsedMs`, then `atMs = t0 +
   * range.elapsedMs` for every range.  A time in the future is treated as
   * now, and a word never starts before the previous one. */
  cue(index: number, durationMs?: number, atMs?: number): void;
  /** Paint one frame for time `timeMs` (also what the frame loop calls). */
  renderAt(timeMs: number): void;
  /** Index of the word painted as current, or -1. */
  readonly currentIndex: number;
  /** Clear every highlight and stop the frame loop.  play/cue may follow. */
  stop(): void;
  /** stop(), and drop the DOM references. */
  dispose(): void;
}

const LIVE_DEFAULT_MS = 320;
const REDUCED_MOTION_MIN_MS = 80;

export function createKaraokeHighlighter(
  container: Element,
  options: KaraokeHighlightOptions = {},
): KaraokeHighlighter {
  const env: KaraokeEnv = { ...defaultEnv(), ...options.env };
  const display = collectDisplayText(container, options.exclude ?? KARAOKE_EXCLUDE);
  const words = display.words;
  const count = words.length;
  const supported = Boolean(env.highlights && env.createHighlight);
  const reducedMotion = options.reducedMotion ?? env.prefersReducedMotion();
  const dimAhead = options.dimAhead ?? true;
  const trailMs = options.trailMs ?? 220;
  const skipStep = options.skipStepMs ?? 40;
  const skipMax = options.skipMaxMs ?? 320;

  const wordRanges: Array<Range | null | undefined> = Array.from({ length: count }, () => undefined);
  const graphemes: Array<number[] | undefined> = Array.from({ length: count }, () => undefined);
  const wordRange = (index: number): Range | null => {
    if (wordRanges[index] === undefined) {
      const w = words[index];
      wordRanges[index] = rangeForOffsets(display, w.start, w.end);
    }
    return wordRanges[index] ?? null;
  };

  let ahead: HighlightLike | null = null;
  let current: HighlightLike | null = null;
  let trail: HighlightLike | null = null;
  /** Words [aheadFrom, count) have their whole range in `ahead`. */
  let aheadFrom = count;
  let currentParts: Range[] = [];
  let trailRanges: Range[] = [];
  let painted = -1;

  let timeline = new Float64Array(count * 2);
  let clock: (() => number) | null = null;
  let frame: number | null = null;
  let live = false;
  let liveIndex = -1;
  let disposed = false;
  /** The time last painted, and whether the paint is stale anyway (a new
   * timeline, a cue, a reset).  A clock that has not moved since then, as
   * between two clips or while one is paused, paints nothing new, so the
   * frame loop skips the work and the highlight invalidation it costs. */
  let renderedAt = Number.NaN;
  let dirty = true;

  const register = (): void => {
    if (!supported || !env.highlights || !env.createHighlight) return;
    if (!ahead) {
      ahead = env.createHighlight();
      ahead.priority = 1;
      trail = env.createHighlight();
      trail.priority = 2;
      current = env.createHighlight();
      current.priority = 3;
    }
    env.highlights.set(KARAOKE_HIGHLIGHT_NAMES.ahead, ahead);
    env.highlights.set(KARAOKE_HIGHLIGHT_NAMES.trail, trail!);
    env.highlights.set(KARAOKE_HIGHLIGHT_NAMES.current, current!);
  };

  const unregister = (): void => {
    if (!env.highlights) return;
    // Another message may have taken the names since; only remove our own.
    if (ahead && env.highlights.get(KARAOKE_HIGHLIGHT_NAMES.ahead) === ahead) {
      env.highlights.delete(KARAOKE_HIGHLIGHT_NAMES.ahead);
    }
    if (trail && env.highlights.get(KARAOKE_HIGHLIGHT_NAMES.trail) === trail) {
      env.highlights.delete(KARAOKE_HIGHLIGHT_NAMES.trail);
    }
    if (current && env.highlights.get(KARAOKE_HIGHLIGHT_NAMES.current) === current) {
      env.highlights.delete(KARAOKE_HIGHLIGHT_NAMES.current);
    }
  };

  const resetPaint = (): void => {
    dirty = true;
    ahead?.clear();
    trail?.clear();
    current?.clear();
    currentParts = [];
    trailRanges = [];
    painted = -1;
    aheadFrom = count;
    if (dimAhead && ahead) {
      for (let i = 0; i < count; i += 1) {
        const r = wordRange(i);
        if (r) ahead.add(r);
      }
      aheadFrom = 0;
    }
  };

  /** Number of words whose start is at or before t, minus one. */
  const indexAt = (t: number): number => {
    let lo = 0;
    let hi = count - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[2 * mid] <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const renderAt = (t: number): void => {
    if (!supported || !ahead || !current || !trail || disposed) return;
    renderedAt = t;
    dirty = false;
    const c = indexAt(t);
    // Words before c (and c itself) leave the dimmed set as they are reached.
    if (dimAhead) {
      const firstAhead = c + 1;
      if (firstAhead > aheadFrom) {
        for (let i = aheadFrom; i < Math.min(firstAhead, count); i += 1) {
          const r = wordRange(i);
          if (r) ahead.delete(r);
        }
      } else if (firstAhead < aheadFrom) {
        for (let i = firstAhead; i < aheadFrom; i += 1) {
          const r = wordRange(i);
          if (r) ahead.add(r);
        }
      }
      aheadFrom = Math.max(0, Math.min(firstAhead, count));
    }

    for (const r of currentParts) {
      current.delete(r);
      ahead.delete(r);
    }
    currentParts = [];
    painted = -1;
    if (c >= 0) {
      const start = timeline[2 * c];
      const end = timeline[2 * c + 1];
      const duration = end - start;
      const speaking = t < end;
      const showCurrent = speaking && (!reducedMotion || duration >= REDUCED_MOTION_MIN_MS);
      if (showCurrent) {
        const w = words[c];
        let cut = w.end - w.start;
        if (!reducedMotion && duration > 0) {
          const bounds = graphemes[c] ?? (graphemes[c] = graphemeBoundaries(w.text));
          const steps = bounds.length - 1;
          const progress = Math.max(0, Math.min(1, (t - start) / duration));
          // At least the first grapheme is lit as soon as the word starts.
          cut = bounds[Math.max(1, Math.min(steps, Math.ceil(progress * steps)))];
        }
        const lit = rangeForOffsets(display, w.start, w.start + cut);
        if (lit) {
          current.add(lit);
          currentParts.push(lit);
        }
        if (dimAhead && cut < w.end - w.start) {
          const rest = rangeForOffsets(display, w.start + cut, w.end);
          if (rest) {
            ahead.add(rest);
            currentParts.push(rest);
          }
        }
        painted = c;
      }
    }

    for (const r of trailRanges) trail.delete(r);
    trailRanges = [];
    if (!reducedMotion && trailMs > 0) {
      // Recently finished words, newest first; ends never decrease, so stop
      // at the first one that finished too long ago.
      const from = painted === c ? c - 1 : c;
      for (let i = from, n = 0; i >= 0 && n < 8; i -= 1, n += 1) {
        const end = timeline[2 * i + 1];
        if (end > t) continue;
        if (t - end >= trailMs) break;
        const r = wordRange(i);
        if (r) {
          trail.add(r);
          trailRanges.push(r);
        }
      }
    }
  };

  const finishedAt = (t: number): boolean => {
    if (count === 0) return true;
    if (live) return false;
    return t >= timeline[2 * count - 1] + trailMs;
  };

  /** Live mode with nothing left to animate until the next cue: the last
   * cued word and its trail are over.  cue() starts the loop again. */
  const liveIdleAt = (t: number): boolean => live && (liveIndex < 0 || t >= timeline[2 * liveIndex + 1] + trailMs);

  const loop = (): void => {
    frame = null;
    if (!clock || disposed) return;
    const t = clock();
    if (dirty || t !== renderedAt) renderAt(t);
    if (finishedAt(t) || liveIdleAt(t)) return;
    frame = env.requestFrame(loop);
  };

  const ensureLoop = (): void => {
    if (!supported || frame !== null || disposed) return;
    frame = env.requestFrame(loop);
  };

  const setTimeline = (next: ArrayLike<number>): void => {
    timeline = new Float64Array(count * 2);
    for (let i = 0; i < count * 2; i += 1) timeline[i] = i < next.length ? next[i] : Number.POSITIVE_INFINITY;
    dirty = true;
  };

  const stop = (): void => {
    if (frame !== null) env.cancelFrame(frame);
    frame = null;
    clock = null;
    live = false;
    liveIndex = -1;
    ahead?.clear();
    trail?.clear();
    current?.clear();
    currentParts = [];
    trailRanges = [];
    painted = -1;
    aheadFrom = count;
    dirty = true;
    unregister();
  };

  return {
    supported,
    text: display.text,
    words,
    get currentIndex() {
      return painted;
    },
    rangeFor(index, from, to) {
      if (index < 0 || index >= count) return null;
      const w = words[index];
      if (from === undefined && to === undefined) return wordRange(index);
      const a = w.start + Math.max(0, Math.min(from ?? 0, w.end - w.start));
      const b = w.start + Math.max(0, Math.min(to ?? w.end - w.start, w.end - w.start));
      return rangeForOffsets(display, a, b);
    },
    play(next, nextClock) {
      if (disposed) return;
      stop();
      setTimeline(next);
      clock = nextClock;
      register();
      resetPaint();
      ensureLoop();
    },
    setTimeline(next) {
      if (disposed) return;
      setTimeline(next);
      ensureLoop();
    },
    cue(index, durationMs = LIVE_DEFAULT_MS, atMs) {
      if (disposed || index < 0 || index >= count) return;
      const now = env.now();
      if (!live) {
        stop();
        live = true;
        timeline = new Float64Array(count * 2).fill(Number.POSITIVE_INFINITY);
        clock = env.now;
        register();
        resetPaint();
      }
      const duration = Math.max(0, durationMs);
      let at = atMs !== undefined && Number.isFinite(atMs) ? Math.min(now, atMs) : now;
      if (liveIndex >= 0 && index >= liveIndex) at = Math.max(at, timeline[2 * liveIndex]);
      if (index === liveIndex) {
        timeline[2 * index + 1] = Math.max(timeline[2 * index + 1], at + duration);
      } else {
        if (index < liveIndex) {
          // A restart or seek backwards: everything after it is unspoken again.
          for (let i = index; i < count; i += 1) {
            timeline[2 * i] = Number.POSITIVE_INFINITY;
            timeline[2 * i + 1] = Number.POSITIVE_INFINITY;
          }
        } else if (liveIndex >= 0 && timeline[2 * liveIndex + 1] > at) {
          timeline[2 * liveIndex + 1] = at;
        }
        const from = Math.max(0, index < liveIndex ? index : liveIndex + 1);
        const run = index - from;
        const budget = Math.min(skipMax, run * skipStep);
        for (let k = 0; k < run; k += 1) {
          timeline[2 * (from + k)] = at + (budget * k) / run;
          timeline[2 * (from + k) + 1] = at + (budget * (k + 1)) / run;
        }
        timeline[2 * index] = at + budget;
        timeline[2 * index + 1] = at + budget + duration;
        liveIndex = index;
      }
      dirty = true;
      ensureLoop();
    },
    renderAt,
    stop,
    dispose() {
      stop();
      disposed = true;
      wordRanges.fill(null);
      display.nodes.length = 0;
      display.nodeStart.length = 0;
    },
  };
}
