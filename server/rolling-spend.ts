// Rolling 5-hour and 7-day spend per engine, folded out of the canonical event
// logs at boot and kept up to date from live `turn.completed` events.
//
// Boot used to read every events file with an mtime inside the window whole,
// with `readFileSync`, and split it on newlines: with 16 MB files that is a
// multi-second synchronous stall and roughly 3x transient RSS, and the owner's
// Mac saw 29 boots in two days with nothing cached between any of them (audit
// HS11).  Two changes fix it and neither moves a number:
//
//   Stream.  Lines come off a read stream in chunks, split on bytes, so peak
//   memory is one chunk plus one line instead of the whole file.
//
//   Remember.  A cursor file in the data directory holds the folded entries
//   and, per file, how far into it the last run read — so a boot pays for the
//   bytes appended since the last boot, not for a week of history.
//
// The cursor is keyed by INODE, not by name, which is what makes rotation free:
// when `<thread>.ndjson` is renamed to `<thread>.ndjson.1` the inode goes with
// it, so the next boot resumes at the offset it already reached and reads the
// fresh live file from zero.  Truncation is the other direction — a size below
// the recorded offset means the file that offset described is gone — and that
// restarts at zero.  A log REPLACED by the daily trim (a rename over the
// original, so a new inode holding old lines) would re-read lines already
// folded in, which is why entries carry their event id and are merged by it.
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { TurnBillingMode } from "./contracts.ts";

export interface TurnSpendEntry {
  at: number;
  provider: string;
  instanceId?: string;
  costUsd: number;
  billingMode?: TurnBillingMode;
  /** The `eventId` of the `turn.completed` this came from, when there was one.
   * The merge key: it is what stops one turn being counted twice when the same
   * bytes are seen again under a different inode. */
  eventId?: string;
}

export interface EngineSpendSummary {
  spend5hUsd: number;
  spend7dUsd: number;
}

export type EngineSpendMap = Record<string, EngineSpendSummary>;

export const FIVE_HOURS_MS = 5 * 3600 * 1000;
export const SEVEN_DAYS_MS = 7 * 86400 * 1000;

/** Read size for the incremental scan.  Big enough that a 16 MB file is a few
 * hundred reads, small enough that peak memory is a rounding error. */
const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/** Ceiling on entries carried in the cursor.  Seven days of a busy fleet is a
 * few thousand; this is the bound that keeps a pathological run from turning
 * the cursor into the thing it was written to avoid.  Over it the OLDEST go,
 * because the 5-hour number matters more than the tail of the 7-day one. */
export const MAX_PERSISTED_SPEND_ENTRIES = 20_000;

/** Name of the cursor, kept beside `events/` rather than inside it so the
 * transcript sweeps never see it as a log. */
export const SPEND_CURSOR_FILE = "rolling-spend-cursor.json";

const turnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  eventId: z.string().optional(),
  provider: z.string().default("unknown"),
  providerInstanceId: z.string().optional(),
  createdAt: z.string().optional(),
  cost: z.number().positive(),
  billingMode: z.enum(["actual", "estimated"]).optional(),
});

const spendEntrySchema = z.object({
  at: z.number(),
  provider: z.string(),
  instanceId: z.string().optional(),
  costUsd: z.number(),
  billingMode: z.enum(["actual", "estimated"]).optional(),
  eventId: z.string().optional(),
});

const spendCursorFileSchema = z.object({
  name: z.string(),
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});

const spendCursorSchema = z.object({
  version: z.literal(1),
  savedAt: z.number().optional(),
  /** keyed `${dev}:${ino}` */
  files: z.record(z.string(), spendCursorFileSchema),
  entries: z.array(spendEntrySchema),
});

export type SpendCursor = z.infer<typeof spendCursorSchema>;

/** One NDJSON line, or null when it is not a billable settled turn.  The two
 * `includes` are the cheap gate that keeps `JSON.parse` off the 99% of lines
 * that cannot match. */
export function parseTurnSpendLine(line: string, cutoffMs: number): TurnSpendEntry | null {
  if (!line.includes('"turn.completed"') || !line.includes('"cost"')) return null;
  try {
    const parsed = turnCompletedSchema.safeParse(JSON.parse(line));
    if (!parsed.success) return null;
    const ev = parsed.data;
    if (ev.billingMode === "estimated") return null;
    const at = ev.createdAt ? Date.parse(ev.createdAt) : NaN;
    if (!Number.isFinite(at) || at < cutoffMs) return null;
    return {
      at,
      provider: ev.provider,
      instanceId: ev.providerInstanceId,
      costUsd: ev.cost,
      billingMode: ev.billingMode,
      eventId: ev.eventId,
    };
  } catch {
    // ignore torn or unparseable lines
    return null;
  }
}

export function parseTurnSpendFromEventLog(content: string, cutoffMs: number): TurnSpendEntry[] {
  const entries: TurnSpendEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseTurnSpendLine(line, cutoffMs);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Feed every COMPLETE line between `start` and `end` to `onLine`, and return
 * the offset just past the last newline consumed.
 *
 * Splitting happens on bytes, before any decoding: 0x0a cannot appear inside a
 * multi-byte UTF-8 sequence, so a chunk boundary in the middle of a character
 * is carried forward rather than turned into replacement characters.  A
 * trailing partial line — an append that landed between the stat and the read
 * — is deliberately NOT consumed, so the next run picks it up whole instead of
 * resuming in the middle of a record. */
async function readNewLines(path: string, start: number, end: number, onLine: (line: string) => void): Promise<number> {
  if (end <= start) return start;
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: READ_CHUNK_BYTES });
  let carry: Buffer | null = null;
  let consumed = start;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    // Annotated, not inferred: `carry` is assigned out of `buffer` at the foot
    // of this loop, and letting both sides infer makes the pair circular.
    const buffer: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    let from = 0;
    let index = buffer.indexOf(NEWLINE, from);
    while (index !== -1) {
      onLine(buffer.toString("utf8", from, index));
      consumed += index + 1 - from;
      from = index + 1;
      index = buffer.indexOf(NEWLINE, from);
    }
    carry = from < buffer.length ? Buffer.from(buffer.subarray(from)) : null;
  }
  return consumed;
}

/** Merge key.  An event id when the record has one; otherwise the record is
 * kept as-is, because inventing a key out of the fields would let two genuinely
 * distinct turns that happened to cost the same in the same millisecond cancel
 * one another out. */
function mergeKey(entry: TurnSpendEntry): string | null {
  return entry.eventId ? `id:${entry.eventId}` : null;
}

/** Earlier lists win: the cursor's already-folded entries come first, so a
 * file replaced under us cannot count its old lines twice. */
export function mergeSpendEntries(...lists: TurnSpendEntry[][]): TurnSpendEntry[] {
  const seen = new Set<string>();
  const merged: TurnSpendEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const key = mergeKey(entry);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(entry);
    }
  }
  return merged;
}

export interface SpendScanResult {
  entries: TurnSpendEntry[];
  cursor: SpendCursor;
  /** Bytes actually read off disk — the number HS11 is about. */
  bytesRead: number;
  filesRead: number;
}

/** Fold every events log in `eventsDir` into spend entries, reading only what
 * the cursor says is new.  With no cursor this is a full read of every file
 * inside the window, which is exactly what the old synchronous scan did. */
export async function scanRecentSpend(
  eventsDir: string,
  options: { now?: number; cursor?: SpendCursor | null } = {},
): Promise<SpendScanResult> {
  const now = options.now ?? Date.now();
  const cutoff = now - SEVEN_DAYS_MS;
  const prior = options.cursor ?? null;
  const carried = (prior?.entries ?? []).filter((entry) => entry.at >= cutoff);
  const fresh: TurnSpendEntry[] = [];
  const files: SpendCursor["files"] = {};
  let bytesRead = 0;
  let filesRead = 0;

  let names: string[];
  try {
    names = await readdir(eventsDir);
  } catch {
    // Unreadable directory: keep what the cursor already knew rather than
    // forgetting every offset because one `readdir` failed.
    return {
      entries: carried,
      cursor: { version: 1, savedAt: now, files: prior?.files ?? {}, entries: carried },
      bytesRead,
      filesRead,
    };
  }

  for (const name of names) {
    if (!name.endsWith(".ndjson") && !name.endsWith(".ndjson.1")) continue;
    const fullPath = join(eventsDir, name);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      const key = `${st.dev}:${st.ino}`;
      const previous = prior?.files[key];
      // A size below the recorded offset means this is not the file that
      // offset described any more — truncated in place, or emptied — so the
      // only safe resume point is the start.
      const offset = previous && previous.offset <= st.size ? previous.offset : 0;
      if (st.mtimeMs < cutoff) {
        // Its NEWEST line predates the window, so nothing in it can count.
        // Recording it as fully consumed is both correct and free.
        files[key] = { name, offset: st.size, size: st.size };
        continue;
      }
      if (offset >= st.size) {
        files[key] = { name, offset, size: st.size };
        continue;
      }
      const consumed = await readNewLines(fullPath, offset, st.size, (line) => {
        const entry = parseTurnSpendLine(line, cutoff);
        if (entry) fresh.push(entry);
      });
      bytesRead += consumed - offset;
      filesRead += 1;
      files[key] = { name, offset: consumed, size: st.size };
    } catch {
      // skip unreadable files
    }
  }

  const entries = mergeSpendEntries(carried, fresh);
  return { entries, cursor: { version: 1, savedAt: now, files, entries }, bytesRead, filesRead };
}

/** Where the cursor lives for a given events directory: beside it, in the data
 * directory (`EVENTS_DIR` is always `DATA_DIR/events`). */
export function spendCursorPath(eventsDir: string): string {
  return join(dirname(eventsDir), SPEND_CURSOR_FILE);
}

export async function loadSpendCursor(path: string): Promise<SpendCursor | null> {
  try {
    const parsed = spendCursorSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    // No cursor, or one this build cannot read: fall back to a full scan.
    return null;
  }
}

export function saveSpendCursor(path: string, cursor: SpendCursor): void {
  const entries =
    cursor.entries.length > MAX_PERSISTED_SPEND_ENTRIES
      ? [...cursor.entries].sort((a, b) => a.at - b.at).slice(-MAX_PERSISTED_SPEND_ENTRIES)
      : cursor.entries;
  writeFileAtomic(path, JSON.stringify({ ...cursor, entries }), { mode: 0o600 });
}

export class RollingSpendTracker {
  private records: TurnSpendEntry[] = [];
  private initialized = false;

  /** Fold history in.  Resolves when the spend map is complete; the harness
   * calls it from a `setImmediate` at boot and does not await it, because the
   * only consumer is a settings read far later. */
  async init(eventsDir: string, options: { now?: number; cursorPath?: string } = {}): Promise<void> {
    if (this.initialized) return;
    // Claimed before the first await: two boots cannot overlap, but a second
    // call inside the same process must not start a second scan.
    this.initialized = true;
    const now = options.now ?? Date.now();
    const cursorPath = options.cursorPath ?? spendCursorPath(eventsDir);
    const cursor = await loadSpendCursor(cursorPath);
    const result = await scanRecentSpend(eventsDir, { now, cursor });
    // `recordTurn` can land while the scan is in flight, so the live records
    // are merged in rather than replaced — by event id, so a turn that made it
    // into the log before the scan reached that file is still counted once.
    this.records = mergeSpendEntries(result.entries, this.records);
    try {
      saveSpendCursor(cursorPath, result.cursor);
    } catch {
      // A cursor that cannot be written costs the next boot a full read and
      // nothing else.
    }
  }

  recordTurn(entry: {
    at?: number;
    provider: string;
    instanceId?: string;
    costUsd?: number | null;
    billingMode?: TurnBillingMode;
    eventId?: string;
  }): void {
    if (!entry.costUsd || !Number.isFinite(entry.costUsd) || entry.costUsd <= 0) {
      return;
    }
    if (entry.billingMode === "estimated") {
      return;
    }
    this.records.push({
      at: entry.at ?? Date.now(),
      provider: entry.provider,
      instanceId: entry.instanceId,
      costUsd: entry.costUsd,
      billingMode: entry.billingMode,
      eventId: entry.eventId,
    });
  }

  getSpend(now = Date.now()): EngineSpendMap {
    const t5h = now - FIVE_HOURS_MS;
    const t7d = now - SEVEN_DAYS_MS;
    // Prune entries older than 7 days
    this.records = this.records.filter((r) => r.at >= t7d);

    const spend: EngineSpendMap = {};

    const addCost = (key: string, cost: number, at: number) => {
      if (!spend[key]) {
        spend[key] = { spend5hUsd: 0, spend7dUsd: 0 };
      }
      spend[key].spend7dUsd += cost;
      if (at >= t5h) {
        spend[key].spend5hUsd += cost;
      }
    };

    // Ensure DeepSeek alias keys are aggregated together across all aliases
    const dsKeys = ["deepseekAgent", "deepseek"];
    let dsSpend5h = 0;
    let dsSpend7d = 0;
    let hasDsEntry = false;
    for (const r of this.records) {
      const isDs = dsKeys.includes(r.provider) || (r.instanceId && dsKeys.includes(r.instanceId));
      if (isDs) {
        hasDsEntry = true;
        dsSpend7d += r.costUsd;
        if (r.at >= t5h) {
          dsSpend5h += r.costUsd;
        }
      }
    }
    if (hasDsEntry) {
      const dsSummary = {
        spend5hUsd: Math.round(dsSpend5h * 10_000) / 10_000,
        spend7dUsd: Math.round(dsSpend7d * 10_000) / 10_000,
      };
      for (const k of dsKeys) {
        spend[k] = { ...dsSummary };
      }
    }

    for (const r of this.records) {
      const isDs = dsKeys.includes(r.provider) || (r.instanceId && dsKeys.includes(r.instanceId));
      if (!isDs) {
        addCost(r.provider, r.costUsd, r.at);
        if (r.instanceId && r.instanceId !== r.provider) {
          addCost(r.instanceId, r.costUsd, r.at);
        }
      }
    }

    // Round accumulated values in final output
    for (const key of Object.keys(spend)) {
      spend[key].spend5hUsd = Math.round(spend[key].spend5hUsd * 10_000) / 10_000;
      spend[key].spend7dUsd = Math.round(spend[key].spend7dUsd * 10_000) / 10_000;
    }

    return spend;
  }

  reset(): void {
    this.records = [];
    this.initialized = false;
  }
}

export const rollingSpendTracker = new RollingSpendTracker();
