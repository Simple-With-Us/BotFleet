// User-configured MCP servers from ~/.botfleet/config.json `mcpServers`.
// Validate-with-skip so one bad entry never takes the fleet down.
//
// Ported from OpenMausBot (MIT), milind-soni/OpenMausBot — see also
// server/mcp-registry.ts upstream when the full registry panel lands.

import { z } from "zod";

import type { AppConfig } from "./config.ts";
import { isJsonObject, type JsonValue } from "./schema.ts";

export type CustomMcpServer =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

/** Validated MCP servers keyed by config entry name. */
export interface CustomMcpServerByName {
  [serverName: string]: CustomMcpServer;
}

const mcpName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const stringRecord = z.record(z.string(), z.string());
const stdioMcp = z.object({
  enabled: z.literal(false).optional(),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: stringRecord.default({}),
});
const remoteMcp = z.object({
  enabled: z.literal(false).optional(),
  type: z.enum(["http", "sse"]).default("http"),
  url: z.string().trim().min(1),
  headers: stringRecord.default({}),
});

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

function parseStoredMcpServer(name: string, raw: JsonValue): { ok: true; config: CustomMcpServer } | { ok: false; error: string } {
  const nameError = mcpName.safeParse(name);
  if (!nameError.success) {
    return { ok: false, error: `Name “${name}” must be lowercase letters, digits, _ or -, starting with a letter.` };
  }
  if (!isJsonObject(raw)) return { ok: false, error: "Expected an object." };
  if (raw.enabled === false) return { ok: false, error: "disabled" };
  const remote = remoteMcp.safeParse(raw);
  if (remote.success) {
    const { type, url, headers } = remote.data;
    return { ok: true, config: { type, url, headers } };
  }
  const stdio = stdioMcp.safeParse(raw);
  if (stdio.success) {
    const { command, args, env } = stdio.data;
    return { ok: true, config: { command, args, env } };
  }
  return { ok: false, error: "Expected a command or a url." };
}

/** The validated, normalized custom servers from config — or {}. */
export function customMcpServers(cfg: AppConfig, only?: string[]): CustomMcpServerByName {
  const out: CustomMcpServerByName = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (only && !only.includes(name)) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      if (parsed.error !== "disabled") {
        skipMcpEntry(
          name,
          `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } } or { "type": "http", "url": "https://…", "headers": { ... } }.`,
        );
      }
      continue;
    }
    out[name] = parsed.config;
  }
  return out;
}

/** Configured MCP servers that may reach this bot's engine. */
export function engineMcpServers(cfg: AppConfig, botMcpServers?: string[] | null): CustomMcpServerByName {
  return customMcpServers(cfg, botMcpServers ?? undefined);
}
