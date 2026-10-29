/** Mac-local GitHub request log: a durable, metadata-only, non-executing
 * consumer subscribed to WebhookManager attempt events.
 *
 * Durability: metadata is fsynced to a spool before the normal response when
 * the write succeeds. Failed writes need GET-only source reconciliation.
 * Replay reads the whole spool and deduplicates against the full durable log,
 * then truncates only after all valid records have landed. Malformed records
 * preserve the spool and report an error. Server and reconciler share a mkdir
 * lock at filePath + ".lock". A crash-held lock fails visibly, never reclaimed
 * automatically; recovery must verify writer liveness before removing it.
 *
 * Lines carry event metadata only - event name, action, repository, number,
 * actor, delivery id, outcome - never payload bodies, titles, or message
 * text.  Fail-open with observability: a logging failure never breaks
 * dispatch, but is reported through onError so the gap is visible.
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, writeSync } from "node:fs";
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
    return code <= 31 || code === 127 ? " " : char;
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
    if (number !== undefined) { meta.number = number; break; }
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

export interface RequestLogOptions {
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



/** Delivery ids already in the Markdown full log (crash-window dedupe). */
function loggedDeliveries(filePath: string): Set<string> {
  try {
    const text = readFileSync(filePath, "utf8");
    const tail = text;
    const ids = new Set<string>();
    for (const match of tail.matchAll(/\(delivery ([^)]+)\)/g)) ids.add(match[1]!);
    return ids;
  } catch (error) {
    const parsedError = z.object({ code: z.string() }).safeParse(error);
    if (parsedError.success && parsedError.data.code === "ENOENT") return new Set();
    throw error;
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
  const flush = (): void => {
    let spool: string;
    try {
      spool = readFileSync(options.spoolPath, "utf8");
    } catch (error) {
      const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
      if (missing.success) return;
      throw error;
    }
    const pending = spool
      .split("\n")
      .filter((line) => line.length > 0);
    if (pending.length > 0) {
      const seen = loggedDeliveries(options.filePath);
      const lines: string[] = [];
      for (const record of pending) {
        try {
          const parsed = z.object({ line: z.string(), delivery: z.string().optional() }).parse(JSON.parse(record));
          if (parsed.delivery && seen.has(parsed.delivery)) continue;
          lines.push(parsed.line);
          if (parsed.delivery) seen.add(parsed.delivery);
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
  };

  const record = (entry: RequestLogEntry, metadata: WebhookRequestMetadata): boolean => {
    let durable = false;
    try {
      const name = options.webhookName?.(entry.webhookId) ?? entry.webhookId;
      const line = formatRequestLogLine(entry, metadata, name);
      mkdirSync(dirname(options.spoolPath), { recursive: true });
      mkdirSync(dirname(options.filePath), { recursive: true });
      const lock = options.filePath + ".lock";
      mkdirSync(lock, { mode: 0o700 });
      try {
        appendFsync(options.spoolPath, JSON.stringify({ line, delivery: logAtom(entry.deliveryId, 100) }) + "\n");
        durable = true; // The fsynced spool owns recovery even if flush fails.
        flush();
      } finally {
        rmdirSync(lock);
      }
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
