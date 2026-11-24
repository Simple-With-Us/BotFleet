// The MCP servers a bot may mount:  the ones the workspace shares and the
// ones that belong to this bot alone.
//
// The panel lists what the bot can reach, and lets the person add a server
// of its own and narrow the shared set.  It never shows a credential:  the
// server's own env and header values are write-only, and the listing names
// the FIELDS a server carries without ever returning their values.  So the
// panel shows a server's field names and never their contents.
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { mcpNameError, type McpServerEntry } from "../../shared/mcp-servers";

/** A visible sentence gap that survives HTML whitespace collapsing: a
 * non-breaking space (never collapsed) plus a regular space, built from a
 * char code rather than typed literally so no editor/transfer step can
 * silently flatten it back to two plain spaces.  Mirrors
 * ConnectorToolsSettings.tsx's GAP. */
const GAP = `${String.fromCharCode(160)} `;

/** One MCP server as the listing reports it.  The secret fields are NAMED,
 * never valued:  a listing never returns an env value or a header value. */
export interface McpServerView {
  name: string;
  scope: "shared" | "bot";
  enabled: boolean;
  command?: string;
  args?: string[];
  envKeys?: string[];
  type?: "http" | "sse";
  url?: string;
  headerKeys?: string[];
}

/** Parse the `KEY=value` lines a credential box holds into a record.  A
 * line without an `=` is dropped rather than stored half-formed:  a
 * credential with no value is not a credential. */
export function parseCredentialLines(text: string) {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key) continue;
    values[key] = value;
  }
  return values;
}

/** The credential box's starting text:  the field names a server carries,
 * with no values, because a listing never returns them. */
export function credentialLinesFrom(keys: string[] | undefined): string {
  return (keys ?? []).map((key) => `${key}=`).join("\n");
}

/** A server's own label:  the command it runs, or the address it answers
 * on. */
export function serverDescriptor(server: McpServerView): string {
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  if (server.url) return server.url;
  return "";
}

export function McpServersSettings({
  bot,
  servers,
  onPatch,
  onError,
}: {
  bot: Bot;
  servers: McpServerView[];
  onPatch: (patch: { ownMcpServers?: Record<string, McpServerEntry>; mcpServers?: string[] }) => void;
  onError?: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");

  const shared = servers.filter((server) => server.scope === "shared");
  const own = servers.filter((server) => server.scope === "bot");

  // The bot's shared narrowing list, as the names it holds.
  const allowedShared = new Set(bot.mcpServers ?? []);
  const narrowed = bot.mcpServers !== undefined;

  useEffect(() => {
    setCredential("");
  }, [name]);

  const add = () => {
    const problem = mcpNameError(name);
    if (problem) {
      onError?.(problem);
      return;
    }
    const trimmed = name.trim();
    if (servers.some((server) => server.name === trimmed)) {
      onError?.("This bot already has an MCP server with that name.");
      return;
    }
    const isRemote = url.trim().length > 0;
    if (!isRemote && command.trim().length === 0) {
      onError?.("Give the server a command to run, or an address to connect to.");
      return;
    }
    if (isRemote && command.trim().length > 0) {
      onError?.("A server has either a command to run or an address to connect to, not both.");
      return;
    }
    const entry: McpServerEntry = isRemote
      ? { type: "http", url: url.trim(), headers: parseCredentialLines(credential), enabled: true }
      : {
          command: command.trim(),
          args: command.trim().split(/\s+/).slice(1),
          env: parseCredentialLines(credential),
          enabled: true,
        };
    onPatch({ ownMcpServers: { ...bot.ownMcpServers, [trimmed]: entry } });
    setName("");
    setCommand("");
    setUrl("");
    setCredential("");
  };

  const remove = (serverName: string) => {
    const next = { ...bot.ownMcpServers };
    delete next[serverName];
    onPatch({ ownMcpServers: next });
  };

  const toggleShared = (serverName: string) => {
    const next = new Set(allowedShared);
    if (next.has(serverName)) next.delete(serverName);
    else next.add(serverName);
    onPatch({ mcpServers: [...next].sort() });
  };

  return (
    <div className="rounded-xl bg-card p-4 flex flex-col gap-4">
      <div>
        <div className="text-[15px] font-medium text-ink">MCP Servers</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {`MCP servers give this bot extra tools.${GAP}Shared servers are set up for the whole workspace;${GAP}a server you add here belongs to this bot alone.${GAP}Credentials are write-only: BotFleet shows the field names, never what is in them.`}
        </div>
      </div>

      {shared.length > 0 && (
        <div>
          <div className="text-[13px] font-medium text-ink-secondary">
            {narrowed ? "Shared servers this bot may use" : "Shared servers (all available)"}
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {shared.map((server) => (
              <div
                key={server.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{server.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-ink-secondary">
                    {serverDescriptor(server)}
                  </div>
                </div>
                {narrowed && (
                  <label className="flex shrink-0 items-center gap-2 text-[12px] text-ink-secondary">
                    <input
                      type="checkbox"
                      aria-label={`Allow the shared server ${server.name}`}
                      checked={allowedShared.has(server.name)}
                      onChange={() => toggleShared(server.name)}
                    />
                    Allow
                  </label>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {own.length > 0 && (
        <div>
          <div className="text-[13px] font-medium text-ink-secondary">This bot&apos;s own servers</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {own.map((server) => (
              <div
                key={server.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{server.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-ink-secondary">
                    {serverDescriptor(server)}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove the MCP server ${server.name}`}
                  onClick={() => remove(server.name)}
                  className={cn("shrink-0 text-[12px] text-ink-secondary hover:text-ink")}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-ink-secondary">Add a server for this bot</div>
        <input
          aria-label="MCP server name"
          className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          placeholder="my-server"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label="MCP server command"
          className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          placeholder="npx -y my-mcp-server"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <input
          aria-label="MCP server address"
          className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          placeholder="https://example.com/mcp"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <textarea
          aria-label="MCP server credentials, one KEY=value per line"
          className="min-h-[60px] w-full resize-none rounded-lg border border-hairline/40 bg-card px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          placeholder={"API_TOKEN=\nOTHER_TOKEN="}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={add}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Add Server
          </button>
        </div>
      </div>
    </div>
  );
}
