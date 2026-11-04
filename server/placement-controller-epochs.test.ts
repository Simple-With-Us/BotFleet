import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HOST_ID_PATTERN, PLACEMENT_WIRE_VERSION, type CapacitySample, type ClaimMessage, type ControllerEpoch, type EnqueueMessage, type HeartbeatMessage, type HostId, type RegisterMessage, type ReleaseMessage, type ReportMessage, type StopMessage, type TakeoverMessage } from "../shared/placement.ts";
import * as atomic from "./atomic.ts";
import { loadControllerEpoch, openControllerEpochStore } from "./placement-identity.ts";
import { PlacementLeaseService, placementLeaseRoute, type PlacementLeaseAction } from "./placement-leases.ts";
import { spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";
import { freePortBlock } from "./testing/ports.ts";
import { fileURLToPath } from "node:url";
import { openPlacementStore } from "./placement-store.ts";

const hostId: HostId = "server:11111111-1111-4111-8111-111111111111";
const nextId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const initial: ControllerEpoch = { controllerId: hostId, epoch: 0 };
const fence = { ...initial, version: PLACEMENT_WIRE_VERSION };
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };
const sample: CapacitySample = {
  at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null,
  memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null,
  diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null,
  dataVolume: null, rootDiskFreeBytes: null,
};
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bf-controller-epochs-"));
  dirs.push(dir);
  return dir;
}
function service(dir: string) {
  const controllerStore = openControllerEpochStore(dir, hostId);
  return new PlacementLeaseService({ volatileForTests: true, hostId, controller: controllerStore.read(), controllerStore });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable controller transitions", () => {
  it("persists release and takeover before acknowledging, and fences stale requests after restart", () => {
    const dir = fixture();
    const leases = service(dir);
    const release = placementLeaseRoute(owner, "release-controller", { ...fence, toControllerId: nextId }, leases);
    expect(release).toMatchObject({ status: 200, body: { accepted: true, controllerId: nextId, epoch: 1 } });
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: nextId, epoch: 1 });
    const restarted = service(dir);
    expect(placementLeaseRoute(owner, "release-controller", { ...fence, toControllerId: hostId }, restarted))
      .toMatchObject({ body: { accepted: false, controllerId: nextId, epoch: 1 } });
    expect(placementLeaseRoute(owner, "takeover", { ...fence, epoch: 4, reconcile: true }, restarted))
      .toMatchObject({ body: { accepted: true, controllerId: hostId, epoch: 4 } });
    expect(service(dir).controller()).toEqual({ controllerId: hostId, epoch: 4 });
    expect(statSync(join(dir, "placement-controller.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses failed writes without changing controller, reconciliation, or in-flight jobs", () => {
    const dir = fixture();
    const leases = service(dir);
    const empty = service(fixture());
    leases.register({ ...fence, hostId: nextId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "queued", botId: "bot", threadId: "thread", command: "true", cwd: dir, timeoutMs: 1000 });
    leases.claim({ ...fence, jobId: "queued", hostId: nextId });
    const before = leases.jobsList();
    const bytes = readFileSync(join(dir, "placement-controller.json"), "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("fixture disk failure"); });
    expect(placementLeaseRoute(owner, "takeover", { ...fence, epoch: 2, controllerId: nextId, reconcile: true }, leases))
      .toMatchObject({ body: { accepted: false, controllerId: hostId, epoch: 0, reason: expect.stringMatching(/could not be persisted/) } });
    expect(leases.controller()).toEqual(initial);
    expect(leases.reconciling()).toBe(false);
    expect(leases.jobsList()).toEqual(before);
    expect(readFileSync(join(dir, "placement-controller.json"), "utf8")).toBe(bytes);
    expect(empty.release({ ...fence, toControllerId: nextId })).toMatchObject({ reply: { accepted: false, epoch: 0 } });
    expect(empty.controller()).toEqual(initial);
  });

  it("refuses a held writer lock and preserves its owner, then permits a retry after it is released", () => {
    const dir = fixture();
    const leases = service(dir);
    const lock = join(dir, "placement-controller.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "fixture");
    expect(leases.release({ ...fence, toControllerId: nextId })).toMatchObject({ reply: { accepted: false, epoch: 0 } });
    expect(leases.controller()).toEqual(initial);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("fixture");
    expect(() => service(dir)).toThrow();
    rmSync(lock, { recursive: true });
    expect(leases.release({ ...fence, toControllerId: nextId })).toMatchObject({ reply: { accepted: true, epoch: 1 } });
  });

  it("never lets stale service instances or store writers overwrite a newer pair", () => {
    const dir = fixture();
    const first = service(dir);
    const stale = service(dir);
    const staleStore = openControllerEpochStore(dir, hostId);
    expect(first.takeover({ ...fence, controllerId: nextId, epoch: 3, reconcile: true }))
      .toMatchObject({ reply: { accepted: true, epoch: 3 } });
    expect(stale.release({ ...fence, toControllerId: hostId }))
      .toMatchObject({ reply: { accepted: false, controllerId: nextId, epoch: 3 } });
    expect(stale.takeover({ ...fence, epoch: 2, reconcile: true })).toMatchObject({ reply: { accepted: false, epoch: 3 } });
    expect(staleStore.compareAndSet(initial, { controllerId: hostId, epoch: 2 }))
      .toEqual({ accepted: false, controller: { controllerId: nextId, epoch: 3 } });
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: nextId, epoch: 3 });
    expect(stale.controller()).toEqual(first.controller());
  });

  it("allows at most one of two concurrent processes to commit the same expected fence", async () => {
    const dir = fixture();
    openControllerEpochStore(dir, hostId);
    const module = new URL("./placement-identity.ts", import.meta.url).href;
    const script = `import {openControllerEpochStore} from ${JSON.stringify(module)}; const store=openControllerEpochStore(process.argv[1], process.argv[2]); process.stdout.write('ready\\n'); process.stdin.once('data', () => {try {process.stdout.write(JSON.stringify(store.compareAndSet({controllerId:process.argv[2],epoch:0},{controllerId:process.argv[3],epoch:1})))} catch {process.stdout.write('locked')} });`;
    function writer() {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, hostId, nextId], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (data) => { output += data; if (output.startsWith("ready\n")) resolve(); });
        child.on("error", reject);
        child.on("exit", (code) => { if (code) reject(new Error(errors)); });
      });
      child.stderr.on("data", (data) => { errors += data; });
      const done = new Promise<string>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve(output.slice("ready\n".length)) : reject(new Error(errors)));
      });
      return { child, ready, done };
    }
    const a = writer();
    await a.ready;
    const b = writer();
    await b.ready;
    a.child.stdin.end("go");
    b.child.stdin.end("go");
    const results = await Promise.all([a.done, b.done]);
    expect(results.filter((result) => result === '{"accepted":true}')).toHaveLength(1);
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: nextId, epoch: 1 });
  });

  it("refuses a competing transition committed between validation and compare-and-set", () => {
    const dir = fixture();
    const store = openControllerEpochStore(dir, hostId);
    const leases = new PlacementLeaseService({
      volatileForTests: true,
      hostId, controller: initial,
      controllerStore: {
        read: () => store.read(),
        compareAndSet: (expected, next) => {
          store.compareAndSet(expected, { controllerId: nextId, epoch: 9 });
          return store.compareAndSet(expected, next);
        },
      },
    });
    expect(leases.takeover({ ...fence, epoch: 2, reconcile: false }))
      .toMatchObject({ reply: { accepted: false, controllerId: nextId, epoch: 9 } });
    expect(leases.controller()).toEqual({ controllerId: nextId, epoch: 9 });
    expect(leases.reconciling()).toBe(true);
    expect(store.read()).toEqual({ controllerId: nextId, epoch: 9 });
  });

  it.each(["missing", "damaged"])("refuses a contended transition whose refresh becomes %s without reporting a write failure", (damage) => {
    const dir = fixture();
    const store = openControllerEpochStore(dir, hostId);
    const path = join(dir, "placement-controller.json");
    const leases = new PlacementLeaseService({
      hostId, controller: initial,
      controllerStore: {
        read: () => store.read(),
        compareAndSet: (expected, next) => {
          store.compareAndSet(expected, { controllerId: nextId, epoch: 9 });
          const result = store.compareAndSet(expected, next);
          if (damage === "missing") rmSync(path); else writeFileSync(path, "damaged");
          return result;
        },
      },
    });
    expect(leases.takeover({ ...fence, epoch: 2, reconcile: true }))
      .toMatchObject({ reply: { accepted: false, reason: "Controller epoch could not be verified; placement refused", epoch: 0 } });
    expect(leases.reconciling()).toBe(false);
    expect(leases.jobsList()).toEqual([]);
    if (damage === "damaged") expect(readFileSync(path, "utf8")).toBe("damaged");
    else expect(() => readFileSync(path)).toThrow();
  });

  it("rejects unsafe or non-advancing epochs and never resets missing, damaged or regressed state", () => {
    const dir = fixture();
    const store = openControllerEpochStore(dir, hostId);
    for (const epoch of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.compareAndSet(initial, { controllerId: nextId, epoch })).toThrow();
    }
    expect(store.read()).toEqual(initial);
    const leases = service(dir);
    leases.takeover({ ...fence, epoch: 2, reconcile: true });
    const path = join(dir, "placement-controller.json");
    writeFileSync(path, JSON.stringify(initial));
    expect(leases.release({ ...fence, toControllerId: nextId }))
      .toMatchObject({ reply: { accepted: false, reason: "Controller epoch could not be verified; placement refused", epoch: 2 } });
    writeFileSync(path, "damaged");
    expect(() => leases.controller()).toThrow(/invalid/);
    expect(readFileSync(path, "utf8")).toBe("damaged");
    rmSync(path);
    expect(leases.takeover({ ...fence, epoch: 3, reconcile: true }))
      .toMatchObject({ reply: { accepted: false, reason: "Controller epoch could not be verified; placement refused", epoch: 2 } });
    expect(() => store.read()).toThrow();
  });

  it("returns structured refusals without changing jobs when the durable fence is unavailable", () => {
    const dir = fixture();
    const leases = service(dir);
    const path = join(dir, "placement-controller.json");
    const enqueue = { ...fence, jobId: "held", botId: "bot", threadId: "thread", command: "true", cwd: dir, timeoutMs: 1000 };
    leases.enqueue(enqueue);
    const before = leases.jobsList();
    for (const damaged of ["private damaged fixture", JSON.stringify({ ...initial, epoch: -1 }), null]) {
      if (damaged === null) rmSync(path); else writeFileSync(path, damaged);
      expect(placementLeaseRoute(owner, "claim", { ...fence, hostId: nextId, jobId: "held" }, leases))
        .toEqual({ status: 200, body: { accepted: false, reason: "Controller epoch could not be verified; placement refused", ...initial } });
      expect(placementLeaseRoute(owner, "heartbeat", { ...fence, hostId: nextId, leases: [], admission: { admit: true }, sample }, leases))
        .toMatchObject({ status: 409, body: { error: "Controller epoch could not be verified; placement refused" } });
      expect(placementLeaseRoute(owner, "enqueue", { ...enqueue, jobId: "new" }, leases))
        .toMatchObject({ status: 200, body: { accepted: false, reason: "Controller epoch could not be verified; placement refused" } });
      expect(placementLeaseRoute(owner, "takeover", { ...fence, epoch: 3, reconcile: true }, leases))
        .toMatchObject({ status: 200, body: { accepted: false, reason: "Controller epoch could not be verified; placement refused" } });
      expect(leases.jobsList()).toEqual(before);
      expect(leases.reconciling()).toBe(false);
    }
    writeFileSync(path, JSON.stringify(initial));
    expect(placementLeaseRoute(owner, "enqueue", { ...enqueue, jobId: "new" }, leases))
      .toMatchObject({ status: 200, body: { accepted: true } });
  });

  it("refuses release overflow at the largest valid epoch", () => {
    const dir = fixture();
    const store = openControllerEpochStore(dir, hostId);
    store.compareAndSet(initial, { controllerId: hostId, epoch: Number.MAX_SAFE_INTEGER });
    const leases = service(dir);
    expect(leases.release({ ...fence, epoch: Number.MAX_SAFE_INTEGER, toControllerId: nextId }))
      .toMatchObject({ reply: { accepted: false, epoch: Number.MAX_SAFE_INTEGER } });
    expect(store.read().epoch).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.skipIf(process.platform === "win32")("serves the active identity through the real HTTP route before and after restart", async () => {
    const home = fixture();
    const dir = join(home, ".botfleet");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }));
    const port = await freePortBlock([0, 1]);
    const base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | undefined;
    async function boot() {
      let stderr = "";
      const childEnv: NodeJS.ProcessEnv = {
        HOME: home, USERPROFILE: home, TZ: "America/Chicago",
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
      };
      if (process.env.PATH) childEnv.PATH = process.env.PATH;
      child = spawnDetached(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (data) => { stderr += String(data); });
      const deadline = Date.now() + 30_000;
      while (!await harnessReady(base, 1000)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`isolated harness did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const identity = async () => {
      const response = await fetch(`${base}/api/placement/identity`);
      expect(response.status).toBe(200);
      return z.object({
        controllerId: z.string().regex(HOST_ID_PATTERN).transform((value) => {
          // SAFETY: HOST_ID_PATTERN validates the HostId shape at this HTTP boundary.
          return value as HostId;
        }),
        epoch: z.number().int().nonnegative().safe(),
      }).parse(await response.json());
    };
    const transition = async (action: PlacementLeaseAction, body: ReleaseMessage | TakeoverMessage | EnqueueMessage | RegisterMessage | HeartbeatMessage | ClaimMessage | StopMessage | ReportMessage) => {
      const response = await fetch(`${base}/api/placement/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      // Ordinary updates preserve the existing strict epoch/rollback contract.
      await boot();
      const legacy = await identity();
      expect(loadControllerEpoch(dir, legacy.controllerId)).toEqual({ controllerId: legacy.controllerId, epoch: 0 });
      expect(existsSync(join(dir, "placement.sqlite"))).toBe(false);
      expect(existsSync(join(dir, "placement-payloads"))).toBe(false);
      if (!child) throw new Error("fixture child missing");
      await waitForExit(child, { signal: "SIGTERM" });
      // Explicit isolated fixture migration stands in for the later verified activation.
      openPlacementStore(dir, legacy.controllerId).close();
      await boot();
      const start = await identity();
      expect(start.epoch).toBe(0);
      const currentFence = { ...fence, controllerId: start.controllerId };
      expect(await transition("release-controller", { ...currentFence, toControllerId: nextId })).toMatchObject({ accepted: true, epoch: 1 });
      expect(await identity()).toMatchObject({ controllerId: nextId, epoch: 1 });
      expect(await transition("takeover", { ...fence, epoch: 5, reconcile: true })).toMatchObject({ accepted: true, epoch: 5 });
      expect(await identity()).toMatchObject({ controllerId: hostId, epoch: 5 });
      if (!child) throw new Error("fixture child missing");
      await waitForExit(child, { signal: "SIGTERM" });
      await boot();
      expect(await identity()).toMatchObject({ controllerId: hostId, epoch: 5 });
      expect(await transition("release-controller", { ...currentFence, toControllerId: nextId }))
        .toMatchObject({ accepted: false, controllerId: hostId, epoch: 5 });
      const liveFence = { ...fence, epoch: 5 };
      const enqueue = { ...liveFence, jobId: "http-restart", botId: "fixture-bot", threadId: "fixture-thread", command: "true", cwd: dir, timeoutMs: 1000 };
      expect(await transition("enqueue", enqueue)).toMatchObject({ accepted: true });
      const register = { ...liveFence, hostId: nextId, role: "worker" as const, capabilities: ["shell"] as const, sample };
      const heartbeat = { ...liveFence, hostId: nextId, leases: [], admission: { admit: true }, sample };
      await transition("register", { ...register, capabilities: ["shell"] });
      await transition("heartbeat", heartbeat);
      const claim = { ...liveFence, hostId: nextId, jobId: enqueue.jobId };
      const claimed = await transition("claim", claim);
      expect(claimed).toMatchObject({ accepted: true });
      const leaseId = z.object({ lease: z.object({ leaseId: z.string().min(1) }) }).parse(claimed).lease.leaseId;
      await transition("stop", { ...liveFence, jobId: enqueue.jobId, leaseId, reason: "fixture stop" });
      await waitForExit(child, { signal: "SIGTERM" });
      await boot();
      expect(await transition("claim", claim)).toMatchObject({ accepted: false });
      await transition("register", { ...register, capabilities: ["shell"] });
      expect(await transition("heartbeat", heartbeat)).toMatchObject({ pendingStops: [leaseId] });
      expect(await transition("claim", claim)).toMatchObject({ accepted: true, lease: { leaseId } });
      const report: ReportMessage = { ...liveFence, jobId: enqueue.jobId, hostId: nextId, leaseId, status: "killed", exitCode: null, signal: "SIGTERM", endedAt: 2000 };
      expect(await transition("report", report)).toMatchObject({ accepted: true });
      expect(await transition("heartbeat", heartbeat)).toMatchObject({ pendingStops: [] });
      expect(await transition("report", report)).toMatchObject({ accepted: true });
      expect(await transition("enqueue", enqueue)).toMatchObject({ accepted: true, duplicate: true, status: "killed" });
    } finally {
      if (child) await waitForExit(child, { signal: "SIGTERM" });
    }
  }, 60_000);
});
