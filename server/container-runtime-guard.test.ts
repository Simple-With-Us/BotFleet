import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTAINER_RUNTIME_DISABLED_ENV,
  CONTAINER_RUNTIME_DISABLED_MESSAGE,
  CONTAINER_RUNTIME_FIXTURE_DIR_ENV,
  ContainerRuntimeDisabledError,
  UNREACHABLE_RUNTIME_SOCKET,
  containerRuntimeDisabled,
  containerRuntimeLockdownEnv,
  fixtureRuntimeCommand,
  isContainerRuntimeCommand,
  resolveRuntimeCommand,
} from "./container-runtime-guard.ts";
import {
  containerComputerAction,
  containerComputerStatus,
  containerRuntimeStatus,
  defaultCommandRunner,
} from "./container-computer.ts";
import { runLivenessProbe } from "./mcp-bridge.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posixOnly = describe.skipIf(process.platform === "win32");

describe("container runtime kill switch: env and command matching", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is on for every value except an explicit off spelling", () => {
    expect(containerRuntimeDisabled({})).toBe(false);
    for (const off of ["", " ", "0", "false", "FALSE", "no", "off"]) {
      expect(containerRuntimeDisabled({ [CONTAINER_RUNTIME_DISABLED_ENV]: off }), off).toBe(false);
    }
    for (const on of ["1", "true", "yes", "on"]) {
      expect(containerRuntimeDisabled({ [CONTAINER_RUNTIME_DISABLED_ENV]: on }), on).toBe(true);
    }
  });

  it("is set in every test process by the shared setup file", () => {
    expect(containerRuntimeDisabled()).toBe(true);
    expect(process.env.DOCKER_HOST).toBe(UNREACHABLE_RUNTIME_SOCKET);
    expect(process.env[CONTAINER_RUNTIME_FIXTURE_DIR_ENV]).toBeUndefined();
  });

  it("recognises runtimes by basename, whatever the path or suffix", () => {
    for (const runtime of [
      "docker",
      "podman",
      "container",
      "orb",
      "orbctl",
      "/opt/homebrew/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "Podman.EXE",
    ]) {
      expect(isContainerRuntimeCommand(runtime), runtime).toBe(true);
    }
    for (const other of ["git", "/usr/bin/which", "ssh", "dockerd", "docker-compose", "node", ""]) {
      expect(isContainerRuntimeCommand(other), other).toBe(false);
    }
  });

  it("leaves everything untouched while the switch is off", () => {
    const off = { [CONTAINER_RUNTIME_DISABLED_ENV]: "0" };
    expect(resolveRuntimeCommand("docker", off)).toBe("docker");
    expect(resolveRuntimeCommand("/usr/local/bin/podman", off)).toBe("/usr/local/bin/podman");
  });

  it("lets non-runtime commands through while the switch is on", () => {
    const on = { [CONTAINER_RUNTIME_DISABLED_ENV]: "1" };
    expect(resolveRuntimeCommand("/usr/bin/which", on)).toBe("/usr/bin/which");
    expect(resolveRuntimeCommand("ssh", on)).toBe("ssh");
  });

  it("refuses every runtime, however it is spelled, when the switch is on with no fixture", () => {
    const on = { [CONTAINER_RUNTIME_DISABLED_ENV]: "1" };
    for (const runtime of ["docker", "podman", "container", "orb", "orbctl", "/opt/homebrew/bin/docker"]) {
      expect(() => resolveRuntimeCommand(runtime, on), runtime).toThrow(ContainerRuntimeDisabledError);
    }
    expect(() => resolveRuntimeCommand("docker", on)).toThrow(
      expect.objectContaining({ message: CONTAINER_RUNTIME_DISABLED_MESSAGE, status: 409, code: "CONTAINER_RUNTIME_DISABLED" }),
    );
  });

  it("builds the lockdown env the harness helpers apply", () => {
    expect(containerRuntimeLockdownEnv()).toEqual({
      [CONTAINER_RUNTIME_DISABLED_ENV]: "1",
      DOCKER_HOST: UNREACHABLE_RUNTIME_SOCKET,
      CONTAINER_HOST: UNREACHABLE_RUNTIME_SOCKET,
    });
  });
});

posixOnly("container runtime kill switch: the default runner never reaches a runtime", () => {
  let dir: string;
  let trapLog: string;

  /** A stand-in for every runtime on the machine: it records that it ran. */
  const writeTrap = (name: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${trapLog}"\necho fixture-${name}\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
  };
  const trapCalls = () => (existsSync(trapLog) ? readFileSync(trapLog, "utf8") : "");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bf-runtime-guard-"));
    trapLog = join(dir, "trap.log");
    for (const name of ["docker", "podman", "container", "orb", "orbctl"]) writeTrap(name);
    // The traps are first on every PATH the runner could consult, so a
    // refusal that merely "failed to find" a runtime would still hit one.
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("OMB_EXTRA_PATH", dir);
    vi.stubEnv(CONTAINER_RUNTIME_DISABLED_ENV, "1");
    vi.stubEnv(CONTAINER_RUNTIME_FIXTURE_DIR_ENV, "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempDir(dir);
  });

  it("rejects each runtime before spawning it", async () => {
    for (const runtime of ["docker", "podman", "container", "orb", "orbctl", join(dir, "docker")]) {
      await expect(defaultCommandRunner(runtime, ["info"]), runtime).rejects.toThrow(CONTAINER_RUNTIME_DISABLED_MESSAGE);
    }
    expect(trapCalls()).toBe("");
  });

  it("still runs commands that are not runtimes", async () => {
    const { stdout } = await defaultCommandRunner(process.execPath, ["-e", "console.log('ok')"]);
    expect(stdout.trim()).toBe("ok");
  });

  it("reports no runtime and a clear problem instead of probing the machine", async () => {
    expect(await containerRuntimeStatus()).toEqual({
      runtime: null,
      available: [],
      daemonUp: false,
      disabled: CONTAINER_RUNTIME_DISABLED_MESSAGE,
    });
    const status = await containerComputerStatus();
    expect(status.runtime).toBeNull();
    expect(status.available).toEqual([]);
    expect(status.daemonUp).toBe(false);
    expect(status.container).toBe("missing");
    expect(status.problem).toBe(CONTAINER_RUNTIME_DISABLED_MESSAGE);
    expect(trapCalls()).toBe("");
  });

  it("refuses every lifecycle action with a 409, so run, stop and remove cannot touch a real container", async () => {
    for (const action of ["pull", "run", "start", "stop", "remove"] as const) {
      await expect(containerComputerAction(action), action).rejects.toMatchObject({
        message: CONTAINER_RUNTIME_DISABLED_MESSAGE,
        status: 409,
      });
    }
    expect(trapCalls()).toBe("");
  });

  it("fails a bridge liveness probe instead of spawning the runtime", async () => {
    expect(await runLivenessProbe({ command: "docker", args: ["version"] })).toBe(false);
    expect(trapCalls()).toBe("");
  });

  it("runs a runtime only from the fixture directory, by absolute path", async () => {
    vi.stubEnv(CONTAINER_RUNTIME_FIXTURE_DIR_ENV, dir);
    expect(fixtureRuntimeCommand("docker")).toBe(join(dir, "docker"));
    expect(fixtureRuntimeCommand("nerdctl")).toBeNull();

    const { stdout } = await defaultCommandRunner("docker", ["info", "--format", "x"]);
    expect(stdout.trim()).toBe("fixture-docker");
    expect(trapCalls()).toBe("docker info --format x\n");
  });

  it("detects only the fixture runtimes, never a PATH lookup, when a fixture directory is set", async () => {
    const only = mkdtempSync(join(tmpdir(), "bf-runtime-guard-only-"));
    try {
      writeFileSync(join(only, "docker"), "#!/bin/sh\necho fixture-server\n", { mode: 0o755 });
      chmodSync(join(only, "docker"), 0o755);
      vi.stubEnv(CONTAINER_RUNTIME_FIXTURE_DIR_ENV, only);

      // podman, container and the rest ARE on PATH (the traps), and are ignored.
      expect(await containerRuntimeStatus(undefined, "linux")).toEqual({
        runtime: "docker",
        available: ["docker"],
        daemonUp: true,
      });
      expect(trapCalls()).toBe("");
    } finally {
      await removeTempDir(only);
    }
  });

  it("does not interfere with an injected runner (a test double)", async () => {
    const calls: string[] = [];
    const status = await containerRuntimeStatus(async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "" };
    }, "linux");
    expect(status.runtime).toBe("docker");
    expect(calls.length).toBeGreaterThan(0);
  });
});
