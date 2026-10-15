import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { DeferredAdmissionRoute } from "../webhook-ingress.ts";
import type { ZulipHub } from "./hub.ts";

const MAX_BODY = 128 * 1024;
const TOKEN_MAX = 512;
const MAX_ACTIVE_REQUESTS = 64;
const BODY_DEADLINE_MS = 5_000;

function respond(res: ServerResponse, status: number, body: { error: string } | { response_not_required: true }): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => fail(408), BODY_DEADLINE_MS);
    timer.unref?.();
    const fail = (status: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new WebhookBodyError(status));
    };
    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_BODY) return fail(413);
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => fail(400));
    req.on("aborted", () => fail(400));
  });
}

class WebhookBodyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("invalid request body");
    this.status = status;
  }
}

const outgoingWebhookPayload = z.object({
  token: z.string().min(1).max(TOKEN_MAX),
  bot_email: z.string().max(320),
  message: z.object({ id: z.number().int().safe().positive() }).passthrough(),
}).passthrough();

/** Zulip's native outgoing hook is only a wake hint.  The body text is
 *  deliberately discarded; the hub fetches the message using the bound
 *  bot's REST key before routing it. */
export type OutgoingWebhookHub = Pick<ZulipHub, "outgoingWebhookAvailability" | "authorizeOutgoingWebhook" | "enqueueOutgoingWebhook">;

export function createZulipOutgoingWebhookRoute(
  getHub: () => OutgoingWebhookHub | undefined,
  beginAdmission: () => (() => void) | null,
): DeferredAdmissionRoute {
  let activeRequests = 0;
  return {
    deferAdmission: true,
    handler: async (req, res) => {
      let pathname: string;
      let parsedUrl: URL;
      try { parsedUrl = new URL(req.url ?? "/", "http://localhost"); pathname = parsedUrl.pathname; }
      catch { return respond(res, 400, { error: "Malformed webhook URL" }); }
      if (parsedUrl.search || parsedUrl.hash) return respond(res, 404, { error: "Unknown webhook endpoint" });
      const match = pathname.match(/^\/zulip\/outgoing\/([A-Z0-9][A-Z0-9_-]{0,47})$/);
      if (!match) return respond(res, 404, { error: "Unknown webhook endpoint" });
      if (req.method !== "POST") return respond(res, 405, { error: "Webhooks accept POST requests" });
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") return respond(res, 415, { error: "Expected JSON" });

      const hub = getHub();
      if (!hub) return respond(res, 503, { error: "Webhook identity is not ready" });
      const availability = hub.outgoingWebhookAvailability(match[1]!);
      if (availability === "unknown") {
        req.resume();
        return respond(res, 404, { error: "Unknown webhook endpoint" });
      }
      if (availability !== "ready") {
        req.resume();
        return respond(res, 503, { error: "Webhook identity is not ready" });
      }
      if (activeRequests >= MAX_ACTIVE_REQUESTS) {
        req.resume();
        return respond(res, 503, { error: "Webhook receiver is busy" });
      }
      activeRequests += 1;

      try {
        let rawBody: string;
        try {
          rawBody = await readBody(req);
        } catch (error) {
          const status = error instanceof WebhookBodyError ? error.status : 400;
          return respond(res, status, { error: "Invalid webhook payload" });
        }
        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return respond(res, 400, { error: "Invalid webhook payload" });
        }
        const parsed = outgoingWebhookPayload.safeParse(json);
        if (!parsed.success) {
          return respond(res, 400, { error: "Invalid webhook payload" });
        }
        const { token, bot_email: email, message: { id: messageId } } = parsed.data;
        const auth = hub.authorizeOutgoingWebhook(match[1]!, email, token);
        if (auth !== "ok") return respond(res, auth === "unknown" ? 404 : auth === "unavailable" ? 503 : 401,
          { error: auth === "unauthorized" ? "Invalid webhook credentials" : "Webhook identity is not ready" });
        const release = beginAdmission();
        if (!release) return respond(res, 503, { error: "BotFleet is quiescing for an update" });
        try {
          const accepted = hub.enqueueOutgoingWebhook(match[1]!, messageId);
          if (accepted === "unknown") return respond(res, 404, { error: "Unknown webhook endpoint" });
          if (accepted === "unavailable") return respond(res, 503, { error: "Webhook identity is not ready" });
          return respond(res, 200, { response_not_required: true });
        } catch {
          return respond(res, 503, { error: "Webhook could not be durably queued" });
        } finally {
          release();
        }
      } finally {
        activeRequests -= 1;
      }
    },
  };
}
