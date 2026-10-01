// Stock `@deepseek-ai/dsh-acp` rejects non-empty session/new mcpServers.
// BotFleet still builds the same stdio mounts every other ACP engine gets.
// YAML overlay helpers live in Harness; this file is the spawn glue that
// needs SPAWNED_PROXIES.dshAcpBridge (packaged Electron stdio bridge).
import {
  writeDshMcpPatch,
  isDshEngineCli,
} from "harness/dsh/mcp-patch";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { acpMcpServers, type AcpSpawnRewrite } from "./core.ts";

export {
  DSH_MCP_PATCH_PREFIX,
  dshMcpPatchYaml,
  dshMcpServerName,
  isDshEngineCli,
  writeDshMcpPatch,
} from "harness/dsh/mcp-patch";

export function dshWrapSpawn(
  cli: string,
  args: string[],
  turn: Pick<SendTurnInput, "integrations">,
): AcpSpawnRewrite {
  if (!isDshEngineCli(cli)) return { cli, args };
  const servers = acpMcpServers(turn);
  if (servers.length === 0) return { cli, args };
  const patch = writeDshMcpPatch(servers);
  return {
    cli: process.execPath,
    args: [SPAWNED_PROXIES.dshAcpBridge, "--", cli, ...args, "--patch", patch],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
