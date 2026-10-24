/** Mac-local GitHub request log: a metadata-only, non-executing consumer
 * subscribed to WebhookManager attempt events.
 *
 * One durable Markdown line per delivery attempt, appended synchronously with
 * fsync so the record survives a crash; GitHub's non-200 redelivery covers the
 * pre-append window, keeping coverage at-least-once.  Lines carry event
 * metadata only - event name, action, repository, number, actor, delivery id,
 * outcome - never payload bodies, titles, or message text.  Fail-open: a
 * logging failure must never break webhook dispatch.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
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

/** One Markdown line per attempt.  Metadata only; no payload content. */
export function formatRequestLogLine(
  attempt: WebhookAttempt,
  metadata: WebhookRequestMetadata,
  webhookName: string,
): string {
  const ts = new Date(attempt.receivedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  const action = metadata.action ? `${attempt.eventName}.${metadata.action}` : attempt.eventName;
  const target =
    (metadata.repository ?? "") +
    (typeof metadata.number === "number" ? `#${metadata.number}` : "") +
    (metadata.ref ? ` ${metadata.ref}` : "");
  const actor = metadata.actor ? ` by ${metadata.actor}` : "";
  const reason = attempt.reason ? ` (${attempt.reason.slice(0, 160)})` : "";
  const delivery = attempt.deliveryId ?? attempt.id;
  return `- ${ts} ${action}${target ? ` ${target}` : ""}${actor} [${attempt.outcome}] via ${webhookName}${reason} (delivery ${delivery})`;
}

export interface RequestLogWriterOptions {
  filePath: string;
  /** Resolve a friendly name for the webhook record; falls back to its id. */
  webhookName?: (webhookId: string) => string;
}

/** Fail-open subscriber for WebhookManager's emit callback. */
export function createRequestLogWriter(options: RequestLogWriterOptions): (event: WebhookManagerEvent) => void {
  return (event) => {
    if (event.kind !== "webhook.attempt") return;
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
      const name = options.webhookName?.(event.attempt.webhookId) ?? event.attempt.webhookId;
      const line = formatRequestLogLine(event.attempt, event.requestMetadata ?? {}, name);
      const fd = openSync(options.filePath, "a");
      try {
        writeSync(fd, line + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Logging must never break dispatch.
    }
  };
}
