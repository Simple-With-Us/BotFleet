// Fail-closed outbound network isolation for plugin sandbox children.
//
// Node's permission model does not block sockets.  Every child is started with
// server/plugin-sandbox-egress-deny.mjs loaded via --import, which patches
// the networking builtins before plugin code runs.  On Linux, when the host
// allows it, the child is also placed in a network namespace via unshare -n.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

/** Stable denial code re-exported for tests. */
export const PLUGIN_EGRESS_DENIED = "ERR_PLUGIN_EGRESS_DENIED";

let linuxUnshareCached: boolean | undefined;

/** True when this Linux host can spawn children in an isolated network namespace. */
export function linuxUnshareNetworkAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (linuxUnshareCached !== undefined) return linuxUnshareCached;
  const probe = spawnSync("unshare", ["-n", process.execPath, "-e", "process.exit(0)"], {
    timeout: 5_000,
  });
  linuxUnshareCached = probe.status === 0;
  return linuxUnshareCached;
}

/** Absolute path to the --import script, canonicalized for --allow-fs-read. */
export function pluginSandboxEgressDenyScript(): string {
  const candidates = ["plugin-sandbox-egress-deny.mjs", "plugin-sandbox-egress-deny.js"];
  for (const name of candidates) {
    const path = join(SERVER_ROOT, name);
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error("plugin sandbox egress deny script is missing");
}

/** argv prefix that loads egress denial before any plugin module runs. */
export function pluginSandboxEgressImportArgv(): string[] {
  return [`--import=${pluginSandboxEgressDenyScript()}`];
}

/** Spawn target for a sandbox child: optional Linux unshare wrapper around node. */
export function pluginSandboxSpawnTarget(
  nodeExecutable: string,
  nodeArgv: readonly string[],
): { command: string; args: string[] } {
  const args = [...nodeArgv];
  if (linuxUnshareNetworkAvailable()) {
    return { command: "unshare", args: ["-n", nodeExecutable, ...args] };
  }
  return { command: nodeExecutable, args };
}
