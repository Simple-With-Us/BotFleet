#!/usr/bin/env node
// Model Context Protocol (MCP) HTTP & SSE Server for BotFleet Admin.
// Serves remote MCP clients (such as MCP Agent on iOS, Cursor Cloud, and Claude Desktop)
// over HTTP and Server-Sent Events (SSE) by wrapping the core tool dispatch in scripts/mcp-server.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { redactSecretsInText } from "../shared/redact.ts";

export const McpRequestSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
}).passthrough();

const PORT = Number(process.env.BOTFLEET_MCP_PORT || process.env.PORT || 8794);
const HOST = process.env.BOTFLEET_MCP_HOST || "127.0.0.1";
const HARNESS_URL = process.env.BOTFLEET_URL || "http://127.0.0.1:8799";
function resolveAuthToken(): string | null {
  // Runtime credentials must be injected through process.env; ~/.secrets is handoff-only.
  return (
    process.env.SEAT_MCP_TOKEN?.trim() ||
    process.env.BOTFLEET_MCP_TOKEN?.trim() ||
    process.env.BOTFLEET_TOKEN?.trim() ||
    null
  );
}

const AUTH_TOKEN = resolveAuthToken();
if (!AUTH_TOKEN) {
  console.error(
    "[FATAL] MCP Token is not configured in environment (BOTFLEET_MCP_TOKEN or SEAT_MCP_TOKEN); refusing to start unauthenticated."
  );
  process.exit(1);
}

// Ensure the underlying mcp-server.ts knows where to find the harness.
// mcp-server.ts captures BOTFLEET_URL at module scope, so the default has to be
// installed before that module is evaluated -- a static import would be too late,
// leaving configuredUrl undefined and the tool layer probing arbitrary ports.
if (!process.env.BOTFLEET_URL) {
  process.env.BOTFLEET_URL = HARNESS_URL;
}
const { processMcpMessage, TOOLS } = await import("./mcp-server.ts");

interface SseSession {
  id: string;
  res: ServerResponse;
  createdAt: number;
  lastPing: number;
  lastActive: number;
}

const MAX_SESSIONS = 64;
const IDLE_MS = 30 * 60_000;

const activeSessions = new Map<string, SseSession>();

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [botfleet-mcp-sse] ${msg}\n`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [botfleet-mcp-sse] ERROR: ${msg}\n`);
}

/** Downstream errors are built from untrusted MCP input, so their text can
 *  carry request or tool context.  Everything derived from one goes through the
 *  shared redactor and is clipped to a single log line. */
function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactSecretsInText(raw).replace(/\s+/g, " ").trim().slice(0, 300);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With, Baggage, Sentry-Trace, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Mcp-Session-Id");
}

function sendJson(res: ServerResponse, status: number, data: unknown, isHead = false): void {
  setCorsHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  if (isHead) {
    res.end();
  } else {
    res.end(JSON.stringify(data) + "\n");
  }
}

/** Bearer auth with the iOS app's double-"Bearer" workaround. Never logs
 *  the Authorization header: it carries the token.  The comparison is
 *  constant-time (length-guarded, like authorizedComms in server/index.ts) so a
 *  network caller cannot learn the token a byte at a time. */
function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) {
    logError(`Missing or invalid token for ${req.method} ${req.url}`);
    return false;
  }

  let authHeader = req.headers.authorization || "";
  authHeader = authHeader.replace(/^Bearer\s+Bearer\s+/i, "Bearer ");

  const parts = authHeader.split(" ");
  const providedToken = parts[1];

  const expected = Buffer.from(AUTH_TOKEN, "utf8");
  const got = Buffer.from(providedToken ?? "", "utf8");

  if (!authHeader.toLowerCase().startsWith("bearer ") || got.length !== expected.length || !timingSafeEqual(got, expected)) {
    logError(`Missing or invalid token for ${req.method} ${req.url}`);
    return false;
  }
  return true;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Buffer chunks and decode once: concatenating per-chunk strings
    // corrupts multi-byte UTF-8 sequences that split across TCP chunks.
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const parsed = McpRequestSchema.safeParse(raw);
          if (!parsed.success) {
            reject(parsed.error);
            return;
          }
          resolve(JSON.stringify(parsed.data));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    req.on("error", reject);
  });
}

const server = createServer((req, res) => {
  // createServer does not observe the promise a listener returns, so an
  // unhandled rejection here would take the process down.  Every throw is
  // caught and answered on the response instead.
  void handleRequest(req, res).catch(() => {
    logError("Unhandled request error");
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
    } else {
      res.end();
    }
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // llhttp accepts characters in the Host header value that URL rejects, so
  // parsing is guarded: a malformed Host is a 400, not a crashed process.
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "Invalid request target" });
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // Health and discovery endpoints
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/health" || pathname === "/api/health" || pathname === "/")) {
    sendJson(
      res,
      200,
      {
        status: "ok",
        app: "botfleet-admin-mcp",
        listen: `${HOST}:${PORT}`,
        // The harness target is deliberately absent: this route is
        // unauthenticated, so it must not reflect internal routing details.
        tools: TOOLS.length,
        activeSessions: activeSessions.size,
      },
      req.method === "HEAD",
    );
    return;
  }

  // Authentication check for MCP endpoints if configured
  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: Invalid or missing Bearer token" },
    });
    return;
  }

  // SSE Transport connection (GET)
  // Supports /mcp/sse, /mcp/sse/, /sse, /mcp
  const isSsePath = pathname === "/mcp/sse" || pathname === "/sse" || pathname === "/mcp";
  if (req.method === "GET" && isSsePath) {
    if (activeSessions.size >= MAX_SESSIONS) {
      sendJson(res, 503, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Too many MCP sessions" },
      });
      return;
    }

    const sessionId = randomUUID();
    // No peer address: an IP is personal data and the session id is already an
    // opaque client identifier.
    log(`New SSE client connecting... Session: ${sessionId}`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Mcp-Session-Id": sessionId,
    });

    const now = Date.now();
    const session: SseSession = {
      id: sessionId,
      res,
      createdAt: now,
      lastPing: now,
      lastActive: now,
    };
    activeSessions.set(sessionId, session);

    // Initial endpoint announcement event as per MCP specification
    // The client will use this URI to POST JSON-RPC messages
    const endpointUri = `/mcp/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);

    req.on("close", () => {
      log(`SSE client disconnected: ${sessionId}`);
      activeSessions.delete(sessionId);
    });

    return;
  }

  // POST endpoint for messages
  // Can be called via /mcp/messages, /messages, or directly on /mcp/sse, /mcp, /
  if (req.method === "POST") {
    let rawBody = "";
    try {
      rawBody = await readBody(req);
    } catch (err) {
      res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: (err instanceof Error ? err.message : String(err)) || "Parse error" },
      });
      return;
    }

    // Node hands this header back as string | string[], so it is narrowed here
    // rather than cast: an assertion would hide a repeated header behind a
    // lookup that could never match.
    const headerSession = req.headers["mcp-session-id"];
    const rawSession =
      url.searchParams.get("sessionId") || (Array.isArray(headerSession) ? headerSession[0] : headerSession);
    let sessionId: string | undefined;
    if (rawSession) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSession)) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32602, message: "Invalid session ID" },
        });
        return;
      }
      sessionId = rawSession;
    }

    if (sessionId && activeSessions.has(sessionId)) {
      // SSE Session route:
      // Acknowledge the POST request immediately with 202 Accepted,
      // and transmit the JSON-RPC reply over the active SSE stream.
      const session = activeSessions.get(sessionId)!;
      session.lastActive = Date.now();
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, status: "accepted" }) + "\n");

      try {
        const responseJson = await processMcpMessage(rawBody, undefined, sessionId);
        if (responseJson && !session.res.writableEnded) {
          session.res.write(`event: message\ndata: ${responseJson}\n\n`);
        }
      } catch (err) {
        logError(`Error processing message for session ${sessionId}`);
        if (!session.res.writableEnded) {
          const errReply = JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: (err as Error).message || "Internal error" },
          });
          session.res.write(`event: message\ndata: ${errReply}\n\n`);
        }
      }
      return;
    }

    if (sessionId) {
      // A POST that named a session we no longer hold is stale, not direct:
      // the closed connection, a restarted gateway, or a forged id.  Falling
      // through would run the tool on a channel the client is not reading,
      // duplicating side effects for tools flagged destructiveHint.
      sendJson(res, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32002, message: "Session not found" },
      });
      return;
    }

    // Direct Streamable HTTP POST route (no SSE session required):
    // Useful for clients using streamable HTTP transport or direct RPC calls
    try {
      const responseJson = await processMcpMessage(rawBody);
      if (responseJson == null) {
        // No response is expected (a notification, or an empty body).  The
        // Streamable HTTP transport reads that as 202; a 200 with a `{}` body
        // fails its JSON-RPC response check and errors the client right after
        // a successful initialize.
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(responseJson);
    } catch (err) {
      logError("Error processing direct POST message");
      sendJson(res, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: (err as Error).message || "Internal error" },
      });
    }
    return;
  }

  // Fallback for unhandled routes
  sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
}

// Periodic keepalive ping to prevent intermediary proxies (like Cloudflare) from terminating idle SSE connections
// and idle session sweep
const PING_INTERVAL_MS = 15_000;
const pingInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (session.res.writableEnded || now - session.lastActive > IDLE_MS) {
      try {
        session.res.end();
      } catch {}
      activeSessions.delete(id);
      continue;
    }
    session.res.write(": keepalive\r\n\r\n");
    session.lastPing = now;
  }
}, PING_INTERVAL_MS);
pingInterval.unref();

server.on("error", (err) => {
  logError(`MCP SSE server error: ${safeErrorText(err)}`);
});

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    let listening = false;
    const onError = (err: Error) => {
      if (!listening) reject(err);
    };
    server.once("error", onError);
    server.listen(PORT, HOST, () => {
      listening = true;
      server.removeListener("error", onError);
      log(`BotFleet MCP HTTP/SSE server listening on http://${HOST}:${PORT}`);
      log(`Ready to accept connections from botfleetadmin.jays.services`);
      resolve();
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    clearInterval(pingInterval);
    for (const session of activeSessions.values()) {
      try {
        session.res.end();
      } catch {}
    }
    activeSessions.clear();
    server.close(() => resolve());
  });
}

function handleShutdown(signal: string): void {
  log(`Received ${signal}, shutting down gracefully...`);
  void stopServer().then(() => {
    log("Server closed");
    process.exit(0);
  });

  // Force close after 5s grace period
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

if (process.argv[1] && (process.argv[1].endsWith("mcp-sse.ts") || process.argv[1].endsWith("mcp-sse.js"))) {
  startServer().catch((err) => {
    logError(`Failed to start server: ${err}`);
    process.exit(1);
  });
}
