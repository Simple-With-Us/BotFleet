import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { customMcpServers } from "./mcp-server-config.ts";

describe("customMcpServers", () => {
  const cfg = (mcpServers: AppConfig["mcpServers"]): AppConfig => ({ mcpServers });

  it("returns enabled stdio and http servers", () => {
    expect(customMcpServers(cfg({
      linear: { command: "node", args: ["mcp.js"], env: { TOKEN: "x" } },
      docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "bearer" } },
      off: { command: "node", enabled: false },
    }))).toEqual({
      linear: { command: "node", args: ["mcp.js"], env: { TOKEN: "x" } },
      docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "bearer" } },
    });
  });

  it("filters to a bot list when provided", () => {
    const all = {
      notes: { command: "node", args: ["notes.js"] },
      linear: { command: "node", args: ["linear.js"] },
    };
    expect(Object.keys(customMcpServers(cfg(all), ["linear"]))).toEqual(["linear"]);
  });
});
