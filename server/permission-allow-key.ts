import { isReadOnlyTool } from "../shared/outbound.ts";

import { offerableApprovalKey, type FileWriteCheck } from "./auto-approve.ts";
import type { AppConfig } from "./config.ts";
import { engineMcpServers } from "./mcp-server-config.ts";
import { providerMcpTool, providerToolAllowKey } from "./provider-tool-allow.ts";

export interface ResolvedPermissionAllowKey {
  allowKey?: string;
  allowKeyWarnWrite?: boolean;
  mcpToolAllowKey?: string | null;
}

/** The allowKey stamped on a permission card, plus the MCP grant key for autoVerdict. */
export function resolvePermissionAllowKey(
  cfg: AppConfig,
  bot: { modelSelection: { instanceId: string }; mcpServers?: string[] },
  tool: string,
  summary: string,
  context: {
    providerInstanceId?: string;
    scope?: "local-computer" | "disposable-computer";
    fileWrite?: FileWriteCheck;
  },
): ResolvedPermissionAllowKey {
  const providerInstanceId = context.providerInstanceId ?? bot.modelSelection.instanceId;
  const configured = engineMcpServers(cfg, bot.mcpServers);
  const parsed = providerMcpTool(tool);
  if (parsed && configured[parsed.server] !== undefined) {
    const mcpToolAllowKey = providerToolAllowKey(providerInstanceId, tool, configured[parsed.server]!);
    if (mcpToolAllowKey) {
      return {
        allowKey: mcpToolAllowKey,
        allowKeyWarnWrite: !isReadOnlyTool(tool),
        mcpToolAllowKey,
      };
    }
  }
  const native = offerableApprovalKey(tool, summary, context.scope, { fileWrite: context.fileWrite });
  return native ? { allowKey: native, mcpToolAllowKey: null } : { mcpToolAllowKey: null };
}
