import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

describe("Qdrant Agent RAG MCP Proxy", () => {
  it("initializes and advertises Qdrant RAG tools via MCP stdio protocol", async () => {
    const child = spawn(process.execPath, [SPAWNED_PROXIES.qdrant], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OMB_QDRANT_URL: "http://127.0.0.1:6333",
        OMB_QDRANT_COLLECTION: "test-botfleet-rag",
      },
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    // 1. Send initialize
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) + "\n"
    );

    // 2. Send tools/list
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) + "\n"
    );

    // Wait for responses
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 3000);
    });

    child.kill("SIGKILL");

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const initResp = JSON.parse(lines[0]);
    expect(initResp.id).toBe(1);
    expect(initResp.result.serverInfo.name).toBe("botfleet-qdrant-rag");

    const toolsResp = JSON.parse(lines[1]);
    expect(toolsResp.id).toBe(2);
    const toolNames = toolsResp.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("recall_search");
    expect(toolNames).toContain("recall_contribute");
    expect(toolNames).toContain("recall_stats");
    expect(toolNames).toContain("qdrant_search");
    expect(toolNames).toContain("qdrant_store");
    expect(toolNames).toContain("qdrant_get_context");
    expect(toolNames).toContain("qdrant_list_collections");
  });
});
