import { beforeAll, describe, expect, it } from "vitest";

// Point BOTFLEET_MCP_PORT to a dynamic port for testing
const TEST_PORT = 38794 + Math.floor(Math.random() * 1000);
process.env.BOTFLEET_MCP_PORT = String(TEST_PORT);
process.env.BOTFLEET_MCP_HOST = "127.0.0.1";
process.env.BOTFLEET_URL = "http://127.0.0.1:8799";

describe("BotFleet MCP HTTP & SSE server", () => {
  let serverModule: typeof import("../scripts/mcp-sse.ts");

  beforeAll(async () => {
    serverModule = await import("../scripts/mcp-sse.ts");
    await serverModule.startServer();
  });

  it("serves health check on /health and /api/health", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.app).toBe("botfleet-admin-mcp");
    expect(body.status).toBe("ok");
    expect(body.tools).toBeGreaterThan(0);

    const apiRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
    expect(apiRes.status).toBe(200);
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
      headers: { "Content-Type": "application/json" },
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
    const initData = (await initRes.json()) as any;
    expect(initData.result.serverInfo.name).toBe("botfleet-mcp");

    const toolsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(toolsRes.status).toBe(200);
    const toolsData = (await toolsRes.json()) as any;
    expect(Array.isArray(toolsData.result.tools)).toBe(true);
    expect(toolsData.result.tools.some((t: any) => t.name === "get_system_health")).toBe(true);
  });

  it("establishes SSE connection, parses endpoint, and receives tool response over SSE stream", async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp/sse/`, {
      headers: { Accept: "text/event-stream" },
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
      headers: { "Content-Type": "application/json" },
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
    let messageData: any = null;

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
            const parsed = JSON.parse(dataStr);
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
    expect(messageData.result.serverInfo.name).toBe("botfleet-mcp");

    controller.abort();
  });
});
