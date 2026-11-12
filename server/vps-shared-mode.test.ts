import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { VPS_DEFAULT_CPUS, VPS_DEFAULT_MEMORY_GIB } from "./config.ts";
import {
  SHARED_VPS_TARGET,
  VPS_CONTAINER_PREFIX,
  VPS_CONTAINER_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  inspectVpsForAuto,
  perBotVpsTarget,
  vpsContainerRunArgs,
  vpsTargetFor,
  vpsModeSwitchTargets,
  vpsContainerName,
  type VpsCommandRunner,
} from "./vps-computer.ts";
import type { AppConfig } from "./config.ts";

const SHARED_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const SHARED_CONTAINER_ID = "c".repeat(64);

function cfgWithVpsMode(mode: "shared" | "per-bot" | null): AppConfig {
  return { botDefaults: { vpsMode: mode } } as AppConfig;
}

describe("VPS targeting", () => {
  it("vpsTargetFor returns SHARED_VPS_TARGET when vpsMode is shared", () => {
    const target = vpsTargetFor(cfgWithVpsMode("shared"), "bot-1");
    expect(target).toBe(SHARED_VPS_TARGET);
    expect(target.key).toBe("shared");
    expect(target.containerName).toBe(`${VPS_CONTAINER_PREFIX}-shared`);
  });

  it("vpsTargetFor returns the same shared target for any botId in shared mode", () => {
    const cfg = cfgWithVpsMode("shared");
    const a = vpsTargetFor(cfg, "bot-a");
    const b = vpsTargetFor(cfg, "bot-b");
    expect(a).toBe(b);
    expect(a.containerName).toBe(b.containerName);
  });

  it("vpsTargetFor returns a per-bot target when vpsMode is per-bot", () => {
    const target = vpsTargetFor(cfgWithVpsMode("per-bot"), "bot-1");
    expect(target.key).toMatch(/^bot:/);
    expect(target.containerName).toBe(vpsContainerName("bot-1"));
  });

  it("vpsTargetFor returns a per-bot target when vpsMode is null (default)", () => {
    const target = vpsTargetFor(cfgWithVpsMode(null), "bot-1");
    expect(target.key).toMatch(/^bot:/);
  });

  it("two different bots in per-bot mode get distinct targets", () => {
    const cfg = cfgWithVpsMode("per-bot");
    const a = vpsTargetFor(cfg, "bot-a");
    const b = vpsTargetFor(cfg, "bot-b");
    expect(a.key).not.toBe(b.key);
    expect(a.containerName).not.toBe(b.containerName);
  });

  it("perBotVpsTarget produces a container name matching vpsContainerName", () => {
    const target = perBotVpsTarget("bot-42");
    expect(target.containerName).toBe(vpsContainerName("bot-42"));
    expect(target.key).toMatch(/^bot:[a-f0-9]{64}$/);
  });
});

describe("vpsModeSwitchTargets", () => {
  it("includes the shared target and all per-bot targets, deduped by key", () => {
    const targets = vpsModeSwitchTargets(["bot-a", "bot-b"]);
    const keys = targets.map((t) => t.key);
    expect(keys).toContain("shared");
    expect(keys.filter((k) => k.startsWith("bot:"))).toHaveLength(2);
    // No duplicates
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns only shared when there are no bots", () => {
    const targets = vpsModeSwitchTargets([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.key).toBe("shared");
  });
});

describe("shared mode lifecycle targeting", () => {
  it("vpsComputerStatus inspects the shared container name, not the bot's", async () => {
    const { vpsComputerStatus, SHARED_VPS_TARGET } = await import("./vps-computer.ts");
    const inspected: string[] = [];
    const runner: import("./vps-computer.ts").VpsCommandRunner = async (args) => {
      // docker -H ssh://alias <command> ...
      const command = args[2];
      if (command === "image") {
        return { stdout: "[]", stderr: "" };
      }
      if (command === "inspect") {
        inspected.push(String(args[3] ?? ""));
        throw new Error(`Error: No such object: ${args[3]}`);
      }
      return { stdout: "", stderr: "" };
    };
    const cfg: AppConfig = {
      vps: { sshAlias: "test-vps" },
      botDefaults: { vpsMode: "shared" },
    };
    const status = await vpsComputerStatus(cfg, "bot-xyz", runner);
    expect(status.container_name).toBe(SHARED_VPS_TARGET.containerName);
    expect(inspected.some((name) => name === SHARED_VPS_TARGET.containerName)).toBe(true);
    expect(inspected.some((name) => name.includes("botxyz") || name.includes("bot-xyz"))).toBe(false);
  });

  it("vpsComputerStatus in per-bot mode still inspects the per-bot name", async () => {
    const { vpsComputerStatus, vpsContainerName } = await import("./vps-computer.ts");
    const inspected: string[] = [];
    const runner: import("./vps-computer.ts").VpsCommandRunner = async (args) => {
      const command = args[2];
      if (command === "image") return { stdout: "[]", stderr: "" };
      if (command === "inspect") {
        inspected.push(String(args[3] ?? ""));
        throw new Error(`Error: No such object: ${args[3]}`);
      }
      return { stdout: "", stderr: "" };
    };
    const cfg: AppConfig = {
      vps: { sshAlias: "test-vps" },
      botDefaults: { vpsMode: "per-bot" },
    };
    const status = await vpsComputerStatus(cfg, "bot-xyz", runner);
    expect(status.container_name).toBe(vpsContainerName("bot-xyz"));
    expect(inspected[0]).toBe(vpsContainerName("bot-xyz"));
  });
});

function sharedReadyRunner(trackSessionEnsure: {
  inFlight: number;
  maxInFlight: number;
  sessionEnsureDelayMs: number;
}): VpsCommandRunner {
  const name = SHARED_VPS_TARGET.containerName;
  const provisioningArgs = vpsContainerRunArgs(name);
  const argValue = (flag: string) => {
    const index = provisioningArgs.indexOf(flag);
    if (index >= 0) return provisioningArgs[index + 1] ?? "";
    return provisioningArgs.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? "";
  };
  const memory = VPS_DEFAULT_MEMORY_GIB * 1024 * 1024 * 1024;
  const cpus = VPS_DEFAULT_CPUS;
  return async (args) => {
    const command = args[2];
    if (command === "image") {
      return {
        stdout: JSON.stringify([{
          Config: {
            Labels: {
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
            },
          },
          Id: SHARED_IMAGE_ID,
        }]),
        stderr: "",
      };
    }
    if (command === "inspect") {
      return {
        stdout: JSON.stringify([{
          Config: {
            Image: VPS_IMAGE,
            Env: [`VNC_PW=${argValue("VNC_PW") || "viewer-secret"}`],
            Labels: {
              [VPS_MANAGED_LABEL]: "1",
              [VPS_CONTAINER_LABEL]: name,
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [VPS_VIEWER_LABEL]: "1",
            },
          },
          Id: SHARED_CONTAINER_ID,
          Image: SHARED_IMAGE_ID,
          HostConfig: {
            Binds: [],
            VolumesFrom: [],
            NetworkMode: "default",
            PortBindings: {},
            PublishAllPorts: false,
            Memory: memory,
            MemorySwap: memory,
            NanoCpus: cpus * 1_000_000_000,
            PidsLimit: 512,
            CapDrop: ["ALL"],
            CapAdd: ["CAP_SETUID", "CAP_SETGID"],
            Privileged: false,
            PidMode: "",
            IpcMode: argValue("--ipc"),
            UTSMode: "",
            ShmSize: 512 * 1024 * 1024,
            Devices: [],
            DeviceRequests: [],
            SecurityOpt: [],
            UsernsMode: "",
            CgroupnsMode: argValue("--cgroupns"),
            OomKillDisable: false,
            AutoRemove: false,
            RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
          },
          NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
          Mounts: [],
          State: { Running: true },
        }]),
        stderr: "",
      };
    }
    if (command === "exec") {
      const joined = args.join("\n");
      if (joined.includes("Xvfb") && joined.includes("botfleet-cua-")) {
        trackSessionEnsure.inFlight += 1;
        trackSessionEnsure.maxInFlight = Math.max(trackSessionEnsure.maxInFlight, trackSessionEnsure.inFlight);
        await new Promise((resolve) => setTimeout(resolve, trackSessionEnsure.sessionEnsureDelayMs));
        trackSessionEnsure.inFlight -= 1;
        return { stdout: "", stderr: "" };
      }
      if (args.at(-1) === "--version") return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n`, stderr: "" };
      if (args.includes("status")) return { stdout: "running\n", stderr: "" };
      if (args.includes("health_report")) {
        return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }), stderr: "" };
      }
      if (args.includes("get_desktop_state")) return { stdout: "{}\n", stderr: "" };
      return { stdout: "{}\n", stderr: "" };
    }
    throw new Error(`unexpected Docker command ${command}`);
  };
}

describe("shared VPS concurrent session ensure", () => {
  it("ensures two bot sessions in parallel after the container is ready", async () => {
    const track = { inFlight: 0, maxInFlight: 0, sessionEnsureDelayMs: 80 };
    const runner = sharedReadyRunner(track);
    const cfg: AppConfig = {
      vps: { sshAlias: "production-vps" },
      botDefaults: { vpsMode: "shared" },
    };
    const [a, b] = await Promise.all([
      inspectVpsForAuto(cfg, "bot-a", runner),
      inspectVpsForAuto(cfg, "bot-b", runner),
    ]);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(track.maxInFlight).toBe(2);
  });
});
