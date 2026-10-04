import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point BOTFLEET_MCP_PORT to a dynamic port for testing
const TEST_PORT = 38794 + Math.floor(Math.random() * 1000);
process.env.BOTFLEET_MCP_PORT = String(TEST_PORT);
process.env.BOTFLEET_MCP_HOST = "127.0.0.1";
process.env.BOTFLEET_URL = "http://127.0.0.1:8799";
// Generated per run rather than committed: a credential-shaped literal does
// not belong in versioned source, even a synthetic one.
const TEST_TOKEN = randomUUID();
process.env.BOTFLEET_MCP_TOKEN = TEST_TOKEN;

const AUTH_HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` };

/** Narrow a decoded JSON body to a plain object without an `any` escape, so a
 *  malformed response fails the test instead of silently reading undefined. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a JSON object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

async function readJson(res: Response, label: string): Promise<Record<string, unknown>> {
  return asRecord(await res.json(), label);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a JSON array, got ${typeof value}`);
  }
  return value;
}

describe("BotFleet MCP HTTP & SSE server", () => {
  let serverModule: typeof import("../scripts/mcp-sse.ts");

  beforeAll(async () => {
    serverModule = await import("../scripts/mcp-sse.ts");
    await serverModule.startServer();
  });

  afterAll(async () => {
    if (serverModule?.stopServer) {
      await serverModule.stopServer();
    }
  });

  it("serves health check on /health and /api/health", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await readJson(res, "health response");
    expect(body.app).toBe("botfleet-admin-mcp");
    expect(body.status).toBe("ok");
    expect(typeof body.tools).toBe("number");

    const apiRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
    expect(apiRes.status).toBe(200);
  });

  it("keeps the internal harness target out of the unauthenticated health response", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const body = await readJson(res, "health response");
    expect(body).not.toHaveProperty("harness");
  });

  it("rejects MCP requests that carry no token or the wrong token", async () => {
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      });

    const missing = await call({ "Content-Type": "application/json" });
    expect(missing.status).toBe(401);
    const missingBody = await readJson(missing, "401 response");
    expect(asRecord(missingBody.error, "error")).toHaveProperty("code", -32001);

    const wrong = await call({ "Content-Type": "application/json", Authorization: "Bearer not-the-token" });
    expect(wrong.status).toBe(401);

    const correct = await call(AUTH_HEADERS);
    expect(correct.status).toBe(200);
  });

  it("answers a malformed Host header with 400 instead of crashing the adapter", async () => {
    // llhttp accepts a space in the Host value but URL does not, so this used to
    // throw ERR_INVALID_URL out of an unobserved async listener: the process
    // died and the client saw a reset, from any unauthenticated caller.
    const status = await new Promise<number | string>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: TEST_PORT,
        path: "/mcp",
        method: "GET",
        headers: { Host: "a b" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? "no status");
      });
      req.on("error", (err) => resolve(`socket error: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
      req.end();
    });
    expect(status).toBe(400);

    // The adapter is still serving after the malformed request.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
  });

  it("handles CORS OPTIONS preflight", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp/sse/`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("handles direct streamable HTTP POST for JSON-RPC initialize and tools/list", async () => {
    const initRes = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const initData = await readJson(initRes, "initialize response");
    expect(asRecord(asRecord(initData.result, "result").serverInfo, "serverInfo")).toMatchObject({
      name: "botfleet-mcp",
    });

    const toolsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(toolsRes.status).toBe(200);
    const toolsData = await readJson(toolsRes, "tools/list response");
    const tools = asArray(asRecord(toolsData.result, "result").tools, "tools/list tools");
    expect(tools.some((t) => asRecord(t, "tool").name === "get_system_health")).toBe(true);
  });

  it("answers a notification with 202 and no JSON-RPC body", async () => {
    // A null dispatch result means "no response expected".  The Streamable HTTP
    // transport reads that as 202; a 200 with a `{}` body fails its JSON-RPC
    // response check, which errors the client right after initialize.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("404s a session-scoped POST for a session it no longer holds", async () => {
    // The previous behaviour fell through to the direct-execution branch, so a
    // client retrying after its stream was reaped re-ran the tool on a channel
    // it was not reading, duplicating destructive side effects.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp/messages?sessionId=${randomUUID()}`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    const body = await readJson(res, "404 response");
    expect(asRecord(body.error, "error")).toHaveProperty("code", -32002);
  });

  it("answers an oversized body with a JSON-RPC error instead of resetting the socket", async () => {
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "get_system_health", arguments: { padding: "x".repeat(10 * 1024 * 1024 + 1024) } },
    });
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: oversized,
    });
    expect(res.status).toBe(400);
    const body = await readJson(res, "400 response");
    expect(asRecord(body.error, "error")).toHaveProperty("code", -32700);
  });

  it("establishes SSE connection, parses endpoint, and receives tool response over SSE stream", async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp/sse/`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // Read the initial endpoint event
    let buffer = "";
    let endpointUri = "";

    while (!endpointUri) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          endpointUri = line.slice(6).trim();
          break;
        }
      }
    }

    expect(endpointUri).toContain("/mcp/messages?sessionId=");

    // Post a message to that endpoint
    const postRes = await fetch(`http://127.0.0.1:${TEST_PORT}${endpointUri}`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sse-test", version: "1.0.0" },
        },
      }),
    });
    expect(postRes.status).toBe(202);

    // Read response from the SSE stream
    let messageReceived = false;
    let messageData: Record<string, unknown> | null = null;

    while (!messageReceived) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const rawEvents = buffer.split("\n\n");
      for (const rawEvent of rawEvents) {
        const lines = rawEvent.split("\n").map((l) => l.trim()).filter(Boolean);
        const eventType = lines.find((l) => l.startsWith("event: "))?.slice(7).trim();
        const dataStr = lines.find((l) => l.startsWith("data: "))?.slice(6).trim();

        if (eventType === "message" && dataStr) {
          try {
            const parsed = asRecord(JSON.parse(dataStr), "SSE message");
            if (parsed.id === 100) {
              messageData = parsed;
              messageReceived = true;
              break;
            }
          } catch {}
        }
      }
    }

    expect(messageReceived).toBe(true);
    expect(asRecord(asRecord(messageData?.result, "result").serverInfo, "serverInfo")).toMatchObject({
      name: "botfleet-mcp",
    });

    controller.abort();
  });
});
