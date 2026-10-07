import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  CUA_SOCKET,
  DISPLAY,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  healCuaShimsScript,
  resetCuaShimHealGate,
} from "./container-computer.ts";
import { VPS_DEFAULT_CPUS, VPS_DEFAULT_MEMORY_GIB, type AppConfig } from "./config.ts";
import {
  SHARED_VPS_TARGET,
  VPS_CONTAINER_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  vpsComputerAction,
  vpsComputerScreenshot,
  vpsComputerStatus,
  vpsComputerMcp,
  vpsContainerMcpArgs,
  vpsContainerName,
  vpsContainerNameCandidates,
  vpsContainerRunArgs,
  vpsDockerArgs,
  vpsDriverError,
  vpsSshTunnelArgs,
  perBotVpsTarget,
  vpsSyncCliCredentials,
  resetVpsCliSyncThrottle,
  reuseVps,
  type VpsCommandRunner,
} from "./vps-computer.ts";
import { computerReach, type ComputerCapabilityFlags } from "./computer-capability.ts";

const BOT_ID = "bot-1234-abcd";
const CONFIG: AppConfig = { vps: { sshAlias: "production-vps" } };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const screenshot = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function fixture({
  image = true,
  container = true,
  running = true,
  managed = true,
  mounts = false,
  publicPorts = false,
  publishAllPorts = false,
  deviceRequests = false,
  networkMode = "default",
  containerImageId = IMAGE_ID,
  inspectedImageId = IMAGE_ID,
  rebuiltImageId,
  containerId = CONTAINER_ID,
  privileged = false,
  pidMode = "",
  ipcMode,
  capAdd = ["CAP_SETUID", "CAP_SETGID"],
  screenshotValid = true,
  screenshotCaptureFails = false,
  desktopProbeFails = false,
  securityOpt = [],
  memory = VPS_DEFAULT_MEMORY_GIB * 1024 * 1024 * 1024,
  cpus = VPS_DEFAULT_CPUS,
  restartPolicyName = "unless-stopped",
  cgroupnsMode,
  imageLabelsMatch = true,
  containerName,
}: {
  image?: boolean;
  container?: boolean;
  running?: boolean;
  managed?: boolean;
  mounts?: boolean;
  publicPorts?: boolean;
  publishAllPorts?: boolean;
  deviceRequests?: boolean;
  networkMode?: string;
  containerImageId?: string;
  inspectedImageId?: string;
  rebuiltImageId?: string;
  containerId?: string;
  privileged?: boolean;
  pidMode?: string;
  ipcMode?: string;
  capAdd?: string[];
  screenshotValid?: boolean;
  screenshotCaptureFails?: boolean;
  desktopProbeFails?: boolean;
  securityOpt?: string[];
  memory?: number;
  cpus?: number;
  restartPolicyName?: string;
  cgroupnsMode?: string;
  imageLabelsMatch?: boolean;
  containerName?: string;
} = {}) {
  const name = containerName ?? vpsContainerName(BOT_ID);
  const provisioningArgs = vpsContainerRunArgs(name);
  const argValue = (flag: string) => {
    const index = provisioningArgs.indexOf(flag);
    if (index >= 0) return provisioningArgs[index + 1] ?? "";
    return provisioningArgs.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? "";
  };
  const calls: Array<{ args: string[]; options?: { input?: string | Buffer; timeoutMs?: number } }> = [];
  const state = { image, container, running, imageLabelsMatch, inspectedImageId, containerImageId };
  const runner: VpsCommandRunner = async (args, options) => {
    calls.push({ args, options });
    const command = args[2];
    if (command === "image") {
      // The real daemon phrases a clean absence this way; anything else is
      // read as a transport failure, exactly like production.
      if (!state.image) throw new Error(`Error: No such image: ${VPS_IMAGE}`);
      return {
        stdout: JSON.stringify([{
          Config: { Labels: state.imageLabelsMatch ? {
             [MANAGED_LABEL]: "1",
             [DRIVER_LABEL]: CUA_DRIVER_VERSION,
             [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
             [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          } : { [MANAGED_LABEL]: "0" } },
          Id: state.inspectedImageId,
        }]),
        stderr: "",
      };
    }
    if (command === "inspect") {
      if (!state.container) throw new Error(`Error: No such object: ${name}`);
      return {
        stdout: JSON.stringify([{
          Config: {
            Image: state.image ? VPS_IMAGE : "old-image",
            Env: [`VNC_PW=${argValue("VNC_PW") || "viewer-secret"}`],
            Labels: {
              [VPS_MANAGED_LABEL]: managed ? "1" : "0",
              [VPS_CONTAINER_LABEL]: managed ? name : "other-container",
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [VPS_VIEWER_LABEL]: "1",
            },
          },
           Id: containerId,
          Image: state.image ? state.containerImageId : "old-image-id",
          HostConfig: {
            Binds: mounts ? ["/host:/container"] : [],
            VolumesFrom: [],
            NetworkMode: networkMode,
            PortBindings: publicPorts ? { "6901/tcp": [{ HostIp: "0.0.0.0" }] } : {},
            PublishAllPorts: publishAllPorts,
            Memory: memory,
            // Derived from the same two knobs the run arguments use, so a
            // fixture can never claim a shape the runtime would not build.
            MemorySwap: memory,
            NanoCpus: cpus * 1_000_000_000,
            PidsLimit: 512,
            CapDrop: ["ALL"],
            CapAdd: capAdd,
            Privileged: privileged,
            PidMode: pidMode,
            IpcMode: ipcMode ?? argValue("--ipc"),
            UTSMode: "",
            ShmSize: 512 * 1024 * 1024,
            Devices: [],
            DeviceRequests: deviceRequests ? [{ Driver: "nvidia" }] : [],
            SecurityOpt: securityOpt,
            UsernsMode: "",
            CgroupnsMode: cgroupnsMode ?? argValue("--cgroupns"),
            OomKillDisable: false,
            AutoRemove: false,
            RestartPolicy: { Name: restartPolicyName, MaximumRetryCount: 0 },
          },
          NetworkSettings: {
            Networks: { [networkMode === "default" ? "bridge" : networkMode]: { IPAddress: "172.17.0.5" } },
          },
          Mounts: mounts ? [{ Source: "/host", Destination: "/container" }] : [],
          State: { Running: state.running },
        }]),
        stderr: "",
      };
    }
    if (command === "exec") {
      // only the pixel-carrying screenshot call fails; the status path's
      // plain get_desktop_state readiness probe keeps answering
      if (screenshotCaptureFails && args.includes("--screenshot-out-file")) throw new Error("capture failed");
      if (args.includes("base64")) return { stdout: screenshotValid ? screenshot.toString("base64") : "not-an-image", stderr: "" };
      if (args.includes("tail")) {
        return { stdout: "X display :1 did not become ready within 45 seconds\n", stderr: "" };
      }
      if (args.at(-1) === "--version") {
        if (desktopProbeFails) throw new Error("driver unavailable");
        return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n`, stderr: "" };
      }
      if (args.includes("status")) return { stdout: "running\n", stderr: "" };
      if (args.includes("health_report")) {
        return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }), stderr: "" };
      }
      if (args.includes("get_desktop_state")) return { stdout: "{}\n", stderr: "" };
      return { stdout: "{}\n", stderr: "" };
    }
    if (command === "pull") return { stdout: "pulled\n", stderr: "" };
    if (command === "build") {
      state.image = true;
      state.imageLabelsMatch = true;
      state.inspectedImageId = rebuiltImageId ?? state.inspectedImageId;
      expect(options?.input).toContain(`FROM ${BASE_IMAGE}`);
      return { stdout: "built\n", stderr: "" };
    }
    if (command === "run") {
      state.container = true;
      state.running = true;
      // a fresh container is created FROM the image ref in the run argv
      state.containerImageId = args.at(-1) ?? state.containerImageId;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "start") {
      state.running = true;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "stop") {
      state.running = false;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "rm") {
      state.container = false;
      state.running = false;
      return { stdout: `${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected Docker command ${command}`);
  };
  return { calls, runner, state, name };
}

describe("VPS computer", () => {
  it("uses a deterministic, bot-id-derived managed container name", () => {
    expect(vpsContainerName(BOT_ID)).toBe(vpsContainerName(BOT_ID));
    expect(vpsContainerName(BOT_ID)).not.toBe(vpsContainerName("another-bot"));
    expect(vpsContainerName(BOT_ID)).toMatch(/^botfleet-vps-[a-z0-9-]+$/);
    expect(vpsContainerNameCandidates(BOT_ID)[0]).toBe(vpsContainerName(BOT_ID));
    expect(vpsContainerNameCandidates(BOT_ID)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^botfleet-vps-/),
        expect.stringMatching(/^openmausbot-vps-/),
        expect.stringMatching(/^opengrokbot-vps-/),
      ]),
    );
  });

  it("passes the SSH target as one validated Docker argv value", () => {
    expect(vpsDockerArgs("production-vps", ["info"])).toEqual(["-H", "ssh://production-vps", "info"]);
    for (const alias of ["production-vps;touch", "ssh://production-vps", "-H", "--host=evil", "prod vps", "prod\n-v"] ) {
      expect(() => vpsDockerArgs(alias, ["info"])).toThrow(/alias/);
    }
    expect(() => vpsContainerMcpArgs("production-vps", "not a container")).toThrow(/connection/);
  });

  it("keeps the live desktop behind a validated loopback SSH forward", () => {
    const args = vpsSshTunnelArgs("production-vps", 45678, "172.17.0.5");
    expect(args).toContain("127.0.0.1:45678:172.17.0.5:6901");
    expect(args.at(-1)).toBe("production-vps");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ControlMaster=no");
    expect(() => vpsSshTunnelArgs("production-vps", 80, "172.17.0.5")).toThrow(/port/);
    expect(() => vpsSshTunnelArgs("production-vps", 45678, "203.0.113.8")).toThrow(/private/);
  });

  it("gives status probes the 30s docker-over-SSH deadline slow WAN links need", async () => {
    const fake = fixture();
    await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    const probes = fake.calls.filter((call) => ["image", "inspect"].includes(call.args[2] ?? ""));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.options?.timeoutMs).toBe(30_000);
  });

  it("reports a ready container only when image, labels, limits, mounts, network, and CUA pass", async () => {
    const fake = fixture();
    const status = await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    expect(status).toMatchObject({
      configured: true,
      daemonUp: true,
      image: true,
      imageMatches: true,
      managed: true,
      network: "private",
      mounts: "none",
      security: "hardened",
      desktopReady: true,
      ready: true,
      problem: null,
    });
    // No standalone `docker info` round-trip: the image inspect doubles as
    // the daemon probe, so a healthy status costs 2 docker calls + 4 execs.
    expect(fake.calls[0]?.args).toEqual(["-H", "ssh://production-vps", "image", "inspect", VPS_IMAGE]);
    expect(fake.calls.some(({ args }) => args[2] === "info")).toBe(false);
    const probes = fake.calls.filter(
      ({ args }) =>
        args[2] === "exec" &&
        (args.at(-1) === "--version" || args.includes("status") || args.includes("health_report") || args.includes("get_desktop_state")),
    );
    expect(probes).toHaveLength(4);
    expect(probes.every(({ args }) => args.includes(CONTAINER_ID))).toBe(true);
    expect(probes.every(({ args }) => !args.includes(fake.name))).toBe(true);
    expect(probes.every(({ args }) => args.includes(`DISPLAY=${DISPLAY}`))).toBe(true);
    expect(probes.every(({ args }) => args.includes("CUA_DRIVER_RS_TELEMETRY_ENABLED=0"))).toBe(true);
    // The status poll must never transfer pixels: readiness is the driver
    // answering get_desktop_state, and pixel validation belongs to the
    // screenshot path alone.
    expect(fake.calls.some(({ args }) => args.includes("base64"))).toBe(false);
    expect(fake.calls.some(({ args }) => args.includes("--screenshot-out-file"))).toBe(false);
  });

  it("refuses host mounts, public ports, and unowned containers", async () => {
    const mounted = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ mounts: true }).runner);
    expect(mounted.ready).toBe(false);
    expect(mounted.mounts).toBe("unsafe");

    const publicPorts = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publicPorts: true }).runner);
    expect(publicPorts.ready).toBe(false);
    expect(publicPorts.network).toBe("unsafe");

    const publishedAll = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publishAllPorts: true }).runner);
    expect(publishedAll.ready).toBe(false);
    expect(publishedAll.network).toBe("unsafe");

    const devices = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ deviceRequests: true }).runner);
    expect(devices.ready).toBe(false);
    expect(devices.security).toBe("unsafe");

    const sharedNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "shared-net" }).runner);
    expect(sharedNetwork.ready).toBe(false);
    expect(sharedNetwork.network).toBe("unsafe");

    const hostNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "host" }).runner);
    expect(hostNetwork.ready).toBe(false);
    expect(hostNetwork.network).toBe("unsafe");

    const privileged = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ privileged: true }).runner);
    expect(privileged.ready).toBe(false);
    expect(privileged.security).toBe("unsafe");

    const hostNamespaces = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ pidMode: "host", ipcMode: "host" }).runner,
    );
    expect(hostNamespaces.ready).toBe(false);
    expect(hostNamespaces.security).toBe("unsafe");

    const extraCapability = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ capAdd: ["CAP_SETUID", "CAP_SETGID", "CAP_SYS_ADMIN"] }).runner,
    );
    expect(extraCapability.ready).toBe(false);
    expect(extraCapability.security).toBe("unsafe");

    const unsafeProfile = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ securityOpt: ["seccomp=unconfined"], memory: 8 * 1024 * 1024 * 1024, restartPolicyName: "always", cgroupnsMode: "host" }).runner,
    );
    expect(unsafeProfile.ready).toBe(false);
    expect(unsafeProfile.security).toBe("unsafe");

    // the VPS container must survive an unwatched reboot: exactly
    // unless-stopped, so a policy-less container is flagged for recreation
    const noRestart = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ restartPolicyName: "no" }).runner);
    expect(noRestart.ready).toBe(false);
    expect(noRestart.security).toBe("unsafe");

    const wrongImage = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerImageId: "c".repeat(64) }).runner);
    expect(wrongImage.ready).toBe(false);
    expect(wrongImage.imageMatches).toBe(false);

    const malformedImageId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ inspectedImageId: "--help" }).runner);
    expect(malformedImageId.ready).toBe(false);
    expect(malformedImageId.image).toBe(false);

    const malformedContainerId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerId: "--help" }).runner);
    expect(malformedContainerId.ready).toBe(false);
    expect(malformedContainerId.container_id).toBeNull();

    const unowned = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ managed: false }).runner);
    expect(unowned.ready).toBe(false);
    expect(unowned.managed).toBe(false);
  });

  it("lets explicit provisioning build and run the pinned container, but Auto only reuses", async () => {
    const auto = fixture({ image: false, container: false });
    expect(await reuseVps(CONFIG, BOT_ID, auto.runner)).toBeNull();
    expect(auto.calls.some(({ args }) => ["run", "start", "build", "pull"].includes(args[2]!))).toBe(false);

    const provision = fixture({ image: false, container: false });
    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run).toContain("--memory");
    // A shared VPS carries one desktop per bot, so the default budget is a
    // fraction of the host rather than a whole workstation's worth.
    expect(run[run.indexOf("--memory") + 1]).toBe(`${VPS_DEFAULT_MEMORY_GIB}g`);
    // memory-swap pinned to memory means no swap: on a shared host, one
    // bot's swapping is every other bot's problem.
    expect(run[run.indexOf("--memory-swap") + 1]).toBe(`${VPS_DEFAULT_MEMORY_GIB}g`);
    expect(run[run.indexOf("--cpus") + 1]).toBe(String(VPS_DEFAULT_CPUS));
    expect(run).toContain("--pids-limit");
    expect(run).toContain("--ipc");
    expect(run[run.indexOf("--ipc") + 1]).toBe("private");
    expect(run).toContain("--cgroupns");
    expect(run[run.indexOf("--cgroupns") + 1]).toBe("private");
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.join(" ")).toContain(`--label ${VPS_MANAGED_LABEL}=1`);
    expect(run.join(" ")).toContain(`--label ${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`);
    expect(run.join(" ")).toContain(`--label ${VPS_VIEWER_LABEL}=1`);
    expect(run.join(" ")).toContain("--restart unless-stopped");
    expect(run).toContain("-e");
    expect(run.some((arg) => /^VNC_PW=[A-Za-z0-9_-]{8,}$/.test(arg))).toBe(true);
    expect(run).not.toContain("--mount");
    expect(run).not.toContain("-p");
    expect(provision.calls.some(({ args }) => args[2] === "build")).toBe(true);
  });

  it("uses the image id produced by a rebuild", async () => {
    const staleImageId = `sha256:${"b".repeat(64)}`;
    const provision = fixture({
      image: true,
      imageLabelsMatch: false,
      container: false,
      inspectedImageId: staleImageId,
      rebuiltImageId: IMAGE_ID,
    });

    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.at(-1)).not.toBe(staleImageId);
  });

  it("starts and sleeps only the managed container, never the VPS", async () => {
    const start = fixture({ running: false });
    const started = await vpsComputerAction("start", CONFIG, BOT_ID, start.runner);
    expect(started.container).toBe("running");
    expect(start.calls.some(({ args }) => args[2] === "start")).toBe(true);
    expect(start.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);

    const stop = fixture();
    const stopped = await vpsComputerAction("stop", CONFIG, BOT_ID, stop.runner);
    expect(stopped.container).toBe("stopped");
    expect(stop.calls.some(({ args }) => args[2] === "stop" && args[3] === CONTAINER_ID)).toBe(true);
    expect(stop.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);
  });

  it("serializes concurrent provisioning for the same bot", async () => {
    const fake = fixture({ image: false, container: false });
    const results = await Promise.all([
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
    ]);
    expect(results.every((status) => status.ready)).toBe(true);
    expect(fake.calls.filter(({ args }) => args[2] === "run")).toHaveLength(1);
  });

  it("mounts the official CUA MCP server through the tiny remote exec bridge", () => {
    const connection = vpsComputerMcp(CONFIG, BOT_ID);
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.slice(1, 3)).toEqual(["production-vps", vpsContainerName(BOT_ID)]);
    expect(connection.args.at(-2)).toBe(CUA_SOCKET);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(vpsComputerMcp(CONFIG, BOT_ID, CONTAINER_ID).args.slice(1, 3)).toEqual(["production-vps", CONTAINER_ID]);
    expect(vpsContainerMcpArgs("production-vps", vpsContainerName(BOT_ID))).toEqual([
      "-H",
      "ssh://production-vps",
      "exec",
      "-i",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      "-e",
      "DISPLAY=:1",
      "-e",
      "CUA_DRIVER_INSTALL_CHANNEL=python_package",
      "-e",
      "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
      vpsContainerName(BOT_ID),
      "/usr/local/libexec/botfleet/cua-driver",
      "mcp",
      "--socket",
      "/run/user/1000/botfleet-cua.sock",
    ]);
  });

  it("captures screenshots through CUA Driver and validates the returned image", async () => {
    const fake = fixture();
    const frame = await vpsComputerScreenshot(CONFIG, BOT_ID, fake.runner);
    expect(frame).toMatchObject({ png: screenshot.toString("base64"), format: "png" });
    expect(typeof frame.capturedAt).toBe("number");
    expect(Number.isFinite(frame.capturedAt)).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("get_desktop_state"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("base64") && args.includes("-u") && args.includes("cua"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);

    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, fixture({ screenshotValid: false }).runner)).rejects.toThrow(/incomplete/);

    const failedCapture = fixture({ screenshotCaptureFails: true });
    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, failedCapture.runner)).rejects.toThrow(/capture failed/);
    expect(failedCapture.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);
  });

  it("fails clearly for BoxAgent and engines without computer MCP", () => {
    // The reach comes from the one derivation, so these stay true to what
    // the dispatch itself computed rather than to a hand-passed boolean.
    const reachOf = (driverKind: string, capabilities: ComputerCapabilityFlags) =>
      computerReach({ driverKind, capabilities });
    expect(
      vpsDriverError("boxAgent", reachOf("boxAgent", { computerMcp: true })),
    ).toMatch(/cannot use a self-hosted VPS/);
    expect(vpsDriverError("codex", reachOf("codex", {}))).toMatch(/cannot mount/);
    expect(
      vpsDriverError("claudeAgent", reachOf("claudeAgent", { computerMcp: true })),
    ).toBeNull();
  });

  it("fails cleanly when no VPS alias is configured", async () => {
    await expect(vpsComputerAction("provision", {}, BOT_ID, fixture().runner)).rejects.toThrow(/not configured/);
  });

  it("attributes a transport failure to the link, never to a missing container", async () => {
    const fake = fixture();
    const flaky: VpsCommandRunner = async (args, options) => {
      if (args[2] === "inspect") throw new Error("ssh: connect to host production-vps port 22: Connection timed out");
      return fake.runner(args, options);
    };
    const status = await vpsComputerStatus(CONFIG, BOT_ID, flaky);
    expect(status.daemonUp).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toMatch(/Docker over SSH failed while checking the VPS/);

    // and provision must refuse to `docker run --name <existing>` into the fog
    await expect(vpsComputerAction("provision", CONFIG, BOT_ID, flaky)).rejects.toThrow(/Docker over SSH failed/);
    expect(fake.calls.some(({ args }) => args[2] === "run")).toBe(false);

    const imageFlaky: VpsCommandRunner = async (args, options) => {
      if (args[2] === "image") throw new Error("kex_exchange_identification: read: Connection reset by peer");
      return fake.runner(args, options);
    };
    const imageStatus = await vpsComputerStatus(CONFIG, BOT_ID, imageFlaky);
    expect(imageStatus.daemonUp).toBe(false);
    expect(imageStatus.problem).toMatch(/Docker over SSH failed while checking the VPS/);
  });

  it("removes a managed container even when its image is incompatible, then provisions fresh", async () => {
    // an IMAGE_LAYER_VERSION bump leaves a running container that provision
    // refuses to touch — remove is the in-app escape hatch
    const stale = fixture({ containerImageId: `sha256:${"c".repeat(64)}` });
    expect((await vpsComputerStatus(CONFIG, BOT_ID, stale.runner)).imageMatches).toBe(false);
    await expect(vpsComputerAction("provision", CONFIG, BOT_ID, stale.runner)).rejects.toThrow(/incompatible|unsafe/);

    const removed = await vpsComputerAction("remove", CONFIG, BOT_ID, stale.runner);
    expect(removed.container).toBe("missing");
    expect(stale.calls.some(({ args }) => args[2] === "rm" && args[3] === "-f" && args[4] === CONTAINER_ID)).toBe(true);

    const rebuilt = await vpsComputerAction("provision", CONFIG, BOT_ID, stale.runner);
    expect(rebuilt.ready).toBe(true);
  });

  it("never removes a container BotFleet did not create", async () => {
    const unowned = fixture({ managed: false });
    await expect(vpsComputerAction("remove", CONFIG, BOT_ID, unowned.runner)).rejects.toThrow(/did not create/);
    expect(unowned.calls.some(({ args }) => args[2] === "rm")).toBe(false);

    const absent = fixture({ container: false });
    const afterMissing = await vpsComputerAction("remove", CONFIG, BOT_ID, absent.runner);
    expect(afterMissing.container).toBe("missing");
    expect(absent.calls.some(({ args }) => args[2] === "rm")).toBe(false);
  });

  it("surfaces the supervisor error log when the desktop probe fails", async () => {
    const fake = fixture({ desktopProbeFails: true });
    const status = await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
    expect(fake.calls.some(({ args }) => args[2] === "exec" && args.includes("tail"))).toBe(true);
  });

  it("waits for readiness with a cheap driver probe and backoff, not full re-inspections", async () => {
    vi.useFakeTimers();
    try {
      const fake = fixture({ container: false });
      let driverProbes = 0;
      const runner: VpsCommandRunner = async (args, options) => {
        if (args[2] === "exec" && args.includes("status")) {
          driverProbes += 1;
          if (driverProbes < 4) throw new Error("driver not up yet");
        }
        return fake.runner(args, options);
      };
      const pending = vpsComputerAction("provision", CONFIG, BOT_ID, runner);
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await pending;
      expect(status.ready).toBe(true);
      // the expensive end of the pipeline ran exactly once — every retry in
      // between was the single `cua-driver status` predicate
      const desktopCalls = fake.calls.filter(({ args }) => args.includes("get_desktop_state"));
      expect(desktopCalls).toHaveLength(1);
      const healthCalls = fake.calls.filter(({ args }) => args.includes("health_report"));
      expect(healthCalls).toHaveLength(1);
      expect(driverProbes).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails lifecycle calls fast instead of queueing behind a long provision", async () => {
    vi.useFakeTimers();
    try {
      let releaseBuild!: () => void;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const fake = fixture({ image: false, container: false });
      const slowRunner: VpsCommandRunner = async (args, options) => {
        if (args[2] === "build") await buildGate;
        return fake.runner(args, options);
      };
      const first = vpsComputerAction("provision", CONFIG, BOT_ID, slowRunner);
      // let the first action reach its (gated) docker build
      await vi.advanceTimersByTimeAsync(0);
      const second = vpsComputerAction("stop", CONFIG, BOT_ID, slowRunner);
      const rejection = expect(second).rejects.toThrow(/being prepared/);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;

      releaseBuild();
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await first;
      expect(status.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("vpsSyncCliCredentials", () => {
    it("rejects if VPS SSH alias is not configured", async () => {
      await expect(vpsSyncCliCredentials({}, SHARED_VPS_TARGET)).rejects.toMatchObject({
        message: expect.stringContaining("VPS is not configured"),
        status: 409,
      });
    });

    it("rejects if the target container does not exist", async () => {
      const fake = fixture({ container: false });
      await expect(vpsSyncCliCredentials(CONFIG, SHARED_VPS_TARGET, fake.runner)).rejects.toMatchObject({
        message: expect.stringContaining("does not exist"),
        status: 404,
      });
    });

    it("rejects if the target container is not running", async () => {
      const fake = fixture({ container: true, running: false });
      await expect(vpsSyncCliCredentials(CONFIG, SHARED_VPS_TARGET, fake.runner)).rejects.toMatchObject({
        message: expect.stringContaining("is not running"),
        status: 409,
      });
    });

    it("returns empty synced array if no candidate credentials exist", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "vps-sync-empty-"));
      try {
        const fake = fixture({ container: true, running: true });
        const result = await vpsSyncCliCredentials(CONFIG, SHARED_VPS_TARGET, fake.runner, tempDir);
        expect(result.ok).toBe(true);
        expect(result.syncedTools).toEqual([]);
        expect(result.containerName).toBe(SHARED_VPS_TARGET.containerName);
        expect(fake.calls.some(({ args }) => args.includes("tar"))).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("packages and streams credentials to the container", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "vps-sync-test-"));
      try {
        mkdirSync(join(tempDir, ".ssh"), { recursive: true });
        writeFileSync(join(tempDir, ".ssh", "id_ed25519"), "dummy-key\n");
        writeFileSync(join(tempDir, ".gitconfig"), "[user]\n  name = Test\n");

        const fake = fixture({ container: true, running: true });
        const result = await vpsSyncCliCredentials(CONFIG, SHARED_VPS_TARGET, fake.runner, tempDir);
        expect(result.ok).toBe(true);
        expect(result.syncedTools.some((entry) => entry.name === "ssh")).toBe(true);
        expect(result.syncedTools.some((entry) => entry.name === "git")).toBe(true);
        expect(result.containerName).toBe(SHARED_VPS_TARGET.containerName);

        const tarCall = fake.calls.find(({ args }) => args.includes("tar") && args.includes("-xf"));
        expect(tarCall).toBeDefined();
        expect(Buffer.isBuffer(tarCall?.options?.input)).toBe(true);

        const chmodCall = fake.calls.find(({ args }) => args.some((arg) => arg.includes("chmod")));
        expect(chmodCall).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses the per-bot container name when target is per-bot", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "vps-sync-per-bot-"));
      const botTarget = perBotVpsTarget("bot-sync-test");
      try {
        const fake = fixture({ container: true, running: true, containerName: botTarget.containerName });
        const result = await vpsSyncCliCredentials(CONFIG, botTarget, fake.runner, tempDir);
        expect(result.containerName).toBe(botTarget.containerName);
        const execArgs = fake.calls.flatMap(({ args }) => args);
        expect(execArgs).toContain(botTarget.containerName);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
  describe("concurrent shared-mode bots", () => {
    const SHARED_CONFIG: AppConfig = {
      vps: { sshAlias: "production-vps" },
      botDefaults: { vpsMode: "shared" },
      localVm: { shareCliCredentials: true },
    };
    let home: string;
    let previousHome: string | undefined;
    let previousUserProfile: string | undefined;

    beforeEach(() => {
      resetVpsCliSyncThrottle();
      resetCuaShimHealGate();
      home = mkdtempSync(join(tmpdir(), "vps-concurrent-home-"));
      writeFileSync(join(home, ".gitconfig"), "[user]\n  name = Test\n");
      previousHome = process.env.HOME;
      previousUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
    });
    afterEach(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      rmSync(home, { recursive: true, force: true });
    });

    const tarCalls = (calls: ReturnType<typeof fixture>["calls"]) =>
      calls.filter(({ args }) => args.includes("tar") && args.includes("-xf"));

    it("lets every bot's simultaneous turn-start provision succeed without a spurious 409", async () => {
      const solo = fixture({ containerName: SHARED_VPS_TARGET.containerName });
      await vpsComputerAction("provision", SHARED_CONFIG, "bot-solo", solo.runner);
      const soloImageProbes = solo.calls.filter(({ args }) => args[2] === "image").length;

      resetVpsCliSyncThrottle();
      const crowd = fixture({ containerName: SHARED_VPS_TARGET.containerName });
      const bots = Array.from({ length: 8 }, (_, i) => `bot-crowd-${i}`);
      const results = await Promise.all(bots.map((bot) => vpsComputerAction("provision", SHARED_CONFIG, bot, crowd.runner)));
      expect(results.every((status) => status.ready)).toBe(true);
      // One flight inspected the host for all eight bots.
      expect(crowd.calls.filter(({ args }) => args[2] === "image").length).toBe(soloImageProbes);
    });

    it("syncs CLI credentials once for many simultaneous bots, then again only for a new container", async () => {
      const first = fixture({ containerName: SHARED_VPS_TARGET.containerName });
      const bots = Array.from({ length: 6 }, (_, i) => `bot-sync-${i}`);
      await Promise.all(bots.map((bot) => vpsComputerAction("provision", SHARED_CONFIG, bot, first.runner)));
      expect(tarCalls(first.calls)).toHaveLength(1);

      await vpsComputerAction("provision", SHARED_CONFIG, "bot-sync-late", first.runner);
      expect(tarCalls(first.calls)).toHaveLength(1);

      const replaced = fixture({ containerId: "c".repeat(64), containerName: SHARED_VPS_TARGET.containerName });
      await vpsComputerAction("provision", SHARED_CONFIG, "bot-sync-0", replaced.runner);
      expect(tarCalls(replaced.calls)).toHaveLength(1);
    });

    it("backs off after a failed automatic sync instead of retrying on every turn", async () => {
      const base = fixture({ containerName: SHARED_VPS_TARGET.containerName });
      const failing: VpsCommandRunner = async (args, options) => {
        if (args.includes("tar") && args.includes("-xf")) {
          base.calls.push({ args, options });
          throw new Error("tar extract failed");
        }
        return base.runner(args, options);
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await vpsComputerAction("provision", SHARED_CONFIG, "bot-a", failing);
        await vpsComputerAction("provision", SHARED_CONFIG, "bot-b", failing);
        expect(tarCalls(base.calls)).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("repairs the PATH driver symlinks once per container without a root exec on every turn", async () => {
      const fake = fixture({ containerName: SHARED_VPS_TARGET.containerName });
      await Promise.all(
        ["bot-h1", "bot-h2", "bot-h3"].map((bot) => vpsComputerAction("provision", SHARED_CONFIG, bot, fake.runner)),
      );
      await vpsComputerAction("provision", SHARED_CONFIG, "bot-h4", fake.runner);
      const heals = fake.calls.filter(({ args }) => args.includes("root") && args.includes(healCuaShimsScript()));
      expect(heals).toHaveLength(1);
    });
  });
});
