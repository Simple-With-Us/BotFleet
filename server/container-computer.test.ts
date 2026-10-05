import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

import { DATA_DIR } from "./config.ts";
import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  BOX_GATEWAY_PATH,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DRIVER_LABEL,
  HOST_GATEWAY_BLACKHOLE,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  LEGACY_VM_WORKSPACE_DIR,
  MANAGED_LABEL,
  TARGET_LABEL,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  VM_WORKSPACE_ROOT,
  WORKSPACE_LABEL,
  DEFAULT_CONTAINER_LIMITS,
  LEGACY_UNLABELED_CONTAINER_LIMITS,
  LIMITS_LABEL,
  adaptContainerLimits,
  localVmHostCapacityError,
  declaredHardening,
  authorizeBoxGateway,
  defaultCommandRunner,
  healCuaShimsScript,
  limitsFromLabels,
  redactSecrets,
  readRuntimeHost,
  resolveContainerLimits,
  boxGatewayUrl,
  computerProxyEnv,
  containerComputerAction,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  wakeContainerComputer,
  containerNetworkArgs,
  containerRuntimeStatus,
  containerRunArgs,
  hostCliCredentialMounts,
  handleBoxGatewayRequest,
  managedImageDockerfile,
  migrateVmWorkspace,
  mintBoxGatewayGrant,
  resetBoxGatewayGrants,
  revokeBoxGatewayGrant,
  SHARED_LOCAL_VM_TARGET,
  localVmModeSwitchTargets,
  legacyVmWorkspaceDir,
  perBotLocalVmTarget,
  podmanSecurityIsHardened,
  setupCommands,
  workspaceSources,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";

function runner(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response instanceof Error || response === undefined) {
      throw response ?? new Error(`unexpected command: ${key}`);
    }
    return { stdout: response };
  };
  return { calls, run };
}

const driverExec =
  `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
  `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ${CUA_EXECUTABLE}`;
const versionProbe = `${driverExec} --version`;
const statusProbe = `${driverExec} status --socket ${CUA_SOCKET}`;
const healthProbe = `${driverExec} call health_report {} --socket ${CUA_SOCKET}`;
const readinessProbe =
  `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
  "--screenshot-out-file /tmp/botfleet-readiness.png";
const readinessRead = `docker exec ${CONTAINER} base64 -w0 /tmp/botfleet-readiness.png`;
const validPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function preparedImageInspect() {
  return JSON.stringify([
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
  ]);
}

function readyInspect(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      Config: {
        Image: IMAGE,
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [WORKSPACE_LABEL]: "1",
        },
        Env: ["VNC_PW=secret123"],
      },
      State: { Running: true },
      Image: "sha256:managed-image-id",
      // the full hardened HostConfig the stricter shared check now demands:
      // unprivileged, private IPC/cgroup namespaces, pinned shm, no devices
      HostConfig: {
        Memory: 8 * 1024 * 1024 * 1024,
        MemorySwap: 8 * 1024 * 1024 * 1024,
        NanoCpus: 4_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        IpcMode: "private",
        CgroupnsMode: "private",
        ShmSize: 512 * 1024 * 1024,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
      },
      Mounts: [
        {
          Type: "bind",
          Source: VM_WORKSPACE_DIR,
          Destination: VM_WORKSPACE_GUEST,
          RW: true,
        },
      ],
      ...overrides,
    },
  ]);
}

function perBotReadyInspect(botId: string, viewerPort: number, targetLabel?: string) {
  const target = perBotLocalVmTarget(botId);
  const detail = JSON.parse(readyInspect())[0];
  detail.Config.Labels[TARGET_LABEL] = targetLabel ?? target.label;
  detail.Mounts[0].Source = target.workspaceDir;
  detail.HostConfig.PortBindings["6901/tcp"][0].HostPort = String(viewerPort);
  detail.NetworkSettings = {
    Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: String(viewerPort) }] },
  };
  return JSON.stringify([detail]);
}

describe("containerComputerStatus", () => {
  it("prefers the supported Podman image store when Docker is also healthy on Windows", async () => {
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": "C:\\Program Files\\Docker\\docker.exe\n",
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      "docker info --format {{.ServerVersion}}": "29.0.0\n",
    });

    const status = await containerRuntimeStatus(fake.run, "win32");

    expect(status).toEqual({
      runtime: "podman",
      available: ["podman", "docker"],
      daemonUp: true,
    });
  });

  it("accepts exact Podman-on-Windows hardening and its WSL-translated durable mount", async () => {
    const derived = perBotLocalVmTarget("bot-win");
    const target: LocalVmTarget = {
      ...derived,
      workspaceDir: "C:\\Users\\light\\.botfleet\\vm-homes\\win-target",
    };
    const detail = JSON.parse(perBotReadyInspect("bot-win", 41629))[0];
    detail.Mounts[0].Source = "/mnt/c/Users/light/.botfleet/vm-homes/win-target";
    detail.HostConfig = {
      ...detail.HostConfig,
      CapDrop: ["CAP_CHOWN", "CAP_DAC_OVERRIDE"],
      CapAdd: [],
      PidMode: "private",
      UTSMode: "private",
      CgroupnsMode: null,
    };
    detail.EffectiveCaps = ["CAP_SETGID", "CAP_SETUID"];
    detail.BoundingCaps = ["CAP_SETGID", "CAP_SETUID"];
    const targetDriverExec =
      `podman exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": new Error("missing"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${target.containerName}`]: JSON.stringify([detail]),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/botfleet-readiness.png`]: "{}\n",
      [`podman exec ${target.containerName} base64 -w0 /tmp/botfleet-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "win32", target);

    expect(status).toMatchObject({
      runtime: "podman",
      security: "hardened",
      persistence: "durable",
      network: "loopback",
      ready: true,
    });
  });

  it("rejects extra effective or bounding capabilities in Podman inspect output", () => {
    const config = {
      Memory: 8 * 1024 * 1024 * 1024,
      MemorySwap: 8 * 1024 * 1024 * 1024,
      NanoCpus: 4_000_000_000,
      PidsLimit: 512,
      CapDrop: ["CAP_CHOWN"],
      CapAdd: [],
      Privileged: false,
      PidMode: "private",
      IpcMode: "private",
      UTSMode: "private",
      ShmSize: 512 * 1024 * 1024,
      Devices: [],
      DeviceRequests: null,
      SecurityOpt: [],
      UsernsMode: "",
      CgroupnsMode: undefined,
      OomKillDisable: false,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    };
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(true);
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(false);
  });

  it("keeps per-bot identities, workspaces, and ephemeral viewer ports separate", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const targetDriverExec =
      `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/botfleet-readiness.png`]: "{}\n",
      [`docker exec ${target.containerName} base64 -w0 /tmp/botfleet-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status).toMatchObject({
      container_name: target.containerName,
      target_key: target.key,
      workspace_path: target.workspaceDir,
      viewer_port: 49152,
      managed: true,
      persistence: "durable",
      ready: true,
    });
    expect(status.viewer_url).toContain("http://127.0.0.1:49152/vnc.html");
  });

  it("refuses a per-bot container carrying another target's label", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const other = perBotLocalVmTarget("bot-b");
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152, other.label),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.managed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("not created by BotFleet");
  });

  it("prefers a running runtime over an earlier installed but stopped one", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": "podman\n",
      "docker info --format {{.ServerVersion}}": new Error("daemon stopped"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: false },
          HostConfig: { PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] } },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.runtime).toBe("podman");
    expect(status.available).toEqual(["docker", "podman"]);
    expect(status.daemonUp).toBe(true);
    expect(status.image).toBe(true);
    expect(status.container).toBe("stopped");
    expect(status.network).toBe("loopback");
  });

  it("uses Apple container's actual system and inspect commands", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${CONTAINER}`]: JSON.stringify([
        {
          configuration: {
            image: { reference: IMAGE, descriptor: { digest: "sha256:managed-image-id" } },
            resources: { cpus: 4, memoryInBytes: 8 * 1024 * 1024 * 1024 },
            publishedPorts: [{ hostAddress: "127.0.0.1", containerPort: 6901 }],
            labels: {
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [WORKSPACE_LABEL]: "1",
            },
            mounts: [{ source: VM_WORKSPACE_DIR, destination: VM_WORKSPACE_GUEST, options: [] }],
          },
          status: { state: "running" },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "darwin");

    expect(status.runtime).toBe("container");
    expect(status.container).toBe("running");
    expect(status.network).toBe("loopback");
    expect(fake.calls).not.toContain("container info --format {{.ServerVersion}}");
  });

  it("does not report a running container as ready when its viewer is public", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "27\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        HostConfig: {
          Memory: 8 * 1024 * 1024 * 1024,
          MemorySwap: 8 * 1024 * 1024 * 1024,
          NanoCpus: 4_000_000_000,
          PidsLimit: 512,
          CapDrop: ["ALL"],
          CapAdd: ["CAP_SETUID", "CAP_SETGID"],
          PortBindings: { "6901/tcp": [{ HostIp: "0.0.0.0" }] },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.container).toBe("running");
    expect(status.network).toBe("unsafe");
    expect(status.ready).toBe(false);
  });

  it("rejects a privileged or host-namespaced Local VM even with correct limits", async () => {
    // pins the stricter shared hardening check: resource limits alone are
    // not hardening — privilege and namespace escapes disqualify the VM too
    const base = JSON.parse(readyInspect())[0].HostConfig;
    for (const override of [
      { Privileged: true },
      { IpcMode: "host" },
      { PidMode: "host" },
      { CgroupnsMode: "host" },
      { SecurityOpt: ["seccomp=unconfined"] },
      { DeviceRequests: [{ Driver: "nvidia" }] },
      { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
    ]) {
      const fake = runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: readyInspect({ HostConfig: { ...base, ...override } }),
      });
      const status = await containerComputerStatus(fake.run, "linux");
      expect(status.security, JSON.stringify(override)).toBe("unsafe");
      expect(status.ready).toBe(false);
    }
  });

  it("rejects missing or unexpected host mounts instead of exposing them to the bot", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Mounts: [
          { Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true },
          { Type: "bind", Source: "/tmp/unexpected", Destination: "/host", RW: true },
        ],
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.persistence).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("durable workspace");
  });

  it("does not mistake an unrelated container executable for Apple container off macOS", async () => {
    const fake = runner({
      "where.exe docker": new Error("missing"),
      "where.exe podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "win32");

    expect(status.runtime).toBeNull();
    expect(fake.calls).not.toContain("where.exe container");
  });

  it("reports ready only after the exact image, limits, network, version and daemon pass", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status).toMatchObject({
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      desktop_error: null,
      ready: true,
      problem: null,
      driver_version: "0.20.0",
    });
    expect(status.viewer_url).toContain("#autoconnect=true&resize=scale&password=secret123");
  });

  it("reports the bounded desktop startup error instead of waiting forever", async () => {
    const errorProbe =
      `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: new Error("driver unavailable"),
      [errorProbe]: "X display :1 did not become ready within 45 seconds\n",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
  });

  it("does not report ready when the driver's health contract fails", async () => {
    const errorProbe = `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "failed", checks: [] }),
      [errorProbe]: "",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("health report is failed");
    expect(fake.calls).not.toContain(readinessProbe);
  });

  it("rejects a lookalike container with a different driver or base-image label", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: {
          Image: IMAGE,
          Labels: { [MANAGED_LABEL]: "1", [DRIVER_LABEL]: "0.12.4", [BASE_IMAGE_LABEL]: "wrong" },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
    expect(fake.calls).not.toContain(versionProbe);
  });

  it("rejects a container created from a stale build under the same mutable tag", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ Image: "sha256:previous-build-id" }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image_id).toBe("managed-image-id");
    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
  });

  it("does not treat an unlabelled image under the local tag as prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: JSON.stringify([{ Config: { Labels: {} } }]),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image).toBe(false);
    expect(status.problem).toContain("Prepare the Cua desktop image");
  });
});

describe("Cua integration", () => {
  it("points the box proxy at the harness gateway instead of the account's Box API", () => {
    // Repinned: the proxy used to receive the account-wide API key and talk
    // to ascii.dev itself.  It now receives a per-mount grant and the
    // loopback base that grant is only good at.
    expect(
      computerProxyEnv({
        boxId: "bx_1",
        token: "grant-value",
        gatewayUrl: `http://127.0.0.1:8799${BOX_GATEWAY_PATH}`,
        control: { url: "http://127.0.0.1:8799/api/internal/computer-control?botId=b1", token: "ctl" },
      }),
    ).toEqual({
      OGB_BOX_API: `http://127.0.0.1:8799${BOX_GATEWAY_PATH}`,
      OGB_BOX_ID: "bx_1",
      OGB_BOX_TOKEN: "grant-value",
      OMB_CONTROL_URL: "http://127.0.0.1:8799/api/internal/computer-control?botId=b1",
      OMB_CONTROL_TOKEN: "ctl",
    });
  });

  it("derives the gateway base from the turn's own control endpoint", () => {
    expect(boxGatewayUrl({ url: `http://127.0.0.1:8799/api/internal/computer-control?botId=b%201` })).toBe(
      `http://127.0.0.1:8799${BOX_GATEWAY_PATH}`,
    );
    expect(boxGatewayUrl(undefined)).toBe("");
    expect(boxGatewayUrl({ url: "not a url" })).toBe("");
  });

  it("keeps the VM workspace out of the tree the desktop app can open", () => {
    // `resolveOpenablePath` (electron/open-file.mjs) confines every
    // renderer-supplied path to DATA_DIR and then calls shell.openPath, so a
    // workspace inside that tree is one click from a user.  The check is a
    // path-segment test, not a string prefix: the new root's name starts with
    // the old one ("~/.botfleet-vm"), which a prefix test would call inside.
    const inside = (root: string, candidate: string) => {
      const rel = relative(root, candidate);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    expect(inside(DATA_DIR, VM_WORKSPACE_DIR)).toBe(false);
    expect(inside(DATA_DIR, VM_WORKSPACE_ROOT)).toBe(false);
    expect(inside(VM_WORKSPACE_ROOT, VM_WORKSPACE_DIR)).toBe(true);
    expect(legacyVmWorkspaceDir(SHARED_LOCAL_VM_TARGET)).toBe(LEGACY_VM_WORKSPACE_DIR);
    expect(legacyVmWorkspaceDir(perBotLocalVmTarget("bot-1"))).toBe(
      join(DATA_DIR, "vm-homes", basename(perBotLocalVmTarget("bot-1").workspaceDir)),
    );
  });

  it("accepts a running pre-move container as a correctly bound workspace", () => {
    expect(workspaceSources(SHARED_LOCAL_VM_TARGET)).toEqual([VM_WORKSPACE_DIR, LEGACY_VM_WORKSPACE_DIR]);
  });

  it("names the host gateway blackhole per runtime instead of leaving the network implicit", () => {
    // Podman on macOS and Windows: the only supported setups are `podman
    // machine`, whose slirp4netns already denies host loopback — stated, not
    // inherited.  Rootful Linux Podman has no slirp4netns, so the mode is
    // left alone there.
    expect(containerNetworkArgs("podman", "darwin")).toEqual([
      "--network",
      "slirp4netns:allow_host_loopback=false",
      "--add-host",
      `host.docker.internal:${HOST_GATEWAY_BLACKHOLE}`,
      "--add-host",
      `host.containers.internal:${HOST_GATEWAY_BLACKHOLE}`,
    ]);
    expect(containerNetworkArgs("podman", "linux")).not.toContain("--network");
    expect(containerNetworkArgs("podman", "linux").join(" ")).toContain(
      `--add-host host.docker.internal:${HOST_GATEWAY_BLACKHOLE}`,
    );
    // Docker and Colima share an engine: the bridge gateway is not removable
    // by a run flag, so the names it answers to are pinned at a
    // documentation-only address instead.
    expect(containerNetworkArgs("docker", "darwin")).toEqual([
      "--network",
      "bridge",
      "--add-host",
      `host.docker.internal:${HOST_GATEWAY_BLACKHOLE}`,
      "--add-host",
      `host.containers.internal:${HOST_GATEWAY_BLACKHOLE}`,
    ]);
    // Apple's `container` CLI cannot be verified from this tree, so it is
    // given no flag it might reject.
    expect(containerNetworkArgs("container", "darwin")).toEqual([]);

    const docker = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "darwin");
    expect(docker.join(" ")).toContain("--add-host host.docker.internal:203.0.113.1");
    expect(containerRunArgs("podman", "pw", SHARED_LOCAL_VM_TARGET, "darwin").join(" ")).toContain(
      "--network slirp4netns:allow_host_loopback=false",
    );
  });

  it("mounts host CLI credentials into the guest when shareCliCredentials is enabled", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "bf-cli-home-"));
    mkdirSync(join(fakeHome, ".config", "gh"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "infisical"), { recursive: true });
    mkdirSync(join(fakeHome, ".infisical"), { recursive: true });
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    mkdirSync(join(fakeHome, ".docker"), { recursive: true });
    writeFileSync(join(fakeHome, ".gitconfig"), "fake git config");
    writeFileSync(join(fakeHome, ".config", "gh", "hosts.yml"), "fake gh");
    writeFileSync(join(fakeHome, ".infisical", "infisical-config.json"), "fake infisical");
    writeFileSync(join(fakeHome, ".config", "infisical", "shared.env"), "fake shared env");
    writeFileSync(join(fakeHome, ".ssh", "config"), "fake ssh");
    writeFileSync(join(fakeHome, ".docker", "config.json"), "fake docker");

    const mounts = hostCliCredentialMounts("darwin", fakeHome);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".gitconfig")},target=/home/cua/.gitconfig,readonly`);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".config", "gh")},target=/home/cua/.config/gh,readonly`);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".infisical")},target=/home/cua/.infisical,readonly`);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".config", "infisical")},target=/home/cua/.config/infisical,readonly`);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".ssh")},target=/home/cua/.ssh,readonly`);
    expect(mounts).toContain(`type=bind,source=${join(fakeHome, ".docker", "config.json")},target=/home/cua/.docker/config.json,readonly`);

    const args = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "darwin", {
      shareCliCredentials: true,
      homeDir: fakeHome,
    });
    expect(args).toContain(`type=bind,source=${join(fakeHome, ".gitconfig")},target=/home/cua/.gitconfig,readonly`);
    expect(args).toContain(`type=bind,source=${join(fakeHome, ".infisical")},target=/home/cua/.infisical,readonly`);
    expect(args).toContain(`type=bind,source=${join(fakeHome, ".ssh")},target=/home/cua/.ssh,readonly`);
  });

  it("accepts containers running with read-only CLI credential mounts as safe and durable", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Mounts: [
          { Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true },
          { Type: "bind", Source: "/Users/test/.infisical", Destination: "/home/cua/.infisical", RW: false },
          { Type: "bind", Source: "/Users/test/.ssh", Destination: "/home/cua/.ssh", RW: false },
          { Type: "bind", Source: "/Users/test/.gitconfig", Destination: "/home/cua/.gitconfig", RW: false },
        ],
      }),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux");
    expect(status.persistence).toBe("durable");
    expect(status.ready).toBe(true);
  });

  it("mounts the official Cua MCP server for Local VM turns", () => {
    const connection = containerComputerMcp("podman");
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.at(-3)).toBe("podman");
    expect(connection.args.at(-2)).toBe(CONTAINER);
    expect(connection.args.at(-1)).toBe(CUA_SOCKET);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("builds an exact, checksum-verified Cua Driver 0.20.0 image", () => {
    const dockerfile = managedImageDockerfile();
    expect(BASE_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`);
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(dockerfile).not.toContain("/tmp/cua-driver.whl");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain(`install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}`);
    expect(dockerfile).toContain(`cua-driver ${CUA_DRIVER_VERSION}`);
    expect(dockerfile).toContain(`serve --socket ${CUA_SOCKET} --permission-mode standard`);
    expect(dockerfile).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(dockerfile).toContain("prepare-botfleet-workspace.sh");
    expect(dockerfile).toContain('if ! chmod 0700 "$workspace"');
    expect(dockerfile).toContain('test -r "$directory" && test -w "$directory" && test -x "$directory"');
    expect(dockerfile).toContain("migrate_profile google-chrome");
    expect(dockerfile).toContain("migrate_profile chromium");
    expect(dockerfile).toContain("SingletonLock");
    expect(dockerfile).toContain(`${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"`);
    expect(dockerfile).toContain("did not become ready within 45 seconds");
    expect(dockerfile).not.toContain("while ! DISPLAY=:1 xset q");
  });

  it("rejects a zero-byte OpenSSL base image before the wheel download needs curl", () => {
    const dockerfile = managedImageDockerfile();
    // both multiarch triplets, both OpenSSL libraries
    expect(dockerfile).toContain('"/lib/$lib_triplet/libssl.so.3"');
    expect(dockerfile).toContain('"/lib/$lib_triplet/libcrypto.so.3"');
    expect(dockerfile).toContain("[ ! -s \"$ssl_lib\" ]");
    expect(dockerfile).toContain("is zero bytes, so curl cannot start");
    // the gate runs in the same RUN as the fetch, ahead of it — a defective
    // layer must be named before curl has any chance to fail confusingly
    const gate = dockerfile.indexOf('[ ! -s "$ssl_lib" ]');
    const fetch = dockerfile.indexOf("curl -fsSL");
    expect(gate).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(gate);
  });

  it("captures the preview through Cua Driver rather than xdotool or VNC", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/botfleet-preview.png";
    const png = validPng;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: png.toString("base64"),
      [screenshotCall]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/botfleet-preview.png`]: png.toString("base64"),
    });

    const image = await containerComputerScreenshot(fake.run, "linux");

    expect(image).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(fake.calls).toContain(screenshotCall);
    expect(fake.calls.some((call) => /xdotool|scrot|vnc/i.test(call))).toBe(false);
  });
});

describe("containerComputerAction", () => {
  it("fails closed instead of giving Apple container an invalid dynamic-port spec", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${target.containerName}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "darwin", target)).rejects.toThrow(
      "require Docker or Podman",
    );
    expect(fake.calls.some((call) => call.startsWith("container run "))).toBe(false);
  });

  it("does not create a VM before its managed image is prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: new Error("missing image"),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow(
      "Prepare the Cua desktop image",
    );
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(false);
  });

  it("never starts a stopped desktop because its stale X lock makes resume unsafe", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: false } }),
    });

    await expect(containerComputerAction("start", fake.run, "linux")).rejects.toThrow("cannot safely resume");
    expect(fake.calls).not.toContain(`docker start ${CONTAINER}`);
  });
});

describe("wakeContainerComputer", () => {
  // A stateful fake daemon: the container starts STOPPED, `rm` moves it to
  // missing, `run` moves it to running (unless scripted to fail). Every
  // status probe answers from the current phase.
  function wakeFake(opts: { removeResult?: Error; runResult?: Error; initialPhase?: "stopped" | "running" } = {}) {
    let phase: "stopped" | "missing" | "running" = opts.initialPhase ?? "stopped";
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (key === "/usr/bin/which docker") return { stdout: "docker\n" };
      if (key === "/usr/bin/which podman") throw new Error("missing");
      if (key === "docker info --format {{.ServerVersion}}") return { stdout: "29\n" };
      if (key === "docker info --format {{.NCPU}} {{.MemTotal}}") return { stdout: "8 17179869184\n" };
      if (key === "docker info --format {{.OperatingSystem}}") return { stdout: "Linux\n" };
      if (key === `docker image inspect ${IMAGE}`) return { stdout: preparedImageInspect() };
      if (key === `docker inspect ${CONTAINER}`) {
        if (phase === "running") return { stdout: readyInspect() };
        if (phase === "stopped") return { stdout: readyInspect({ State: { Running: false } }) };
        throw new Error("No such container");
      }
      if (key === `docker rm -f ${CONTAINER}`) {
        if (opts.removeResult) throw opts.removeResult;
        phase = "missing";
        return { stdout: `${CONTAINER}\n` };
      }
      if (key.startsWith("docker run ")) {
        if (opts.runResult) throw opts.runResult;
        phase = "running";
        return { stdout: "new-container-id\n" };
      }
      if (key === versionProbe) return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n` };
      if (key === statusProbe) return { stdout: "running\n" };
      if (key === healthProbe) return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }) };
      if (key === readinessProbe) return { stdout: "{}\n" };
      if (key === readinessRead) return { stdout: validPng.toString("base64") };
      throw new Error(`unexpected command: ${key}`);
    };
    return { calls, run };
  }

  it("recreates a stopped container and returns the fresh running status", async () => {
    const fake = wakeFake();
    const stopped = await containerComputerStatus(fake.run, "linux");
    expect(stopped.container).toBe("stopped");

    const woken = await wakeContainerComputer(stopped, fake.run, "linux");

    expect(woken.container).toBe("running");
    expect(woken.ready).toBe(true);
    expect(fake.calls).toContain(`docker rm -f ${CONTAINER}`);
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(true);
  });

  it("never removes a stopped container its runtime cannot recreate", async () => {
    const probe = wakeFake();
    const stopped = await containerComputerStatus(probe.run, "linux");
    expect(stopped.container).toBe("stopped");

    // create_supported:false (e.g. a runtime that cannot create this
    // target): removal would destroy the VM with no way back.
    const fake = wakeFake();
    const result = await wakeContainerComputer({ ...stopped, create_supported: false }, fake.run, "linux");

    expect(result.container).toBe("stopped");
    expect(fake.calls).toHaveLength(0);
  });

  it("leaves a running container alone", async () => {
    const fake = wakeFake({ initialPhase: "running" });
    const running = await containerComputerStatus(fake.run, "linux");
    expect(running.container).toBe("running");

    const callsBefore = fake.calls.length;
    const result = await wakeContainerComputer(running, fake.run, "linux");

    expect(result.container).toBe("running");
    expect(fake.calls.slice(callsBefore).some((call) => call.includes(" rm ") || call.startsWith("docker run "))).toBe(false);
  });

  it("reports the real failure when remove succeeds but run cannot recreate", async () => {
    // The regression from the #696 review thread: the old code suppressed
    // this and the readiness check judged the stale pre-wake snapshot,
    // misreporting a REMOVED container as merely stopped.
    const fake = wakeFake({ runResult: new Error("daemon exploded") });
    const stopped = await containerComputerStatus(fake.run, "linux");

    await expect(wakeContainerComputer(stopped, fake.run, "linux")).rejects.toThrow(
      /could not be started: daemon exploded/,
    );
    // The removal really happened (no silent skip), and no stale "stopped"
    // verdict was reused.
    expect(fake.calls).toContain(`docker rm -f ${CONTAINER}`);
  });

  it("creates a missing container on wake without calling remove first", async () => {
    const fake = wakeFake();
    let containerMissing = true;
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      if (key === `docker inspect ${CONTAINER}` && containerMissing) throw new Error("No such container");
      if (key.startsWith("docker run ")) containerMissing = false;
      if (key === "docker info --format {{.NCPU}} {{.MemTotal}}") return { stdout: "4 8589934592\n" };
      if (key === "docker info --format {{.OperatingSystem}}") return { stdout: "OrbStack\n" };
      return fake.run(command, args);
    };
    const missing = await containerComputerStatus(run, "linux");
    expect(missing.container).toBe("missing");

    const woken = await wakeContainerComputer(missing, run, "linux");
    expect(woken.container).toBe("running");
    expect(fake.calls.filter((call) => call === `docker rm -f ${CONTAINER}`)).toHaveLength(0);
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(true);
  });

  it("reports a remove failure without attempting a run", async () => {
    const fake = wakeFake({ removeResult: new Error("rm refused") });
    const stopped = await containerComputerStatus(fake.run, "linux");

    await expect(wakeContainerComputer(stopped, fake.run, "linux")).rejects.toThrow(
      /could not be started: rm refused/,
    );
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(false);
  });
});

describe("setupCommands", () => {
  it("derives opaque, distinct per-bot container and workspace identities", () => {
    const a = perBotLocalVmTarget("bot-a");
    const b = perBotLocalVmTarget("bot-b");

    expect(a).toEqual(perBotLocalVmTarget("bot-a"));
    expect(a.key).not.toBe(b.key);
    expect(a.containerName).not.toBe(b.containerName);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
    expect(a.containerName).not.toContain("bot-a");
    expect(a.workspaceDir).not.toContain("bot-a");
  });

  it("asks Docker for an ephemeral loopback viewer port for each per-bot VM", () => {
    const target = perBotLocalVmTarget("bot-a");
    const args = containerRunArgs("docker", "secret", target);
    const command = ["docker", ...args].join(" ");

    expect(command).toContain(`--name ${target.containerName}`);
    expect(command).toContain(`--label ${TARGET_LABEL}=${target.label}`);
    expect(command).toContain(`source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`);
    expect(command).toContain("-p 127.0.0.1::6901");
    expect(command).not.toContain("127.0.0.1:6080:6901");
  });

  it("does not invent Docker commands when no runtime was detected", () => {
    const commands = setupCommands(null, "darwin");
    expect(commands.pull).toBeNull();
    expect(commands.run).toBeNull();
    expect(commands.start).toBeNull();
    expect(commands.install).toContain("podman");
    expect(commands.install).not.toContain("Docker");
  });

  it("publishes only the password-protected viewer and only on loopback", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain("-p 127.0.0.1:6080:6901");
    expect(command).not.toContain(" -p 6080:6901");
    expect(command).not.toContain("5900");
    expect(command).toContain("VNC_PW=CHANGE_ME");
  });

  it("does not suggest docker start for an image that must be recreated", () => {
    expect(setupCommands("docker", "linux").start).toBeNull();
  });

  it("limits resources and retains only the sandbox supervisor's identity-switch caps", () => {
    const command = setupCommands("docker", "linux").run!;
    expect(command).toContain("--memory 3g --memory-swap 3g");
    expect(command).toContain("--cpus 2 --pids-limit 512");
    expect(command).toContain("--ipc private --cgroupns private");
    expect(command).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(command).toContain(`--label ${MANAGED_LABEL}=1`);
    expect(command).toContain(`--label ${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`);
    expect(command).toContain(`--label ${WORKSPACE_LABEL}=1`);
    expect(command).toContain(`--hostname ${CONTAINER}`);
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST}`,
    );
  });

  it("asks rootless Podman to map and privately relabel the durable workspace", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`,
    );
  });

  it("shows the pinned base pull while creating the managed derivative through the API", () => {
    expect(setupCommands("docker", "linux").pull).toBe(`docker pull ${BASE_IMAGE}`);
    expect(setupCommands("docker", "linux").run).toContain(IMAGE);
  });

  it("uses an explicit local image name so Podman never resolves the managed build on Docker Hub", () => {
    expect(IMAGE).toMatch(/^localhost\/botfleet\/cua-local-vm:/);
    expect(setupCommands("podman", "darwin").run).toContain(IMAGE);
    expect(setupCommands("podman", "darwin").run).not.toContain("docker.io/botfleet");
  });

  it("generates Apple container lifecycle commands without Docker-only flags", () => {
    const commands = setupCommands("container", "darwin");
    expect(commands.runtimeStart).toBe("container system start");
    expect(commands.remove).toBe(`container rm --force ${CONTAINER}`);
    expect(commands.run).toContain("--memory 3g --cpus 2 --cap-drop ALL");
    expect(commands.run).not.toContain("--memory-swap");
  });

  it("offers the supported Podman Desktop installer on Windows", () => {
    expect(setupCommands(null, "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
  });
});

describe("Local VM mode switch targets", () => {
  it("covers the shared target and every bot's own, without duplicates", () => {
    // A mode switch removes containers and refuses on a held lease.  Looking
    // only at the shared target meant switching to per-bot orphaned the
    // shared container and switching back orphaned one per bot, and a per-bot
    // lease held mid-turn never blocked the switch at all.
    const targets = localVmModeSwitchTargets(["bot-a", "bot-b", "bot-a"]);
    expect(targets[0]).toBe(SHARED_LOCAL_VM_TARGET);
    expect(targets.map((target) => target.key)).toEqual([
      SHARED_LOCAL_VM_TARGET.key,
      perBotLocalVmTarget("bot-a").key,
      perBotLocalVmTarget("bot-b").key,
    ]);
    // Distinct container names and workspaces, so "remove them all" removes
    // three different things rather than the same one three times.
    expect(new Set(targets.map((target) => target.containerName)).size).toBe(3);
    expect(new Set(targets.map((target) => target.workspaceDir)).size).toBe(3);
  });

  it("is just the shared target when the workspace has no bots", () => {
    expect(localVmModeSwitchTargets([])).toEqual([SHARED_LOCAL_VM_TARGET]);
  });
});

describe("migrateVmWorkspace", () => {
  const temp = () => mkdtempSync(join(tmpdir(), "omb-vm-migrate-"));

  it("moves a pre-move workspace into the new root, keeping the files", async () => {
    const dir = temp();
    const from = join(dir, "vm-home");
    const to = join(dir, "homes", "shared");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "keep-me.txt"), "workspace contents");

    expect(await migrateVmWorkspace(SHARED_LOCAL_VM_TARGET, { from, to })).toBe(from);
    expect(readFileSync(join(to, "keep-me.txt"), "utf8")).toBe("workspace contents");
  });

  it("does nothing when there is nothing to move, or the new root already exists", async () => {
    const dir = temp();
    expect(await migrateVmWorkspace(SHARED_LOCAL_VM_TARGET, { from: join(dir, "absent"), to: join(dir, "new") })).toBeNull();

    const from = join(dir, "vm-home");
    const to = join(dir, "new");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "already-here.txt"), "new root");
    expect(await migrateVmWorkspace(SHARED_LOCAL_VM_TARGET, { from, to })).toBeNull();
    // A migration is never destructive: the pre-move directory stays put.
    expect(existsSync(from)).toBe(true);
    expect(readFileSync(join(to, "already-here.txt"), "utf8")).toBe("new root");
  });
});

describe("Box gateway", () => {
  const bearer = (token: string) => `Bearer ${token}`;

  it("refuses a box the mount's grant does not name", async () => {
    resetBoxGatewayGrants();
    const grant = mintBoxGatewayGrant("bot-1", "box-allowed", `http://127.0.0.1:8799${BOX_GATEWAY_PATH}`);
    const call = (boxId: string) =>
      handleBoxGatewayRequest(
        { method: "POST", url: `${BOX_GATEWAY_PATH}/boxes/${boxId}/commands`, authorization: bearer(grant.token), remoteAddress: "127.0.0.1", body: "{}" },
        // SAFETY: the gateway reads `cfg.box.token` and nothing else, and this
        // test hands it one literal; a full AppConfig would only add sections
        // the gateway never looks at.
        { cfg: { box: { token: "account-wide-key" } } as never, fetchImpl: async () => new Response("{}") },
      );

    // The provider would have honoured both of these.  The gateway does not.
    expect((await call("box-someone-else")).status).toBe(403);
    expect((await call("box-allowed")).status).toBe(200);
  });

  it("forwards the granted call with the account key, which the child never sends", async () => {
    resetBoxGatewayGrants();
    const grant = mintBoxGatewayGrant("bot-1", "box-1", `http://127.0.0.1:8799${BOX_GATEWAY_PATH}`);
    const seen: Array<{ url: string; init: RequestInit }> = [];
    // SAFETY: the recorder answers the one Box command call this test makes and
    // never reaches the network, so the narrowed `(string, RequestInit)` shape
    // stands in for the overloaded global `fetch` without being one.
    const recordingFetch = async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response('{"exitCode":0}', { status: 200 });
    };
    const res = await handleBoxGatewayRequest(
      {
        method: "POST",
        url: `${BOX_GATEWAY_PATH}/boxes/box-1/commands?x=1`,
        authorization: bearer(grant.token),
        remoteAddress: "::1",
        body: '{"command":"ls"}',
      },
      {
        // SAFETY: the gateway reads `cfg.box.token` and nothing else, and this
        // test hands it one literal; a full AppConfig would only add sections
        // the gateway never looks at.
        cfg: { box: { token: "account-wide-key" } } as never,
        // SAFETY: the recorder answers the one Box command call this test makes
        // and never reaches the network, so the narrowed `(string, RequestInit)`
        // shape stands in for the overloaded global `fetch` without being one.
        fetchImpl: recordingFetch as typeof fetch,
      },
    );

    expect(res).toEqual({ status: 200, body: '{"exitCode":0}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/boxes/box-1/commands?x=1");
    // The child's own bearer is replaced, never forwarded.
    // SAFETY: `fetch` was handed a plain object literal for `headers`, so
    // reading it back as a flat string map is exact rather than hopeful.
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer account-wide-key");
    expect(seen[0]!.init.body).toBe('{"command":"ls"}');
  });

  it("answers only a loopback caller holding a live grant", () => {
    resetBoxGatewayGrants();
    const grant = mintBoxGatewayGrant("bot-1", "box-1", "");
    const call = (over: Partial<Parameters<typeof handleBoxGatewayRequest>[0]>) =>
      handleBoxGatewayRequest(
        { method: "GET", url: `${BOX_GATEWAY_PATH}/boxes/box-1/files?path=/tmp/a`, remoteAddress: "127.0.0.1", ...over },
        // SAFETY: the gateway reads `cfg.box.token` and nothing else, and this
        // test hands it one literal; a full AppConfig would only add sections
        // the gateway never looks at.
        { cfg: { box: { token: "account-wide-key" } } as never, fetchImpl: async () => new Response("{}") },
      );

    return Promise.all([
      expect(call({ remoteAddress: "10.0.0.7" }).then((r) => r.status)).resolves.toBe(403),
      expect(call({}).then((r) => r.status)).resolves.toBe(401),
      expect(call({ authorization: bearer("not-a-grant") }).then((r) => r.status)).resolves.toBe(401),
      expect(call({ authorization: bearer(grant.token) }).then((r) => r.status)).resolves.toBe(200),
    ]);
  });

  it("refuses operations outside the proxy's surface, so the key is never a general pass-through", async () => {
    resetBoxGatewayGrants();
    const grant = mintBoxGatewayGrant("bot-1", "box-1", "");
    const call = (method: string, tail: string) =>
      handleBoxGatewayRequest(
        { method, url: `${BOX_GATEWAY_PATH}/boxes/box-1/${tail}`, authorization: bearer(grant.token), remoteAddress: "127.0.0.1" },
        // SAFETY: the gateway reads `cfg.box.token` and nothing else, and this
        // test hands it one literal; a full AppConfig would only add sections
        // the gateway never looks at.
        { cfg: { box: { token: "account-wide-key" } } as never, fetchImpl: async () => new Response("{}") },
      );

    // Deleting a box, renaming one, and reading its account-wide listing all
    // used to be reachable with the key the child held.
    expect((await call("DELETE", "")).status).toBe(405);
    expect((await call("PATCH", "")).status).toBe(405);
    expect((await call("POST", "stop")).status).toBe(405);
    expect((await call("GET", "")).status).toBe(200);
    expect((await call("GET", "commands")).status).toBe(405);
    expect(authorizeBoxGateway(bearer(grant.token), "box-1", Date.now() + 5 * 60 * 60 * 1000).ok).toBe(false);
  });

  it("forgets a grant when it is revoked", () => {
    resetBoxGatewayGrants();
    const grant = mintBoxGatewayGrant("bot-1", "box-1", "");
    expect(authorizeBoxGateway(bearer(grant.token), "box-1").ok).toBe(true);
    revokeBoxGatewayGrant(grant.token);
    expect(authorizeBoxGateway(bearer(grant.token), "box-1").ok).toBe(false);
  });
});

describe("localVmHostCapacityError", () => {
  it("refuses hosts below the CPU and memory floors with plain guidance", () => {
    expect(localVmHostCapacityError({ cpus: 1, memoryBytes: 4 * 1024 ** 3 }, "OrbStack")).toMatch(
      /OrbStack has 1 CPUs.*at least 2.*Settings → System/,
    );
    expect(localVmHostCapacityError({ cpus: 4, memoryBytes: 1024 ** 3 }, "Docker")).toMatch(
      /about 1 GiB.*at least 2 GiB/,
    );
    expect(localVmHostCapacityError({ cpus: 3, memoryBytes: 4 * 1024 ** 3 }, "OrbStack")).toBeNull();
    expect(adaptContainerLimits({ cpus: 3, memoryBytes: 4 * 1024 ** 3 })).toEqual({ cpus: 2, memoryGib: 3 });
  });
});

describe("adaptive container limits", () => {
  it("requests a modest 2 CPU / 3 GiB cap on a roomy runtime", () => {
    expect(adaptContainerLimits({ cpus: 16, memoryBytes: 64 * 1024 ** 3 })).toEqual({ cpus: 2, memoryGib: 3 });
    expect(adaptContainerLimits(null)).toEqual(DEFAULT_CONTAINER_LIMITS);
  });

  it("shrinks to an OrbStack-sized runtime (3 CPUs, 4 GiB) instead of failing to start", () => {
    expect(adaptContainerLimits({ cpus: 3, memoryBytes: 4 * 1024 ** 3 })).toEqual({ cpus: 2, memoryGib: 3 });
    expect(adaptContainerLimits({ cpus: 1, memoryBytes: 1024 ** 3 })).toEqual({ cpus: 1, memoryGib: 1 });
  });

  it("honours a configured ceiling and never exceeds 4 / 8", () => {
    expect(adaptContainerLimits({ cpus: 16, memoryBytes: 64 * 1024 ** 3 }, { cpus: 4, memoryGib: 8 })).toEqual({
      cpus: 4,
      memoryGib: 8,
    });
    expect(adaptContainerLimits(null, { cpus: 99, memoryGib: 99 })).toEqual({ cpus: 4, memoryGib: 8 });
  });

  it("asks the runtime what it has, and falls back to the ceiling when it will not say", async () => {
    const answering = runner({ "docker info --format {{.NCPU}} {{.MemTotal}}": "3 4294967296\n" });
    expect(await resolveContainerLimits("docker", answering.run)).toEqual({ cpus: 2, memoryGib: 3 });
    const podman = runner({ "podman info --format {{.Host.CPUs}} {{.Host.MemTotal}}": "2 8589934592\n" });
    expect(await resolveContainerLimits("podman", podman.run)).toEqual({ cpus: 2, memoryGib: 3 });
    const silent = runner({});
    expect(await resolveContainerLimits("docker", silent.run)).toEqual(DEFAULT_CONTAINER_LIMITS);
  });

  it("ignores malformed docker info stdout instead of trusting manual coercion", async () => {
    const junk = runner({ "docker info --format {{.NCPU}} {{.MemTotal}}": "not-a-number 4294967296\n" });
    expect(await readRuntimeHost("docker", junk.run)).toEqual({});
    const partial = runner({ "docker info --format {{.NCPU}} {{.MemTotal}}": "3\n" });
    expect(await readRuntimeHost("docker", partial.run)).toEqual({});
    expect(await resolveContainerLimits("docker", junk.run)).toEqual(DEFAULT_CONTAINER_LIMITS);
  });

  it("reads declared limits from the label and treats anything odd as the historical cap", () => {
    expect(limitsFromLabels({ [LIMITS_LABEL]: "3x3" })).toEqual({ cpus: 3, memoryGib: 3 });
    expect(limitsFromLabels({})).toEqual(LEGACY_UNLABELED_CONTAINER_LIMITS);
    expect(limitsFromLabels({ [LIMITS_LABEL]: "64x512" })).toEqual(LEGACY_UNLABELED_CONTAINER_LIMITS);
    expect(limitsFromLabels({ [LIMITS_LABEL]: "0x0" })).toEqual(LEGACY_UNLABELED_CONTAINER_LIMITS);
    expect(limitsFromLabels({ [LIMITS_LABEL]: "junk" })).toEqual(LEGACY_UNLABELED_CONTAINER_LIMITS);
  });

  it("judges declaredHardening against safety floors and rejects self-declared sub-minimum limits", () => {
    expect(declaredHardening({ [LIMITS_LABEL]: "3x3" })).toEqual({
      nanoCpus: 3_000_000_000,
      memoryBytes: 3 * 1024 ** 3,
    });
    expect(declaredHardening({ [LIMITS_LABEL]: "1x1" })).toEqual({
      nanoCpus: 1_000_000_000,
      memoryBytes: 1 * 1024 ** 3,
    });
    expect(declaredHardening(null)).toEqual({
      nanoCpus: LEGACY_UNLABELED_CONTAINER_LIMITS.cpus * 1_000_000_000,
      memoryBytes: LEGACY_UNLABELED_CONTAINER_LIMITS.memoryGib * 1024 ** 3,
    });
  });

  it("creates the container with the adapted caps and records them in a label", () => {
    const args = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "linux", { limits: { cpus: 3, memoryGib: 3 } });
    expect(args[args.indexOf("--memory") + 1]).toBe("3g");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("3g");
    expect(args[args.indexOf("--cpus") + 1]).toBe("3");
    expect(args).toContain(`${LIMITS_LABEL}=3x3`);
    const defaults = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, "linux");
    expect(defaults[defaults.indexOf("--memory") + 1]).toBe("3g");
    expect(defaults[defaults.indexOf("--cpus") + 1]).toBe("2");
  });

  it("reports a container built with adapted limits as hardened, and a mismatch as unsafe", async () => {
    const adapted = JSON.parse(readyInspect())[0];
    adapted.Config.Labels[LIMITS_LABEL] = "3x3";
    adapted.HostConfig.Memory = 3 * 1024 ** 3;
    adapted.HostConfig.MemorySwap = 3 * 1024 ** 3;
    adapted.HostConfig.NanoCpus = 3_000_000_000;
    const status = (inspect: string) =>
      runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: inspect,
      });
    expect((await containerComputerStatus(status(JSON.stringify([adapted])).run, "linux")).security).toBe("hardened");
    // declared 3x3 but actually running with the old 8 GiB / 4 CPU limits
    const drifted = JSON.parse(JSON.stringify(adapted));
    drifted.HostConfig.Memory = 8 * 1024 ** 3;
    drifted.HostConfig.MemorySwap = 8 * 1024 ** 3;
    expect((await containerComputerStatus(status(JSON.stringify([drifted])).run, "linux")).security).toBe("unsafe");
    // an unlabeled container is judged against the historical cap, as before
    expect((await containerComputerStatus(status(readyInspect()).run, "linux")).security).toBe("hardened");
  });
});

describe("secret redaction", () => {
  it("scrubs the viewer password out of a failed docker run command line", () => {
    const message =
      "Command failed: docker run -d --name x -e VNC_PW=hunter2 -p 127.0.0.1:6080:6901 image\n" +
      "docker: Error response from daemon: ports are not available";
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("VNC_PW=<redacted>");
    expect(redacted).toContain("ports are not available");
  });

  it("scrubs the password from the error the real command runner throws", async () => {
    const failure = await defaultCommandRunner("/bin/sh", ["-c", "exit 3", "x", "-e", "VNC_PW=hunter2"]).catch(
      (error: Error & { cmd?: string }) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("hunter2");
    expect((failure as Error & { cmd?: string }).cmd ?? "").not.toContain("hunter2");
  });

  it("scrubs other credential-shaped variables and leaves ordinary text alone", () => {
    expect(redactSecrets("-e API_TOKEN=abc -e DB_PASSWORD='p w' --cpus 4")).toBe(
      "-e API_TOKEN=<redacted> -e DB_PASSWORD=<redacted> --cpus 4",
    );
  });
});

describe("Local VM creation on a busy host", () => {
  const dockerHost = (runCalls: string[][]) => {
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      if (key === "/usr/bin/which docker") return { stdout: "docker\n" };
      if (key === "/usr/bin/which podman") throw new Error("missing");
      if (key === "docker info --format {{.ServerVersion}}") return { stdout: "29\n" };
      if (key === "docker info --format {{.NCPU}} {{.MemTotal}}") return { stdout: "3 4294967296\n" };
      if (key === `docker image inspect ${IMAGE}`) return { stdout: preparedImageInspect() };
      if (command === "docker" && args[0] === "run") {
        runCalls.push(args);
        return { stdout: "id\n" };
      }
      throw new Error(`no such object: ${key}`);
    };
    return run;
  };
  const tempTarget = (viewerPort: number | null): LocalVmTarget => {
    const base = perBotLocalVmTarget("busy-port-test");
    return { ...base, viewerPort, workspaceDir: join(mkdtempSync(join(tmpdir(), "vm-port-")), "homes", "abcd") };
  };

  it("adapts the container limits to the runtime when it is created", async () => {
    const runCalls: string[][] = [];
    await containerComputerAction("run", dockerHost(runCalls), "linux", tempTarget(null));
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]![runCalls[0]!.indexOf("--cpus") + 1]).toBe("2");
    expect(runCalls[0]![runCalls[0]!.indexOf("--memory") + 1]).toBe("3g");
  });

  it("falls back to an ephemeral loopback viewer port when the fixed one is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const runCalls: string[][] = [];
      await containerComputerAction("run", dockerHost(runCalls), "linux", tempTarget(busy));
      const published = runCalls[0]![runCalls[0]!.indexOf("-p") + 1];
      expect(published).toBe("127.0.0.1::6901");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("keeps the fixed viewer port when it is free", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const runCalls: string[][] = [];
    await containerComputerAction("run", dockerHost(runCalls), "linux", tempTarget(free));
    expect(runCalls[0]![runCalls[0]!.indexOf("-p") + 1]).toBe(`127.0.0.1:${free}:6901`);
  });
});

describe("PATH driver symlink repair", () => {
  it("links both PATH entries to the root-owned binary, only when it exists and a link is missing", () => {
    const script = healCuaShimsScript();
    expect(script).toContain(`[ -x ${CUA_EXECUTABLE} ] || exit 0`);
    for (const shim of ["/usr/local/bin/cua-driver", "/opt/venv/bin/cua-driver"]) {
      expect(script).toContain(`ln -sf ${CUA_EXECUTABLE} ${shim}`);
      expect(script).toContain(`readlink ${shim}`);
    }
  });
});
