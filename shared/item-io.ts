// The full input and output of one step, kept OUT of the transcript.
//
// A tool row in the chat carries a headline: a clipped target and one clipped
// line of what came back (`shared/tool-activity.ts`).  That is deliberate —
// the renderer holds every message of every thread, and a 5 MB `read_file`
// result on each of them is the shape of the 35.7 MB routines.json incident.
// But a person who opens a step wants the real thing: the JSON the model
// passed and the text the tool returned.
//
// So the full payload lives in a per-thread side store (server/item-io-store.ts)
// keyed by the step's item id, bounded per field and per thread, and is
// fetched only when a row is opened.  This module is the vocabulary both
// halves share: the bounded-text shape, the per-field cap, and the pure
// functions that turn whatever an engine handed us into text.
//
// Nothing here redacts.  Redaction is the store's job (it runs the same pass
// the wire and the event log use, at write AND at read), because it has to
// happen exactly once per destination and never depend on which driver built
// the capture.

/** Longest field the side store keeps, in UTF-16 units.  Generous enough for a
 * whole source file or a long command's output, small enough that a thread of
 * a few hundred steps stays in a few megabytes. */
export const ITEM_IO_FIELD_LIMIT = 32 * 1024;

/** What a driver hands the bus: a little PAST the stored limit.  Redaction
 * shortens masked text, so the store needs a margin to still fill the limit
 * after masking, and a secret that straddles the stored limit is seen whole by
 * the redactor before the final cut. */
export const ITEM_IO_CAPTURE_LIMIT = ITEM_IO_FIELD_LIMIT + 4 * 1024;

/** One captured field.  `length` is the original size in UTF-16 units, so a
 * reader can say "showing the first 32,768 of 2,410,118". */
export interface BoundedText {
  text: string;
  /** more existed than `text` holds */
  truncated: boolean;
  length: number;
}

/** What a driver attaches to an event (`RuntimeEventBase.io`).  Never
 * forwarded: the bus moves it into the side store and strips it, so neither
 * the wire nor the event log ever carries it. */
export interface ItemIoCapture {
  /** the arguments the model passed, pretty-printed when they were JSON */
  input?: BoundedText;
  /** the text the tool returned */
  output?: BoundedText;
  /** the full text of an injected context record (`context.injected`) */
  text?: BoundedText;
}

/** What `GET /api/threads/:id/items/:itemId/io` answers. */
export interface ItemIoPayload {
  itemId: string;
  turnId?: string;
  /** when the newest record was written, ISO */
  at: string;
  input?: BoundedText;
  output?: BoundedText;
  text?: BoundedText;
}

/** Cut `value` to `limit` UTF-16 units without ending on the first half of a
 * surrogate pair — a lone half renders as a replacement glyph. */
export function cutText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit);
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** `text` bounded to `limit`, with the facts a reader needs to say it was. */
export function boundText(text: string, limit: number = ITEM_IO_CAPTURE_LIMIT): BoundedText {
  if (text.length <= limit) return { text, truncated: false, length: text.length };
  return { text: cutText(text, limit), truncated: true, length: text.length };
}

function pretty(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value, null, 2);
    // JSON.stringify answers undefined for a function or a bare undefined
    return typeof json === "string" ? json : undefined;
  } catch {
    // a cycle, or a BigInt: better a plain string than no record at all
    try {
      return String(value);
    } catch {
      return undefined;
    }
  }
}

/** The arguments of a step as text.  A string that is JSON — OpenAI-shaped
 * arguments arrive as one — is re-indented so it reads as the object it is;
 * any other string is kept verbatim; an object is pretty-printed.  Empty and
 * absent inputs answer undefined: a tool that took no arguments has no IN
 * block worth showing. */
export function inputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // Only a whole object or array is worth re-indenting.  A bare string
    // that happens to be a number or `true` is still just that string.
    // A multi-megabyte argument string is kept verbatim: parsing it on the
    // event path to re-indent text that is about to be cut would cost more
    // than the row is worth.
    const wholeValue =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (wholeValue && trimmed.length <= ITEM_IO_CAPTURE_LIMIT * 4) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        // a fragment of arguments still streaming in: show it as it is
        return value;
      }
    }
    return value;
  }
  const text = pretty(value);
  return text === "{}" || text === "[]" ? undefined : text;
}

/** Fields an engine puts a result's text under, in the order a reader would
 * expect them — the same list `describeResult` walks for its one line. */
const RESULT_FIELDS = ["text", "content", "output", "stdout", "message", "result", "value"] as const;

function blockText(block: unknown, depth: number): string | undefined {
  if (block === undefined || block === null) return undefined;
  if (typeof block === "string") return block;
  if (typeof block === "number" || typeof block === "boolean") return String(block);
  if (depth > 6 || typeof block !== "object") return undefined;
  if (Array.isArray(block)) {
    const parts: string[] = [];
    for (const entry of block) {
      const found = blockText(entry, depth + 1);
      if (found) parts.push(found);
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  const record = block as Record<string, unknown>;
  if (record.type === "image") return "[image]";
  // a diff block names its file and carries both sides; the new text is what
  // the step produced
  if (record.type === "diff" && typeof record.newText === "string") {
    const path = typeof record.path === "string" ? `${record.path}\n` : "";
    return `${path}${record.newText}`;
  }
  for (const field of RESULT_FIELDS) {
    const found = blockText(record[field], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** What a step returned, as text.  Claude's `tool_result` content blocks, ACP
 * `content` arrays, Codex's aggregated output and a bare string all land as
 * the text a person would read; a shape with no text in it is shown as the
 * JSON it is rather than hidden. */
export function outputText(content: unknown): string | undefined {
  const text = blockText(content, 0);
  if (text !== undefined) return text.length > 0 ? text : undefined;
  if (content === undefined || content === null) return undefined;
  const fallback = pretty(content);
  return fallback === "{}" || fallback === "[]" ? undefined : fallback;
}

/** `{ io: { input } }` for a step's arguments, or `{}` when there were none.
 * Spread into an `item.started` event. */
export function captureInput(value: unknown): { io?: ItemIoCapture } {
  const text = inputText(value);
  return text === undefined ? {} : { io: { input: boundText(text) } };
}

/** `{ io: { output } }` for a step's result, or `{}` when it returned nothing.
 * Spread into an `item.completed` event. */
export function captureOutput(content: unknown): { io?: ItemIoCapture } {
  const text = outputText(content);
  return text === undefined ? {} : { io: { output: boundText(text) } };
}

/** Both halves, for an `item.completed` that carries the settled arguments
 * beside the result. */
export function captureBoth(input: unknown, content: unknown): { io?: ItemIoCapture } {
  const inText = inputText(input);
  const outText = outputText(content);
  if (inText === undefined && outText === undefined) return {};
  return {
    io: {
      ...(inText !== undefined ? { input: boundText(inText) } : {}),
      ...(outText !== undefined ? { output: boundText(outText) } : {}),
    },
  };
}
