import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveConfig } from "./config.ts";
import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  SHARED_LOCAL_VM_TARGET,
  containerComputerAction,
  containerRunArgs,
  defaultCommandRunner,
  perBotLocalVmTarget,
  refreshLocalVmGhCredentials,
  setupCommands,
  type CommandRunOptions,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";
import {
  GH_SYNC_RETRY_MS,
  LOCAL_VM_GH_CONFIG_DIR,
  forgetLocalVmGhToken,
  ghLoginExecArgs,
  ghLoginScript,
  localVmGhContainerEnv,
  readHostGhToken,
  resetLocalVmGhTokenCache,
  syncLocalVmGhToken,
} from "./local-vm-gh-credentials.ts";

// A fake that merely LOOKS like a token.  Nothing here ever talks to GitHub.
const FAKE_TOKEN = "gho_FakeTokenForUnitTestsOnly000000000";
const OTHER_TOKEN = "gho_AnotherFakeTokenForUnitTests00000";
const CONTAINER_NAME = "botfleet-computer-test";

interface Call {
  command: string;
  args: string[];
  timeout?: number;
  options?: CommandRunOptions;
}

/** Host `gh auth token` answers with `state.token` (null = signed out); a
 *  `docker exec` succeeds unless `state.loginError` is set. */
function ghFake(initial: { token?: string | null; loginError?: Error } = {}) {
  const state = { token: initial.token === undefined ? FAKE_TOKEN : initial.token, loginError: initial.loginError };
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, timeout, options) => {
    calls.push({ command, args, timeout, options });
    if (command === "gh") {
      if (state.token === null) throw new Error("gh: not logged in");
      return { stdout: `${state.token}\n` };
    }
    if (command === "docker" && args[0] === "exec") {
      if (state.loginError) throw state.loginError;
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return {
    calls,
    run,
    state,
    logins: () => calls.filter((call) => call.command === "docker" && call.args[0] === "exec"),
  };
}

const sync = (run: CommandRunner, extra: { now?: () => number; log?: (level: "info" | "warn", message: string) => void } = {}) =>
  syncLocalVmGhToken({ runtime: "docker", containerName: CONTAINER_NAME, runner: run, ...extra });

beforeEach(() => {
  resetLocalVmGhTokenCache();
  // The sync reports through console by default; keep the test output readable.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLocalVmGhTokenCache();
  saveConfig({ localVm: { shareCliCredentials: false } });
});

describe("the token only ever travels on stdin", () => {
  it("logs in inside the container as cua, with the token on stdin and in no argv or env", async () => {
    const fake = ghFake();
    await expect(sync(fake.run)).resolves.toBe("synced");

    const [login] = fake.logins();
    expect(login).toBeDefined();
    expect(login!.args.slice(0, 4)).toEqual(["exec", "-i", "-u", "cua"]);
    expect(login!.args).toContain(CONTAINER_NAME);
    expect(login!.args).toContain(`GH_CONFIG_DIR=${LOCAL_VM_GH_CONFIG_DIR}`);
    expect(login!.options?.input).toBe(`${FAKE_TOKEN}\n`);

    // The script is the in-container half of the login.
    const script = login!.args[login!.args.length - 1]!;
    expect(script).toContain("gh auth login --hostname github.com --with-token --insecure-storage");
    expect(script).toContain("umask 077");
    expect(script).toContain('chmod 700 "$GH_CONFIG_DIR"');

    // No call anywhere carries the token outside of stdin.
    for (const call of fake.calls) {
      expect(JSON.stringify([call.command, call.args, call.options?.env ?? null])).not.toContain(FAKE_TOKEN);
    }
    expect(fake.calls.filter((call) => call.options?.input !== undefined)).toHaveLength(1);
  });

  it("reads the host login with the harness's own token variables cleared", async () => {
    const fake = ghFake();
    await sync(fake.run);

    const hostCall = fake.calls[0]!;
    expect(hostCall.command).toBe("gh");
    expect(hostCall.args).toEqual(["auth", "token", "--hostname", "github.com"]);
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
      expect(Object.keys(hostCall.options?.env ?? {})).toContain(name);
      expect(hostCall.options?.env?.[name]).toBeUndefined();
    }
  });

  it("never puts the token in the exec argv builder or the container's create-time environment", () => {
    expect(JSON.stringify(ghLoginExecArgs(CONTAINER_NAME))).not.toMatch(/gh[opsu]_|github_pat_/);
    expect(localVmGhContainerEnv().join("\n")).not.toMatch(/gh[opsu]_|github_pat_|TOKEN/);
  });

  it("keeps the token out of the log, even when the command echoed it back", async () => {
    const error = Object.assign(new Error("Command failed"), { stderr: `error validating ${FAKE_TOKEN}: HTTP 401\n` });
    const fake = ghFake({ loginError: error });
    const lines: string[] = [];
    await expect(sync(fake.run, { log: (level, message) => lines.push(`${level}: ${message}`) })).resolves.toBe("failed");
    expect(lines.join("\n")).toContain("HTTP 401");
    expect(lines.join("\n")).not.toContain(FAKE_TOKEN);
  });
});

describe.skipIf(process.platform === "win32")("the real command runner", () => {
  it("writes input to stdin and removes a variable overlaid with undefined", async () => {
    await expect(defaultCommandRunner("/bin/cat", [], 5_000, { input: "from-stdin" })).resolves.toEqual({
      stdout: "from-stdin",
    });

    process.env.BOTFLEET_GH_TEST_VAR = "present";
    try {
      const kept = await defaultCommandRunner("/bin/sh", ["-c", 'printf %s "${BOTFLEET_GH_TEST_VAR-unset}"']);
      expect(kept.stdout).toBe("present");
      const removed = await defaultCommandRunner("/bin/sh", ["-c", 'printf %s "${BOTFLEET_GH_TEST_VAR-unset}"'], 5_000, {
        env: { BOTFLEET_GH_TEST_VAR: undefined },
      });
      expect(removed.stdout).toBe("unset");
    } finally {
      delete process.env.BOTFLEET_GH_TEST_VAR;
    }
  });

  it("does not crash when the command exits without reading its stdin", async () => {
    await expect(defaultCommandRunner("/usr/bin/true", [], 5_000, { input: "x".repeat(1 << 20) })).resolves.toBeDefined();
  });
});

describe("host login handling", () => {
  it("skips quietly, without touching the container, when gh fails on the host", async () => {
    const fake = ghFake({ token: null });
    const lines: string[] = [];
    await expect(sync(fake.run, { log: (_level, message) => lines.push(message) })).resolves.toBe("no-host-token");
    expect(fake.logins()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no host gh login");
  });

  it("treats output that is not a token as no login", async () => {
    for (const stdout of ["", "\n", "gh: command exited with a long\nmultiline explanation\n", "x"]) {
      await expect(
        readHostGhToken(async () => ({ stdout })),
      ).resolves.toBeNull();
    }
    await expect(readHostGhToken(async () => ({ stdout: `${FAKE_TOKEN}\n` }))).resolves.toBe(FAKE_TOKEN);
  });

  it("logs the same 'no host login' line once per container, not once per turn", async () => {
    const fake = ghFake({ token: null });
    const lines: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) await sync(fake.run, { log: (_level, message) => lines.push(message) });
    expect(lines).toHaveLength(1);
  });
});

describe("hash-gated refresh", () => {
  it("logs in once, then skips while the host token is unchanged", async () => {
    const fake = ghFake();
    await expect(sync(fake.run)).resolves.toBe("synced");
    await expect(sync(fake.run)).resolves.toBe("unchanged");
    await expect(sync(fake.run)).resolves.toBe("unchanged");
    expect(fake.logins()).toHaveLength(1);
  });

  it("logs in again when the host re-logs in with a different token", async () => {
    const fake = ghFake();
    await sync(fake.run);
    fake.state.token = OTHER_TOKEN;
    await expect(sync(fake.run)).resolves.toBe("synced");
    const logins = fake.logins();
    expect(logins).toHaveLength(2);
    expect(logins[1]!.options?.input).toBe(`${OTHER_TOKEN}\n`);
  });

  it("keeps one entry per container", async () => {
    const fake = ghFake();
    await sync(fake.run);
    await syncLocalVmGhToken({ runtime: "docker", containerName: "botfleet-computer-other", runner: fake.run });
    expect(fake.logins()).toHaveLength(2);
    await sync(fake.run);
    expect(fake.logins()).toHaveLength(2);
  });

  it("does not hammer a rejected token, but retries a changed token or a later attempt", async () => {
    const fake = ghFake({ loginError: new Error("HTTP 401") });
    let now = 1_000;
    const clock = () => now;
    await expect(sync(fake.run, { now: clock })).resolves.toBe("failed");
    await expect(sync(fake.run, { now: clock })).resolves.toBe("backoff");
    expect(fake.logins()).toHaveLength(1);

    now += GH_SYNC_RETRY_MS - 1;
    await expect(sync(fake.run, { now: clock })).resolves.toBe("backoff");
    expect(fake.logins()).toHaveLength(1);

    now += 1;
    await expect(sync(fake.run, { now: clock })).resolves.toBe("failed");
    expect(fake.logins()).toHaveLength(2);

    fake.state.token = OTHER_TOKEN;
    fake.state.loginError = undefined;
    await expect(sync(fake.run, { now: clock })).resolves.toBe("synced");
    expect(fake.logins()).toHaveLength(3);
  });

  it("shares one login between overlapping syncs of the same container", async () => {
    const fake = ghFake();
    const outcomes = await Promise.all([sync(fake.run), sync(fake.run), sync(fake.run)]);
    expect(outcomes).toEqual(["synced", "synced", "synced"]);
    expect(fake.logins()).toHaveLength(1);
  });

  it("logs in again after the container is forgotten, because a new container has no login", async () => {
    const fake = ghFake();
    await sync(fake.run);
    forgetLocalVmGhToken(CONTAINER_NAME);
    await expect(sync(fake.run)).resolves.toBe("synced");
    expect(fake.logins()).toHaveLength(2);
  });

  it("does not record a login that finished after its container was replaced", async () => {
    const fake = ghFake();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: CommandRunner = async (command, args, timeout, options) => {
      if (command === "docker") await gate;
      return fake.run(command, args, timeout, options);
    };
    const pending = sync(slow);
    // Let the host read resolve and the (gated) exec start.
    await new Promise((resolve) => setTimeout(resolve, 10));
    forgetLocalVmGhToken(CONTAINER_NAME);
    release();
    await pending;

    await expect(sync(fake.run)).resolves.toBe("synced");
    expect(fake.logins()).toHaveLength(2);
  });
});

describe("the existing share-CLI-credentials option gates all of it", () => {
  it("does nothing when the option is off", async () => {
    const fake = ghFake();
    await expect(refreshLocalVmGhCredentials("docker", perBotLocalVmTarget("gate-off"), fake.run)).resolves.toBe("disabled");
    expect(fake.calls).toHaveLength(0);
  });

  it("carries the login in when the option is on", async () => {
    saveConfig({ localVm: { shareCliCredentials: true } });
    const fake = ghFake();
    const target = perBotLocalVmTarget("gate-on");
    await expect(refreshLocalVmGhCredentials("docker", target, fake.run)).resolves.toBe("synced");
    expect(fake.logins()[0]!.args).toContain(target.containerName);
    await expect(refreshLocalVmGhCredentials("docker", target, fake.run)).resolves.toBe("unchanged");
    expect(fake.logins()).toHaveLength(1);
  });

  it("keys the cache per container, so each per-bot VM gets its own login", async () => {
    saveConfig({ localVm: { shareCliCredentials: true } });
    const fake = ghFake();
    await refreshLocalVmGhCredentials("docker", perBotLocalVmTarget("bot-a"), fake.run);
    await refreshLocalVmGhCredentials("docker", perBotLocalVmTarget("bot-b"), fake.run);
    await refreshLocalVmGhCredentials("docker", SHARED_LOCAL_VM_TARGET, fake.run);
    expect(new Set(fake.logins().map((call) => call.args[call.args.indexOf("sh") - 1])).size).toBe(3);
  });
});

describe("container create", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "gh-create-home-"));
  const envPairs = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : []));

  it("points gh at a writable directory and git's github.com helper at gh when the option is on", () => {
    const args = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "linux", {
      shareCliCredentials: true,
      homeDir: fakeHome,
    });
    const env = envPairs(args);
    expect(env).toContain(`GH_CONFIG_DIR=${LOCAL_VM_GH_CONFIG_DIR}`);
    expect(env).toContain("GIT_CONFIG_COUNT=4");
    expect(env).toContain("GIT_CONFIG_KEY_1=credential.https://github.com.helper");
    expect(env).toContain("GIT_CONFIG_VALUE_1=!gh auth git-credential");
    // The empty value resets the host gitconfig's own (host-path) helper first.
    expect(env).toContain("GIT_CONFIG_VALUE_0=");
    // The writable directory is not under any bind mount.
    for (const mount of args.filter((arg) => arg.startsWith("type=bind,"))) {
      const target = /target=([^,]+)/.exec(mount)![1]!;
      expect(`${LOCAL_VM_GH_CONFIG_DIR}/`.startsWith(`${target}/`)).toBe(false);
    }
  });

  it("adds nothing when the option is off", () => {
    const args = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "linux", { homeDir: fakeHome });
    expect(envPairs(args).filter((entry) => /^(GH_|GIT_)/.test(entry))).toEqual([]);
  });

  it("quotes the helper in the pasteable setup command", () => {
    saveConfig({ localVm: { shareCliCredentials: true } });
    const run = setupCommands("docker", "linux", SHARED_LOCAL_VM_TARGET).run!;
    expect(run).toContain("-e 'GIT_CONFIG_VALUE_1=!gh auth git-credential'");
    expect(run).toContain("-e GH_CONFIG_DIR=/home/cua/.local/state/botfleet-gh");
  });
});

describe("Local VM create and recreate", () => {
  const dockerHost = (fake: ReturnType<typeof ghFake>) => {
    const run: CommandRunner = async (command, args, timeout, options) => {
      const key = [command, ...args].join(" ");
      if (key === "/usr/bin/which docker") return { stdout: "docker\n" };
      if (key === "/usr/bin/which podman") throw new Error("missing");
      if (key === "docker info --format {{.ServerVersion}}") return { stdout: "29\n" };
      if (key === "docker info --format {{.NCPU}} {{.MemTotal}}") return { stdout: "3 4294967296\n" };
      if (key === `docker image inspect ${IMAGE}`) {
        return {
          stdout: JSON.stringify([
            {
              Id: "sha256:managed-image-id",
              Config: {
                Labels: {
                  [MANAGED_LABEL]: "1",
                  [DRIVER_LABEL]: CUA_DRIVER_VERSION,
                  [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
                  [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
                },
              },
            },
          ]),
        };
      }
      if (command === "docker" && args[0] === "run") {
        fake.calls.push({ command, args, timeout, options });
        return { stdout: "id\n" };
      }
      if (command === "gh" || (command === "docker" && args[0] === "exec")) return fake.run(command, args, timeout, options);
      throw new Error(`no such object: ${key}`);
    };
    return run;
  };
  const tempTarget = (): LocalVmTarget => {
    const base = perBotLocalVmTarget("gh-sync-test");
    return { ...base, viewerPort: null, workspaceDir: join(mkdtempSync(join(tmpdir(), "vm-gh-")), "homes", "abcd") };
  };

  it("does not touch gh at all when the option is off", async () => {
    const fake = ghFake();
    await containerComputerAction("run", dockerHost(fake), "linux", tempTarget());
    expect(fake.calls.map((call) => call.command)).toEqual(["docker"]);
  });

  it("logs gh in right after a successful create, and again for a recreated container", async () => {
    saveConfig({ localVm: { shareCliCredentials: true } });
    const fake = ghFake();
    const host = dockerHost(fake);
    const target = tempTarget();

    await containerComputerAction("run", host, "linux", target);
    const order = fake.calls.map((call) => (call.command === "docker" ? `docker ${call.args[0]}` : call.command));
    // Create first, then read the host token, then log in.
    expect(order).toEqual(["docker run", "gh", "docker exec"]);
    expect(fake.calls[0]!.args).toContain(`GH_CONFIG_DIR=${LOCAL_VM_GH_CONFIG_DIR}`);

    // A later turn with the same token costs only the host read.
    await expect(refreshLocalVmGhCredentials("docker", target, host)).resolves.toBe("unchanged");
    expect(fake.logins()).toHaveLength(1);

    // The container is replaced under the same name: the new one has no login.
    await containerComputerAction("run", host, "linux", target);
    expect(fake.logins()).toHaveLength(2);
  });

  it("keeps a failed login from failing the create", async () => {
    saveConfig({ localVm: { shareCliCredentials: true } });
    const fake = ghFake({ loginError: new Error("HTTP 401") });
    await expect(containerComputerAction("run", dockerHost(fake), "linux", tempTarget())).resolves.toBeDefined();
    expect(fake.logins()).toHaveLength(1);
  });
});

describe("the login script", () => {
  it("never reads the host's token-bearing hosts.yml and copies preferences only once", () => {
    const script = ghLoginScript();
    expect(script).not.toContain("hosts.yml");
    expect(script).toContain('[ ! -e "$GH_CONFIG_DIR/config.yml" ]');
    // The token-reading login is the last command, so nothing before it can consume stdin.
    expect(script.trim().split("\n").pop()).toMatch(/^exec gh auth login /);
  });
});
