// Durable, exact grants for tools from configured custom MCP servers.
//
// The key binds the person's approval to the provider instance, the exact
// MCP server/tool pair and that server's current configuration. Editing the
// server invalidates the grant instead of silently transferring authority to
// a different endpoint or command that happens to reuse the same name.
//
// Ported from OpenMausBot PR #2708 (MIT), milind-soni/OpenMausBot, with
// BotFleet changes: write-shaped MCP tools may be remembered too (with a
// separate UI warning), not only read-shaped tools.
import { createHash } from "node:crypto";

import { isOutboundTool } from "../shared/outbound.ts";

import type { CustomMcpServer } from "./mcp-server-config.ts";

export interface ProviderMcpTool {
  server: string;
  tool: string;
}

/** Built-in harness MCP proxies never get a durable per-tool grant here. */
const HARNESS_MCP_SERVERS = new Set([
  "agents",
  "composio",
  "qdrant",
  "phone",
  "botfleet",
  "computer",
]);

/** Provider-facing MCP tool names are mcp__<server>__<tool>. */
export function providerMcpTool(name: string): ProviderMcpTool | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp" || !parts[1] || !parts.slice(2).join("__")) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** True when this MCP tool may offer a durable always-allow grant. */
export function isProviderMcpToolGrantCandidate(name: string): boolean {
  const parsed = providerMcpTool(name);
  if (!parsed) return false;
  if (HARNESS_MCP_SERVERS.has(parsed.server)) return false;
  if (parsed.server.startsWith("computer")) return false;
  if (isOutboundTool(name)) return false;
  return true;
}

/** A grant candidate for an exact MCP tool on a configured server. */
export function providerToolAllowKey(
  providerInstanceId: string,
  name: string,
  serverConfig: CustomMcpServer,
): string | null {
  if (!providerInstanceId || !isProviderMcpToolGrantCandidate(name)) return null;
  const parsed = providerMcpTool(name);
  if (!parsed) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify(serverConfig)).digest("hex").slice(0, 16);
  return `provider-tool:${providerInstanceId}:${parsed.server}:${parsed.tool}:${fingerprint}`;
}

/** Whether a saved provider-tool grant covers this permission ask. */
export function providerToolAllowed(bot: { alwaysAllow?: string[] }, toolAllowKey: string | null | undefined): boolean {
  return Boolean(toolAllowKey && bot.alwaysAllow?.includes(toolAllowKey));
}
