// The spoken script, with every character traced back to the message text it
// came from.
//
// server/tts/speech-text.ts `speakable()` turns a reply's markdown into the
// line a voice reads: fences become "(a code block)", links become their
// label, paths become their file name, scaffolding disappears.  Karaoke on the
// main message needs to know, for each spoken word, which part of the message
// produced it.  This module re-runs exactly the same ordered rules, but every
// replacement is applied to a text whose characters each carry the source span
// they came from, so the result is the same string plus a map.
//
// Contract (pinned by shared/speech-spans.test.ts against the real server
// functions over a fixture corpus and a seeded fuzz):
//   speakableWithSpans(x).text                    === speakable(x)
//   utterancesWithSpans(x).map((u) => u.text)    deep-equals toUtterances(x)
//
// Offsets are UTF-16 code units, which is what a JavaScript string index is.
// The Swift mirror (ios/Sources/CompanionCore/SpeechSpans.swift) runs the same
// rules over NSString, which is also UTF-16, and converts to String.Index only
// at its API edge.  Both read the shared fixture
// ios/Tests/CompanionCoreTests/Fixtures/speech-spans.json.
//
// The rules here must stay in lockstep with speakable(): a rule changed there
// and not here fails the parity test rather than drifting silently.

import { findPronunciations, type Pronunciation } from "./pronunciations.ts";

/** `copy`: the spoken characters are the source characters, one for one.
 * `insert`: literal text the rules wrote in place of the source span (it may
 * be empty, e.g. the space that joins two merged utterances). */
export type SpeechSpanKind = "copy" | "insert";

export interface SpeechSpan {
  /** Spoken text offsets (UTF-16), end exclusive. */
  spokenStart: number;
  spokenEnd: number;
  /** Source (message markdown) offsets (UTF-16), end exclusive. */
  srcStart: number;
  srcEnd: number;
  kind: SpeechSpanKind;
}

export interface SpokenScript {
  /** Exactly what speakable() returns for the same input. */
  text: string;
  /** Cover `text` in order with no gaps; source spans never decrease. */
  segments: SpeechSpan[];
}

export interface SpokenUtterance {
  /** Exactly one entry of toUtterances() for the same input. */
  text: string;
  /** Where this utterance sits inside SpokenScript.text (for the same input). */
  spokenStart: number;
  spokenEnd: number;
  /** Spoken offsets here are LOCAL to `text`; source offsets are global. */
  segments: SpeechSpan[];
}

const KIND_COPY = 0;
const KIND_INSERT = 1;

/** A string whose every UTF-16 unit remembers the source span it came from. */
interface Tracked {
  text: string;
  srcStart: number[];
  srcEnd: number[];
  kind: number[];
}

class TrackedBuilder {
  private text = "";
  private readonly srcStart: number[] = [];
  private readonly srcEnd: number[] = [];
  private readonly kind: number[] = [];

  copy(from: Tracked, start: number, end: number): void {
    if (end <= start) return;
    this.text += from.text.slice(start, end);
    for (let i = start; i < end; i += 1) {
      this.srcStart.push(from.srcStart[i]);
      this.srcEnd.push(from.srcEnd[i]);
      this.kind.push(from.kind[i]);
    }
  }

  literal(text: string, srcStart: number, srcEnd: number): void {
    if (!text) return;
    this.text += text;
    for (let i = 0; i < text.length; i += 1) {
      this.srcStart.push(srcStart);
      this.srcEnd.push(srcEnd);
      this.kind.push(KIND_INSERT);
    }
  }

  build(): Tracked {
    return { text: this.text, srcStart: this.srcStart, srcEnd: this.srcEnd, kind: this.kind };
  }
}

function fromSource(text: string): Tracked {
  const n = text.length;
  const srcStart = Array.from({ length: n }, (_, i) => i);
  const srcEnd = Array.from({ length: n }, (_, i) => i + 1);
  const kind = Array.from({ length: n }, () => KIND_COPY);
  return { text, srcStart, srcEnd, kind };
}

/** Source span covered by tracked units [start, end).  An empty range is a
 * point: the end of the unit before it (or the start of the text). */
function spanOf(t: Tracked, start: number, end: number): [number, number] {
  if (end <= start) {
    const point = start > 0 ? t.srcEnd[start - 1] : t.srcStart.length > 0 ? t.srcStart[0] : 0;
    return [point, point];
  }
  let lo = t.srcStart[start];
  let hi = t.srcEnd[start];
  for (let i = start + 1; i < end; i += 1) {
    if (t.srcStart[i] < lo) lo = t.srcStart[i];
    if (t.srcEnd[i] > hi) hi = t.srcEnd[i];
  }
  return [lo, hi];
}

/** One piece of a replacement:
 *  - a string: literal text standing in for the whole match;
 *  - `{ copy: [a, b] }`: the current text's units a..b, mapping kept;
 *  - `{ text, over: [a, b] }`: literal text standing in for units a..b. */
type Part = string | { copy: [number, number] } | { text: string; over: [number, number] };

type RegExpMatchWithIndices = RegExpMatchArray & { index: number; indices: Array<[number, number] | undefined> };

function group(m: RegExpMatchWithIndices, n: number): Part[] {
  const at = m.indices[n];
  return at ? [{ copy: [at[0], at[1]] }] : [];
}

/** String.prototype.replace with a function, but tracked.  `re` must carry the
 * same source and flags as the speakable() rule, plus `g` and `d`. */
function replaceTracked(t: Tracked, re: RegExp, replacer: (m: RegExpMatchWithIndices) => Part[]): Tracked {
  const out = new TrackedBuilder();
  let last = 0;
  for (const raw of t.text.matchAll(re)) {
    // SAFETY: every rule regex carries the `d` flag, so matchAll yields `indices`, and a match always has `index`.
    const m = raw as RegExpMatchWithIndices;
    const start = m.index;
    const end = start + m[0].length;
    out.copy(t, last, start);
    const parts = replacer(m);
    let replacement = "";
    for (const part of parts) {
      if (typeof part === "string") replacement += part;
      else if ("copy" in part) replacement += t.text.slice(part.copy[0], part.copy[1]);
      else replacement += part.text;
    }
    if (replacement === m[0]) {
      // A no-op replacement (one space collapsed to one space) keeps the
      // characters' own mapping, so copied prose stays one long copy span.
      out.copy(t, start, end);
    } else {
      // A bare literal stands in for the matched units between the copy
      // before it and the copy after it, so spans stay in source order (the
      // "." a heading gains maps to the heading's end, not its "##").
      for (let p = 0; p < parts.length; p += 1) {
        const part = parts[p];
        if (typeof part === "string") {
          let gapStart = start;
          for (let q = p - 1; q >= 0; q -= 1) {
            const before = parts[q];
            if (typeof before !== "string" && "copy" in before) {
              gapStart = before.copy[1];
              break;
            }
          }
          let gapEnd = end;
          for (let q = p + 1; q < parts.length; q += 1) {
            const after = parts[q];
            if (typeof after !== "string" && "copy" in after) {
              gapEnd = after.copy[0];
              break;
            }
          }
          const [a, b] = spanOf(t, gapStart, Math.max(gapStart, gapEnd));
          out.literal(part, a, b);
        } else if ("copy" in part) {
          out.copy(t, part.copy[0], part.copy[1]);
        } else {
          const [a, b] = spanOf(t, part.over[0], part.over[1]);
          out.literal(part.text, a, b);
        }
      }
    }
    last = end;
  }
  out.copy(t, last, t.text.length);
  return out.build();
}

function sliceTracked(t: Tracked, start: number, end: number): Tracked {
  return {
    text: t.text.slice(start, end),
    srcStart: t.srcStart.slice(start, end),
    srcEnd: t.srcEnd.slice(start, end),
    kind: t.kind.slice(start, end),
  };
}

/** JavaScript's String.prototype.trim whitespace set, which is exactly `\s`. */
const JS_SPACE = /\s/;

function trimBounds(text: string, start: number, end: number): [number, number] {
  let a = start;
  let b = end;
  while (a < b && JS_SPACE.test(text[a])) a += 1;
  while (b > a && JS_SPACE.test(text[b - 1])) b -= 1;
  return [a, b];
}

function trimTracked(t: Tracked): Tracked {
  const [a, b] = trimBounds(t.text, 0, t.text.length);
  return a === 0 && b === t.text.length ? t : sliceTracked(t, a, b);
}

function joinTracked(left: Tracked, joiner: string, right: Tracked): Tracked {
  const out = new TrackedBuilder();
  out.copy(left, 0, left.text.length);
  const point = left.text.length > 0 ? left.srcEnd[left.text.length - 1] : right.srcStart[0] ?? 0;
  const next = right.text.length > 0 ? right.srcStart[0] : point;
  out.literal(joiner, Math.min(point, next), Math.max(point, next));
  out.copy(right, 0, right.text.length);
  return out.build();
}

function segmentsOf(t: Tracked): SpeechSpan[] {
  const segments: SpeechSpan[] = [];
  let current: SpeechSpan | null = null;
  for (let i = 0; i < t.text.length; i += 1) {
    const kind = t.kind[i] === KIND_COPY ? "copy" : "insert";
    const s = t.srcStart[i];
    const e = t.srcEnd[i];
    const extends_ = current !== null
      && current.kind === kind
      && (kind === "copy" ? current.srcEnd === s : current.srcStart === s && current.srcEnd === e);
    if (current && extends_) {
      current.spokenEnd = i + 1;
      if (kind === "copy") current.srcEnd = e;
    } else {
      current = { spokenStart: i, spokenEnd: i + 1, srcStart: s, srcEnd: e, kind };
      segments.push(current);
    }
  }
  return segments;
}

// ── the rules, in speakable()'s order ──────────────────────────────────────

const SPOKEN_LANGUAGES = new Map<string, string>([
  ["ts", "TypeScript"],
  ["tsx", "TypeScript"],
  ["js", "JavaScript"],
  ["jsx", "JavaScript"],
  ["py", "Python"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["json", "JSON"],
  ["yml", "YAML"],
  ["yaml", "YAML"],
  ["sql", "SQL"],
  ["rs", "Rust"],
  ["go", "Go"],
  ["swift", "Swift"],
  ["diff", "diff"],
]);

/** Identical to speech-text.ts describeCodeBlock. */
function describeCodeBlock(fence: string): string {
  const lang = fence.trim().split(/\s+/)[0]?.replace(/[^a-z0-9+#]/gi, "") ?? "";
  const name = SPOKEN_LANGUAGES.get(lang.toLowerCase());
  return name ? `. (a ${name} code block) ` : ". (a code block) ";
}

const ENDS_SENTENCE = /[.!?:;]\s*$/;

/** The HTML entities a model actually writes, which the chat renders as the
 * character (ChatMarkdown, notify.summarize).  Every no-break-space form
 * becomes a plain space, so the fleet's sentence gap (`.&nbsp; `) is a
 * pause and a sentence boundary instead of the word "nbsp".  One pass, so
 * `&amp;nbsp;` decodes once, to the text `&nbsp;`, as a browser shows it.
 * speakable() (server/tts/speech-text.ts) imports this table; the Swift
 * mirrors (SpeechSpans.swift, SpeechProjection.swift) copy it. */
export const SPOKEN_ENTITY = /&(nbsp|#160|#xa0|amp|lt|gt|quot|apos|#39);/gi;
export function spokenEntity(name: string): string {
  const key = name.toLowerCase();
  if (key === "nbsp" || key === "#160" || key === "#xa0") return " ";
  if (key === "amp") return "&";
  if (key === "lt") return "<";
  if (key === "gt") return ">";
  if (key === "quot") return '"';
  return "'";
}
const SPOKEN_ENTITY_TRACKED = new RegExp(SPOKEN_ENTITY.source, "dgi");

/** speakable()'s emoji and pictograph ranges, including the variation
 * selectors U+FE00-U+FE0F.  Assembled from code points so the class is read
 * as ranges, not as a combining sequence. */
const EMOJI = new RegExp(
  `[${[
    [0x1f000, 0x1faff],
    [0x2600, 0x27bf],
    [0xfe00, 0xfe0f],
    [0x2190, 0x21ff],
    [0x2b00, 0x2bff],
  ]
    .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)
    .join("")}]`,
  "dgu",
);

function speakableTracked(input: string): Tracked {
  let t = fromSource(input);
  if (!input) return t;

  t = replaceTracked(t, /```([^\n]*)\n[\s\S]*?(?:```|$)/dg, (m) => [describeCodeBlock(m[1] ?? "")]);
  t = replaceTracked(t, /~~~([^\n]*)\n[\s\S]*?(?:~~~|$)/dg, (m) => [describeCodeBlock(m[1] ?? "")]);

  t = replaceTracked(t, /!\[([^\]]*)\]\([^)]*\)/dg, (m) =>
    m[1] ? [". (image: ", ...group(m, 1), ") "] : [". (an image) "],
  );
  t = replaceTracked(t, /\[([^\]]+)\]\([^)]*\)/dg, (m) => group(m, 1));
  t = replaceTracked(t, /<https?:\/\/[^>\s]+>/dg, () => [" a link "]);
  t = replaceTracked(t, /\bhttps?:\/\/\S+/dg, () => [" a link "]);

  t = replaceTracked(t, /^\s*\|?[\s:-]*\|[\s|:-]*$/dgm, () => []);
  t = replaceTracked(t, /^\s*\|(.+)\|\s*$/dgm, (m) => {
    const [rowStart, rowEnd] = m.indices[1] ?? [0, 0];
    const text = t.text;
    const cells: Array<[number, number]> = [];
    let cellStart = rowStart;
    for (let i = rowStart; i <= rowEnd; i += 1) {
      if (i === rowEnd || text[i] === "|") {
        const [a, b] = trimBounds(text, cellStart, i);
        if (b > a) cells.push([a, b]);
        cellStart = i + 1;
      }
    }
    const parts: Part[] = [];
    cells.forEach((cell, index) => {
      if (index > 0) parts.push({ text: ", ", over: [cells[index - 1][1], cell[0]] });
      parts.push({ copy: cell });
    });
    return parts;
  });

  t = replaceTracked(t, /`([^`\n]+)`/dg, (m) => ((m[1] ?? "").length <= 40 ? group(m, 1) : [" that snippet "]));

  t = replaceTracked(t, /^\s{0,3}#{1,6}\s+(.*)$/dgm, (m) => {
    const head = m[1] ?? "";
    if (ENDS_SENTENCE.test(head)) return group(m, 1);
    const at = m.indices[1];
    if (!at) return ["."];
    const [a, b] = trimBounds(t.text, at[0], at[1]);
    return [{ copy: [a, b] }, "."];
  });

  t = replaceTracked(t, /^\s*[-*+]\s+/dgm, () => []);
  t = replaceTracked(t, /^\s*\d+[.)]\s+/dgm, () => []);
  t = replaceTracked(t, /^\s*>\s?/dgm, () => []);
  t = replaceTracked(t, /^\s*(?:[-*_]\s*){3,}$/dgm, () => []);

  t = replaceTracked(t, /(\*\*|__)(.*?)\1/dg, (m) => group(m, 2));
  t = replaceTracked(t, /(\*|_)(?=\S)(.*?)(?<=\S)\1/dg, (m) => group(m, 2));
  t = replaceTracked(t, /~~(.*?)~~/dg, (m) => group(m, 1));

  t = replaceTracked(t, /\[[ xX]\]\s*/dg, () => []);

  // shortenPaths
  t = replaceTracked(t, /(?:[\w.@-]+\/){1,}([\w.-]+\.\w{1,6})\b/dg, (m) => group(m, 1));

  t = replaceTracked(t, EMOJI, () => []);

  t = replaceTracked(t, SPOKEN_ENTITY_TRACKED, (m) => [spokenEntity(m[1] ?? "")]);

  t = replaceTracked(t, /\n{2,}/dg, () => [". "]);
  t = replaceTracked(t, /\n/dg, () => [". "]);

  t = replaceTracked(t, /\s+/dg, () => [" "]);
  t = replaceTracked(t, /\s+([.,!?;:])/dg, (m) => group(m, 1));
  t = replaceTracked(t, /(?:\.\s*){2,}/dg, () => [". "]);
  t = replaceTracked(t, /,\s*\./dg, () => ["."]);
  t = trimTracked(t);

  return /[\p{L}\p{N}]/u.test(t.text) ? t : fromSource("");
}

/**
 * speakable(displayText), plus the source span behind every spoken character.
 * `displayText` is the message markdown the speech is made from (for example
 * writtenReply(message.text)).
 */
export function speakableWithSpans(displayText: string): SpokenScript {
  const t = speakableTracked(displayText ?? "");
  return { text: t.text, segments: segmentsOf(t) };
}

/** Identical to speech-text.ts BOUNDARY, plus the `d` flag. */
const BOUNDARY = /(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|No|approx))(?<![.\d])([.!?])(["')\]]*)\s+/dg;

function splitLongTracked(piece: Tracked, maxChars: number): Tracked[] {
  const out: Tracked[] = [];
  let rest = piece;
  while (rest.text.length > maxChars) {
    const window = rest.text.slice(0, maxChars);
    const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" — "));
    const cut = at > maxChars / 2 ? at + 1 : window.lastIndexOf(" ");
    if (cut <= 0) break;
    out.push(trimTracked(sliceTracked(rest, 0, cut)));
    rest = trimTracked(sliceTracked(rest, cut, rest.text.length));
  }
  if (rest.text) out.push(rest);
  return out;
}

/**
 * toUtterances(displayText, options), each utterance with its spans.  The
 * defaults match speech-text.ts (minChars 12, maxChars 320).
 */
export function utterancesWithSpans(
  displayText: string,
  { minChars = 12, maxChars = 320 }: { minChars?: number; maxChars?: number } = {},
): SpokenUtterance[] {
  const script = speakableTracked(displayText ?? "");
  if (!script.text) return [];

  const MARK = "\u0000";
  const marked = replaceTracked(script, BOUNDARY, (m) => {
    const tail = m.indices[2] ?? m.indices[1] ?? [m.index, m.index];
    return [...group(m, 1), ...group(m, 2), { text: MARK, over: [tail[1], m.index + m[0].length] }];
  });

  const rough: Tracked[] = [];
  let pieceStart = 0;
  for (let i = 0; i <= marked.text.length; i += 1) {
    if (i === marked.text.length || marked.text[i] === MARK) {
      const piece = trimTracked(sliceTracked(marked, pieceStart, i));
      if (piece.text) rough.push(piece);
      pieceStart = i + 1;
    }
  }

  const merged: Tracked[] = [];
  for (const piece of rough) {
    const parts = piece.text.length <= maxChars ? [piece] : splitLongTracked(piece, maxChars);
    for (const part of parts) {
      const prev = merged[merged.length - 1];
      if (prev && (prev.text.length < minChars || part.text.length < minChars)) {
        merged[merged.length - 1] = joinTracked(prev, " ", part);
      } else {
        merged.push(part);
      }
    }
  }

  const out: SpokenUtterance[] = [];
  let cursor = 0;
  for (const utterance of merged) {
    const found = script.text.indexOf(utterance.text, cursor);
    const spokenStart = found >= 0 ? found : cursor;
    const spokenEnd = spokenStart + utterance.text.length;
    cursor = found >= 0 ? spokenEnd : cursor;
    out.push({ text: utterance.text, spokenStart, spokenEnd, segments: segmentsOf(utterance) });
  }
  return out;
}

/** Index of the segment covering spoken offset `offset` (the last one that
 * starts at or before it), or -1 for an empty list. */
export function segmentIndexAt(segments: readonly SpeechSpan[], offset: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].spokenStart <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Source offset for a spoken offset.  Inside a copy span it is exact; inside
 * an insert span it is spread proportionally across the replaced source.
 */
export function sourceOffsetAt(segments: readonly SpeechSpan[], spokenOffset: number): number {
  const index = segmentIndexAt(segments, spokenOffset);
  if (index < 0) return 0;
  const seg = segments[index];
  const into = Math.max(0, Math.min(spokenOffset, seg.spokenEnd) - seg.spokenStart);
  if (seg.kind === "copy") return Math.min(seg.srcEnd, seg.srcStart + into);
  const spokenLength = Math.max(1, seg.spokenEnd - seg.spokenStart);
  return seg.srcStart + Math.floor((into * (seg.srcEnd - seg.srcStart)) / spokenLength);
}

// ── the pronunciation list, on a finished utterance ──────────────────────

/** The tracked form of an utterance, rebuilt from its segments (which cover
 * its text in order with no gaps). */
function trackedFromUtterance(u: SpokenUtterance): Tracked {
  const n = u.text.length;
  const srcStart = Array.from({ length: n }, () => -1);
  const srcEnd = Array.from({ length: n }, () => -1);
  const kind = Array.from({ length: n }, () => KIND_INSERT);
  for (const seg of u.segments) {
    for (let i = Math.max(0, seg.spokenStart); i < Math.min(n, seg.spokenEnd); i += 1) {
      if (seg.kind === "copy") {
        srcStart[i] = seg.srcStart + (i - seg.spokenStart);
        srcEnd[i] = srcStart[i] + 1;
        kind[i] = KIND_COPY;
      } else {
        srcStart[i] = seg.srcStart;
        srcEnd[i] = seg.srcEnd;
      }
    }
  }
  // Defensive only: a unit no segment covered points at the end of the one
  // before it, so the spans stay in source order.
  let point = n > 0 && srcStart[0] >= 0 ? srcStart[0] : 0;
  for (let i = 0; i < n; i += 1) {
    if (srcStart[i] < 0) {
      srcStart[i] = point;
      srcEnd[i] = point;
    }
    point = srcEnd[i];
  }
  return { text: u.text, srcStart, srcEnd, kind };
}

/**
 * `u` as the voice should say it: every term on the pronunciation list
 * (shared/pronunciations.ts) replaced by its respelling, with the spans kept
 * valid.  A replaced term becomes one `insert` segment whose source span is
 * the term's own, so karaoke still lands "sequel" on "SQL".  Utterance
 * offsets are not shifted for later utterances; consumers read the local
 * segments, which is all encodeSpokenSpans sends.
 */
export function pronounceUtterance(u: SpokenUtterance, list: readonly Pronunciation[]): SpokenUtterance {
  const matches = findPronunciations(u.text, list);
  if (!matches.length) return u;
  const t = trackedFromUtterance(u);
  const out = new TrackedBuilder();
  let last = 0;
  for (const m of matches) {
    out.copy(t, last, m.start);
    const [a, b] = spanOf(t, m.start, m.end);
    out.literal(m.replacement, a, b);
    last = m.end;
  }
  out.copy(t, last, t.text.length);
  const built = out.build();
  return { text: built.text, spokenStart: u.spokenStart, spokenEnd: u.spokenStart + built.text.length, segments: segmentsOf(built) };
}
