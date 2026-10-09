// The fleet's sentence gap, made to survive Zulip's renderer.
//
// Zulip collapses runs of ASCII spaces, so the two spaces the fleet writes
// between sentences would show as one.  `sentenceGap` turns a sentence
// terminator (`.` `!` `?`, then any closing `"` `'` `”` `’` `)` `]` `*` `_`)
// followed by two or more ASCII spaces and a non-space on the same line into
// the terminator, U+00A0 and one space, which renders as a visibly wider gap.
// It is a safety net on every outbound Zulip text (server/zulip/outbound.ts,
// `checkContent`), applied before the secret scan so the scan sees exactly
// what is sent.
//
// Left alone:  single spaces, spaces at a line end, an existing gap, fenced
// code blocks (``` or ~~~, behind indentation, quote or list markers, closed
// by a fence of the same character at least as long, or open to the end),
// inline code spans and $$math$$ (never across a blank line; an opener with
// no closer protects nothing), @-mentions, and a numbered-list marker
// ("1.  Item").  Running it twice changes nothing.
//
// A port of the fleet listener's own function (AFC scripts/agent_sync,
// `sentence_gap`), so a BF bot and a CLI seat put the same text on the realm.

export const SENTENCE_GAP_NBSP = "\u00a0";
const GAP = `${SENTENCE_GAP_NBSP} `;

/** A terminator and its closers, then a run of ASCII spaces before a
 *  non-space.  `[ ]`, not `\s`:  U+00A0 is whitespace to `\s`, and matching
 *  it would stop an existing gap from being left exactly as it is. */
const GAP_RE = /([.!?]["'”’)\]*_]*)( {2,})(?=[^\s])/g;
const LIST_MARKER_PREFIX = /^[ \t>]*\d{1,9}$/;
/** An opening fence, possibly behind indentation, quote and list markers. */
const FENCE_OPEN = /^((?:[ \t]*(?:>|[-+*]|\d{1,9}[.)]))*[ \t]*)(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t\r]*$/;
/** Inline spans, left to right so the earlier opener wins:  a code span, a
 *  $$math$$ span, or an @-mention.  None runs across a blank line. */
const INLINE = /((?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])+?(?<!`)\2(?!`))|(\$\$(?:(?!\n[ \t]*\n)[\s\S])+?\$\$)|(@_?\*{1,2}[^*\n]+\*{1,2})/g;
/** Stands in for a protected character: not whitespace, not a terminator. */
const MASK = "";

type Range = readonly [number, number];

/** Fenced blocks (opening line through closing line, or to the end when
 *  unclosed) and the prose runs between them, as line-aligned ranges. */
function splitFences(text: string): { fenced: Range[]; prose: Range[] } {
  const fenced: Range[] = [];
  const prose: Range[] = [];
  let pos = 0;
  let proseStart = 0;
  let fenceStart = 0;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of text.split("\n")) {
    const end = pos + line.length + 1;
    if (fenceChar) {
      const closer = FENCE_CLOSE.exec(line);
      if (closer && closer[1]![0] === fenceChar && closer[1]!.length >= fenceLen) {
        fenced.push([fenceStart, Math.min(end, text.length)]);
        fenceChar = "";
        proseStart = Math.min(end, text.length);
      }
    } else {
      const opener = FENCE_OPEN.exec(line);
      // A backtick fence whose info string holds a backtick is inline code.
      if (opener && !(opener[2]![0] === "`" && opener[3]!.includes("`"))) {
        if (proseStart < pos) prose.push([proseStart, pos]);
        fenceStart = pos;
        fenceChar = opener[2]![0]!;
        fenceLen = opener[2]!.length;
      }
    }
    pos = end;
  }
  if (fenceChar) fenced.push([fenceStart, text.length]);
  else if (proseStart < text.length) prose.push([proseStart, text.length]);
  return { fenced, prose };
}

/** Every range the gap must not look inside. */
function protectedRanges(text: string): Range[] {
  const { fenced, prose } = splitFences(text);
  const ranges: Range[] = [...fenced];
  for (const [start, end] of prose) {
    for (const match of text.slice(start, end).matchAll(INLINE)) {
      ranges.push([start + match.index, start + match.index + match[0].length]);
    }
  }
  return ranges;
}

/** `text` with each ASCII-space sentence gap turned into U+00A0 plus one
 *  space.  See the header for what is left alone. */
export function sentenceGap(text: string): string {
  if (!text.includes("  ")) return text;
  const masked = text.split("");
  for (const [start, end] of protectedRanges(text)) {
    for (let index = start; index < end; index++) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = MASK;
    }
  }
  let out = "";
  let last = 0;
  for (const match of masked.join("").matchAll(GAP_RE)) {
    const lead = match[1]!;
    const spacesStart = match.index + lead.length;
    if (lead === ".") {
      // "1.  Item" is a list marker, not a sentence.
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      if (LIST_MARKER_PREFIX.test(text.slice(lineStart, match.index))) continue;
    }
    out += text.slice(last, spacesStart) + GAP;
    last = spacesStart + match[2]!.length;
  }
  return last === 0 ? text : out + text.slice(last);
}
