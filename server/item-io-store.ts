// The side store for what a step actually took and returned.
//
// The transcript keeps a headline per tool step and nothing more (the renderer
// holds every message of every thread), and the canonical event log holds the
// arguments only for the HTTP engines and never the result — `detail` on
// `item.completed` is one clipped line.  The native tee has the provider's
// whole protocol, but in each provider's own shape, at up to 64 MB per thread,
// with no provider-neutral key to find one step by.  So the full payload gets
// its own small, bounded log:
//
//   item-io/<threadId>.ndjson   one record per captured input, output or
//                               injected context, keyed by the step's item id
//
// Bounds, all of them enforced here or by the shared retention module:
//
//   per field    32 KB (ITEM_IO_FIELD_LIMIT), with `truncated` and the original
//                length kept so a reader can say what it is not seeing
//   per thread   one live file plus one rotated generation, ITEM_IO_LOG_MAX_BYTES
//                each (server/transcript-retention.ts), trimmed at boot and
//                swept when the thread is gone
//   in flight    a bounded append queue that drops its oldest entries before it
//                grows, exactly as the event-log tee does
//
// Redaction runs twice and both times with the pass the wire uses
// (`redactSecretsInText`): when a record is written, so the file on disk never
// holds a credential the wire would hide, and again when one is read, so a
// pattern added after a record was written still covers it.
//
// Nothing here throws at a caller.  The store is a convenience over the bus; a
// disk that will not take a write costs a row its expanded view, never a turn.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BoundedAppendQueue, type AppendQueueStats } from "./harness/append-queue.ts";
import { redactSecretsInText } from "./redact.ts";
import {
  appendBoundedAsync,
  ITEM_IO_LOG_MAX_BYTES,
  removeTranscriptLogs,
  rotatedPath,
  type AppendWriter,
} from "./transcript-retention.ts";
import {
  cutText,
  ITEM_IO_FIELD_LIMIT,
  type BoundedText,
  type ItemIoCapture,
  type ItemIoPayload,
} from "../shared/item-io.ts";

/** A thread id that is safe to use as a file name.  The route already matches
 * `[\w-]+`; the store checks again because it is the one that touches disk. */
const SAFE_THREAD_ID = /^[\w-]+$/;

/** Longest item id the store will key on.  Providers mint short ids; anything
 * longer is not one, and an id is searched for verbatim in a line of the log. */
export const ITEM_ID_MAX_LENGTH = 256;

/** Ceiling on bytes waiting to be written.  Small on purpose: a record is at
 * most ~100 KB, and past this the oldest queued record goes. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/** One line of `item-io/<threadId>.ndjson`. */
interface StoredRecord {
  v: 1;
  at: string;
  itemId: string;
  turnId?: string;
  input?: BoundedText;
  output?: BoundedText;
  text?: BoundedText;
}

export interface ItemIoWrite {
  itemId: string;
  turnId?: string;
  /** ISO.  Defaults to now. */
  at?: string;
  io: ItemIoCapture;
}

export interface ItemIoStoreOptions {
  dir: string;
  /** per-generation cap; ITEM_IO_LOG_MAX_BYTES unless a test shrinks it */
  maxBytes?: number;
  /** the one call that touches disk, injectable so a test can fail a write */
  append?: AppendWriter;
  maxQueuedBytes?: number;
  report?: (line: string) => void;
}

/** A field as it is stored: redacted, THEN cut, because a credential that
 * straddles the limit would lose the closing marker its pattern anchors on
 * if it were cut first (shared/redact.ts `redactSecretsInLogText`). */
function storedField(field: BoundedText | undefined): BoundedText | undefined {
  if (!field || typeof field.text !== "string" || field.text.length === 0) return undefined;
  const redacted = redactSecretsInText(field.text);
  const text = cutText(redacted, ITEM_IO_FIELD_LIMIT);
  const original = typeof field.length === "number" && Number.isFinite(field.length) ? field.length : field.text.length;
  return {
    text,
    truncated: field.truncated === true || redacted.length > ITEM_IO_FIELD_LIMIT,
    length: Math.max(original, field.text.length),
  };
}

/** The same field on its way OUT: the stored text through the wire redaction
 * once more, so the answer is never less covered than the wire would be. */
function servedField(field: unknown): BoundedText | undefined {
  if (!field || typeof field !== "object") return undefined;
  const { text, truncated, length } = field as Partial<BoundedText>;
  if (typeof text !== "string") return undefined;
  return {
    text: redactSecretsInText(text),
    truncated: truncated === true,
    length: typeof length === "number" && Number.isFinite(length) ? length : text.length,
  };
}

export class ItemIoStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly append: AppendWriter | undefined;
  private readonly writes: BoundedAppendQueue<null>;
  private dirReady: Promise<void> | null = null;

  constructor(options: ItemIoStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? ITEM_IO_LOG_MAX_BYTES;
    this.append = options.append;
    this.writes = new BoundedAppendQueue<null>(
      async (file, data) => {
        await this.ensureDir();
        await appendBoundedAsync(file, data, this.maxBytes, { mode: 0o600 }, this.append);
      },
      {
        maxQueuedBytes: options.maxQueuedBytes ?? MAX_QUEUED_BYTES,
        report: options.report,
        label: "tool input/output store",
        // a failed write costs one step its expanded view; say so once in the
        // server log and move on — never retry, never throw at the bus
        onWriteError: (_context, error) => console.error("item-io: could not write a record", error),
      },
    );
  }

  private ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (error: unknown) => {
        // let the next write try again rather than caching the failure
        this.dirReady = null;
        throw error;
      },
    );
    return this.dirReady;
  }

  private fileFor(threadId: string): string {
    return join(this.dir, `${threadId}.ndjson`);
  }

  /** Queue one record.  Synchronous and cheap past the redaction pass: the
   * serialized line is handed to the queue and the write happens later, off
   * the publisher's stack.  Silently ignores a record it cannot key. */
  record(threadId: string, write: ItemIoWrite): void {
    try {
      if (!SAFE_THREAD_ID.test(threadId)) return;
      if (!write.itemId || write.itemId.length > ITEM_ID_MAX_LENGTH) return;
      const input = storedField(write.io.input);
      const output = storedField(write.io.output);
      const text = storedField(write.io.text);
      if (!input && !output && !text) return;
      const record: StoredRecord = {
        v: 1,
        at: write.at ?? new Date().toISOString(),
        itemId: write.itemId,
        ...(write.turnId ? { turnId: write.turnId } : {}),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...(text ? { text } : {}),
      };
      this.writes.enqueue(this.fileFor(threadId), `${JSON.stringify(record)}\n`, null);
    } catch (error) {
      console.error("item-io: could not build a record", error);
    }
  }

  /** The newest input, output and text recorded for one step, merged field by
   * field: the start of a step and its end are separate records, and an
   * argument that streamed in fragments is written again, settled, when the
   * step completes.  `turnId`, when given, narrows to that turn — an engine
   * that reuses small item ids across turns would otherwise answer with the
   * wrong turn's payload.  Null when nothing was recorded. */
  async read(threadId: string, itemId: string, turnId?: string): Promise<ItemIoPayload | null> {
    if (!SAFE_THREAD_ID.test(threadId) || !itemId || itemId.length > ITEM_ID_MAX_LENGTH) return null;
    // a step that just finished may still be in the queue
    await this.writes.flush();
    const needle = `"itemId":${JSON.stringify(itemId)}`;
    const found: { at?: string; turnId?: string; input?: unknown; output?: unknown; text?: unknown } = {};
    const live = this.fileFor(threadId);
    for (const file of [live, rotatedPath(live)]) {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes(needle)) continue;
        let record: Partial<StoredRecord>;
        try {
          record = JSON.parse(line) as Partial<StoredRecord>;
        } catch {
          // a line cut by a trim or a crash; the rest of the file is still good
          continue;
        }
        if (record.itemId !== itemId) continue;
        if (turnId && record.turnId && record.turnId !== turnId) continue;
        found.at ??= typeof record.at === "string" ? record.at : undefined;
        found.turnId ??= record.turnId;
        found.input ??= record.input;
        found.output ??= record.output;
        found.text ??= record.text;
        // input and output are the two halves of a tool step; a context record
        // has only text.  Nothing older can improve on either.
        if ((found.input && found.output) || found.text) break;
      }
      if ((found.input && found.output) || found.text) break;
    }
    const input = servedField(found.input);
    const output = servedField(found.output);
    const text = servedField(found.text);
    if (!input && !output && !text) return null;
    return {
      itemId,
      ...(found.turnId ? { turnId: found.turnId } : {}),
      at: found.at ?? new Date(0).toISOString(),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(text ? { text } : {}),
    };
  }

  /** Everything queued has reached disk, or failed trying.  Shutdown awaits
   * this beside the event bus's own flush. */
  async flush(): Promise<void> {
    await this.writes.flush();
  }

  /** Queue depth and cumulative drops, for tests. */
  stats(): AppendQueueStats {
    return this.writes.stats();
  }

  /** Delete every generation a thread owns here.  Called wherever a bot, a task
   * or a room is deleted, beside the same call for the event and native logs. */
  remove(threadIds: Iterable<string>): number {
    return removeTranscriptLogs(this.dir, threadIds);
  }
}
