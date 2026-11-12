// Explicit outbound destinations a plugin may open.  The manifest field
// is `needs.network`: a list of `host:port` tokens.  An absent or empty
// list means the sandbox denies every outbound connection.
//
// This module is imported by the sandboxed child, so it stays free of
// zod and of anything under node_modules.  The child can read only the
// files the parent grants.

/** How many destinations one manifest may name. */
export const MAX_PLUGIN_NETWORK_ALLOWS = 32;

/** Longest accepted allowlist entry, in characters. */
export const MAX_PLUGIN_NETWORK_ENTRY = 300;

/** One parsed destination.  `token` is the canonical `host:port` form. */
export interface PluginNetworkAllow {
  host: string;
  port: number;
  token: string;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return false;
  }
  return true;
}

/** A conservative IPv6 check.  One `::` compression is allowed.  IPv4
 *  tails are rejected so a mapped address cannot sneak past the IPv4
 *  literal rules. */
function isIpv6(inner: string): boolean {
  if (inner.length === 0 || inner.length > 39) return false;
  if (!/^[0-9a-f:]+$/i.test(inner)) return false;
  const halves = inner.split("::");
  if (halves.length > 2) return false;
  const groupsOf = (part: string): number => (part.length === 0 ? 0 : part.split(":").length);
  const validGroups = (part: string): boolean =>
    part.length === 0 || part.split(":").every((group) => group.length > 0 && group.length <= 4);
  if (!halves.every(validGroups)) return false;
  if (halves.length === 2) return groupsOf(halves[0] ?? "") + groupsOf(halves[1] ?? "") < 8;
  return groupsOf(inner) === 8;
}

function normalizeHost(host: string): string | null {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.length === 0) return null;
  // Four numeric labels are an IP address, not a hostname.  A leading
  // zero or an octet past 255 is rejected rather than treated as a name.
  if (/^(?:[0-9]+\.){3}[0-9]+$/.test(value)) return isIpv4(value) ? value : null;
  if (isIpv6(value)) return value;
  if (HOSTNAME.test(value)) return value;
  return null;
}

function formatToken(host: string, port: number): string {
  return isIpv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Parse one manifest entry.  Returns null for anything that is not a
 *  single host and a port: schemes, paths, wildcards, credentials, and
 *  an IPv6 address that is not wrapped in brackets. */
export function parsePluginNetworkAllow(entry: string): PluginNetworkAllow | null {
  if (entry.length === 0 || entry.length > MAX_PLUGIN_NETWORK_ENTRY) return null;
  const trimmed = entry.trim();
  if (trimmed !== entry) return null;
  if (/[\s/?#@\\]/.test(trimmed) || trimmed.includes("*")) return null;
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) return null;
  const hostPart = trimmed.slice(0, colon);
  const portPart = trimmed.slice(colon + 1);
  if (hostPart.includes(":") && !(hostPart.startsWith("[") && hostPart.endsWith("]"))) return null;
  if (!/^[0-9]{1,5}$/.test(portPart)) return null;
  const port = Number(portPart);
  if (port < 1 || port > 65535) return null;
  const host = normalizeHost(hostPart);
  if (!host) return null;
  return { host, port, token: formatToken(host, port) };
}

/** Canonical `host:port` for a destination the plugin asked to open.
 *  Null when the host or port is not something the allowlist can name. */
export function canonicalNetworkToken(host: string, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return formatToken(normalized, port);
}

/** True when `host:port` is one of the canonical allowlist tokens. */
export function networkAllowMatches(allow: readonly string[], host: string, port: number): boolean {
  const token = canonicalNetworkToken(host, port);
  if (!token) return false;
  return allow.includes(token);
}

/** True when some allowlist entry names this host, on any port.  DNS
 *  lookup is permitted only that far: the port check still happens on
 *  connect. */
export function hostIsAllowlisted(allow: readonly string[], host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  for (const token of allow) {
    const parsed = parsePluginNetworkAllow(token);
    if (parsed?.host === normalized) return true;
  }
  return false;
}

/** True when the host is an IP literal rather than a DNS name. */
export function isPluginNetworkIp(host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return isIpv4(normalized) || isIpv6(normalized);
}

/** Drop invalid entries, canonicalize, and dedupe.  Invalid input is
 *  omitted, never granted.  The result is capped at the manifest maximum. */
export function normalizePluginNetworkAllow(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_PLUGIN_NETWORK_ALLOWS) break;
    const parsed = parsePluginNetworkAllow(entry);
    if (!parsed || out.includes(parsed.token)) continue;
    out.push(parsed.token);
  }
  return out;
}
