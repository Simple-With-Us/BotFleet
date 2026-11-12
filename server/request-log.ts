/** Mac-local GitHub request log: a durable, metadata-only, non-executing
 * consumer subscribed to WebhookManager attempt events.
 *
 * Durability: metadata is fsynced to a spool before the normal response when
 * the write succeeds. Failed writes need GET-only source reconciliation.
 * Replay drains legacy spool and immutable inbox files, deduplicating against the durable log,
 * then truncates only after all valid records have landed. Malformed records
 * preserve the spool and report an error. Dispatch fsyncs inbox records before attempting the short shared mkdir
 * lock at filePath + ".lock". A crash-held lock fails visibly, never reclaimed
 * automatically; recovery must verify writer liveness before removing it.
 *
 * Lines carry event metadata only - event name, action, repository, number,
 * actor, delivery id, outcome - never payload bodies, titles, or message
 * text.  Fail-open with observability: a logging failure never breaks
 * dispatch, but is reported through onError so the gap is visible.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { WebhookAttempt, WebhookManagerEvent } from "./webhooks.ts";

export interface WebhookRequestMetadata {
  action?: string;
  repository?: string;
  number?: number;
  actor?: string;
  ref?: string;
  sourceUrl?: string;
}

type LogAtomValue = string | number | null | undefined;
export function logAtom(value: LogAtomValue, limit = 200): string {
  return Array.from(String(value ?? ""), (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 || code === 133 || code === 8232 || code === 8233 ? " " : char;
  }).join("").replace(/[()]/g, "").slice(0, limit);
}

const optionalText = z.string().optional().catch(undefined);
const numberRecord = z.object({ number: z.number().optional().catch(undefined) }).optional().catch(undefined);
const metadataPayload = z.object({
  action: optionalText,
  repository: z.object({ full_name: optionalText }).optional().catch(undefined),
  sender: z.object({ login: optionalText }).optional().catch(undefined),
  pull_request: numberRecord, issue: numberRecord, discussion: numberRecord,
  release: numberRecord, check_run: numberRecord,
  ref: optionalText,
  comment: z.object({ html_url: optionalText }).optional().catch(undefined),
  review: z.object({ html_url: optionalText }).optional().catch(undefined),
}).catch({});

/** Preserve only GitHub content permalinks, never queries, credentials or arbitrary destinations. */
export function requestSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search) return undefined;
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull|discussions)\/[0-9]+(?:\/files)?$/.test(url.pathname)) return undefined;
    if (url.hash && !/^#(?:issuecomment-|discussion_r|pullrequestreview-|discussioncomment-)[0-9]+$/.test(url.hash)) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Decode untrusted webhook fields before reading metadata; never body/title text. */
export function extractRequestMetadata(event: { eventName?: string; payload?: unknown }): WebhookRequestMetadata {
  const payload = metadataPayload.parse(event.payload);
  const meta: WebhookRequestMetadata = {};
  if (payload.action) meta.action = logAtom(payload.action, 64);
  if (payload.repository?.full_name) meta.repository = logAtom(payload.repository.full_name, 200);
  if (payload.sender?.login) meta.actor = logAtom(payload.sender.login, 100);
  for (const key of ["pull_request", "issue", "discussion", "release", "check_run"] as const) {
    const number = payload[key]?.number;
    if (number !== undefined && Number.isSafeInteger(number)) { meta.number = number; break; }
  }
  const sourceUrl = requestSourceUrl(payload.comment?.html_url ?? payload.review?.html_url);
  if (sourceUrl) meta.sourceUrl = sourceUrl;
  if (event.eventName === "push" && payload.ref) {
    meta.ref = logAtom(payload.ref, 200).replace(/^refs\/heads\//, "").slice(0, 100);
  }
  return meta;
}

/** A loggable delivery: a WebhookManager attempt, or a direct record from
 *  the non-executing org-hook route (outcome "received"). */
export interface RequestLogEntry {
  deliveryId: string;
  eventName: string;
  receivedAt: number;
  outcome: string;
  reason?: string;
  webhookId: string;
}

/** One Markdown line per delivery.  Metadata only; no payload content. */
export function formatRequestLogLine(
  entry: RequestLogEntry,
  metadata: WebhookRequestMetadata,
  webhookName: string,
): string {
  const ts = new Date(entry.receivedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  const action = metadata.action ? `${logAtom(entry.eventName, 64)}.${logAtom(metadata.action, 64)}` : logAtom(entry.eventName, 64);
  const target =
    logAtom(metadata.repository) +
    (Number.isSafeInteger(metadata.number) ? `#${metadata.number}` : "") +
    (metadata.ref ? ` ${logAtom(metadata.ref)}` : "");
  const actor = metadata.actor ? ` by ${logAtom(metadata.actor, 100)}` : "";
  const sourceUrl = requestSourceUrl(metadata.sourceUrl);
  const source = sourceUrl ? ` source ${sourceUrl}` : "";
  const reason = entry.reason ? ` (${logAtom(entry.reason, 160)})` : "";
  return `- ${ts} ${action}${target ? ` ${target}` : ""}${actor} [${logAtom(entry.outcome, 64)}] via ${logAtom(webhookName)}${reason}${source} (delivery ${logAtom(entry.deliveryId, 100)})`;
}

/** Read a byte range from the already-open ledger snapshot. Caller owns fd. */
export function readRequestLogRange(fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const n = readSync(fd, bytes, count, length - count, offset + count);
    if (!n) break;
    count += n;
  }
  return bytes.subarray(0, count);
}

export interface RequestLogOptions {
  /** Real byte-range reader seam, also used to measure incremental I/O. */
  readLogRange?: typeof readRequestLogRange;
  /** Markdown log Jay opens on demand. */
  filePath: string;
  /** Append-only JSONL crash spool (mode 600). */
  spoolPath: string;
  /** Flush recovery marker (mode 600). */
  cursorPath: string;
  /** Resolve a friendly name for the webhook record; falls back to its id. */
  webhookName?: (webhookId: string) => string;
  /** Observable failure channel; logging never throws into dispatch. */
  onError?: (message: string) => void;
}

function appendFsync(path: string, text: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("request-log short write");
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFsync(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("request-log short write");
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}



export interface RequestLog {
  subscriber: (event: WebhookManagerEvent) => void;
  /** True only after the record is fsynced to the spool. Never throws into dispatch. */
  record: (entry: RequestLogEntry, metadata: WebhookRequestMetadata) => boolean;
  /** Drain any spool records a crash left behind.  Safe to call repeatedly. */
  replay: () => void;
  routineSubscriber: (event: { kind?: unknown; run?: unknown }) => void;
}

export function createRequestLog(options: RequestLogOptions): RequestLog {
  // Immutable per-record inbox files let dispatch fsync without contending with
  // the short shared Markdown commit lock. Only a lock holder removes files.
  const inbox = options.spoolPath + ".pending";
  let cachedIds = new Set<string>();
  let cachedOffset = 0;
  let cachedFile = "";
  const deliveryIds = (attempt = 0): Set<string> => {
    try {
      const fd = openSync(options.filePath, "r");
      try {
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== cachedFile || stat.size < cachedOffset) {
        cachedIds = new Set(); cachedOffset = 0; cachedFile = identity;
      }
      if (stat.size > cachedOffset) {
        const bytes = (options.readLogRange ?? readRequestLogRange)(fd, cachedOffset, stat.size - cachedOffset);
        const end = bytes.lastIndexOf(10) + 1;
        for (const match of bytes.subarray(0, end).toString("utf8").matchAll(/\(delivery ([^)]+)\)/g)) cachedIds.add(match[1]!);
        cachedOffset += end;
      }
      const current = statSync(options.filePath);
      if (`${current.dev}:${current.ino}` !== identity || current.size < cachedOffset) {
        cachedIds = new Set(); cachedOffset = 0; cachedFile = "";
        if (attempt >= 2) throw new Error("request-log changed repeatedly during dedupe");
        return deliveryIds(attempt + 1);
      }
      return cachedIds;
      } finally { closeSync(fd); }
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) {
        cachedIds = new Set(); cachedOffset = 0; cachedFile = ""; return new Set();
      }
      throw error;
    }
  };
  const flush = (): void => {
    let spool: string;
    try {
      spool = readFileSync(options.spoolPath, "utf8");
    } catch (error) {
      const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
      if (missing.success) spool = "";
      else throw error;
    }
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const files = readdirSync(inbox).filter((name) => /^[0-9a-f-]+\.json$/.test(name));
    const pending = spool
      .split("\n")
      .filter((line) => line.length > 0)
      .concat(files.map((name) => readFileSync(inbox + "/" + name, "utf8")));
    if (pending.length > 0) {
      const seen = deliveryIds();
      const lines: string[] = [];
      const batchIds = new Set<string>();
      for (const record of pending) {
        try {
          const parsed = z.object({ line: z.string(), delivery: z.string().optional() }).parse(JSON.parse(record));
          if (parsed.delivery && (seen.has(parsed.delivery) || batchIds.has(parsed.delivery))) continue;
          lines.push(parsed.line);
          if (parsed.delivery) batchIds.add(parsed.delivery);
        } catch {
          // Preserve the entire spool and cursor for recovery. Never silently
          // discard malformed or partially-written records.
          throw new Error("request-log spool requires recovery");
        }
      }
      if (lines.length > 0) {
        mkdirSync(dirname(options.filePath), { recursive: true });
        appendFsync(options.filePath, lines.map((line) => line + "\n").join(""));
      }
      // Full-spool replay plus durable log dedupe avoids a truncate/cursor
      // crash letting an old byte offset skip new records.
    }
    // Fully drained: the spool's crash-recovery job is done; start it empty.
    writeFsync(options.spoolPath, "");
    writeFsync(options.cursorPath, "0");
    for (const name of files) unlinkSync(inbox + "/" + name);
  };

  const record = (entry: RequestLogEntry, metadata: WebhookRequestMetadata): boolean => {
    let durable = false;
    try {
      const name = options.webhookName?.(entry.webhookId) ?? entry.webhookId;
      const line = formatRequestLogLine(entry, metadata, name);
      mkdirSync(dirname(options.spoolPath), { recursive: true });
      mkdirSync(dirname(options.filePath), { recursive: true });
      mkdirSync(inbox, { recursive: true, mode: 0o700 });
      // Preserve legacy spool health checks: a directory/unreadable spool is
      // an operational failure, not a silently bypassed recovery record.
      try { readFileSync(options.spoolPath, "utf8"); }
      catch (error) { if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error; }
      const pendingPath = inbox + "/" + randomUUID();
      writeFsync(pendingPath + ".tmp", JSON.stringify({ line, delivery: logAtom(entry.deliveryId, 100) }));
      renameSync(pendingPath + ".tmp", pendingPath + ".json");
      const directory = openSync(inbox, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      durable = true;
      const lock = options.filePath + ".lock";
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch (error) {
        if (z.object({ code: z.literal("EEXIST") }).safeParse(error).success) {
          options.onError?.("request-log commit lock busy; durable inbox awaits replay");
          return durable;
        }
        throw error;
      }
      try { flush(); } finally { rmdirSync(lock); }
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
    }
    return durable;
  };

  return {
    routineSubscriber: (event) => {
      if (event.kind !== "routine.run") return;
      const parsed = z.object({
        id: z.string().min(1).max(100), botId: z.string().min(1).max(100),
        status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "missed"]), createdAt: z.number().min(0).max(8640000000000000),
        triggerSource: z.string().max(64).optional(),
        startedAt: z.number().min(0).max(8640000000000000).optional(), finishedAt: z.number().min(0).max(8640000000000000).optional(),
      }).safeParse(event.run);
      if (!parsed.success) return;
      const run = parsed.data;
      record({
        deliveryId: `routine:${createHash("sha256").update(JSON.stringify([run.id, run.status])).digest("hex")}`,
        eventName: "botfleet_routine", outcome: run.status,
        receivedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
        webhookId: "routine-manager",
      }, { action: run.triggerSource ?? "unknown", actor: run.botId, ref: run.id });
    },
    subscriber: (event) => {
      if (event.kind !== "webhook.attempt") return;
      const attempt: WebhookAttempt = event.attempt;
      record(
        {
          deliveryId: attempt.deliveryId ?? attempt.id,
          eventName: attempt.eventName ?? "unknown",
          receivedAt: attempt.receivedAt,
          outcome: attempt.outcome,
          reason: attempt.reason,
          webhookId: attempt.webhookId,
        },
        event.requestMetadata ?? {},
      );
    },
    record,
    replay: () => {
      try {
        mkdirSync(dirname(options.filePath), { recursive: true });
        const lock = options.filePath + ".lock";
        mkdirSync(lock, { mode: 0o700 });
        try { flush(); } finally { rmdirSync(lock); }
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
