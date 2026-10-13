// User-configured MCP servers from ~/.botfleet/config.json `mcpServers`.
// Validate-with-skip so one bad entry never takes the fleet down.
//
// Ported from OpenMausBot (MIT), milind-soni/OpenMausBot — see also
// server/mcp-registry.ts upstream when the full registry panel lands.

import type { AppConfig } from "./config.ts";

export type CustomMcpServer =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

function parseStoredMcpServer(name: string, raw: unknown): { ok: true; config: CustomMcpServer } | { ok: false; error: string } {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    return { ok: false, error: `Name “${name}” must be lowercase letters, digits, _ or -, starting with a letter.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected an object." };
  }
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) return { ok: false, error: "disabled" };
  if (typeof record.url === "string" && record.url.trim()) {
    const type = record.type === "sse" ? "sse" : "http";
    const headers = asStringRecord(record.headers) ?? {};
    return { ok: true, config: { type, url: record.url.trim(), headers } };
  }
  if (typeof record.command === "string" && record.command.trim()) {
    const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
    const env = asStringRecord(record.env) ?? {};
    return { ok: true, config: { command: record.command.trim(), args, env } };
  }
  return { ok: false, error: "Expected a command or a url." };
}

/** The validated, normalized custom servers from config — or {}. */
export function customMcpServers(cfg: AppConfig, only?: string[]): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
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
export function engineMcpServers(cfg: AppConfig, botMcpServers?: string[] | null): Record<string, CustomMcpServer> {
  return customMcpServers(cfg, botMcpServers ?? undefined);
}
