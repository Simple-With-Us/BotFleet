// OS backstop for the plugin sandbox's outbound network.
//
// The in-process guard (server/plugin-net-guard.ts) is what every
// platform runs.  This wrapper adds a kernel boundary where the host
// has one:
//   * Linux, and only when the plugin declared no destinations: a user
//     and network namespace (`unshare --net`).  The child keeps loopback
//     inside the namespace and cannot reach the host's network, so a
//     raw `tcp_wrap` connect fails even if the JavaScript guard is
//     bypassed.  A declared allowlist cannot use this namespace,
//     because a namespace with no interfaces cannot reach an allowed
//     host either.  The guard enforces that list.
//   * macOS, and only when the plugin declared no destinations:
//     `sandbox-exec` with a deny-all network profile.  Seatbelt's
//     remote-host filter accepts only `*` or `localhost`, so a
//     hostname or IP literal makes `sandbox-exec` refuse to start.
//     A declared allowlist is not wrapped.  The guard enforces that
//     list, the same way a Linux allowlist skips the network namespace.
//
// Windows has no equivalent tool in the base system.  The guard is the
// boundary there, and on a Node build that supports `--allow-net` the
// loader withholds that flag unless the plugin declared destinations.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";

export interface PluginSpawnRequest {
  execPath: string;
  args: readonly string[];
  options: SpawnOptions;
  /** Canonical host:port tokens.  Empty denies every outbound connection. */
  networkAllow: readonly string[];
}

export interface PluginSpawn {
  child: ChildProcess;
  /** True when `child` is a wrapper (unshare or sandbox-exec) rather than Node itself. */
  wrapped: boolean;
}

let linuxNetns: boolean | null = null;
let darwinSandbox: boolean | null = null;

function linuxNetnsAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (linuxNetns !== null) return linuxNetns;
  try {
    const probe = spawnSync("unshare", ["--user", "--map-root-user", "--net", "--", "true"], { timeout: 2_000 });
    linuxNetns = probe.status === 0;
  } catch {
    linuxNetns = false;
  }
  return linuxNetns;
}

function darwinSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  if (darwinSandbox !== null) return darwinSandbox;
  try {
    const probe = spawnSync(
      "sandbox-exec",
      ["-p", "(version 1)(allow default)(deny network*)", "true"],
      { timeout: 2_000 },
    );
    darwinSandbox = probe.status === 0;
  } catch {
    darwinSandbox = false;
  }
  return darwinSandbox;
}

export type PluginOsNetworkWrap = "netns" | "seatbelt" | "none";

/** Which kernel wrapper this host can apply.  A non-empty allowlist is
 *  always `none`: a network namespace cannot reach an allowed host, and
 *  seatbelt cannot name one. */
export function pluginOsNetworkWrap(input: {
  platform: NodeJS.Platform;
  networkAllow: readonly string[];
  linuxNetns: boolean;
  darwinSandbox: boolean;
}): PluginOsNetworkWrap {
  if (input.networkAllow.length > 0) return "none";
  if (input.platform === "linux" && input.linuxNetns) return "netns";
  if (input.platform === "darwin" && input.darwinSandbox) return "seatbelt";
  return "none";
}

/** Deny-all seatbelt profile.  Null when the allowlist is non-empty,
 *  because a `(remote tcp "host:port")` filter with a real host or IP
 *  is not valid seatbelt and `sandbox-exec` exits before the child
 *  runs.  Nothing from the allowlist is interpolated. */
export function darwinNetworkProfile(allow: readonly string[]): string | null {
  if (allow.length > 0) return null;
  return "(version 1)(allow default)(deny network*)";
}

/** Spawn the sandbox child, wrapped in an OS network boundary when this
 *  host has one that can express the allowlist.  The Node argument list
 *  is unchanged either way. */
export function spawnPluginProcess(request: PluginSpawnRequest): PluginSpawn {
  const options = request.options;
  const wrap = pluginOsNetworkWrap({
    platform: process.platform,
    networkAllow: request.networkAllow,
    linuxNetns: linuxNetnsAvailable(),
    darwinSandbox: darwinSandboxAvailable(),
  });
  switch (wrap) {
    case "netns":
      return {
        wrapped: true,
        child: spawn(
          "unshare",
          ["--fork", "--kill-child", "--user", "--map-root-user", "--net", "--", request.execPath, ...request.args],
          { ...options, detached: true },
        ),
      };
    case "seatbelt": {
      const profile = darwinNetworkProfile(request.networkAllow);
      if (profile === null) break;
      return {
        wrapped: true,
        child: spawn(
          "sandbox-exec",
          ["-p", profile, request.execPath, ...request.args],
          { ...options, detached: true },
        ),
      };
    }
    case "none":
      break;
    default: {
      const unreachable: never = wrap;
      return unreachable;
    }
  }
  return {
    wrapped: false,
    child: spawn(request.execPath, [...request.args], options),
  };
}

/** Stop a sandbox child.  A wrapper such as `unshare` forks Node, and
 *  SIGKILL on the wrapper does not run `--kill-child`, so the Node
 *  process is signalled first. */
export function killPluginProcess(child: ChildProcess, wrapped: boolean): void {
  const pid = child.pid;
  if (wrapped && pid !== undefined) {
    if (process.platform === "linux") {
      try {
        const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
        for (const id of kids.split(/\s+/)) {
          if (!/^[0-9]+$/.test(id)) continue;
          try {
            process.kill(Number(id), "SIGKILL");
          } catch {
            // The child already exited.
          }
        }
      } catch {
        // /proc is already gone, or this host has no procfs.
      }
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The wrapper was not a process-group leader.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}
