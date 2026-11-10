import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";

import { dataDir } from "./data-dir.ts";
import { resolveHarnessPort } from "./harness-ports.ts";

import {
  CONTAINER,
  DRIVER_LABEL,
  MANAGED_LABEL,
  SHARED_LOCAL_VM_TARGET,
  TARGET_LABEL,
  WORKSPACE_LABEL,
  createStoppedSharedLocalVm,
  defaultCommandRunner,
  type CommandRunner,
} from "./container-computer.ts";

export type OfflineVmAction = "status" | "create-stopped" | "stop";
export interface OfflineVmStatus {
  key: string;
  name: string;
  running: boolean;
  state: "running" | "created" | "stopped" | "missing";
}

interface InspectedContainer {
  name: string;
  status: string;
  running: boolean;
  managed: string | null;
  workspace: string | null;
  driver: string | null;
  target: string | null;
}

const SAFE_INSPECT_FORMAT = [
  "{{json .Name}}", "{{json .State.Status}}", "{{json .State.Running}}",
  `{{json (index .Config.Labels "${MANAGED_LABEL}")}}`,
  `{{json (index .Config.Labels "${WORKSPACE_LABEL}")}}`,
  `{{json (index .Config.Labels "${DRIVER_LABEL}")}}`,
  `{{json (index .Config.Labels "${TARGET_LABEL}")}}`,
].join("\t");

function parseSafeInspect(value: string): InspectedContainer {
  const fields = value.trim().split("\t");
  if (fields.length !== 7) throw new Error("Docker returned an incomplete Local VM inspection");
  const [name, status, running, managed, workspace, driver, target] = z.tuple([
    z.string(), z.string(), z.boolean(), z.string().nullable(), z.string().nullable(),
    z.string().nullable(), z.string().nullable(),
  ]).parse(fields.map((field) => JSON.parse(field)));
  return { name, status, running, managed, workspace, driver, target };
}

function managedTarget(detail: InspectedContainer): OfflineVmStatus | null {
  if (detail.managed !== "1" || detail.workspace !== "1" || !detail.driver) return null;
  const name = detail.name.replace(/^\//, "");
  const label = detail.target;
  const running = detail.running;
  const state = running ? "running" : detail.status === "created" ? "created" : "stopped";
  if (name === CONTAINER && (!label || label === "shared")) {
    return { key: "shared", name: "Shared Local VM", running, state };
  }
  if (label && /^[a-f0-9]{64}$/.test(label) && name === `${CONTAINER}-${label.slice(0, 16)}`) {
    return { key: `bot:${label}`, name: `Bot Local VM ${label.slice(0, 8)}`, running, state };
  }
  return null;
}

/** Refuse a remote Docker daemon, including a local context overridden by env. */
export async function assertLocalDocker(runner: CommandRunner = defaultCommandRunner): Promise<void> {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY) {
    throw new Error("Unset Docker host and context overrides before controlling Local VMs");
  }
  const context = (await runner("docker", ["context", "show"])).stdout.trim();
  if (!context || !/^[a-zA-Z0-9_.-]+$/.test(context)) throw new Error("Docker context could not be verified");
  const endpoint = (await runner("docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"]))
    .stdout.trim();
  const host = z.string().parse(JSON.parse(endpoint));
  if (!host.startsWith("unix://") || !host.slice(7).startsWith("/")) {
    throw new Error("Local VM controls require a local Unix Docker socket");
  }
  await runner("docker", ["info", "--format", "{{.ServerVersion}}"]).catch(() => {
    throw new Error("The local Docker daemon is unavailable");
  });
}

/** Docker inspect is read-only.  Never use containerComputerStatus here: it can rename legacy containers. */
export async function inspectOfflineLocalVms(runner: CommandRunner = defaultCommandRunner): Promise<OfflineVmStatus[]> {
  await assertLocalDocker(runner);
  const ids = (await runner("docker", ["ps", "-a", "--filter", `label=${MANAGED_LABEL}=1`, "--format", "{{.ID}}"]))
    .stdout.trim().split(/\s+/).filter(Boolean);
  const vms: OfflineVmStatus[] = [];
  for (const id of ids) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Docker returned an invalid container ID");
    const inspected = parseSafeInspect((await runner("docker", ["inspect", "--format", SAFE_INSPECT_FORMAT, id])).stdout);
    const vm = managedTarget(inspected);
    if (vm) vms.push(vm);
  }
  if (!vms.some((vm) => vm.key === "shared")) {
    vms.unshift({ key: "shared", name: "Shared Local VM", running: false, state: "missing" });
  }
  return vms;
}

export async function assertHarnessStopped(dir = dataDir()): Promise<void> {
  if (!existsSync(join(dir, "stopped.marker"))) throw new Error("BotFleet Server has no deliberate-stop marker");
  const harnessPort = resolveHarnessPort();
  const portFree = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port: harnessPort, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
  if (!portFree) throw new Error(`BotFleet Server may still be listening on port ${harnessPort}`);
  if (process.platform === "darwin") {
    try {
      const launchd = execFileSync("/bin/launchctl", ["list"], {
        encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
      });
      const row = launchd.split("\n").find((line) => line.endsWith("\tapp.botfleet.server"));
      if (row) {
        const pid = row.split("\t")[0];
        if (pid !== "-") throw new Error("BotFleet Server LaunchAgent is still running");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "BotFleet Server LaunchAgent is still running") throw error;
      throw new Error("BotFleet Server LaunchAgent state could not be verified");
    }
  }
}

export async function offlineLocalVmAction(
  action: OfflineVmAction,
  options: { runner?: CommandRunner; assertStopped?: () => Promise<void>; createStopped?: (runner: CommandRunner) => Promise<void> } = {},
): Promise<{ ok: true; localVms: OfflineVmStatus[] }> {
  const runner = options.runner ?? defaultCommandRunner;
  if (action !== "status") await (options.assertStopped ?? assertHarnessStopped)();
  const before = await inspectOfflineLocalVms(runner);
  if (action === "create-stopped") {
    if (before.find((vm) => vm.key === "shared")?.state !== "missing") {
      throw new Error("A shared Local VM already exists; recreate it from Computer settings");
    }
    await (options.assertStopped ?? assertHarnessStopped)();
    await (options.createStopped ?? createStoppedSharedLocalVm)(runner);
  } else if (action === "stop") {
    for (const vm of before.filter((entry) => entry.running)) {
      const id = vm.key === "shared" ? SHARED_LOCAL_VM_TARGET.containerName : `${CONTAINER}-${vm.key.slice(4, 20)}`;
      await (options.assertStopped ?? assertHarnessStopped)();
      await runner("docker", ["stop", id], 2 * 60_000);
    }
  }
  return { ok: true, localVms: action === "status" ? before : await inspectOfflineLocalVms(runner) };
}
