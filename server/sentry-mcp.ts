// Manual MCP server spans for BotFleet's stdio JSON-RPC MCP entry
// (`scripts/mcp-server.ts`).  That server is not built on
// `@modelcontextprotocol/sdk`'s `McpServer`, so `wrapMcpServerWithSentry`
// cannot attach.  We emit the same `mcp.server` / `tools/call` shape the
// wrapper would.  Connector/CUA bridges that only forward bytes are out of
// scope — they define no tools here.
import { getSentry, isSentryActive } from "./sentry.ts";

export type McpToolSpanOpts = {
  toolName: string;
  requestId?: string | number | null;
  /** When false, skip argument attribute capture even if genAI inputs are on. */
  recordArguments?: boolean;
};

/** Run an MCP `tools/call` under an `mcp.server` span when Sentry is active. */
export async function withMcpToolCallSpan<T>(
  opts: McpToolSpanOpts,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isSentryActive()) return fn();
  const Sentry = getSentry();
  if (!Sentry?.startSpan) return fn();

  const toolName = (opts.toolName || "tool").trim() || "tool";
  return Sentry.startSpan(
    {
      op: "mcp.server",
      name: `tools/call ${toolName}`,
      attributes: {
        "mcp.tool.name": toolName,
        "mcp.method.name": "tools/call",
        "mcp.transport": "stdio",
        "network.transport": "pipe",
        ...(opts.requestId != null ? { "mcp.request.id": String(opts.requestId) } : {}),
      },
    },
    async (span) => {
      try {
        const result = await fn();
        span.setAttribute("mcp.tool.result.is_error", false);
        return result;
      } catch (error) {
        span.setAttribute("mcp.tool.result.is_error", true);
        throw error;
      }
    },
  );
}
