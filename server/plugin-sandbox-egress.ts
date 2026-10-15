// OS-level outbound network isolation for plugin sandbox children.
//
// Node's permission model does not block sockets.  We wrap the child spawn
// in a platform mechanism that fails closed when unavailable:
//   * macOS: sandbox-exec with an explicit (deny network*) rule
//   * Linux: unshare --net plus plugin-sandbox-netwrap.sh to drop loopback
//   * Windows: unsupported until a WFP or AppContainer policy exists
import { spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

/** Seatbelt profile: deny every socket; Node permissions still gate disk. */
const MACOS_NETWORK_DENY_PROFILE = `(version 1)
(allow default)
(deny network*)
`;

let availabilityCache: boolean | null = null;

function unshareBinary(): string | null {
  if (existsSync("/usr/bin/unshare")) return "/usr/bin/unshare";
  if (existsSync("/bin/unshare")) return "/bin/unshare";
  return null;
}

function netwrapScriptPath(): string {
  return join(SERVER_ROOT, "plugin-sandbox-netwrap.sh");
}

/** True when this host can spawn a plugin child with outbound sockets blocked. */
export function pluginNetworkIsolationAvailable(): boolean {
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = probePluginNetworkIsolation();
  return availabilityCache;
}

/** Test-only: clear the probe cache after mocking platform or spawn. */
export function resetPluginNetworkIsolationProbe(): void {
  availabilityCache = null;
}

function probePluginNetworkIsolation(): boolean {
  switch (process.platform) {
    case "darwin":
      return existsSync("/usr/bin/sandbox-exec");
    case "linux": {
      const unshare = unshareBinary();
      if (!unshare) return false;
      const wrap = netwrapScriptPath();
      if (!existsSync(wrap)) return false;
      const probe = spawnSync(
        unshare,
        ["-U", "-r", "--net", wrap, process.execPath, "-e", "process.exit(0)"],
        { stdio: "ignore", timeout: 10_000 },
      );
      return probe.status === 0 && !probe.error;
    }
    default:
      return false;
  }
}

export interface PluginSandboxSpawnPlan {
  command: string;
  args: string[];
}

/** Build argv for spawning the permission-sandboxed Node child with no egress. */
export function buildPluginSandboxSpawnPlan(execPath: string, nodeArgs: string[]): PluginSandboxSpawnPlan {
  if (!pluginNetworkIsolationAvailable()) {
    throw new Error("plugin network isolation unavailable on this platform");
  }
  switch (process.platform) {
    case "darwin":
      return {
        command: "/usr/bin/sandbox-exec",
        args: ["-p", MACOS_NETWORK_DENY_PROFILE, execPath, ...nodeArgs],
      };
    case "linux": {
      const unshare = unshareBinary();
      if (!unshare) throw new Error("unshare missing");
      const wrap = netwrapScriptPath();
      if (!existsSync(wrap)) throw new Error("plugin-sandbox-netwrap.sh missing");
      return {
        command: unshare,
        args: ["-U", "-r", "--net", wrap, execPath, ...nodeArgs],
      };
    }
    default:
      throw new Error(`plugin network isolation unsupported on ${process.platform}`);
  }
}

/** Spawn options shared by every plugin sandbox child. */
export type PluginSandboxSpawnOptions = Omit<SpawnOptions, "shell">;
