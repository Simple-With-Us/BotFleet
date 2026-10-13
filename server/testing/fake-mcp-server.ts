import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "healthy";
if (mode === "silent") setInterval(() => {}, 60_000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
    if (frame.method === "initialize") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1" },
        },
      })}\n`);
    }
    if (frame.method === "tools/list") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        // FAKE_MCP_TOOLS_FILE: a JSON array of tools to list instead
        result: { tools: process.env.FAKE_MCP_TOOLS_FILE ? JSON.parse(readFileSync(process.env.FAKE_MCP_TOOLS_FILE, "utf8")) : [{
          name: "read_notes",
          description: process.env.FAKE_MCP_DESCRIPTION ?? "Read saved notes",
          inputSchema: { type: "object", properties: {} },
        }] },
      })}\n`);
    }
    if (frame.method === "tools/call") {
      if (process.env.FAKE_MCP_CALL_FILE) writeFileSync(process.env.FAKE_MCP_CALL_FILE, JSON.stringify(frame.params));
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id,
        result: { content: [{ type: "text", text: "Fixture notes read through MCP." }] } })}\n`);
    }
  });
}
