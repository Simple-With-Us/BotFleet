// The inspector's data: what a thread's turn actually looked like on the
// wire. Nothing new is captured here — the harness already tees two logs
// per thread, and this just reads them back:
//
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream the bus
//                               publishes (server/harness/bus.ts)
//   native/<threadId>.ndjson  — the provider's own protocol messages,
//                               verbatim and secret-redacted
//                               (server/drivers/native.ts)
//
// Each log is capped and rotated (server/transcript-retention.ts), so a
// thread's history is the live file plus at most one `.ndjson.1` beside it,
// and the tail read here spans both.
//
// Merged by timestamp so a tool call and the raw message behind it sit
// next to each other. Newest-`limit` only: a long-lived thread has
// thousands of native lines and the panel wants the recent ones first.
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "./contracts.ts";
import { rotatedPath } from "./transcript-retention.ts";

/** One line of native/<threadId>.ndjson (server/drivers/native.ts). */
export interface NativeRecord {
  at: string;
  dir: "in" | "out";
  source: string;
  msg: unknown;
}

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: RuntimeEvent }
  | { kind: "native"; at: string; data: NativeRecord };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
const READ_CHUNK = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
/** How far back the single-record fallback looks for a line boundary.  This
 * bounds the SEARCH, never a parse: the fallback deserializes a record only
 * when it fits inside the tail window, and reports a placeholder otherwise.
 * Matches the largest a log can be after retention
 * (server/transcript-retention.ts), so the scan is bounded by the file rather
 * than by hope. */
const MAX_RECORD_SCAN_BYTES = 64 * 1024 * 1024;

interface LineCount {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  complete: number;
  trailing: boolean;
}
type FileStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;

// Counts are incremental per append-only log. The first request scans bytes
// once (without decoding or parsing every JSON record); later requests inspect
// only bytes appended since the cached size. Keep this bounded across threads.
const lineCounts = new Map<string, LineCount>();
const LINE_COUNT_CACHE_MAX = 256;

/** Thread ids are uuids the harness minted; anything else is not a file we
 * should be reading. */
function assertThreadId(threadId: string) {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

function countLines(fd: number, file: string, stat: FileStat): number {
  const previous = lineCounts.get(file);
  const appended =
    previous &&
    previous.dev === stat.dev &&
    previous.ino === stat.ino &&
    stat.size >= previous.size &&
    (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  // A torn final line is not counted: both writers append a record and its
  // newline in one call, so bytes after the last newline are a document cut in
  // half, not a record the panel could ever show.
  if (appended && stat.size === previous.size) return previous.complete;

  let offset = appended ? previous.size : 0;
  let complete = appended ? previous.complete : 0;
  let trailing = appended ? previous.trailing : false;
  while (offset < stat.size) {
    const length = Math.min(READ_CHUNK, stat.size - offset);
    const chunk = Buffer.allocUnsafe(length);
    const read = readSync(fd, chunk, 0, length, offset);
    if (read <= 0) break;
    for (let i = 0; i < read; i++) {
      if (chunk[i] === 0x0a) {
        if (trailing) complete++;
        trailing = false;
      } else if (chunk[i] !== 0x0d) {
        trailing = true;
      }
    }
    offset += read;
  }
  const next = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, complete, trailing };
  lineCounts.delete(file);
  lineCounts.set(file, next);
  while (lineCounts.size > LINE_COUNT_CACHE_MAX) lineCounts.delete(lineCounts.keys().next().value!);
  return complete;
}

type RecordGuard<T> = (value: unknown) => value is T;

/** Turns the accumulated tail into text.  A seam, not a strategy: production
 * always decodes UTF-8, and the test counts what passes through to hold the
 * scan below to one decode. */
type Decode = (bytes: Buffer) => string;

const decodeUtf8: Decode = (bytes) => bytes.toString("utf8");

/** How many newlines a chunk holds, counted on the bytes.  A newline cannot
 * appear inside a multi-byte UTF-8 sequence, so this is exactly the count the
 * decoded text would give — without decoding anything. */
function countNewlinesIn(bytes: Buffer): number {
  let count = 0;
  let index = bytes.indexOf(0x0a);
  while (index !== -1) {
    count += 1;
    index = bytes.indexOf(0x0a, index + 1);
  }
  return count;
}

/** Builds the stand-in row for a record too wide to read on a request.  It
 * carries the size and the timestamp the caller supplies; `null` means this
 * lens would rather show nothing. */
type OversizedRecord<T> = (bytes: number, at: string) => T | null;

/** What one log file contributes to a page: its newest valid records, and how
 * many lines it holds in total. */
interface LogPage<T> {
  lines: T[];
  total: number;
}

interface LogTail<T> extends LogPage<T> {
  /** True when the backward scan reached byte zero — every line in the file
   * was considered.  False when it stopped at the tail window, which means
   * there are older records in THIS file that the page does not show. */
  exhausted: boolean;
}

function parseRecent<T>(text: string, includeFirst: boolean, limit: number, valid: RecordGuard<T>): T[] {
  const lines = text.split("\n");
  if (!includeFirst) lines.shift();
  const out: T[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (valid(value)) out.push(value);
    } catch {
      // A torn line during a write, or a hand-edited record. Keep looking
      // farther back until we still have `limit` valid recent entries.
    }
  }
  return out.slice(-limit);
}

/** The newest `limit` valid records of ONE file, plus its line count.  A
 * `limit` of zero counts without parsing, which is how the rotated generation
 * is counted when the live file already filled the page. */
function readTail<T>(
  file: string,
  limit: number,
  valid: RecordGuard<T>,
  maxTailBytes: number,
  oversized: OversizedRecord<T>,
  decode: Decode,
): LogTail<T> {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], total: 0, exhausted: true };
  }
  try {
    const stat = fstatSync(fd);
    const total = countLines(fd, file, stat);
    if (limit <= 0) return { lines: [], total, exhausted: stat.size === 0 };
    let position = stat.size;
    // Chunks newest-last, concatenated and decoded only when the scan has
    // something to parse.  Decoding the whole accumulated tail on every 64 KB
    // step was quadratic — a 12 MB log of 100 KB records at limit 300 decoded
    // 524 MB and held the event loop for about 150 ms per Inspector request,
    // on a route the panel refetches after every turn.  Newlines are counted
    // on the bytes as they arrive instead, which is the only thing that
    // decode was being asked.
    const chunks: Buffer[] = [];
    let buffered = 0;
    let newlines = 0;
    let lines: T[] = [];
    while (position > 0 && buffered < maxTailBytes) {
      const remaining = maxTailBytes - buffered;
      const start = Math.max(0, position - Math.min(READ_CHUNK, remaining));
      const length = position - start;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, start);
      if (read <= 0) break;
      const kept = chunk.subarray(0, read);
      chunks.unshift(kept);
      buffered += read;
      newlines += countNewlinesIn(kept);
      position = start;
      // The first line is partial until we reach byte zero. Parse only once
      // enough complete candidates exist; corrupt candidates make us keep
      // walking backwards rather than returning fewer valid rows.
      if (position === 0 || newlines >= limit) {
        lines = parseRecent(decode(Buffer.concat(chunks)), position === 0, limit, valid);
        if (lines.length >= limit || position === 0) break;
      }
    }
    if (lines.length === 0 && buffered > 0) {
      lines = parseRecent(decode(Buffer.concat(chunks)), position === 0, limit, valid);
    }
    // A record wider than the window leaves the scan above with no newline to
    // cut on, so it returns nothing at all against a nonzero total — the
    // panel goes blank for the one thread whose newest message is the reason
    // anyone opened it.  Walk back past the window to that record's own
    // boundary instead.
    let exhausted = position === 0;
    if (lines.length === 0 && !exhausted) {
      const newest = readNewestRecord(fd, stat.size, maxTailBytes, valid, oversized, decode);
      lines = newest.lines;
      // The fallback may have walked to byte zero even though the windowed
      // scan did not: that file IS fully read, and the rotated generation
      // behind it may complete the page.
      exhausted = newest.fromStart;
    }
    return { lines, total, exhausted };
  } finally {
    closeSync(fd);
  }
}

/** Offset of the last newline strictly before `from`, `-1` when the scan
 * reached byte zero without meeting one, and `null` when it gave up at
 * MAX_RECORD_SCAN_BYTES. */
function lastNewlineBefore(fd: number, from: number): number | null {
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  let position = from;
  while (position > 0) {
    if (from - position >= MAX_RECORD_SCAN_BYTES) return null;
    const start = Math.max(0, position - READ_CHUNK);
    const read = readSync(fd, buffer, 0, position - start, start);
    if (read <= 0) return null;
    const index = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (index !== -1) return start + index;
    position = start;
  }
  return -1;
}

interface NewestRecord<T> {
  lines: T[];
  /** True when the record that was found starts at byte zero — this file
   * holds nothing older than what came back. */
  fromStart: boolean;
}

/** The newest complete record of a file, for the case the windowed scan above
 * cannot serve: a record wider than the window, which leaves that scan with
 * no line boundary to cut on.
 *
 * Two bounds, and they are different.  The SEARCH for the record's boundaries
 * walks back at most MAX_RECORD_SCAN_BYTES.  The PARSE is bounded by the tail
 * window itself: a record wider than the window is never allocated, read or
 * deserialized — the panel gets a stand-in row naming its size instead.  That
 * matters because this runs synchronously on the harness event loop, on a
 * route the Inspector refetches after every turn, and a multi-megabyte
 * `JSON.parse` there is the shape of stall that took the harness down on
 * 2026-09-12.
 *
 * Anything after the file's last newline is a torn write — both writers
 * append a record and its newline in one call — so it is skipped here and not
 * counted in `total`. */
function readNewestRecord<T>(
  fd: number,
  size: number,
  maxTailBytes: number,
  valid: RecordGuard<T>,
  oversized: OversizedRecord<T>,
  decode: Decode,
): NewestRecord<T> {
  if (size === 0) return { lines: [], fromStart: true };
  const terminator = lastNewlineBefore(fd, size);
  // No newline at all, byte zero reached: this file holds nothing complete —
  // one torn partial from a kill mid-write is the ordinary way that happens.
  // It IS fully read, so the rotated generation can be spliced on without
  // opening a gap, and the panel says "showing 100 of 100" rather than
  // "showing 0 of 100".
  if (terminator === -1) return { lines: [], fromStart: true };
  // Gave up at the scan bound instead: there may well be complete records
  // further back, so this file is not exhausted.
  if (terminator === null) return { lines: [], fromStart: false };
  const end = terminator;
  const previous = end === 0 ? -1 : lastNewlineBefore(fd, end);
  if (previous === null) return { lines: [], fromStart: false };
  const start = previous + 1;
  const fromStart = start === 0;
  const length = end - start;
  if (length <= 0) return { lines: [], fromStart };
  if (length > maxTailBytes) {
    // Deliberately not read.  `stat.mtime` is the closest timestamp available
    // without parsing, and it is what this row sorts by.
    const at = new Date(fstatSync(fd).mtimeMs).toISOString();
    const placeholder = oversized(length, at);
    return { lines: placeholder ? [placeholder] : [], fromStart };
  }
  const record = Buffer.allocUnsafe(length);
  const read = readSync(fd, record, 0, length, start);
  if (read <= 0) return { lines: [], fromStart };
  try {
    const value: unknown = JSON.parse(decode(record.subarray(0, read)));
    return { lines: valid(value) ? [value] : [], fromStart };
  } catch {
    return { lines: [], fromStart };
  }
}

/** A thread's log spans at most two files: the live one and the single
 * rotated generation beside it (server/transcript-retention.ts).  Rotation is
 * what keeps either from growing without bound, so the panel reads across the
 * seam — the newest lines come from the live file, and the rotated one both
 * completes a short page and keeps the "showing 200 of 1,687" count honest
 * about what is still on disk.
 *
 * The rotated file is spliced on ONLY when the live file was read to its
 * first byte.  A live file short of `limit` for any other reason — it hit the
 * tail window, or its own records failed the guard — still holds records
 * between what came back and where the rotated file ends, and splicing across
 * that would hand the panel a page with a silent gap in the middle of it,
 * looking for all the world like a contiguous history. */
function readRecentLines<T>(
  file: string,
  limit: number,
  valid: RecordGuard<T>,
  maxTailBytes: number,
  oversized: OversizedRecord<T>,
  decode: Decode,
): LogPage<T> {
  const live = readTail(file, limit, valid, maxTailBytes, oversized, decode);
  const need = live.exhausted ? limit - live.lines.length : 0;
  // `need` of zero still counts the rotated file's lines, so the footer
  // describes the history that exists rather than the page that was built.
  const rotated = readTail(rotatedPath(file), need, valid, maxTailBytes, oversized, decode);
  return { lines: [...rotated.lines, ...live.lines], total: live.total + rotated.total };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrMissing = (value: unknown) => value === undefined || typeof value === "string";
const stringOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "string";
const numberOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "number";
const stringsOrMissing = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.type !== "string" ||
    !stringOrMissing(value.providerInstanceId) ||
    !stringOrMissing(value.turnId) ||
    !stringOrMissing(value.itemId) ||
    !stringOrMissing(value.requestId)
  ) return false;
  switch (value.type) {
    case "session.started":
      return (value.sessionId === null || typeof value.sessionId === "string") && stringOrNullOrMissing(value.model);
    case "session.exited":
      return stringOrMissing(value.reason);
    case "session.invalidated":
      return typeof value.sessionId === "string" && stringOrMissing(value.reason);
    case "turn.started":
      return true;
    case "turn.retrying":
      return (
        typeof value.attempt === "number" &&
        Number.isInteger(value.attempt) &&
        value.attempt >= 1 &&
        typeof value.delayMs === "number" &&
        Number.isFinite(value.delayMs) &&
        value.delayMs >= 0 &&
        typeof value.reason === "string" &&
        (value.maxAttempts === undefined ||
          (typeof value.maxAttempts === "number" && Number.isInteger(value.maxAttempts) && value.maxAttempts >= 1))
      );
    case "turn.completed":
      return (
        typeof value.ok === "boolean" &&
        stringOrNullOrMissing(value.stopReason) &&
        numberOrNullOrMissing(value.cost) &&
        stringsOrMissing(value.denials) &&
        (value.usage === undefined ||
          (isRecord(value.usage) &&
            typeof value.usage.input === "number" &&
            (value.usage.output === undefined || typeof value.usage.output === "number")))
      );
    case "item.started":
      return (value.itemType === "tool" || value.itemType === "reasoning") && stringOrMissing(value.title);
    case "item.updated":
      return (value.itemType === "tool" || value.itemType === "reasoning") && numberOrNullOrMissing(value.tokens);
    case "item.completed":
      return value.itemType === "assistant_text" ? typeof value.text === "string" : value.itemType === "tool" && typeof value.ok === "boolean";
    case "content.delta":
      return (value.streamKind === "assistant_text" || value.streamKind === "reasoning_text") && typeof value.delta === "string";
    case "request.opened":
      return (
        (value.requestType === "permission" || value.requestType === "question") &&
        typeof value.tool === "string" &&
        typeof value.summary === "string" &&
        stringsOrMissing(value.choices)
      );
    case "request.resolved":
      return (
        (value.behavior === "allow" || value.behavior === "deny" || value.behavior === "answer") &&
        (value.source === "user" ||
          value.source === "auto" ||
          value.source === "timeout" ||
          value.source === "system" ||
          value.source === "unavailable" ||
          value.source === "peer")
      );
    case "thread.token-usage.updated":
      return (
        typeof value.input === "number" && (value.output === undefined || typeof value.output === "number")
      );
    case "runtime.error":
      return typeof value.message === "string" && (value.setup === undefined || typeof value.setup === "boolean");
    default:
      return false;
  }
}

function isNativeRecord(value: unknown): value is NativeRecord {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    (value.dir === "in" || value.dir === "out") &&
    typeof value.source === "string" &&
    Object.hasOwn(value, "msg")
  );
}

/** Owner-facing: this string is a row in the Inspector. */
function oversizedMessage(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `A ${mb} MB record was skipped here — it is larger than the Inspector reads in one page.`;
}

export function readThreadEvents(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
  limit?: number;
  /** How far back either file is read before the page is called done.
   * Defaults to MAX_TAIL_BYTES; tests set it small so the window's edge can
   * be exercised without an 8 MB fixture. */
  maxTailBytes?: number;
  /** How the tail becomes text.  Defaults to UTF-8; the test counts what
   * passes through it to hold the scan to one decode. */
  decode?: Decode;
}): InspectorPage {
  const { eventsDir, nativeDir, threadId } = input;
  assertThreadId(threadId);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT)) : DEFAULT_LIMIT;
  const window = Number.isFinite(input.maxTailBytes) ? Math.max(1, Math.trunc(input.maxTailBytes!)) : MAX_TAIL_BYTES;
  const decode = input.decode ?? decodeUtf8;

  // What either lens shows in place of a record too wide to read on a
  // request.  One row, built rather than parsed, so the panel says what is
  // there instead of going blank — and the harness never deserializes
  // megabytes to answer a refresh.
  const runtime = readRecentLines(join(eventsDir, `${threadId}.ndjson`), limit, isRuntimeEvent, window, (bytes, at): RuntimeEvent => ({
    eventId: `oversized-${threadId}-${bytes}`,
    provider: "botfleet",
    threadId,
    createdAt: at,
    type: "runtime.error",
    message: oversizedMessage(bytes),
  }), decode);
  const native = readRecentLines(join(nativeDir, `${threadId}.ndjson`), limit, isNativeRecord, window, (bytes, at): NativeRecord => ({
    at,
    dir: "in",
    source: "botfleet",
    msg: { skipped: oversizedMessage(bytes), bytes },
  }), decode);

  // cap each log on its own, then merge: the native tee is several times
  // chattier than the runtime stream, and one shared cap would leave the
  // Events lens with a handful of rows behind hundreds of raw ones
  const merged: InspectorEntry[] = [
    ...runtime.lines.map((data): InspectorEntry => ({ kind: "runtime", at: data.createdAt, data })),
    ...native.lines.map((data): InspectorEntry => ({ kind: "native", at: data.at, data })),
  ];
  // stable sort: ties keep file order, which is emit order
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: merged,
    total: { runtime: runtime.total, native: native.total },
  };
}
