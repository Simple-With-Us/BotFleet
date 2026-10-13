// The MCP servers a turn hands an agent that mounts them as stdio children:
// the harness's own proxies (peer agents, connected apps, computers, phone,
// recall) and the person's own servers. Shared by the ACP family so custom
// URL servers ride BotFleet's remote proxy with the same handshake as Test.
import type { SendTurnInput } from "../contracts.ts";
import { turnComputerMounts } from "../computer-grants.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { gateServer, mcpStdioServer } from "../mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

export interface TurnStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;

/** A URL server is always mounted as BotFleet's remote proxy, even for an
 * agent that speaks HTTP itself: the proxy opens the connection with the same
 * minimal handshake as Settings → Test (mcp-http.ts), where an agent's own MCP
 * client adds capability fields a strict server refuses. */
export function turnStdioMcpServers(
  turn: Pick<SendTurnInput, "integrations" | "toolScope"> & { threadId?: string },
): TurnStdioMcpServer[] {
  const servers: TurnStdioMcpServer[] = [];
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> } | undefined) => {
    if (server) servers.push({ name, command: server.command, args: server.args, env: server.env ?? {} });
  };
  add("agents", turn.integrations?.agents);
  add("composio", turn.integrations?.composio);
  for (const mount of turnComputerMounts(turn.integrations)) {
    if (mount.box) {
      add(mount.name, {
        command: process.execPath,
        args: [COMPUTER_PROXY_PATH],
        env: { ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(mount.box) },
      });
    } else if (mount.stdio) {
      add(mount.name, mount.stdio);
    }
  }
  add("phone", turn.integrations?.phone);
  add("qdrant", turn.integrations?.qdrant);
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if (servers.some((existing) => existing.name === name)) continue;
    const stdio = "url" in server ? mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } }) : server;
    if (!stdio) continue;
    servers.push({ name, command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} });
  }
  if (turn.toolScope === undefined) return servers;
  return servers.filter((server) => canUseMcpServer(turn.toolScope, server.name)).map((server) => {
    const gated = gateServer({
      name: server.name,
      server: { command: server.command, args: server.args, env: server.env },
      threadId: turn.threadId ?? "thread",
      budget: 0,
      toolScope: turn.toolScope,
      nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });
    if (!gated) throw new Error("Tool selection requires an MCP gate.");
    return { name: server.name, command: gated.command, args: gated.args, env: gated.env };
  });
}
