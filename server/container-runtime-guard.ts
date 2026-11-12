// Kill switch for every local container runtime (docker, podman, Apple
// `container`, OrbStack's `orb`/`orbctl`).
//
// Why this exists: the Local VM container name derives from the OS username,
// not from HOME, and the runtime CLI talks to one machine-wide daemon.  A test
// harness booted against a throwaway HOME therefore still reaches the owner's
// REAL runtime, and a test that turned the Local VM on and POSTed `/run`
// created (and claimed the name of) the owner's real container, bind-mounted
// from a temp directory that was deleted when the suite ended.
//
// `BOTFLEET_DISABLE_CONTAINER_RUNTIME` is enforced at the spawn layer (the
// default Local VM runner, the BYO-VPS Docker-over-SSH runner and the MCP
// stdio bridge), so no route handler, idle timer or startup probe can reach a
// runtime while it is set.  Fixture suites that deliberately shadow `docker`
// with a script point `BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR` at the
// directory holding that script; with the switch on, a runtime command runs
// ONLY from that directory, by absolute path, so a PATH lookup can never fall
// through to the real binary.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const CONTAINER_RUNTIME_DISABLED_ENV = "BOTFLEET_DISABLE_CONTAINER_RUNTIME";
export const CONTAINER_RUNTIME_FIXTURE_DIR_ENV = "BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR";

/** Points every Docker-API client at a socket that does not exist.  Belt and
 * braces for the runtimes that honor an env endpoint (it does not cover
 * `docker -H ssh://…`, which is why the spawn-layer check exists). */
export const UNREACHABLE_RUNTIME_SOCKET = "unix:///nonexistent.sock";

export const CONTAINER_RUNTIME_DISABLED_MESSAGE =
  `Container runtimes are disabled in this process (${CONTAINER_RUNTIME_DISABLED_ENV} is set), ` +
  "so BotFleet will not run docker, podman, container or orb.";

const RUNTIME_COMMANDS: ReadonlySet<string> = new Set(["docker", "podman", "container", "orb", "orbctl"]);

export class ContainerRuntimeDisabledError extends Error {
  readonly code = "CONTAINER_RUNTIME_DISABLED";
  /** The HTTP status the Local VM routes map a refused lifecycle action to. */
  readonly status = 409;
  constructor() {
    super(CONTAINER_RUNTIME_DISABLED_MESSAGE);
    this.name = "ContainerRuntimeDisabledError";
  }
}

/** True when the switch is set to anything but an explicit "off" spelling.
 * Read at call time, never at module load: the value is per process and a
 * test may flip it. */
export function containerRuntimeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CONTAINER_RUNTIME_DISABLED_ENV]?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/** The name a runtime command is known by: its basename, lowercased, with a
 * Windows executable suffix removed.  `/opt/homebrew/bin/docker` is `docker`. */
function runtimeName(command: string): string | null {
  const name = basename(command.replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  return RUNTIME_COMMANDS.has(name) ? name : null;
}

export function isContainerRuntimeCommand(command: string): boolean {
  return runtimeName(command) !== null;
}

/** The fixture copy of a runtime (`<fixture dir>/<name>`), or null when no
 * fixture directory is configured or it holds no such file. */
export function fixtureRuntimeCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[CONTAINER_RUNTIME_FIXTURE_DIR_ENV]?.trim();
  if (!dir) return null;
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  const windows = `${direct}.exe`;
  return process.platform === "win32" && existsSync(windows) ? windows : null;
}

/** What to actually execute for `command`.
 *
 * Anything that is not a container runtime, and every runtime while the switch
 * is off, is returned untouched.  With the switch on, a runtime resolves only
 * to its fixture copy; with no fixture, this throws before anything spawns. */
export function resolveRuntimeCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = runtimeName(command);
  if (!name || !containerRuntimeDisabled(env)) return command;
  const fixture = fixtureRuntimeCommand(name, env);
  if (!fixture) throw new ContainerRuntimeDisabledError();
  return fixture;
}

/** The env a test harness child must carry so it can never reach a real
 * container runtime.  One definition, applied by `spawnDetached`. */
export function containerRuntimeLockdownEnv() {
  return {
    [CONTAINER_RUNTIME_DISABLED_ENV]: "1",
    DOCKER_HOST: UNREACHABLE_RUNTIME_SOCKET,
    CONTAINER_HOST: UNREACHABLE_RUNTIME_SOCKET,
  };
}
