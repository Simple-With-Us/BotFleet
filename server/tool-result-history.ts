// Oversized tool results in replayed conversation history.
//
// The round that receives a tool result still gets the full text.  Every
// later round would otherwise re-upload that text with the prefix.  Once a
// result is longer than the threshold, the copy kept in the messages array
// becomes a head, a tail, and a pointer.  The full text stays in an artifact
// store and comes back through `read_tool_result`.
//
// `0` turns the replacement off.  Anything else invalid falls back to the
// default, so a bad setting cannot silently disable the cap or pass NaN into
// a slice.

export const DEFAULT_TOOL_RESULT_HISTORY_CHARS = 8_000;

/** The HTTP tool that reads a stored artifact.  HTTP only; the registry
 *  record uses this same name. */
export const READ_TOOL_RESULT_TOOL = "read_tool_result";

const HIGH_SURROGATE = 0xd800;
const LOW_SURROGATE = 0xdc00;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE && code <= 0xdfff;
}

/** First `maxChars` code units, never ending on a lone high surrogate. */
export function takeHead(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length === 0) return "";
  let end = Math.min(text.length, maxChars);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, Math.max(0, end));
}

/** Last `maxChars` code units, never starting on a lone low surrogate. */
export function takeTail(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length === 0) return "";
  let start = Math.max(0, text.length - maxChars);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** `null` leaves every tool result whole. */
export function resolveToolResultHistoryChars(value: number | undefined): number | null {
  if (value === 0) return null;
  if (value === undefined) return DEFAULT_TOOL_RESULT_HISTORY_CHARS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TOOL_RESULT_HISTORY_CHARS;
  return Math.floor(value);
}

/** In-memory full texts for tool results that history now only excerpts.
 *  Newest entries survive when the byte cap is exceeded.  One entry larger
 *  than the cap is kept: dropping it would make the pointer a dead end. */
export class ToolResultArtifactStore {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  put(id: string, text: string): void {
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      this.bytes -= Buffer.byteLength(existing);
      this.entries.delete(id);
    }
    this.entries.set(id, text);
    this.bytes += Buffer.byteLength(text);
    while (this.entries.size > 1 && this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === id) break;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (removed !== undefined) this.bytes -= Buffer.byteLength(removed);
    }
  }

  get(id: string): string | undefined {
    const text = this.entries.get(id);
    if (text === undefined) return undefined;
    this.entries.delete(id);
    this.entries.set(id, text);
    return text;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

let sharedStore: ToolResultArtifactStore | undefined;

/** The store the tool loop writes and `read_tool_result` reads. */
export function sharedToolResultArtifacts(): ToolResultArtifactStore {
  sharedStore ??= new ToolResultArtifactStore();
  return sharedStore;
}

/** Test isolation.  Production turns share one store for the process. */
export function resetSharedToolResultArtifacts(): void {
  sharedStore = new ToolResultArtifactStore();
}

function gapFor(omitted: number): string {
  return `\n…[${omitted} characters omitted]…\n`;
}

/** Head, tail, and the retrieval pointer, at most `threshold` characters. */
export function renderToolResultHistory(text: string, id: string, threshold: number): string {
  const header =
    `[Tool result truncated for later turns. ${text.length} characters stored as artifact ${id}. ` +
    `Call ${READ_TOOL_RESULT_TOOL} with artifact_id "${id}" to retrieve the full text.]\n`;
  if (header.length >= threshold) return takeHead(header, threshold);
  const room = threshold - header.length;
  const maxGap = gapFor(Math.max(0, text.length - 1)).length;
  const contentRoom = Math.max(0, room - maxGap);
  let head = takeHead(text, Math.ceil(contentRoom / 2));
  let tail = takeTail(text, Math.floor(contentRoom / 2));
  if (head.length + tail.length >= text.length) {
    return header + takeHead(text, room);
  }
  const join = () => {
    const omitted = text.length - head.length - tail.length;
    const gap = omitted > 0 ? gapFor(omitted) : "";
    return header + head + gap + tail;
  };
  let out = join();
  while (out.length > threshold && (head.length > 0 || tail.length > 0)) {
    if (tail.length >= head.length && tail.length > 0) tail = takeTail(tail, tail.length - 1);
    else head = takeHead(head, head.length - 1);
    out = join();
  }
  return out.length > threshold ? takeHead(out, threshold) : out;
}

export interface DeliveredToolMessage {
  role: string;
  content: string;
  tool_call_id?: string;
}

/** Replace tool results in `messages[0, deliveredUntil)` that are over the
 *  threshold.  The full text is stored under the tool call id first, so a
 *  later `read_tool_result` still returns what the model already saw. */
export function compactDeliveredToolResults(
  messages: DeliveredToolMessage[],
  deliveredUntil: number,
  opts: { threshold: number; store: ToolResultArtifactStore },
): number {
  const end = Math.max(0, Math.min(messages.length, deliveredUntil));
  let count = 0;
  for (let i = 0; i < end; i++) {
    const message = messages[i];
    if (message.role !== "tool" || message.content.length <= opts.threshold) continue;
    const id = message.tool_call_id?.trim() ? message.tool_call_id : `tool-result-${i}`;
    opts.store.put(id, message.content);
    message.content = renderToolResultHistory(message.content, id, opts.threshold);
    count += 1;
  }
  return count;
}

export interface ToolResultRead {
  ok: true;
  text: string;
  /** Length of the stored artifact, not of `text` when a window was asked for. */
  chars: number;
}

/** The full stored artifact, or a character window of it. */
export function readToolResultArtifact(
  id: string,
  opts?: { offset?: number; limit?: number; store?: ToolResultArtifactStore },
): ToolResultRead | { ok: false; message: string } {
  const store = opts?.store ?? sharedToolResultArtifacts();
  const text = store.get(id);
  if (text === undefined) {
    return { ok: false, message: `No stored tool result for artifact ${id}.` };
  }
  const offset = opts?.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, message: "offset must be a non-negative integer." };
  }
  if (offset > text.length) {
    return { ok: false, message: `offset ${offset} is past the end of the ${text.length}-character artifact.` };
  }
  let end = text.length;
  if (opts?.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      return { ok: false, message: "limit must be a positive integer." };
    }
    end = Math.min(text.length, offset + opts.limit);
  }
  const start = offset > 0 && isLowSurrogate(text.charCodeAt(offset)) ? offset + 1 : offset;
  if (end < text.length && end > start && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { ok: true, text: text.slice(start, end), chars: text.length };
}
