// The MCP servers a bot may mount:  the ones the workspace shares, and the
// ones that belong to this bot alone.
//
// The gap this closes is real and it is old.  `AppConfig.mcpServers` has
// held a workspace-wide map of MCP servers since the config shape was
// written, and `BotRecord.mcpServers` has held a per-bot name list beside
// it — but NOTHING ever populated `turn.integrations.custom`, which is
// the one field the mount point (`server/drivers/turn-mcp.ts`) reads.  So
// a configured server was stored, listed, and never mounted:  the feature
// existed as a shape and not as a behaviour.
//
// Two scopes, one resolution:
//
//   - SHARED servers live in the workspace config and every bot may mount
//     them, unless the bot's own list narrows it to a subset.
//   - BOT servers live on the bot record and mount for that bot only.
//
// A name that exists in both scopes resolves to the bot's own, because the
// more specific grant is the one the person meant.
//
// The rules this module keeps, and why:
//
//   1. A bad entry never takes the fleet down.  A server that does not
//      parse is skipped with one logged reason, exactly like the
//      workspace's own reader does.
//   2. A disabled server never mounts.  `enabled: false` is how a server
//      that was added but not yet tried is held back.
//   3. The name rules are the registry's own (`server/mcp-registry.ts`):
//      lowercase, 1-32 characters, and never one of the harness's own
//      reserved names, because a custom server named `agents` could
//      redirect the harness's own peer proxy.
//   4. A credential in `env` or `headers` never reaches a listing.  The
//      listing reports the NAMES of those fields, never their values.

import { z } from "zod";

import type { AppConfig } from "./config.ts";
import type { McpServerSpec } from "./contracts.ts";
import type { BotRecord } from "./store.ts";
import { isJsonObject, type JsonValue } from "./schema.ts";
import {
  isHarnessOwnedMcpEnvName,
  isRemoteMcpServer,
  mcpServerNameError,
  type StoredMcpServer,
} from "./mcp-registry.ts";

/** The servers this bot may mount, by name. */
export interface McpServersByName {
  [serverName: string]: StoredMcpServer;
}

/** How many servers one bot may hold.  The same bound the workspace's own
 * registry keeps, so a bot's list cannot grow without limit either. */
export const MAX_BOT_MCP_SERVERS = 20;

/** The scope a server is mounted in. */
export type McpServerScope = "shared" | "bot";

/** One server as the person sees it in a listing:  names of secrets, never
 * their values.  Two variants, because the listing itself has two:  a
 * remote server has a url and header names, a local one a command and env
 * names. */
export interface RemoteMcpServerView {
  name: string;
  scope: McpServerScope;
  type: "http" | "sse";
  url: string;
  headerKeys: string[];
  enabled: boolean;
}

export interface StdioMcpServerView {
  name: string;
  scope: McpServerScope;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}

export type McpServerView = RemoteMcpServerView | StdioMcpServerView;

const stringRecord = z.record(z.string(), z.string());

const stdioServerSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: stringRecord.default({}),
  enabled: z.boolean().default(true),
});

const remoteServerSchema = z.object({
  type: z.enum(["http", "sse"]).default("http"),
  url: z.string().trim().min(1),
  headers: stringRecord.default({}),
  enabled: z.boolean().default(true),
});

/** The shape a stored server is read back in.  It is deliberately the
 * permissive one the workspace's own reader uses:  a stored entry that
 * does not parse is skipped, not a fatal error.
 *
 * The value is the config's own JSON type, so the parser is the boundary
 * where an untrusted stored entry becomes a server. */
export function parseMcpServerEntry(
  name: string,
  raw: JsonValue,
): { ok: true; server: StoredMcpServer } | { ok: false; reason: string } {
  const nameProblem = mcpServerNameError(name);
  if (nameProblem) return { ok: false, reason: nameProblem };
  if (!isJsonObject(raw)) return { ok: false, reason: "expected an object" };
  const record: Record<string, JsonValue> = raw;

  const remote = remoteServerSchema.safeParse(record);
  if (remote.success) {
    const badEnv = Object.keys(remote.data.headers).find((key) => isHarnessOwnedMcpEnvName(key));
    if (badEnv) return { ok: false, reason: `header “${badEnv}” is reserved by the harness` };
    return {
      ok: true,
      server: {
        type: remote.data.type,
        url: remote.data.url,
        headers: remote.data.headers,
        enabled: remote.data.enabled,
      },
    };
  }

  const stdio = stdioServerSchema.safeParse(record);
  if (stdio.success) {
    const badEnv = Object.keys(stdio.data.env).find((key) => isHarnessOwnedMcpEnvName(key));
    if (badEnv) return { ok: false, reason: `environment variable “${badEnv}” is reserved by the harness` };
    return {
      ok: true,
      server: {
        command: stdio.data.command,
        args: stdio.data.args,
        env: stdio.data.env,
        enabled: stdio.data.enabled,
      },
    };
  }
  return { ok: false, reason: "expected a command or a url" };
}

/** The workspace's shared servers, parsed and filtered.
 *
 * A bot's own list narrows the shared set:  absent means every enabled
 * shared server, and a list means only the names on it. */
export function sharedMcpServers(cfg: AppConfig, only?: string[] | null): McpServersByName {
  const out: McpServersByName = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (only && !only.includes(name)) continue;
    const parsed = parseMcpServerEntry(name, raw);
    if (!parsed.ok) continue;
    if (!parsed.server.enabled) continue;
    out[name] = parsed.server;
  }
  return out;
}

/** The bot's own servers.
 *
 * They are already in the stored shape, so they are read through their own
 * path:  the name rule and the switch still apply, because a stored server
 * written before a rule changed must not mount under a name it may not
 * have now. */
export function botMcpServers(bot: Pick<BotRecord, "ownMcpServers">): McpServersByName {
  const out: McpServersByName = {};
  for (const [name, server] of Object.entries(bot.ownMcpServers ?? {})) {
    if (mcpServerNameError(name)) continue;
    if (!server.enabled) continue;
    out[name] = server;
  }
  return out;
}

/** Every server this bot may mount, and which scope each came from.
 *
 * The bot's own server wins a name the workspace also has:  the more
 * specific grant is the one the person meant. */
export function resolveMcpServers(
  cfg: AppConfig,
  bot: Pick<BotRecord, "mcpServers" | "ownMcpServers">,
) {
  const servers: McpServersByName = {};
  const scopes: Record<string, McpServerScope> = {};
  // The shared set first, so a bot server can replace it.
  for (const [name, server] of Object.entries(sharedMcpServers(cfg, bot.mcpServers))) {
    servers[name] = server;
    scopes[name] = "shared";
  }
  for (const [name, server] of Object.entries(botMcpServers(bot))) {
    servers[name] = server;
    scopes[name] = "bot";
  }
  return { servers, scopes };
}

/** The servers as the mount point wants them:  the contract's own spec
 * shape, so `turn.integrations.custom` holds exactly what the drivers
 * read.
 *
 * The stored form carries two fields the turn spec does not — the switch
 * that says whether the server is on, and a remote server's sign-in app —
 * and neither belongs in a turn:  a server that is off does not mount at
 * all, and a sign-in app is the registry's business, not the engine's. */
export function mcpServersForTurn(servers: McpServersByName) {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (isRemoteMcpServer(server)) {
      out[name] = { type: server.type, url: server.url, headers: { ...server.headers } };
      continue;
    }
    out[name] = { command: server.command, args: [...server.args], env: { ...server.env } };
  }
  return out;
}

/** What the person sees:  every server, both scopes, with the secret
 * NAMES and never their values. */
export function listMcpServersForBot(
  cfg: AppConfig,
  bot: Pick<BotRecord, "mcpServers" | "ownMcpServers">,
): McpServerView[] {
  const { servers, scopes } = resolveMcpServers(cfg, bot);
  const views: McpServerView[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (isRemoteMcpServer(server)) {
      views.push({
        name,
        scope: scopes[name] ?? "shared",
        type: server.type,
        url: server.url,
        headerKeys: Object.keys(server.headers).sort(),
        enabled: server.enabled,
      });
      continue;
    }
    views.push({
      name,
      scope: scopes[name] ?? "shared",
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env).sort(),
      enabled: server.enabled,
    });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name));
}
