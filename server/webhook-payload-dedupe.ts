// Identical unattended webhook wakes often differ only by a delivery id or a
// clock field.  Hashing the payload after those fields are removed lets
// ingress drop the retry without treating a different event as the same one.

import { createHash } from "node:crypto";

import type { JsonValue } from "./schema.ts";

/** Default quiet period for an accepted bot, source, and payload hash. */
export const DEFAULT_WEBHOOK_PAYLOAD_DEDUPE_MS = 120_000;

const DELIVERY_ID_KEYS = new Set([
  "deliveryid",
  "xgithubdelivery",
  "idempotencykey",
  "svixid",
]);

const ALWAYS_TIMESTAMP_KEYS = new Set([
  "timestamp",
  "timestamps",
  "datetime",
  "datetimeutc",
  "createdat",
  "updatedat",
  "sentat",
  "receivedat",
  "occurredat",
  "deliveredat",
  "publishedat",
  "deletedat",
  "eventtime",
  "senttime",
]);

function foldKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function isDeliveryIdKey(key: string): boolean {
  const folded = foldKey(key);
  return DELIVERY_ID_KEYS.has(folded) || folded.endsWith("deliveryid");
}

function isAlwaysTimestampKey(key: string): boolean {
  const folded = foldKey(key);
  return ALWAYS_TIMESTAMP_KEYS.has(folded) || folded.endsWith("timestamp") || folded.endsWith("datetime");
}

function isClockSuffixKey(key: string): boolean {
  return /(?:_at|-at)$/i.test(key) || /[a-z]At$/.test(key);
}

function isClockValue(value: JsonValue): boolean {
  if (typeof value === "string") {
    const text = value.trim();
    return /^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?$/.test(text);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const abs = Math.abs(value);
    return (abs >= 1_000_000_000 && abs < 10_000_000_000) || (abs >= 1_000_000_000_000 && abs < 10_000_000_000_000);
  }
  return false;
}

function shouldStripKey(key: string, value: JsonValue): boolean {
  if (isDeliveryIdKey(key) || isAlwaysTimestampKey(key)) return true;
  if (foldKey(key) === "time" && isClockValue(value)) return true;
  return isClockSuffixKey(key) && isClockValue(value);
}

/** Copy `value` without delivery-id keys or timestamp keys.  Every other field stays. */
export function normalizeWebhookPayloadForDedupe(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeWebhookPayloadForDedupe(entry));
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (shouldStripKey(key, entry)) continue;
    out[key] = normalizeWebhookPayloadForDedupe(entry);
  }
  return out;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

/** Stable hash of a payload after delivery ids and timestamps are removed. */
export function webhookPayloadDedupeHash(payload: JsonValue): string {
  return createHash("sha256").update(canonicalize(normalizeWebhookPayloadForDedupe(payload))).digest("hex");
}

/**
 * Source identity for one wake: the webhook trigger, plus the event name when
 * the delivery carries one.  A different trigger or event name is a different source.
 */
export function webhookPayloadDedupeSource(triggerId: string, eventName: string | undefined): string {
  const name = (eventName ?? "").trim().slice(0, 200);
  const id = triggerId.trim().slice(0, 200);
  return name ? `${id}:${name}` : id;
}

export interface WebhookPayloadDedupeIdentity {
  botId: string;
  source: string;
  hash: string;
}

export function webhookPayloadDedupeIdentity(
  botId: string,
  triggerId: string,
  eventName: string | undefined,
  payload: JsonValue,
): WebhookPayloadDedupeIdentity {
  return {
    botId,
    source: webhookPayloadDedupeSource(triggerId, eventName),
    hash: webhookPayloadDedupeHash(payload),
  };
}

export function sameWebhookPayloadDedupeIdentity(
  left: WebhookPayloadDedupeIdentity,
  right: WebhookPayloadDedupeIdentity,
): boolean {
  return left.botId === right.botId && left.source === right.source && left.hash === right.hash;
}
