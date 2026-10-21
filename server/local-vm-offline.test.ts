import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER, MANAGED_LABEL, CUA_DRIVER_VERSION } from "./container-computer.ts";
import { assertHarnessStopped, assertLocalDocker, inspectOfflineLocalVms, offlineLocalVmAction } from "./local-vm-offline.ts";
import type { CommandRunner } from "./container-computer.ts";

function fixture() {
  const calls: string[][] = [];
  let state: "created" | "running" | "exited" | "missing" = "created";
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const key = [command, ...args].join(" ");
    if (key === "docker context show") return { stdout: "orbstack\n" };
    if (key === "docker context inspect orbstack --format {{json .Endpoints.docker.Host}}") {
      return { stdout: '"unix:///fixture/docker.sock"\n' };
    }
    if (key === "docker info --format {{.ServerVersion}}") return { stdout: "29\n" };
    if (key === `docker ps -a --filter label=${MANAGED_LABEL}=1 --format {{.ID}}`) {
      return { stdout: state === "missing" ? "badbadbadbad\n" : "abcdefabcdef\nbadbadbadbad\n" };
    }
    if (args[0] === "inspect" && args[1] === "--format" && args[3] === "abcdefabcdef") {
      return { stdout: [`/${CONTAINER}`, state, state === "running", "1", "1", CUA_DRIVER_VERSION, "shared"]
        .map((field) => JSON.stringify(field)).join("\t") + "\n" };
    }
    if (args[0] === "inspect" && args[1] === "--format" && args[3] === "badbadbadbad") {
      return { stdout: ["/unrelated-container", "running", true, "1", "1", CUA_DRIVER_VERSION, null]
        .map((field) => JSON.stringify(field)).join("\t") + "\n" };
    }
    if (key === `docker stop ${CONTAINER}`) {
      state = "exited";
      return { stdout: `${CONTAINER}\n` };
    }
    throw new Error(`unexpected fixture command: ${key}`);
  };
  return { runner, calls, setState: (value: typeof state) => { state = value; } };
}

beforeEach(() => {
  vi.stubEnv("DOCKER_HOST", undefined);
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  vi.stubEnv("DOCKER_TLS_VERIFY", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("offline Local VM control", () => {
  it("refuses mutation without an explicit server-stop marker", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bf-offline-vm-test-"));
    try {
      await expect(assertHarnessStopped(dataDir)).rejects.toThrow(/deliberate-stop marker/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects remote Docker contexts and environment overrides before inspection", async () => {
    const remote: CommandRunner = async (_command, args) => {
      if (args[0] === "context" && args[1] === "show") return { stdout: "remote\n" };
      return { stdout: '"tcp://example.invalid:2376"\n' };
    };
    await expect(assertLocalDocker(remote)).rejects.toThrow(/local Unix Docker socket/);
    vi.stubEnv("DOCKER_HOST", "tcp://example.invalid:2376");
    const f = fixture();
    await expect(inspectOfflineLocalVms(f.runner)).rejects.toThrow(/overrides/);
    expect(f.calls).toHaveLength(0);
  });

  it("reports created distinctly and ignores a container with a foreign name", async () => {
    const f = fixture();
    await expect(inspectOfflineLocalVms(f.runner)).resolves.toEqual([{
      key: "shared", name: "Shared Local VM", running: false, state: "created",
    }]);
    expect(f.calls.some((call) => call.includes("rename"))).toBe(false);
  });

  it("requires stopped-server proof before a stop and touches only the exact managed target", async () => {
    const f = fixture();
    f.setState("running");
    const assertStopped = vi.fn(async () => {});
    await expect(offlineLocalVmAction("stop", { runner: f.runner, assertStopped })).resolves.toMatchObject({
      ok: true, localVms: [{ state: "stopped", running: false }],
    });
    expect(assertStopped).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((call) => call[1] === "stop")).toEqual([["docker", "stop", CONTAINER]]);
  });

  it("refuses creation over any existing shared VM without calling the creator", async () => {
    const f = fixture();
    const createStopped = vi.fn(async () => {});
    await expect(offlineLocalVmAction("create-stopped", {
      runner: f.runner, assertStopped: async () => {}, createStopped,
    })).rejects.toThrow(/already exists/);
    expect(createStopped).not.toHaveBeenCalled();
  });

  it("creates only after the server proof and returns the never-started state", async () => {
    const f = fixture();
    f.setState("missing");
    const order: string[] = [];
    const assertStopped = vi.fn(async () => { order.push("stopped"); });
    const createStopped = vi.fn(async () => { order.push("create"); f.setState("created"); });

    await expect(offlineLocalVmAction("create-stopped", { runner: f.runner, assertStopped, createStopped }))
      .resolves.toMatchObject({ ok: true, localVms: [{ key: "shared", state: "created", running: false }] });
    expect(order).toEqual(["stopped", "stopped", "create"]);
    expect(f.calls.some((call) => ["start", "run", "pull", "build", "rm"].includes(call[1] ?? ""))).toBe(false);
  });
});
