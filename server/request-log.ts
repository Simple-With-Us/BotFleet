/** Mac-local GitHub request log: a durable, metadata-only, non-executing
 * consumer subscribed to WebhookManager attempt events.
 *
 * Durability: each attempt's metadata record is appended to a JSONL spool
 * (mode 600) with fsync inside appendAttempt - synchronously before the
 * ingress answers GitHub, so an ACKed delivery is always on disk.  A flusher
 * converts unflushed spool records into one Markdown line each and advances
 * an offset cursor (mode 600) only after a confirmed write; replay at startup
 * and per event drains whatever a crash left behind.  A crash between the
 * Markdown write and the cursor write can re-emit a line, so flush skips
 * delivery ids already present in the log's tail.  A fully drained spool is
 * truncated back to empty.
 *
 * Lines carry event metadata only - event name, action, repository, number,
 * actor, delivery id, outcome - never payload bodies, titles, or message
 * text.  Fail-open with observability: a logging failure never breaks
 * dispatch, but is reported through onError so the gap is visible.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { WebhookAttempt, WebhookManagerEvent } from "./webhooks.ts";

export interface WebhookRequestMetadata {
  action?: string;
  repository?: string;
  number?: number;
  actor?: string;
  ref?: string;
}

function stringField(source: Record<string, unknown>, key: string, limit: number): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

/** Pull log-safe metadata out of a webhook event.  Never body or title text. */
export function extractRequestMetadata(event: { eventName?: string; payload?: unknown }): WebhookRequestMetadata {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const meta: WebhookRequestMetadata = {};
  meta.action = stringField(payload, "action", 64);
  const repository = payload.repository;
  if (repository && typeof repository === "object") {
    meta.repository = stringField(repository as Record<string, unknown>, "full_name", 200);
  }
  const sender = payload.sender;
  if (sender && typeof sender === "object") {
    meta.actor = stringField(sender as Record<string, unknown>, "login", 100);
  }
  for (const key of ["pull_request", "issue", "discussion", "release", "check_run"] as const) {
    const entry = payload[key];
    if (entry && typeof entry === "object") {
      const number = (entry as Record<string, unknown>).number;
      if (typeof number === "number") {
        meta.number = number;
        break;
      }
    }
  }
  if (event.eventName === "push") {
    const ref = stringField(payload, "ref", 200);
    if (ref) meta.ref = ref.replace(/^refs\/heads\//, "").slice(0, 100);
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
  const action = metadata.action ? `${entry.eventName}.${metadata.action}` : entry.eventName;
  const target =
    (metadata.repository ?? "") +
    (typeof metadata.number === "number" ? `#${metadata.number}` : "") +
    (metadata.ref ? ` ${metadata.ref}` : "");
  const actor = metadata.actor ? ` by ${metadata.actor}` : "";
  const reason = entry.reason ? ` (${entry.reason.slice(0, 160)})` : "";
  return `- ${ts} ${action}${target ? ` ${target}` : ""}${actor} [${entry.outcome}] via ${webhookName}${reason} (delivery ${entry.deliveryId})`;
}

export interface RequestLogOptions {
  /** Markdown log Jay opens on demand. */
  filePath: string;
  /** Append-only JSONL crash spool (mode 600). */
  spoolPath: string;
  /** Flush offset cursor (mode 600). */
  cursorPath: string;
  /** Resolve a friendly name for the webhook record; falls back to its id. */
  webhookName?: (webhookId: string) => string;
  /** Observable failure channel; logging never throws into dispatch. */
  onError?: (message: string) => void;
}

function appendFsync(path: string, text: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFsync(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const DELIVERY_TAIL_BYTES = 65536;

/** Delivery ids already in the Markdown log's tail (crash-window dedupe). */
function loggedDeliveries(filePath: string): Set<string> {
  try {
    const text = readFileSync(filePath, "utf8");
    const tail = text.slice(-DELIVERY_TAIL_BYTES);
    const ids = new Set<string>();
    for (const match of tail.matchAll(/\(delivery ([^)]+)\)/g)) ids.add(match[1]!);
    return ids;
  } catch {
    return new Set();
  }
}

export interface RequestLog {
  subscriber: (event: WebhookManagerEvent) => void;
  /** Record one delivery (spool-first, then flush).  Never throws. */
  record: (entry: RequestLogEntry, metadata: WebhookRequestMetadata) => void;
  /** Drain any spool records a crash left behind.  Safe to call repeatedly. */
  replay: () => void;
}

export function createRequestLog(options: RequestLogOptions): RequestLog {
  const flush = (): void => {
    let offset = 0;
    try {
      offset = Number(readFileSync(options.cursorPath, "utf8")) || 0;
    } catch {
      // No cursor yet.
    }
    let spool: string;
    try {
      spool = readFileSync(options.spoolPath, "utf8");
    } catch {
      return; // Nothing spooled.
    }
    if (offset > spool.length) offset = 0; // Spool was truncated underneath us.
    const pending = spool
      .slice(offset)
      .split("\n")
      .filter((line) => line.length > 0);
    if (pending.length > 0) {
      const seen = loggedDeliveries(options.filePath);
      const lines: string[] = [];
      for (const record of pending) {
        try {
          const parsed = JSON.parse(record) as { line?: string; delivery?: string };
          if (typeof parsed.line !== "string") continue;
          if (parsed.delivery && seen.has(parsed.delivery)) continue;
          lines.push(parsed.line);
        } catch {
          // Skip an unparseable spool record rather than stalling the drain.
        }
      }
      if (lines.length > 0) {
        mkdirSync(dirname(options.filePath), { recursive: true });
        appendFsync(options.filePath, lines.map((line) => line + "\n").join(""));
      }
      // Cursor advances only after the Markdown write confirmed.
      writeFsync(options.cursorPath, String(spool.length));
    }
    // Fully drained: the spool's crash-recovery job is done; start it empty.
    writeFsync(options.spoolPath, "");
    writeFsync(options.cursorPath, "0");
  };

  const record = (entry: RequestLogEntry, metadata: WebhookRequestMetadata): void => {
    try {
      const name = options.webhookName?.(entry.webhookId) ?? entry.webhookId;
      const line = formatRequestLogLine(entry, metadata, name);
      mkdirSync(dirname(options.spoolPath), { recursive: true });
      // Spool-first: the record is durable before dispatch answers GitHub.
      appendFsync(options.spoolPath, JSON.stringify({ line, delivery: entry.deliveryId }) + "\n");
      flush();
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    subscriber: (event) => {
      if (event.kind !== "webhook.attempt") return;
      const attempt: WebhookAttempt = event.attempt;
      record(
        {
          deliveryId: attempt.deliveryId ?? attempt.id,
          eventName: attempt.eventName,
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
        flush();
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
