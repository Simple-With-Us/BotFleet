// POST /api/webhooks/linq — HMAC-verified Linq webhook receiver.
//
// The receiver lives next to the existing webhook-ingress surface because
// it needs its own (a) JSON parsing path with the Linq-specific signature
// header, and (b) dispatch module invocation.  We keep the same shape
// (StatusCapsule-style JSON 200/400/401 answers) so the Linq dashboard
// surfaces an obvious failure during install.
//
// The `botsProvider` is injected by the route registration site so this
// module never has to reach into the singleton Store from inside
// `server/index.ts` — same separation the webhook-ingress surface keeps.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseJson } from "../schema.ts";
import { handleLinqInbound } from "../linq/dispatch.ts";
import { loadConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";

const MAX_LINQ_WEBHOOK_BYTES = 512 * 1024;

const linqReceivedSchema = z.object({
  type: z.literal("message.received"),
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
  from: z.string(),
  to: z.string().optional(),
  body: z.string().optional(),
  parts: z
    .array(
      z.object({
        type: z.enum(["text", "image", "video", "audio", "file"]),
        url: z.string().optional(),
        // Text parts carry their content in `value` rather than a URL;
        // without this the schema strips it and the message reads as empty.
        value: z.string().optional(),
        mime_type: z.string().optional(),
        filename: z.string().optional(),
      }),
    )
    .optional(),
  is_group: z.boolean().optional(),
  group_name: z.string().optional(),
  sent_at: z.string().optional(),
});

const linqLifecycleSchema = z.union([
  z.object({ type: z.literal("message.sent"), message_id: z.string(), chat_id: z.string().optional(), at: z.string().optional() }),
  z.object({ type: z.literal("message.delivered"), message_id: z.string(), chat_id: z.string().optional(), at: z.string().optional() }),
]);

const linqEventSchema = z.union([linqReceivedSchema, linqLifecycleSchema]);

/** Buffer the body as raw bytes.  Decoding per chunk would corrupt a
 *  multibyte UTF-8 character split across chunks, and the HMAC is over the
 *  exact bytes Linq sent, so decode only once, after the signature check. */
// A slow POST must not be able to hold the request (and, pre-auth, the
// process's update admission) open indefinitely.
const LINQ_WEBHOOK_READ_TIMEOUT_MS = 30_000;

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(message), { status }));
    };
    const timer = setTimeout(() => fail(408, "Linq webhook body read timed out"), LINQ_WEBHOOK_READ_TIMEOUT_MS);
    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      if (bytes > MAX_LINQ_WEBHOOK_BYTES) return fail(413, "Linq webhook body is too large");
      chunks.push(buf);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => fail(400, "Could not read Linq webhook body"));
  });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** HMAC-SHA256 of the raw request body keyed by the workspace secret.  Linq
 *  publishes `X-Linq-Signature` as a hex digest; we verify with
 *  `timingSafeEqual` and bail out 401 when the digest does not match.
 *
 *  Fail closed when no secret is configured.  Local/dev unsigned delivery requires the explicit opt-out `LINQ_ALLOW_UNSIGNED_WEBHOOK=1`, which logs a loud warning. */
function verifySignature(rawBody: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.trim().toLowerCase();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** `handleLinqInbound` reasons that are deliberate drops, not failures. */
const FINAL_DROP_REASONS: ReadonlySet<string> = new Set(["no_bot_for_chat", "sender_blocked", "empty"]);

export interface LinqWebhookOptions {
  /** Pull the active bots list.  Injected so this module can stay decoupled
   *  from `server/index.ts`'s singleton store. */
  getBots(): BotRecord[];
  /** Acquire update admission AFTER the request is authenticated.  The route
   *  is registered with `deferAdmission`, so the ingress handler does not
   *  admit it up front: a slow unauthenticated POST must not be able to
   *  hold update quiescing hostage. */
  beginAdmission(): (() => void) | null;
}

export async function readLinqWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: LinqWebhookOptions,
): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    json(res, status, { ok: false, reason: "bad_body" });
    return;
  }
  // Env first; fall back to the resolved config, which carries the
  // Infisical-mapped value after secret hydration.
  const secret =
    process.env.LINQ_WEBHOOK_SECRET?.trim() ||
    loadConfig().imessageLinq?.webhookSecret?.trim() ||
    undefined;
  const header = (req.headers["x-linq-signature"] as string | undefined) ?? undefined;
  const allowUnsigned = process.env.LINQ_ALLOW_UNSIGNED_WEBHOOK?.trim() === "1";
  if (!secret) {
    if (!allowUnsigned) {
      console.error("[linq-webhook] LINQ_WEBHOOK_SECRET is unset; refusing unsigned webhook (set LINQ_ALLOW_UNSIGNED_WEBHOOK=1 for local-only unsigned delivery)");
      json(res, 503, { ok: false, reason: "webhook_secret_not_configured" });
      return;
    }
    console.warn("[linq-webhook] LINQ_ALLOW_UNSIGNED_WEBHOOK=1 — accepting unsigned webhook (dev only)");
  } else if (!verifySignature(rawBody, header, secret)) {
    json(res, 401, { ok: false, reason: "bad_signature" });
    return;
  }
  // Authenticated — only now take update admission.  A forged or stalled
  // POST never reaches this point holding the process open against an
  // update.
  const release = options.beginAdmission();
  if (!release) {
    json(res, 503, { ok: false, reason: "quiescing_for_update" });
    return;
  }
  try {
    await readLinqWebhookAuthed(res, options, rawBody);
  } finally {
    release();
  }
}

/** Parse and dispatch an already-authenticated Linq webhook body.  Runs
 *  under update admission acquired by `readLinqWebhook`. */
async function readLinqWebhookAuthed(
  res: ServerResponse,
  options: LinqWebhookOptions,
  rawBody: Buffer,
): Promise<void> {
  let parsedBody: unknown;
  try {
    parsedBody = parseJson(rawBody.toString("utf8")) as unknown;
  } catch {
    json(res, 400, { ok: false, reason: "bad_json" });
    return;
  }
  const parsed = linqEventSchema.safeParse(parsedBody);
  if (!parsed.success) {
    json(res, 400, { ok: false, reason: "bad_event" });
    return;
  }
  if (parsed.data.type === "message.received") {
    // Text may arrive as `body` or as text parts without a separate body;
    // fold the part values in so the message is not classified as empty.
    const textParts = (parsed.data.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.value === "string" && p.value.trim())
      .map((p) => (p.value as string).trim());
    const inbound = {
      chatId: parsed.data.chat_id,
      fromNumber: parsed.data.from,
      toNumber: parsed.data.to,
      text: (typeof parsed.data.body === "string" && parsed.data.body.trim()
        ? parsed.data.body.trim()
        : textParts.length ? textParts.join("\n") : undefined),
      media: parsed.data.parts
        ?.filter((p) => Boolean(p.url))
        .map((p) => ({ url: p.url as string, mimeType: p.mime_type, filename: p.filename })),
      group: Boolean(parsed.data.is_group),
      groupName: parsed.data.group_name,
      messageId: parsed.data.message_id,
      sentAt: parsed.data.sent_at ?? new Date().toISOString(),
    };
    const result = await handleLinqInbound(inbound, options.getBots());
    // Policy drops (no bound bot, blocked sender, empty message) are final:
    // answer 200 so Linq does not redeliver them.  Anything else means the
    // message never reached the bot, so answer 503 and let Linq retry.
    if (!result.dispatched && !FINAL_DROP_REASONS.has(result.reason ?? "")) {
      json(res, 503, { ok: false, retry: true, ...result });
      return;
    }
    json(res, 200, { ok: true, ...result });
    return;
  }
  json(res, 200, { ok: true, lifecycle: parsed.data.type });
}
