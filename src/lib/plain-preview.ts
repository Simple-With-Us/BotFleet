// One line of a message, as a person would read it aloud.
//
// A sidebar row shows the tail of a conversation in a single truncated line.
// It was showing the raw source: a bot that wrote `**Inventory done.&nbsp;
// Merge not started.**` appeared in the roster as exactly that, asterisks and
// entity and all.  The entity is the worse half — the house copy rule is that
// the six characters `&nbsp;` must never reach a person's eyes, and the
// sidebar was putting them there on every row a bot had formatted.
//
// This is deliberately not a Markdown parser.  A preview needs the words in
// reading order with the punctuation of the source removed, and a parser
// would bring a tree, a renderer, and a dependency to a job that is a dozen
// substitutions.  It errs toward keeping text: a stray asterisk in a filename
// survives, because showing one is much cheaper than eating a word.

/** HTML entities a model actually writes.  Numeric forms are handled
 * separately; this is the named set worth knowing by heart. */
const ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
} satisfies Record<string, string>;

type EntityName = keyof typeof ENTITIES;

/** `Object.hasOwn` first: a name like `constructor` or `toString` is a real
 * thing a model could write, and indexing straight into the table would hand
 * back a function. */
function lookupEntity(name: string): string | undefined {
  if (!Object.hasOwn(ENTITIES, name)) return undefined;
  // SAFETY: hasOwn just proved `name` is one of this object's own keys.
  return ENTITIES[name as EntityName];
}

function isValidCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 1 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    const known = lookupEntity(name.toLowerCase());
    if (known) return known;
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Markdown's punctuation, removed; the words it decorated, kept. */
export function plainPreview(source: string | undefined | null): string {
  if (!source) return "";
  let text = source;

  // fenced code: the fence and the language tag are not words
  text = text.replace(/```[^\n]*\n?/g, " ").replace(/```/g, " ");
  // images before links — an image's alt text is the only readable part
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // a bare autolink reads better as its URL than as angle brackets
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  // block punctuation at the start of a line: heading, quote, list, rule
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, " ");
  // table pipes: the cells are the content
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, " ");
  text = text.replace(/[ \t]*\|[ \t]*/g, " ");
  // inline emphasis and code, innermost first so `**a *b* c**` unwraps whole
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, "$2");
    text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
    text = text.replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, "$2");
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  }
  text = text.replace(/`+([^`]+)`+/g, "$1");
  // Tags before entities, and the order is the point: `&lt;here&gt;` is text
  // that happens to look like a tag, and decoding first would hand it to the
  // tag stripper to eat.
  text = text.replace(/<\/?[a-zA-Z][^>]{0,120}>/g, " ");
  // a model writing for an HTML surface leaves entities behind
  text = decodeEntities(text);

  // one line, and the wide sentence gap collapses with the rest: a preview
  // is a fragment, and its spacing is the row's, not the message's
  return text.replace(/[\s ]+/g, " ").trim();
}
