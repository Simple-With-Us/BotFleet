import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

import { parseJson, type JsonValue } from "./schema.ts";
import { getSentry, isSentryActive } from "./sentry.ts";
import type { WebhookManager } from "./webhooks.ts";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const statusErrorSchema = z.object({ status: z.number().int().optional() });
const serverAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) });

export interface WebhookIngress {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
}

function json(res: ServerResponse, status: number, body: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_WEBHOOK_BODY_BYTES) return fail(413, "Webhook body is too large");
      raw += chunk;
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(raw);
    });
    req.on("error", () => fail(400, "Could not read webhook body"));
  });
}

function parsePayload(raw: string, contentType: string): JsonValue {
  if (!raw) return {};
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return parseJson(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON webhook body"), { status: 400 });
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerSecret(req: IncomingMessage): string {
  const authorization = header(req, "authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || header(req, "x-botfleet-secret")?.trim() || "";
}

function deliveryId(req: IncomingMessage): string | undefined {
  const explicit = (
    header(req, "idempotency-key") ??
    header(req, "x-webhook-id") ??
    header(req, "x-github-delivery") ??
    header(req, "webhook-id")
  )?.trim() || undefined;
  if (explicit) return explicit;
  // The configured Sentry custom integration identifies issue deliveries
  // with Request-ID.  A generic proxy request ID is not an event identity.
  const requestId = header(req, "request-id")?.trim();
  if (header(req, "sentry-hook-resource") === "issue" && requestId && /^[a-f0-9]{32}$/i.test(requestId)) {
    return `sentry:${requestId.toLowerCase()}`;
  }
  return undefined;
}

function eventName(req: IncomingMessage): string | undefined {
  return (
    header(req, "x-botfleet-event") ??
    header(req, "x-github-event") ??
    header(req, "x-webhook-event") ??
    header(req, "x-event-type") ??
    header(req, "ce-type")
  )?.trim() || undefined;
}

export function createWebhookIngressHandler(
  manager: WebhookManager,
  beginAdmission: () => (() => void) | null = () => () => {},
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { app: "botfleet-webhooks", ready: true });
    }
    if (req.method === "GET" && url.pathname === "/.well-known/apple-app-site-association") {
      return json(res, 200, {
        applinks: {
          details: [
            {
              appIDs: ["CC8UTF7ATG.app.botfleet.ios", "CC8UTF7ATG.app.botfleet.macos"],
              components: [{ "/": "/*" }],
            },
          ],
        },
      });
    }
    const match = url.pathname.match(/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
    if (!match) return json(res, 404, { error: "Unknown webhook endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Webhooks accept POST requests" });

    let releaseAdmission: (() => void) | null = null;
    try {
      const pathSecret = match[2] ? decodeURIComponent(match[2]) : "";
      const secret = pathSecret || bearerSecret(req);
      // Reject bad capability URLs before buffering or parsing attacker input.
      if (!manager.authorize(match[1], secret)) {
        manager.recordRejected(match[1], 401, "Invalid webhook URL or secret", {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
        return json(res, 401, { error: "Invalid webhook URL or secret" });
      }
      releaseAdmission = beginAdmission();
      if (!releaseAdmission) return json(res, 503, { error: "BotFleet is quiescing for an update" });
      const raw = await readRawBody(req);
      const contentType = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
      const payload = parsePayload(raw, contentType);
      const result = manager.receive(match[1], secret, {
        payload,
        contentType,
        eventName: eventName(req),
        userAgent: header(req, "user-agent"),
        deliveryId: deliveryId(req),
      });
      return json(res, 202, { accepted: true, ...result });
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      const message = error instanceof Error ? error.message : String(error);
      // Manager-level validation records its own rejection with the parsed
      // payload. Receiver-level failures happen earlier, so record metadata
      // here without buffering untrusted data a second time.
      if (status === 400 || status === 413) {
        manager.recordRejected(match[1], status, message, {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
      }
      // A 500-class failure is the receiver breaking, not a caller sending
      // rubbish, so it is the one branch worth an Issue.  The body is
      // untrusted and can carry credentials, so these explicit tags carry
      // neither the body nor the endpoint id.  That promise covers only the
      // tags below: the SDK also attaches the request itself (URL, culprit,
      // transaction name), and the path's secret segment is kept out of
      // those by `scrubSentryPayload` in server/sentry.ts, not by anything
      // in this file.  The `/hooks/*` filter there drops only the incoming
      // server span; a span started under the request still carries it.
      if (status >= 500 && isSentryActive()) {
        getSentry()?.captureException(error instanceof Error ? error : new Error(message), {
          tags: { component: "webhook-ingress", "http.status_code": String(status) },
        });
      }
      return json(res, status, { error: message });
    } finally {
      releaseAdmission?.();
    }
  };
}

export async function listenWebhookIngress(
  manager: WebhookManager,
  options: { host?: string; port: number; beginAdmission?: () => (() => void) | null },
): Promise<WebhookIngress> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(createWebhookIngressHandler(manager, options.beginAdmission));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = serverAddressSchema.safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("Webhook receiver did not get a TCP address");
  }
  return { server, host, port: address.data.port, baseUrl: `http://${host}:${address.data.port}` };
}

export function webhookCredential(baseUrl: string, endpointId: string, secret: string) {
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
  return {
    endpointUrl,
    secret,
    url: `${endpointUrl}/${encodeURIComponent(secret)}`,
  };
}
