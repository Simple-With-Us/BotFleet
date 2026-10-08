// Karaoke on the main message: which word on screen is being spoken now.
//
// The voice reads a spoken script (shared/speech-spans.ts) that is the message
// with some things skipped ("(a code block)" instead of the code), some things
// added ("a link"), and, from an LLM distiller, sometimes numbers or acronyms
// spelled out ("seven four nine" for 749).  The words on screen come from the
// RENDERED message (DOM text on the Mac, the rendered AttributedString on
// iOS), not from its markdown.  This module pairs the two word lists with a
// monotonic alignment and turns spoken-word times into display-word times:
//
//   - a display word nobody spoke is "skipped" and is swept quickly between
//     its neighbours, the way a reader's eye skips a word;
//   - a spoken word with no display word ("a link") is "inserted" and its time
//     goes to the display word before it.
//
// Spans make it precise: when the script came from speakableWithSpans(), each
// spoken word knows the markdown it came from, the markdown is projected onto
// the rendered words, and the dynamic program only refines inside a narrow band
// around that guess.  Without spans, unique words shared by both sides anchor
// the band instead.
//
// Everything here is pure, deterministic, and integer-scored so the Swift
// mirror (ios/Sources/CompanionCore/KaraokeAlign.swift) reproduces it exactly;
// both read ios/Tests/CompanionCoreTests/Fixtures/karaoke-align.json.  Offsets
// are UTF-16 code units.  Times are milliseconds.

import { sourceOffsetAt, type SpeechSpan } from "./speech-spans.ts";

export interface WordToken {
  /** UTF-16 offsets into the tokenized text, end exclusive. */
  start: number;
  end: number;
  text: string;
  /** Comparison key: compatibility-decomposed, marks and apostrophes removed,
   * lower-cased.  "Don’t" and "dont" share a key; so do "café" and "cafe". */
  key: string;
}

/** A word is a run of letters, marks and digits; an apostrophe between two
 * such runs keeps them one word ("it's").  Hyphens, dots and slashes split,
 * so "twenty-three" is two words and "3.5" is "3" and "5" on both sides. */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['\u2019\u02BC][\p{L}\p{M}\p{N}]+)*/gu;

function isAscii(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) > 0x7f) return false;
  return true;
}

export function wordKey(raw: string): string {
  // ASCII has nothing to decompose and no marks: same result, much cheaper.
  if (isAscii(raw)) return raw.toLowerCase().replace(/'/g, "");
  return raw.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['\u2019\u02BC]/g, "");
}

/** The one tokenizer for spoken text, display text and markdown source.  The
 * Mac highlighter and the Swift mirror use it, so word indices agree. */
export function tokenizeWords(text: string): WordToken[] {
  const out: WordToken[] = [];
  if (!text) return out;
  for (const m of text.matchAll(WORD)) {
    const key = wordKey(m[0]);
    if (!key) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, text: m[0], key });
  }
  return out;
}

// ── numbers ────────────────────────────────────────────────────────────────

const UNITS = new Map<string, number>([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8],
  ["nine", 9],
]);
const TEENS = new Map<string, number>([
  ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16],
  ["seventeen", 17], ["eighteen", 18], ["nineteen", 19],
]);
const TENS = new Map<string, number>([
  ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80],
  ["ninety", 90],
]);
const SCALES = new Map<string, number>([["thousand", 1_000], ["million", 1_000_000], ["billion", 1_000_000_000]]);
const ASCII_DIGITS = /^[0-9]+$/;
const has = (table: Map<string, number>, key: string): boolean => table.has(key);
const value = (table: Map<string, number>, key: string): number => table.get(key) ?? 0;

/** Value of a single word as a decimal string: "749" -> "749", "007" -> "7",
 * "seven" -> "7", "twenty" -> "20".  Null for anything else. */
export function numberKey(key: string): string | null {
  if (ASCII_DIGITS.test(key)) {
    const trimmed = key.replace(/^0+(?=[0-9])/, "");
    return trimmed;
  }
  if (has(UNITS, key)) return String(value(UNITS, key));
  if (has(TEENS, key)) return String(value(TEENS, key));
  if (has(TENS, key)) return String(value(TENS, key));
  return null;
}

/** "seven four nine", "zero oh seven": one digit per word.  "oh" is zero. */
function digitOf(key: string): string | null {
  if (key === "oh") return "0";
  if (has(UNITS, key)) return String(value(UNITS, key));
  if (key.length === 1 && key >= "0" && key <= "9") return key;
  return null;
}

/** Cardinal reading: "seven hundred and forty nine", "twenty three",
 * "two thousand twenty six".  Returns the value or null. */
function parseCardinal(keys: readonly string[]): string | null {
  let total = 0;
  let current = 0;
  let last: "none" | "unit" | "teen" | "tens" | "hundred" | "scale" | "and" = "none";
  for (const key of keys) {
    if (has(UNITS, key) && key !== "zero") {
      if (last !== "none" && last !== "tens" && last !== "hundred" && last !== "scale" && last !== "and") return null;
      current += value(UNITS, key);
      last = "unit";
    } else if (has(TEENS, key)) {
      if (last !== "none" && last !== "hundred" && last !== "scale" && last !== "and") return null;
      current += value(TEENS, key);
      last = "teen";
    } else if (has(TENS, key)) {
      if (last !== "none" && last !== "hundred" && last !== "scale" && last !== "and") return null;
      current += value(TENS, key);
      last = "tens";
    } else if (key === "hundred") {
      if (current <= 0 || current >= 100 || last === "hundred" || last === "and") return null;
      current *= 100;
      last = "hundred";
    } else if (has(SCALES, key)) {
      if (current <= 0 || last === "and") return null;
      total += current * value(SCALES, key);
      current = 0;
      last = "scale";
    } else if (key === "and") {
      if (last !== "hundred" && last !== "scale") return null;
      last = "and";
    } else {
      return null;
    }
  }
  if (last === "none" || last === "and") return null;
  return String(total + current);
}

/** Paired reading: "seven forty nine" (7|49), "twenty twenty six" (20|26),
 * "nineteen eighty four" (19|84), "twenty oh five" (20|05).  Needs at least
 * two groups; every group after the first is two digits. */
function parseGrouped(keys: readonly string[]): string | null {
  let out = "";
  let groups = 0;
  let i = 0;
  while (i < keys.length) {
    const key = keys[i];
    const next = keys[i + 1];
    if (has(TENS, key)) {
      if (next !== undefined && has(UNITS, next) && next !== "zero") {
        out += String(value(TENS, key) + value(UNITS, next));
        i += 2;
      } else {
        out += String(value(TENS, key));
        i += 1;
      }
    } else if (has(TEENS, key)) {
      out += String(value(TEENS, key));
      i += 1;
    } else if (key === "oh" && groups > 0 && next !== undefined && has(UNITS, next) && next !== "zero") {
      out += `0${value(UNITS, next)}`;
      i += 2;
    } else if (groups === 0 && has(UNITS, key) && key !== "zero") {
      out += String(value(UNITS, key));
      i += 1;
    } else {
      return null;
    }
    groups += 1;
  }
  return groups >= 2 ? out : null;
}

const MAX_EXPANSION = 8;

/** For each spoken word, the display keys a run of 2..8 spoken words starting
 * there can stand for, with the run lengths.  Covers digits read one by one,
 * cardinals, paired years, and letters spelled out ("a p i" for "API"). */
function spokenExpansions(words: readonly WordToken[]): Array<Map<string, number[]> | undefined> {
  const out: Array<Map<string, number[]> | undefined> = Array.from({ length: words.length }, () => undefined);
  const add = (i: number, value: string | null, k: number): void => {
    if (value === null) return;
    let map = out[i];
    if (!map) {
      map = new Map();
      out[i] = map;
    }
    const list = map.get(value);
    if (!list) map.set(value, [k]);
    else if (!list.includes(k)) list.push(k);
  };
  for (let i = 0; i < words.length; i += 1) {
    const first = words[i].key;
    const numeric = digitOf(first) !== null || has(TEENS, first) || has(TENS, first);
    const letter = first.length === 1 && !(first >= "0" && first <= "9");
    if (!numeric && !letter) continue;
    let digits = "";
    let digitsOk = true;
    let letters = "";
    let lettersOk = letter;
    const keys: string[] = [first];
    const firstDigit = digitOf(first);
    if (firstDigit === null) digitsOk = false;
    else digits = firstDigit;
    if (lettersOk) letters = first;
    for (let k = 2; k <= MAX_EXPANSION && i + k <= words.length; k += 1) {
      const key = words[i + k - 1].key;
      keys.push(key);
      if (digitsOk) {
        const d = digitOf(key);
        if (d === null) digitsOk = false;
        else {
          digits += d;
          add(i, digits, k);
        }
      }
      if (lettersOk) {
        if (key.length === 1 && !(key >= "0" && key <= "9")) {
          letters += key;
          add(i, letters, k);
        } else {
          lettersOk = false;
        }
      }
      if (numeric) {
        add(i, parseCardinal(keys), k);
        add(i, parseGrouped(keys), k);
      }
    }
  }
  return out;
}

// ── the aligner ───────────────────────────────────────────────────────────

/** How a spoken word was paired.  0 means it was not paired, only attached. */
export const SPOKEN_INSERTED = 0;
export const SPOKEN_EXACT = 1;
export const SPOKEN_EQUIVALENT = 2;
export const SPOKEN_FUZZY = 3;
export const SPOKEN_SUBSTITUTED = 4;
export const SPOKEN_EXPANDED = 5;

export interface KaraokeMapping {
  spokenCount: number;
  displayCount: number;
  /** The display word each spoken word is paired with, or (for an inserted
   * word) attached to: the nearest earlier paired display word, else the
   * nearest later one.  -1 only when nothing on either side pairs. */
  spokenToDisplay: Int32Array;
  /** SPOKEN_* per spoken word. */
  spokenKind: Uint8Array;
  /** First and last spoken word paired with each display word; both -1 when
   * the display word was skipped. */
  displayFirstSpoken: Int32Array;
  displayLastSpoken: Int32Array;
}

interface Params {
  exact: number;
  equivalent: number;
  fuzzy: number;
  substitute: number;
  expand: number;
  /** Cost of a column word nobody in the row list matched. */
  skipCol: number;
  /** Cost of a row word with no column word. */
  insertRow: number;
  numbers: boolean;
  band: number;
}

// Integer scores (tenths) so TypeScript and Swift break ties identically.
const SPOKEN_PARAMS: Params = {
  exact: 30,
  equivalent: 30,
  fuzzy: 15,
  substitute: -6,
  expand: 30,
  skipCol: -3,
  insertRow: -10,
  numbers: true,
  band: 40,
};
const GUIDED_BAND = 16;
// Rendered text is (nearly) a subsequence of the markdown: source words the
// screen does not show (URLs, fence languages) are cheap to skip.
const PROJECTION_PARAMS: Params = {
  exact: 30,
  equivalent: 30,
  fuzzy: 15,
  substitute: -12,
  expand: 30,
  skipCol: -1,
  insertRow: -10,
  numbers: false,
  band: 24,
};

/** The projection's band also widens by however many more words one side
 * has than the other, up to this many.  Source-only words between two
 * anchors pull the path off the straight line by up to their count, and a
 * fixed band then follows the wrong guide.  Fenced code, the usual cause, is
 * taken out before projecting (guideFromSpans), so this only has to cover
 * URLs, image addresses and the like; the cap bounds the work. */
const PROJECTION_EXTRA_BAND_MAX = 1000;
const NEG = -1_000_000_000;

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/** Same first letter, similar length, and either a five-letter common prefix
 * or a small edit distance ("colour"/"color", "analyse"/"analyze"). */
export function fuzzyWordMatch(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  if (a.charCodeAt(0) !== b.charCodeAt(0)) return false;
  if (commonPrefix(a, b) >= 5) return true;
  const limit = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return false;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length] <= limit;
}

/** Longest non-decreasing-column chain of (row, col) anchors already sorted
 * by row (patience sorting, upper bound).  Deterministic. */
function anchorChain(rows: number[], cols: number[]): Array<[number, number]> {
  const n = rows.length;
  const tails: number[] = [];
  const prev = new Int32Array(n);
  for (let a = 0; a < n; a += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cols[tails[mid]] <= cols[a]) lo = mid + 1;
      else hi = mid;
    }
    prev[a] = lo > 0 ? tails[lo - 1] : -1;
    if (lo === tails.length) tails.push(a);
    else tails[lo] = a;
  }
  const chain: Array<[number, number]> = [];
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (at >= 0) {
    chain.push([rows[at], cols[at]]);
    at = prev[at];
  }
  chain.reverse();
  return chain;
}

/** Anchors from words that occur exactly once on each side. */
function uniqueAnchors(rows: readonly WordToken[], cols: readonly WordToken[]): Array<[number, number]> {
  const rowCount = new Map<string, number>();
  const colCount = new Map<string, number>();
  const colAt = new Map<string, number>();
  for (const w of rows) rowCount.set(w.key, (rowCount.get(w.key) ?? 0) + 1);
  cols.forEach((w, j) => {
    colCount.set(w.key, (colCount.get(w.key) ?? 0) + 1);
    colAt.set(w.key, j);
  });
  const anchorRows: number[] = [];
  const anchorCols: number[] = [];
  rows.forEach((w, i) => {
    if (rowCount.get(w.key) === 1 && colCount.get(w.key) === 1) {
      anchorRows.push(i);
      anchorCols.push(colAt.get(w.key)!);
    }
  });
  return anchorChain(anchorRows, anchorCols);
}

function guideAnchors(guide: ArrayLike<number>, rowCount: number, colCount: number): Array<[number, number]> {
  const anchorRows: number[] = [];
  const anchorCols: number[] = [];
  for (let i = 0; i < rowCount && i < guide.length; i += 1) {
    const g = guide[i];
    if (g >= 0 && g < colCount) {
      anchorRows.push(i);
      anchorCols.push(g);
    }
  }
  return anchorChain(anchorRows, anchorCols);
}

interface CoreResult {
  /** Column paired with each row, -1 when the row was inserted. */
  rowToCol: Int32Array;
  rowKind: Uint8Array;
  colFirstRow: Int32Array;
  colLastRow: Int32Array;
}

function alignCore(
  rows: readonly WordToken[],
  cols: readonly WordToken[],
  params: Params,
  anchors: Array<[number, number]>,
  band: number,
): CoreResult {
  const R = rows.length;
  const C = cols.length;
  const rowToCol = new Int32Array(R).fill(-1);
  const rowKind = new Uint8Array(R);
  const colFirstRow = new Int32Array(C).fill(-1);
  const colLastRow = new Int32Array(C).fill(-1);
  if (R === 0 || C === 0) return { rowToCol, rowKind, colFirstRow, colLastRow };

  // Band: interpolate the anchor chain (plus both corners) to a centre column
  // for every row, then widen.  Integer arithmetic only.
  const points: Array<[number, number]> = [[0, 0]];
  for (const [r, c] of anchors) {
    const [lr, lc] = points[points.length - 1];
    if (r > lr && c >= lc && r < R && c < C) points.push([r, c]);
  }
  points.push([R, C]);
  const centreLo = new Int32Array(R + 1);
  const centreHi = new Int32Array(R + 1);
  for (let p = 0; p + 1 < points.length; p += 1) {
    const [r0, c0] = points[p];
    const [r1, c1] = points[p + 1];
    const dr = r1 - r0;
    const dc = c1 - c0;
    for (let i = r0; i <= r1; i += 1) {
      const num = (i - r0) * dc;
      centreLo[i] = c0 + Math.floor(num / dr);
      centreHi[i] = c0 + Math.floor((num + dr - 1) / dr);
    }
  }
  const lo = new Int32Array(R + 1);
  const hi = new Int32Array(R + 1);
  for (let i = 0; i <= R; i += 1) {
    lo[i] = Math.max(0, Math.min(C, centreLo[i] - band));
    hi[i] = Math.max(0, Math.min(C, centreHi[Math.min(i + 1, R)] + band));
  }
  lo[0] = 0;
  hi[R] = C;
  for (let i = R - 1; i >= 0; i -= 1) if (lo[i] > lo[i + 1]) lo[i] = lo[i + 1];
  for (let i = 1; i <= R; i += 1) if (hi[i] < hi[i - 1]) hi[i] = hi[i - 1];

  const offset = new Int32Array(R + 2);
  for (let i = 0; i <= R; i += 1) offset[i + 1] = offset[i] + (hi[i] - lo[i] + 1);
  const total = offset[R + 1];
  const score = new Int32Array(total).fill(NEG);
  const move = new Uint8Array(total);
  const moveK = new Uint8Array(total);
  const at = (i: number, j: number): number => (j < lo[i] || j > hi[i] ? -1 : offset[i] + (j - lo[i]));

  // Intern keys and number values so the inner loop compares integers.
  const ids = new Map<string, number>();
  const intern = (key: string | null): number => {
    if (key === null) return -1;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const rowKey = new Int32Array(R);
  const colKey = new Int32Array(C);
  for (let i = 0; i < R; i += 1) rowKey[i] = intern(rows[i].key);
  for (let j = 0; j < C; j += 1) colKey[j] = intern(cols[j].key);
  const nums = new Map<string, number>();
  const internNum = (value: string | null): number => {
    if (value === null) return -1;
    let id = nums.get(value);
    if (id === undefined) {
      id = nums.size;
      nums.set(value, id);
    }
    return id;
  };
  const rowNum = new Int32Array(R).fill(-1);
  const colNum = new Int32Array(C).fill(-1);
  if (params.numbers) {
    for (let i = 0; i < R; i += 1) rowNum[i] = internNum(numberKey(rows[i].key));
    for (let j = 0; j < C; j += 1) colNum[j] = internNum(numberKey(cols[j].key));
  }
  // Expansions keyed by the display key's id; values no display word has are dropped.
  const expansions: Array<Map<number, number[]> | undefined> = Array.from({ length: R }, () => undefined);
  if (params.numbers) {
    const raw = spokenExpansions(rows);
    for (let i = 0; i < R; i += 1) {
      const table = raw[i];
      if (!table) continue;
      for (const [value, ks] of table) {
        const id = ids.get(value);
        if (id === undefined) continue;
        let byId = expansions[i];
        if (!byId) {
          byId = new Map();
          expansions[i] = byId;
        }
        byId.set(id, ks);
      }
    }
  }
  const classify = (i: number, j: number): number => {
    if (rowKey[i] === colKey[j]) return SPOKEN_EXACT;
    if (rowNum[i] >= 0 && rowNum[i] === colNum[j]) return SPOKEN_EQUIVALENT;
    const a = rows[i].key;
    const b = cols[j].key;
    if (
      a.length >= 4
      && b.length >= 4
      && a.charCodeAt(0) === b.charCodeAt(0)
      && Math.abs(a.length - b.length) <= 2
      && fuzzyWordMatch(a, b)
    ) {
      return SPOKEN_FUZZY;
    }
    return SPOKEN_SUBSTITUTED;
  };
  const kindScore = [0, params.exact, params.equivalent, params.fuzzy, params.substitute];

  for (let i = 0; i <= R; i += 1) {
    const rowLo = lo[i];
    const rowHi = hi[i];
    const base = offset[i] - rowLo;
    const upLo = i > 0 ? lo[i - 1] : 0;
    const upHi = i > 0 ? hi[i - 1] : -1;
    const upBase = i > 0 ? offset[i - 1] - upLo : 0;
    const table = i < R ? expansions[i] : undefined;
    for (let j = rowLo; j <= rowHi; j += 1) {
      const idx = base + j;
      let best = score[idx];
      let bestMove = move[idx];
      if (i === 0 && j === 0) {
        best = 0;
        bestMove = 0;
      }
      if (i > 0 && j > 0 && j - 1 >= upLo && j - 1 <= upHi) {
        const d = score[upBase + j - 1];
        if (d > NEG) {
          const s = d + kindScore[classify(i - 1, j - 1)];
          if (s > best) {
            best = s;
            bestMove = 1;
          }
        }
      }
      if (j > rowLo) {
        const l = score[idx - 1];
        if (l > NEG) {
          const s = l + params.skipCol;
          if (s > best) {
            best = s;
            bestMove = 2;
          }
        }
      }
      if (i > 0 && j >= upLo && j <= upHi) {
        const u = score[upBase + j];
        if (u > NEG) {
          const s = u + params.insertRow;
          if (s > best) {
            best = s;
            bestMove = 3;
          }
        }
      }
      score[idx] = best;
      move[idx] = bestMove;
      // Expansions: k spoken words standing for one display word.
      if (table !== undefined && best > NEG && j < C) {
        const ks = table.get(colKey[j]);
        if (ks) {
          for (const k of ks) {
            if (i + k > R) continue;
            const target = at(i + k, j + 1);
            if (target < 0) continue;
            const s = best + params.expand;
            if (s > score[target]) {
              score[target] = s;
              move[target] = 4;
              moveK[target] = k;
            }
          }
        }
      }
    }
  }

  // Walk back from the far corner.
  let i = R;
  let j = C;
  while (i > 0 || j > 0) {
    const idx = at(i, j);
    const m = idx >= 0 ? move[idx] : 0;
    if (m === 1) {
      rowToCol[i - 1] = j - 1;
      rowKind[i - 1] = classify(i - 1, j - 1);
      i -= 1;
      j -= 1;
    } else if (m === 4) {
      const k = moveK[idx];
      for (let r = i - k; r < i; r += 1) {
        rowToCol[r] = j - 1;
        rowKind[r] = SPOKEN_EXPANDED;
      }
      i -= k;
      j -= 1;
    } else if (m === 2 || (m === 0 && i === 0)) {
      j -= 1;
    } else {
      i -= 1;
    }
  }
  for (let r = 0; r < R; r += 1) {
    const c = rowToCol[r];
    if (c < 0) continue;
    if (colFirstRow[c] < 0) colFirstRow[c] = r;
    colLastRow[c] = r;
  }
  return { rowToCol, rowKind, colFirstRow, colLastRow };
}

/**
 * For each display word, the markdown source word it renders (or -1).
 * Rendered text is nearly a subsequence of the source, so this is an
 * exact-match alignment that skips source-only words (URLs, fence tags,
 * list numbers) cheaply.
 */
export function projectDisplayToSource(displayWords: readonly WordToken[], sourceWords: readonly WordToken[]): Int32Array {
  const extra = Math.min(PROJECTION_EXTRA_BAND_MAX, Math.abs(sourceWords.length - displayWords.length));
  const core = alignCore(
    displayWords,
    sourceWords,
    PROJECTION_PARAMS,
    uniqueAnchors(displayWords, sourceWords),
    PROJECTION_PARAMS.band + extra,
  );
  const out = new Int32Array(displayWords.length);
  for (let d = 0; d < displayWords.length; d += 1) {
    out[d] = core.rowKind[d] === SPOKEN_EXACT || core.rowKind[d] === SPOKEN_FUZZY ? core.rowToCol[d] : -1;
  }
  return out;
}

/** First token whose end is past `offset` (the token containing it, or the
 * next one); tokens.length when none. */
function tokenAtOrAfter(tokens: readonly WordToken[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** speakable()'s fence patterns (server/tts/speech-text.ts), whole match. */
const FENCES = [/```[^\n]*\n[\s\S]*?(?:```|$)/g, /~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g];

/** Source words inside a fenced code block.  The screen never shows them as
 * reply text (the Mac highlighter skips <pre>, iOS drops the block), so they
 * stay out of the projection; the voice names the block instead. */
function fencedWords(sourceText: string, sourceWords: readonly WordToken[]): Uint8Array {
  const fenced = new Uint8Array(sourceWords.length);
  for (const pattern of FENCES) {
    for (const m of sourceText.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      for (let w = tokenAtOrAfter(sourceWords, start); w < sourceWords.length && sourceWords[w].start < end; w += 1) {
        if (sourceWords[w].start >= start) fenced[w] = 1;
      }
    }
  }
  return fenced;
}

/**
 * Expected display word for each spoken word, from the script's spans: the
 * spoken word's source offset, the source word there, and that source word's
 * place on screen.  -1 where nothing on screen corresponds.
 */
export function guideFromSpans(
  spokenWords: readonly WordToken[],
  segments: readonly SpeechSpan[],
  sourceText: string,
  displayWords: readonly WordToken[],
): Int32Array {
  const guide = new Int32Array(spokenWords.length).fill(-1);
  const sourceWords = tokenizeWords(sourceText);
  if (!sourceWords.length || !displayWords.length || !segments.length) return guide;
  // Project onto the words the screen can show, then index back.
  const fenced = fencedWords(sourceText, sourceWords);
  const shown: number[] = [];
  for (let s = 0; s < sourceWords.length; s += 1) if (!fenced[s]) shown.push(s);
  const displayToShown = projectDisplayToSource(displayWords, shown.map((s) => sourceWords[s]));
  // Source word -> display word; a source word that is not on screen takes
  // the next one that is (the code block's words point past the block).
  const sourceToDisplay = new Int32Array(sourceWords.length).fill(-1);
  for (let d = 0; d < displayToShown.length; d += 1) {
    const k = displayToShown[d];
    const s = k >= 0 ? shown[k] : -1;
    if (s >= 0 && sourceToDisplay[s] < 0) sourceToDisplay[s] = d;
  }
  let next = -1;
  for (let s = sourceWords.length - 1; s >= 0; s -= 1) {
    if (sourceToDisplay[s] >= 0) next = sourceToDisplay[s];
    else sourceToDisplay[s] = next;
  }
  spokenWords.forEach((w, i) => {
    const offset = sourceOffsetAt(segments, w.start);
    const s = tokenAtOrAfter(sourceWords, offset);
    guide[i] = s < sourceWords.length ? sourceToDisplay[s] : -1;
  });
  return guide;
}

/**
 * Pair spoken words with display words.  Pass `guide` (expected display index
 * per spoken word, -1 unknown) to narrow the search; without it, words that
 * occur once on each side anchor it.
 */
export function alignWords(
  spokenWords: readonly WordToken[],
  displayWords: readonly WordToken[],
  options: { guide?: ArrayLike<number> | null } = {},
): KaraokeMapping {
  const S = spokenWords.length;
  const D = displayWords.length;
  const guided = Boolean(options.guide);
  const anchors = options.guide
    ? guideAnchors(options.guide, S, D)
    : uniqueAnchors(spokenWords, displayWords);
  const core = alignCore(spokenWords, displayWords, SPOKEN_PARAMS, anchors, guided ? GUIDED_BAND : SPOKEN_PARAMS.band);
  const spokenToDisplay = new Int32Array(S).fill(-1);
  let previous = -1;
  for (let s = 0; s < S; s += 1) {
    if (core.rowToCol[s] >= 0) previous = core.rowToCol[s];
    spokenToDisplay[s] = core.rowToCol[s] >= 0 ? core.rowToCol[s] : previous;
  }
  let following = -1;
  for (let s = S - 1; s >= 0; s -= 1) {
    if (core.rowToCol[s] >= 0) following = core.rowToCol[s];
    else if (spokenToDisplay[s] < 0) spokenToDisplay[s] = following;
  }
  return {
    spokenCount: S,
    displayCount: D,
    spokenToDisplay,
    spokenKind: core.rowKind,
    displayFirstSpoken: core.colFirstRow,
    displayLastSpoken: core.colLastRow,
  };
}

export interface KaraokeAlignment {
  spokenWords: WordToken[];
  displayWords: WordToken[];
  mapping: KaraokeMapping;
  /** True when spans guided the alignment. */
  guided: boolean;
}

/**
 * The whole alignment in one call.
 *
 * - `spokenText`: exactly the text handed to the voice (SpokenScript.text,
 *   or the utterances joined with single spaces, which is the same string).
 * - `displayText`: the rendered message text (the highlighter's `text`).
 * - `segments` + `sourceText`: the script's spans and the markdown they index
 *   into.  Optional; without them the alignment falls back to unique-word
 *   anchors, which is what an LLM-written script gets.
 */
export function alignSpokenToDisplay(input: {
  spokenText: string;
  displayText: string;
  segments?: readonly SpeechSpan[] | null;
  sourceText?: string | null;
  spokenWords?: WordToken[];
  displayWords?: WordToken[];
}): KaraokeAlignment {
  const spokenWords = input.spokenWords ?? tokenizeWords(input.spokenText);
  const displayWords = input.displayWords ?? tokenizeWords(input.displayText);
  const guide = input.segments && input.sourceText
    ? guideFromSpans(spokenWords, input.segments, input.sourceText, displayWords)
    : null;
  const guided = Boolean(guide && guide.some((g) => g >= 0));
  return {
    spokenWords,
    displayWords,
    mapping: alignWords(spokenWords, displayWords, { guide: guided ? guide : null }),
    guided,
  };
}

// ── timing ────────────────────────────────────────────────────────────────

/** About fifteen characters a second, the on-device synthesizer's pace. */
export const DEFAULT_MS_PER_CHAR = 65;

export interface KaraokeTimelineOptions {
  /** Time one skipped display word gets in a sweep. */
  skipStepMs?: number;
  /** Ceiling for a whole run of skipped words. */
  skipMaxMs?: number;
}

/**
 * Display-word times from spoken-word times.
 *
 * `spokenTimes` is flat: [start0, end0, start1, end1, ...] in ms, one pair
 * per spoken word.  Returns the same flat shape per display word.  Starts
 * never decrease, and every display word gets a time: a skipped run is swept
 * in at most `skipMaxMs` just before the next spoken word (borrowing up to
 * half of the previous word when there is no pause to sweep in).
 */
export function buildKaraokeTimeline(
  spokenTimes: ArrayLike<number>,
  mapping: KaraokeMapping,
  options: KaraokeTimelineOptions = {},
): Float64Array {
  const skipStep = options.skipStepMs ?? 40;
  const skipMax = options.skipMaxMs ?? 320;
  const S = mapping.spokenCount;
  const D = mapping.displayCount;
  const out = new Float64Array(D * 2);
  if (D === 0) return out;

  const paired: number[] = [];
  for (let j = 0; j < D; j += 1) {
    const first = mapping.displayFirstSpoken[j];
    if (first < 0) continue;
    paired.push(j);
    out[2 * j] = spokenTimes[2 * first];
    out[2 * j + 1] = spokenTimes[2 * mapping.displayLastSpoken[j] + 1];
  }

  if (paired.length === 0) {
    const t0 = S > 0 ? spokenTimes[0] : 0;
    const t1 = S > 0 ? spokenTimes[2 * S - 1] : 0;
    for (let j = 0; j < D; j += 1) {
      out[2 * j] = t0 + ((t1 - t0) * j) / D;
      out[2 * j + 1] = t0 + ((t1 - t0) * (j + 1)) / D;
    }
    return out;
  }

  // Inserted spoken words lend their time to the word they are attached to.
  for (let s = 0; s < S; s += 1) {
    if (mapping.spokenKind[s] !== SPOKEN_INSERTED) continue;
    const j = mapping.spokenToDisplay[s];
    if (j < 0 || mapping.displayFirstSpoken[j] < 0) continue;
    if (s > mapping.displayLastSpoken[j]) {
      if (spokenTimes[2 * s + 1] > out[2 * j + 1]) out[2 * j + 1] = spokenTimes[2 * s + 1];
    } else if (s < mapping.displayFirstSpoken[j]) {
      if (spokenTimes[2 * s] < out[2 * j]) out[2 * j] = spokenTimes[2 * s];
    }
  }

  // Starts never go backwards, a word never ends before it starts, and a word
  // ends no later than the next one starts.
  for (let p = 0; p < paired.length; p += 1) {
    const j = paired[p];
    if (p > 0) {
      const prev = paired[p - 1];
      if (out[2 * j] < out[2 * prev]) out[2 * j] = out[2 * prev];
      if (out[2 * prev + 1] > out[2 * j]) out[2 * prev + 1] = out[2 * j];
    }
    if (out[2 * j + 1] < out[2 * j]) out[2 * j + 1] = out[2 * j];
  }

  const sweep = (from: number, to: number, startMs: number, endMs: number): void => {
    const run = to - from;
    for (let k = 0; k < run; k += 1) {
      out[2 * (from + k)] = startMs + ((endMs - startMs) * k) / run;
      out[2 * (from + k) + 1] = startMs + ((endMs - startMs) * (k + 1)) / run;
    }
  };

  const firstPaired = paired[0];
  if (firstPaired > 0) {
    const budget = Math.min(skipMax, firstPaired * skipStep);
    sweep(0, firstPaired, out[2 * firstPaired] - budget, out[2 * firstPaired]);
  }
  for (let p = 0; p + 1 < paired.length; p += 1) {
    const before = paired[p];
    const after = paired[p + 1];
    const run = after - before - 1;
    if (run <= 0) continue;
    const budget = Math.min(skipMax, run * skipStep);
    const nextStart = out[2 * after];
    let sweepStart = nextStart - budget;
    const halfway = out[2 * before] + (out[2 * before + 1] - out[2 * before]) / 2;
    if (sweepStart < halfway) sweepStart = halfway;
    if (out[2 * before + 1] > sweepStart) out[2 * before + 1] = sweepStart;
    sweep(before + 1, after, sweepStart, nextStart);
  }
  const lastPaired = paired[paired.length - 1];
  if (lastPaired < D - 1) {
    const run = D - 1 - lastPaired;
    const budget = Math.min(skipMax, run * skipStep);
    sweep(lastPaired + 1, D, out[2 * lastPaired + 1], out[2 * lastPaired + 1] + budget);
  }
  return out;
}

/**
 * Spoken-word times spread over clips by character offset — the MiniMax
 * path, where each utterance is one audio clip with a known (or estimated)
 * duration.  `clips` carry their place in the spoken text (SpokenUtterance
 * spokenStart/spokenEnd) and their playback window.  A word outside every
 * clip inherits the end of the clip before it.
 */
export function proportionalWordTimes(
  spokenWords: readonly WordToken[],
  clips: ReadonlyArray<{ spokenStart: number; spokenEnd: number; startMs: number; durationMs: number }>,
): Float64Array {
  const out = new Float64Array(spokenWords.length * 2);
  let c = 0;
  let carry = clips.length > 0 ? clips[0].startMs : 0;
  for (let i = 0; i < spokenWords.length; i += 1) {
    const w = spokenWords[i];
    while (c < clips.length && clips[c].spokenEnd <= w.start) {
      carry = clips[c].startMs + clips[c].durationMs;
      c += 1;
    }
    const clip = clips[c];
    if (!clip || w.start < clip.spokenStart) {
      out[2 * i] = carry;
      out[2 * i + 1] = carry;
      continue;
    }
    const length = Math.max(1, clip.spokenEnd - clip.spokenStart);
    const from = Math.max(0, w.start - clip.spokenStart);
    const to = Math.min(length, w.end - clip.spokenStart);
    out[2 * i] = clip.startMs + (clip.durationMs * from) / length;
    out[2 * i + 1] = clip.startMs + (clip.durationMs * to) / length;
  }
  return out;
}

/** Estimated playback windows for clips whose real duration is not known
 * yet: `DEFAULT_MS_PER_CHAR` per character, back to back. */
export function estimatedClips(
  utterances: ReadonlyArray<{ spokenStart: number; spokenEnd: number }>,
  msPerChar = DEFAULT_MS_PER_CHAR,
): Array<{ spokenStart: number; spokenEnd: number; startMs: number; durationMs: number }> {
  let t = 0;
  return utterances.map((u) => {
    const durationMs = Math.max(0, u.spokenEnd - u.spokenStart) * msPerChar;
    const clip = { spokenStart: u.spokenStart, spokenEnd: u.spokenEnd, startMs: t, durationMs };
    t += durationMs;
    return clip;
  });
}

/**
 * Index of the spoken word at a UTF-16 offset: the word containing it, else
 * the next word.  -1 past the last word.  Personal Voice reports the range it
 * is about to speak; its location lands on a word start.
 */
export function wordIndexAtOffset(words: readonly WordToken[], offset: number): number {
  const index = tokenAtOrAfter(words, offset);
  return index < words.length ? index : -1;
}
