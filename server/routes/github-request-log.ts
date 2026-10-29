/** GitHub org-hook request-log route: a stable, non-secret endpoint with
 *  HMAC header authentication (X-Hub-Signature-256), mirroring the Linq
 *  route's discipline: verify before admission, fail closed when no secret
 *  is configured, no unsigned fallback.  Authenticated deliveries are
 *  recorded through the shared durable RequestLog and never dispatched -
 *  no bot prompts, no state beyond the log. */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { extractRequestMetadata, type RequestLog } from "../request-log.ts";

export interface GitHubRequestLogRouteOptions {
  requestLog: RequestLog;
  /** Config/Infisical-hydrated HMAC secret; undefined refuses delivery. */
  secretProvider: () => string | undefined;
  /** Label written into each line's via field. */
  webhookName?: string;
  /** Acquire update admission AFTER authentication (deferAdmission route). */
  beginAdmission(): (() => void) | null;
  now?: () => number;
}

const MAX_BODY_BYTES = 1024 * 1024;
class BodyTooLargeError extends Error {}

function json(res: ServerResponse, status: number, body: { ok: boolean; reason?: string }): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError("body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (header.length !== expected.length) return false;
  const supplied = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes);
}

export async function readGitHubRequestLog(
  req: IncomingMessage,
  res: ServerResponse,
  options: GitHubRequestLogRouteOptions,
): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    const status = err instanceof BodyTooLargeError ? 413 : 400;
    json(res, status, { ok: false, reason: "bad_body" });
    return;
  }
  const secret = options.secretProvider();
  if (!secret) {
    console.error("[github-request-log] HMAC secret is not configured; refusing delivery");
    json(res, 503, { ok: false, reason: "webhook_secret_not_configured" });
    return;
  }
  const header = z.string().optional().catch(undefined).parse(req.headers["x-hub-signature-256"]);
  if (!verifyGitHubSignature(rawBody, header, secret)) {
    json(res, 401, { ok: false, reason: "bad_signature" });
    return;
  }
  const eventName = z.string().min(1).max(64).safeParse(req.headers["x-github-event"]);
  const deliveryId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).safeParse(req.headers["x-github-delivery"]);
  if (!eventName.success || !deliveryId.success) {
    json(res, 400, { ok: false, reason: "bad_delivery_headers" });
    return;
  }
  let payload: unknown;
  let validJson = true;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { validJson = false; }
  const release = options.beginAdmission();
  if (!release) {
    json(res, 503, { ok: false, reason: "quiescing_for_update" });
    return;
  }
  try {
    const durable = options.requestLog.record(
      {
        deliveryId: deliveryId.data,
        eventName: eventName.data,
        receivedAt: (options.now ?? Date.now)(),
        outcome: validJson ? "received" : "invalid_json",
        webhookId: options.webhookName ?? "github-request-log",
      },
      extractRequestMetadata({ eventName: eventName.data, payload }),
    );
    if (!durable) {
      json(res, 503, { ok: false, reason: "log_not_durable" });
      return;
    }
    json(res, validJson ? 200 : 400, validJson ? { ok: true } : { ok: false, reason: "bad_json" });
  } finally {
    release();
  }
}
