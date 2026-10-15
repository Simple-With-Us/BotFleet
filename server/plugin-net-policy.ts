// Which outbound destinations a plugin may open.
//
// Deny by default.  A third-party plugin is granted a destination only
// when both of these are true: its manifest lists the `net.hosts`
// capability, and `needs.network` names that exact host:port.  A
// manifest cannot mark itself trusted.
//
// The shipped Zulip plugin is the one first-party exception.  Trust is
// recorded on the registry entry at install, and only when the source
// folder's real path is `plugins/first-party/zulip`.  Install copies
// the tree into the data directory, so comparing the running directory
// to the shipped folder never matches.  A git install does not receive
// the record.  The plugin then also receives the configured Zulip
// realm host, because the realm is chosen on this Mac and cannot be
// written into the manifest ahead of time.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NET_HOSTS_CAPABILITY } from "../shared/plugin-manifest.ts";
import { MAX_PLUGIN_NETWORK_ALLOWS, canonicalNetworkToken, normalizePluginNetworkAllow } from "../shared/plugin-net-allow.ts";
import type { PluginHostTrust, PluginSource } from "./plugin-types.ts";

export const ZULIP_PLUGIN_NAME = "zulip";
export const ZULIP_REALM_HOST_TRUST = "zulip-realm" satisfies PluginHostTrust;

/** Directory the host ships first-party plugins from.  Compared to the
 *  install source path, never to the copy under the data directory. */
export const FIRST_PARTY_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "first-party");

export interface PluginNetworkAllowInput {
  capabilities: readonly string[];
  declared: readonly string[];
  /** True only when this directory is the host's shipped Zulip plugin. */
  shippedZulip: boolean;
  /** Configured realm origin, for example `https://chat.example.com`. */
  zulipRealm?: string;
}

/** `host:port` for an http(s) URL.  Credentials, other schemes, and
 *  unparsable hosts are refused. */
export function httpUrlToNetworkAllow(site: string): string | null {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port)) return null;
  return canonicalNetworkToken(url.hostname, port);
}

/** Registry provenance for the shipped Zulip plugin.  True only when
 *  the install source is a folder whose real path is
 *  `<firstPartyRoot>/zulip` and the manifest name is `zulip`.  A copy
 *  installed from anywhere else, a git source, and a missing directory
 *  get nothing. */
export function shippedZulipHostTrust(
  name: string,
  source: PluginSource,
  firstPartyRoot: string,
): PluginHostTrust | undefined {
  if (name !== ZULIP_PLUGIN_NAME || source.kind !== "folder") return undefined;
  try {
    if (realpathSync(source.path) !== realpathSync(join(firstPartyRoot, ZULIP_PLUGIN_NAME))) return undefined;
  } catch {
    return undefined;
  }
  return ZULIP_REALM_HOST_TRUST;
}

/** The sealed allowlist for one plugin.  Invalid declared entries are
 *  dropped.  The Zulip realm is appended for the shipped plugin even
 *  when `net.hosts` is absent, and it keeps its slot if the declared
 *  list is already full. */
export function pluginNetworkAllow(input: PluginNetworkAllowInput): string[] {
  const granted = input.capabilities.includes(NET_HOSTS_CAPABILITY)
    ? normalizePluginNetworkAllow(input.declared)
    : [];
  if (!input.shippedZulip || input.zulipRealm === undefined) return granted;
  const realm = httpUrlToNetworkAllow(input.zulipRealm);
  if (realm === null || granted.includes(realm)) return granted;
  const room = granted.length >= MAX_PLUGIN_NETWORK_ALLOWS
    ? granted.slice(0, MAX_PLUGIN_NETWORK_ALLOWS - 1)
    : granted;
  return [...room, realm];
}
