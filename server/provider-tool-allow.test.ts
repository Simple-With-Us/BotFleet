import { describe, expect, it } from "vitest";

import { isProviderMcpToolGrantCandidate, providerMcpTool, providerToolAllowKey } from "./provider-tool-allow.ts";

describe("provider MCP tool grants", () => {
  it("parses the server and exact tool from provider-facing names", () => {
    expect(providerMcpTool("mcp__linear__list_issues")).toEqual({ server: "linear", tool: "list_issues" });
    expect(providerMcpTool("mcp__my_server__get_item__v2")).toEqual({ server: "my_server", tool: "get_item__v2" });
    expect(providerMcpTool("Bash")).toBeNull();
    expect(providerMcpTool("mcp____list_issues")).toBeNull();
  });

  it("creates durable keys for read and write tools on custom servers", () => {
    const config = { type: "http" as const, url: "https://linear.example/mcp", headers: { Authorization: "secret" } };
    expect(providerToolAllowKey("claude", "mcp__linear__list_issues", config))
      .toMatch(/^provider-tool:claude:linear:list_issues:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__linear__create_issue", config))
      .toMatch(/^provider-tool:claude:linear:create_issue:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__computer__click", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__agents__ask_bot", config)).toBeNull();
    expect(providerToolAllowKey("", "mcp__linear__list_issues", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__composio__GMAIL_SEND_EMAIL", config)).toBeNull();
  });

  it("invalidates a key when the configured server changes", () => {
    const first = providerToolAllowKey("claude", "mcp__linear__list_issues", { type: "http", url: "https://one.example/mcp", headers: {} });
    const second = providerToolAllowKey("claude", "mcp__linear__list_issues", { type: "http", url: "https://two.example/mcp", headers: {} });
    expect(first).not.toBe(second);
  });

  it("names grant candidates", () => {
    expect(isProviderMcpToolGrantCandidate("mcp__linear__list_issues")).toBe(true);
    expect(isProviderMcpToolGrantCandidate("mcp__linear__save_issue")).toBe(true);
    expect(isProviderMcpToolGrantCandidate("mcp__computer__click")).toBe(false);
  });
});
