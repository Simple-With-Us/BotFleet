#!/usr/bin/env node
// Model Context Protocol (MCP) HTTP & SSE Server for BotFleet Admin.
// Serves remote MCP clients (such as MCP Agent on iOS, Cursor Cloud, and Claude Desktop)
// over HTTP and Server-Sent Events (SSE) by wrapping the core tool dispatch in scripts/mcp-server.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { processMcpMessage, TOOLS } from "./mcp-server.ts";

const PORT = Number(process.env.BOTFLEET_MCP_PORT || process.env.PORT || 8794);
const HOST = process.env.BOTFLEET_MCP_HOST || "127.0.0.1";
const HARNESS_URL = process.env.BOTFLEET_URL || "http://127.0.0.1:8799";
const AUTH_TOKEN = (process.env.BOTFLEET_MCP_TOKEN || process.env.BOTFLEET_TOKEN || "").trim();

// Ensure the underlying mcp-server.ts knows where to find the harness
if (!process.env.BOTFLEET_URL) {
  process.env.BOTFLEET_URL = HARNESS_URL;
}

interface SseSession {
  id: string;
  res: ServerResponse;
  createdAt: number;
  lastPing: number;
}

const activeSessions = new Map<string, SseSession>();

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [botfleet-mcp-sse] ${msg}\n`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [botfleet-mcp-sse] ERROR: ${msg}\n`);
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

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return false;
  return parts[1] === AUTH_TOKEN;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // 10 MB payload limit for tool calls/messages
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
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
        harness: HARNESS_URL,
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
    const sessionId = randomUUID();
    log(`New SSE client connecting... Session: ${sessionId} from ${req.socket.remoteAddress}`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Mcp-Session-Id": sessionId,
    });

    const session: SseSession = {
      id: sessionId,
      res,
      createdAt: Date.now(),
      lastPing: Date.now(),
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
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: (err as Error).message || "Parse error" },
      });
      return;
    }

    const sessionId = url.searchParams.get("sessionId") || (req.headers["mcp-session-id"] as string | undefined);

    if (sessionId && activeSessions.has(sessionId)) {
      // SSE Session route:
      // Acknowledge the POST request immediately with 202 Accepted,
      // and transmit the JSON-RPC reply over the active SSE stream.
      const session = activeSessions.get(sessionId)!;
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, status: "accepted" }) + "\n");

      try {
        const responseJson = await processMcpMessage(rawBody);
        if (responseJson && !session.res.writableEnded) {
          session.res.write(`event: message\ndata: ${responseJson}\n\n`);
        }
      } catch (err) {
        logError(`Error processing message for session ${sessionId}: ${err}`);
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

    // Direct Streamable HTTP POST route (no SSE session required):
    // Useful for clients using streamable HTTP transport or direct RPC calls
    try {
      const responseJson = await processMcpMessage(rawBody);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(responseJson || "{}\n");
    } catch (err) {
      logError(`Error processing direct POST message: ${err}`);
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
});

// Periodic keepalive ping to prevent intermediary proxies (like Cloudflare) from terminating idle SSE connections
const PING_INTERVAL_MS = 15_000;
const pingInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (session.res.writableEnded) {
      activeSessions.delete(id);
      continue;
    }
    session.res.write(": keepalive\r\n\r\n");
    session.lastPing = now;
  }
}, PING_INTERVAL_MS);

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, HOST, () => {
      log(`BotFleet MCP HTTP/SSE server listening on http://${HOST}:${PORT}`);
      log(`Harness target: ${HARNESS_URL}`);
      log(`Ready to accept connections from botfleetadmin.jays.services`);
      resolve();
    });
  });
}

function handleShutdown(signal: string): void {
  log(`Received ${signal}, shutting down gracefully...`);
  clearInterval(pingInterval);

  for (const session of activeSessions.values()) {
    try {
      session.res.end();
    } catch {}
  }
  activeSessions.clear();

  server.close(() => {
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
