// The workspace pronunciation list: terms the voice keeps saying wrong, and
// how to say them instead (owner ruling, 2026-10-08).  Two fields an entry,
// modeled on the list of words BotFleet should always spell correctly
// (`callStt.keyterms`), and stored the same way: in the workspace config, as
// `tts.pronunciations` (server/config.ts).  A list that was never saved means
// DEFAULT_PRONUNCIATIONS; a saved list, even an empty one, is used as is.
//
// Where it applies (server/tts):
// - The distiller is told to say each term as given, so a distilled script
//   made after a change already reads "sequel" for SQL.  A script stored
//   before the change is reused as it was, with its clips.
// - applyPronunciations() runs on every utterance on its way to a voice
//   engine (server/tts/index.ts speak) and on the utterances an on-device
//   Personal Voice is handed (server/tts/message-audio.ts).  It never touches
//   the stored script, so a list edit never invalidates or re-bills a clip:
//   clips already made keep the sound they were made with, and new
//   synthesis uses the list.
// - Karaoke treats each pair as the same word (shared/karaoke-align.ts), so
//   a spoken "oh auth" lights up "OAuth" on screen.
//
// Matching, the same everywhere:
// - A term is one token (no spaces).  A term made only of letters, digits,
//   marks and underscores matches without case ("json", "Json", "JSON"); a
//   term with any other character ("C#", "%") matches exactly.
// - Whole terms only: a letter or digit at the term's edge may not touch
//   another one, so "JSON" never matches inside "JSONL" or "parseJSON".
// - Never inside a URL, a path, an email address, a file name or a dotted
//   name ("config.json", "src/sql/x.ts", "example.com"), and never inside a
//   MiniMax pause tag (`<#0.3#>`).
// - One left-to-right scan, longest term first, so a replacement is never
//   matched again.  A "say" that contains a term is refused when the list is
//   saved, so applying the list twice is the same as applying it once.

import { z } from "zod";

/** A type alias, not an interface, so a list is plain JSON to the config
 * code (server/schema.ts JsonValue). */
export type Pronunciation = {
  /** The term or symbol as written, e.g. "SQL". */
  term: string;
  /** How the voice should say it, e.g. "sequel". */
  say: string;
};

export const PRONUNCIATIONS_MAX = 200;
export const PRONUNCIATION_TERM_MAX = 48;
export const PRONUNCIATION_SAY_MAX = 120;

/** The seeded list (owner ruling, 2026-10-08): said as words, not letters. */
export const DEFAULT_PRONUNCIATIONS: readonly Pronunciation[] = Object.freeze([
  { term: "JSON", say: "Jason" },
  { term: "SaaS", say: "sass" },
  { term: "SQL", say: "sequel" },
  { term: "REGEX", say: "redge ex" },
  { term: "GUI", say: "gooey" },
  { term: "CAPTCHA", say: "cap cha" },
  { term: "sudo", say: "soo doo" },
  { term: "cron", say: "kron" },
  { term: "OAuth", say: "oh auth" },
].map((entry) => Object.freeze(entry)));

/** The list in force: the saved one, or the seeded defaults when the setting
 * has never been saved. */
export function effectivePronunciations(saved: readonly Pronunciation[] | null | undefined): readonly Pronunciation[] {
  return Array.isArray(saved) ? saved : DEFAULT_PRONUNCIATIONS;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const WORD_TERM = /^[\p{L}\p{M}\p{N}_]+$/u;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** Characters a "say" may not contain: markup a voice engine reads as tags
 * (MiniMax pause tags, sound and IPA parentheses). */
const SAY_FORBIDDEN = /[<>()[\]{}]/;

/** Whether `term` matches without case (letters, digits, marks, `_` only). */
export function isWordTerm(term: string): boolean {
  return WORD_TERM.test(term);
}

/** The code point ending just before UTF-16 index `i`, or "" at the start. */
function charBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

/** The code point starting at UTF-16 index `i`, or "" at the end. */
function charAt(text: string, i: number): string {
  if (i >= text.length) return "";
  const cp = text.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

const isWordChar = (ch: string): boolean => ch !== "" && WORD_CHAR.test(ch);

/** A whitespace-delimited chunk that is a URL, path, email address, file
 * name or dotted name once the matched term is set aside. */
const PROTECTED_CHUNK = /:\/\/|[/\\@]|[\p{L}\p{N}_]\.[\p{L}\p{N}_]/u;
const PAUSE_TAG = /<#[0-9]+(?:\.[0-9]+)?#>/g;

/** One row's shape on the wire, before the rules run.  Callers parse with
 * these at their own boundary (the config schema, the phone's route, the
 * stored file) and hand checkPronunciations typed rows. */
export const PronunciationDraftSchema = z.object({ term: z.string(), say: z.string() }).strict();
export const PronunciationDraftListSchema = z.array(PronunciationDraftSchema);
export type PronunciationDraft = z.infer<typeof PronunciationDraftSchema>;

/** A value read from the config file: JSON, nothing narrower known yet. */
export type StoredJson = string | number | boolean | null | StoredJson[] | { [key: string]: StoredJson };

export interface PronunciationMatch {
  /** UTF-16 offsets of the matched term, end exclusive. */
  start: number;
  end: number;
  /** What replaces it, including any space a symbol term needs. */
  replacement: string;
  entry: Pronunciation;
}

interface Prepared {
  entry: Pronunciation;
  term: string;
  lower: string;
  word: boolean;
  startsWord: boolean;
  endsWord: boolean;
}

function prepare(list: readonly Pronunciation[]): Map<string, Prepared[]> {
  const prepared: Prepared[] = [];
  for (const entry of list) {
    const term = entry?.term ?? "";
    if (!term || !entry.say) continue;
    prepared.push({
      entry,
      term,
      lower: term.toLowerCase(),
      word: isWordTerm(term),
      startsWord: isWordChar(charAt(term, 0)),
      endsWord: isWordChar(charBefore(term, term.length)),
    });
  }
  // Longest first; a stable sort keeps list order between equal lengths.
  prepared.sort((a, b) => b.term.length - a.term.length);
  const byFirst = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const key = p.lower.charAt(0);
    const bucket = byFirst.get(key);
    if (bucket) bucket.push(p);
    else byFirst.set(key, [p]);
  }
  return byFirst;
}

/** The whitespace-delimited chunk around [start, end). */
function chunkAround(text: string, start: number, end: number): [number, number] {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(text[a - 1])) a -= 1;
  while (b < text.length && !/\s/.test(text[b])) b += 1;
  return [a, b];
}

/** Every place `list` rewrites `text`, left to right, never overlapping. */
export function findPronunciations(text: string, list: readonly Pronunciation[]): PronunciationMatch[] {
  if (!text || !list.length) return [];
  return scan(text, prepare(list));
}

function scan(text: string, byFirst: Map<string, Prepared[]>): PronunciationMatch[] {
  const out: PronunciationMatch[] = [];
  if (!text || !byFirst.size) return out;
  const tags: Array<[number, number]> = [];
  for (const m of text.matchAll(PAUSE_TAG)) tags.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  // Chunks are read with the pause tags blanked: a tag is a pause, not part
  // of the word beside it ("SQL<#0.5#>JSON" is two words, not "0.5").
  const plain = tags.length ? text.replace(PAUSE_TAG, (t) => " ".repeat(t.length)) : text;
  let tag = 0;
  let i = 0;
  while (i < text.length) {
    while (tag < tags.length && tags[tag][1] <= i) tag += 1;
    if (tag < tags.length && tags[tag][0] <= i) {
      i = tags[tag][1];
      continue;
    }
    const bucket = byFirst.get(text.charAt(i).toLowerCase());
    let matched: PronunciationMatch | null = null;
    if (bucket) {
      for (const p of bucket) {
        const end = i + p.term.length;
        if (end > text.length) continue;
        const slice = text.slice(i, end);
        if (p.word ? slice.toLowerCase() !== p.lower : slice !== p.term) continue;
        if (tag < tags.length && tags[tag][0] < end) continue;
        const before = charBefore(text, i);
        const after = charAt(text, end);
        if (p.startsWord && isWordChar(before)) continue;
        if (p.endsWord && isWordChar(after)) continue;
        const [c, d] = chunkAround(plain, i, end);
        const probe = `${plain.slice(c, i)}w${plain.slice(end, d)}`;
        if (PROTECTED_CHUNK.test(probe)) continue;
        // A symbol term touching a word ("50%", "C#5") gets its own spaces,
        // so the respelling never runs into the word beside it.
        const say = p.entry.say;
        const lead = !p.startsWord && isWordChar(before) && isWordChar(charAt(say, 0)) ? " " : "";
        const trail = !p.endsWord && isWordChar(after) && isWordChar(charBefore(say, say.length)) ? " " : "";
        matched = { start: i, end, replacement: `${lead}${say}${trail}`, entry: p.entry };
        break;
      }
    }
    if (matched) {
      out.push(matched);
      i = matched.end;
    } else {
      i += 1;
    }
  }
  return out;
}

/** `text` with every term in `list` replaced by how to say it. */
export function applyPronunciations(text: string, list: readonly Pronunciation[]): string {
  return rewrite(text, findPronunciations(text, list));
}

/** A reusable applyPronunciations for many texts against one list. */
export function pronouncer(list: readonly Pronunciation[]): (text: string) => string {
  const byFirst = prepare(list);
  return (text) => rewrite(text, scan(text, byFirst));
}

function rewrite(text: string, matches: readonly PronunciationMatch[]): string {
  if (!matches.length) return text;
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + m.replacement;
    last = m.end;
  }
  return out + text.slice(last);
}

export type PronunciationCheck =
  | { ok: true; list: Pronunciation[] }
  | { ok: false; error: string };

/**
 * The one validator, for Settings on the Mac, the iPhone, and the harness:
 * terms and says trimmed (a say's inner whitespace collapsed), bounded, no
 * duplicate terms (without case), no term with spaces, no say containing a
 * term on the list.  Returns the canonical list or the first problem, in
 * words a person can act on.
 */
export function checkPronunciations(drafts: readonly PronunciationDraft[]): PronunciationCheck {
  if (drafts.length > PRONUNCIATIONS_MAX) {
    return { ok: false, error: `Keep the list to ${PRONUNCIATIONS_MAX} terms or fewer.` };
  }
  const list: Pronunciation[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const term = draft.term.trim();
    const say = draft.say.trim().replace(/\s+/g, " ");
    if (!term) return { ok: false, error: say ? `Add the term that is said as "${say}".` : "A pronunciation is missing its term." };
    if (!say) return { ok: false, error: `Add how to say ${term}.` };
    if (/\s/.test(term)) return { ok: false, error: `${term} has a space.\u00a0 Use one word or symbol for each term.` };
    if (term.length > PRONUNCIATION_TERM_MAX) {
      return { ok: false, error: `${term.slice(0, 24)}… is too long.\u00a0 Keep a term to ${PRONUNCIATION_TERM_MAX} characters.` };
    }
    if (say.length > PRONUNCIATION_SAY_MAX) {
      return { ok: false, error: `How to say ${term} is too long.\u00a0 Keep it to ${PRONUNCIATION_SAY_MAX} characters.` };
    }
    if (CONTROL.test(term) || CONTROL.test(say)) {
      return { ok: false, error: `${term} has a character the voice cannot use.` };
    }
    if (SAY_FORBIDDEN.test(say)) {
      return { ok: false, error: `Say ${term} with words only, without brackets or angle brackets.` };
    }
    if (!/[\p{L}\p{N}]/u.test(say)) return { ok: false, error: `Say ${term} with at least one letter or number.` };
    const key = term.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `${term} is on the list twice.` };
    seen.add(key);
    list.push({ term, say });
  }
  const byFirst = prepare(list);
  for (const entry of list) {
    const inner = scan(entry.say, byFirst)[0];
    if (inner) {
      return {
        ok: false,
        error: `"${entry.say}" for ${entry.term} contains ${inner.entry.term}, which is also on the list.\u00a0 Spell it another way.`,
      };
    }
  }
  return { ok: true, list };
}

/**
 * A stored list read back from disk.  Never throws: entries that would not
 * pass checkPronunciations on their own are dropped, so a hand-edited config
 * keeps every other setting (server/config.ts parseStoredConfig).
 */
export function sanitizeStoredPronunciations(stored: StoredJson | undefined): Pronunciation[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const kept: Pronunciation[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    if (kept.length >= PRONUNCIATIONS_MAX) break;
    const draft = PronunciationDraftSchema.safeParse(raw);
    if (!draft.success) continue;
    const one = checkPronunciations([draft.data]);
    if (!one.ok) continue;
    const entry = one.list[0];
    const key = entry.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  // Removing an entry only removes a term, so one pass drops every say
  // that contains a term and leaves a list checkPronunciations accepts.
  const byFirst = prepare(kept);
  return kept.filter((entry) => scan(entry.say, byFirst).length === 0);
}
