/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- The MCP server registry parses stored entries at their boundary, where the shape comes from a config file and a bot record, and the guards are the registry's own. */
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
  environmentNameError,
  headerError,
  isHarnessOwnedMcpEnvName,
  isRemoteMcpServer,
  MAX_ENV,
  MAX_HEADERS,
  mcpServerNameError,
  type McpOAuthClientConfig,
  type StoredMcpServer,
  urlError,
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

/** The sign-in app a remote server carries, when it has one. */
const oauthClientSchema = z
  .object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional(),
    scopes: z.array(z.string().max(256)).max(32).optional(),
  })
  .strict();

const stdioServerSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: stringRecord.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

const remoteServerSchema = z
  .object({
    type: z.enum(["http", "sse"]).default("http"),
    url: z.string().trim().min(1),
    headers: stringRecord.default({}),
    oauth: oauthClientSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

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

  // Exactly one transport.  An entry carrying both would parse as the
  // remote one and silently drop the command, and an entry carrying
  // neither is not a server at all.
  const hasCommand = typeof record.command === "string" && record.command.length > 0;
  const hasUrl = typeof record.url === "string" && record.url.length > 0;
  if (hasCommand && hasUrl) {
    return { ok: false, reason: "a server has either a command to run or an address to connect to, not both" };
  }
  if (!hasCommand && !hasUrl) return { ok: false, reason: "expected a command or a url" };

  if (hasUrl) {
    const remote = remoteServerSchema.safeParse(record);
    if (!remote.success) {
      return { ok: false, reason: remote.error.issues[0]?.message ?? "invalid remote server" };
    }
    const badAddress = urlError(remote.data.url);
    if (badAddress) return { ok: false, reason: badAddress };
    if (Object.keys(remote.data.headers).length > MAX_HEADERS) {
      return { ok: false, reason: `use at most ${MAX_HEADERS} headers` };
    }
    for (const [header, value] of Object.entries(remote.data.headers)) {
      const problem = headerError(header, value);
      if (problem) return { ok: false, reason: problem };
      if (isHarnessOwnedMcpEnvName(header)) {
        return { ok: false, reason: `header “${header}” is reserved by the harness` };
      }
    }
    const oauth: McpOAuthClientConfig | undefined = remote.data.oauth
      ? {
          clientId: remote.data.oauth.clientId,
          ...(remote.data.oauth.clientSecret ? { clientSecret: remote.data.oauth.clientSecret } : {}),
          ...(remote.data.oauth.scopes ? { scopes: remote.data.oauth.scopes } : {}),
        }
      : undefined;
    return {
      ok: true,
      server: {
        type: remote.data.type,
        url: remote.data.url,
        headers: remote.data.headers,
        ...(oauth ? { oauth } : {}),
        enabled: remote.data.enabled,
      },
    };
  }

  const stdio = stdioServerSchema.safeParse(record);
  if (!stdio.success) {
    return { ok: false, reason: stdio.error.issues[0]?.message ?? "invalid local server" };
  }
  if (Object.keys(stdio.data.env).length > MAX_ENV) {
    return { ok: false, reason: `use at most ${MAX_ENV} environment variables` };
  }
  for (const [name_, value] of Object.entries(stdio.data.env)) {
    const problem = environmentNameError(name_, value);
    if (problem) return { ok: false, reason: problem };
    if (isHarnessOwnedMcpEnvName(name_)) {
      return { ok: false, reason: `environment variable “${name_}” is reserved by the harness` };
    }
  }
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

/** The bot's own servers, parsed by the same parser the shared ones use.
 *
 * A stored server written before a rule changed must not mount under a
 * name it may not have now, and must not carry an environment variable
 * the harness owns — so the bot's own entries go through exactly the same
 * checks as the shared ones rather than a second, weaker path. */
export function botMcpServers(bot: Pick<BotRecord, "ownMcpServers">): McpServersByName {
  const out: McpServersByName = {};
  for (const [name, server] of Object.entries(bot.ownMcpServers ?? {})) {
    const parsed = parseMcpServerEntry(name, server as unknown as JsonValue);
    if (!parsed.ok) continue;
    if (!parsed.server.enabled) continue;
    out[name] = parsed.server;
  }
  return out;
}

/** Every server a bot holds, both scopes, whether it is on or off.
 *
 * The listing is built from this and not from the mounted set, so a server
 * that was turned off is still visible — and can be turned back on, or
 * removed.  A server that vanished from the listing could never be
 * re-enabled. */
export function allMcpServersForBot(
  cfg: AppConfig,
  bot: Pick<BotRecord, "mcpServers" | "ownMcpServers">,
): { servers: McpServersByName; scopes: Record<string, McpServerScope> } {
  const servers: McpServersByName = {};
  const scopes: Record<string, McpServerScope> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (bot.mcpServers && !bot.mcpServers.includes(name)) continue;
    const parsed = parseMcpServerEntry(name, raw);
    if (!parsed.ok) continue;
    servers[name] = parsed.server;
    scopes[name] = "shared";
  }
  for (const [name, server] of Object.entries(bot.ownMcpServers ?? {})) {
    const parsed = parseMcpServerEntry(name, server as unknown as JsonValue);
    if (!parsed.ok) continue;
    servers[name] = parsed.server;
    scopes[name] = "bot";
  }
  return { servers, scopes };
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
  // The full set, not the mounted one:  a server that was turned off has to
  // stay visible, or there is no way to turn it back on or to remove it.
  const { servers, scopes } = allMcpServersForBot(cfg, bot);
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
