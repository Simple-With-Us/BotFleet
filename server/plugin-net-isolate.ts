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
//     `sandbox-exec` with `(deny network*)`.  Seatbelt's remote filter
//     accepts `*` or `localhost` and rejects every hostname and IP
//     literal, so a declared destination cannot be written into the
//     profile.  A profile that fails to compile makes the child exit
//     before the plugin loads.  A non-empty list therefore skips the
//     wrapper, and the in-process guard enforces it.
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

/** Seatbelt profile for a plugin that declared no destinations.
 *  Returns null when the list is non-empty.  Apple's profile compiler
 *  accepts only `*` or `localhost` in a remote filter and rejects a
 *  hostname or an IP literal (`host must be * or localhost`).  Putting
 *  either into the profile makes `sandbox-exec` exit and the plugin
 *  never starts.  The in-process guard is the boundary for a declared
 *  list, on macOS and on Windows. */
export function darwinNetworkProfile(allow: readonly string[]): string | null {
  if (allow.length > 0) return null;
  return "(version 1)(allow default)(deny network*)";
}

/** Spawn the sandbox child, wrapped in an OS network boundary when this
 *  host has one.  The Node argument list is unchanged either way. */
export function spawnPluginProcess(request: PluginSpawnRequest): PluginSpawn {
  const options = request.options;
  if (request.networkAllow.length === 0 && linuxNetnsAvailable()) {
    return {
      wrapped: true,
      child: spawn(
        "unshare",
        ["--fork", "--kill-child", "--user", "--map-root-user", "--net", "--", request.execPath, ...request.args],
        { ...options, detached: true },
      ),
    };
  }
  const profile = darwinNetworkProfile(request.networkAllow);
  if (profile !== null && darwinSandboxAvailable()) {
    return {
      wrapped: true,
      child: spawn(
        "sandbox-exec",
        ["-p", profile, request.execPath, ...request.args],
        { ...options, detached: true },
      ),
    };
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
