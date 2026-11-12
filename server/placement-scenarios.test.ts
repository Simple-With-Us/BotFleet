/** Placement Transport T6b: Two-Process Fault Scenarios (BF-2670).
 *
 *  Proves lease durability and exact-once execution across network faults:
 *  - Dropped acknowledgement on terminal report
 *  - Disconnect after completion
 *  - Idempotent report replay
 *  - Controller restart with durable SQLite store
 *  - Worker restart with orphan lease reconciliation
 *  - Controller takeover
 *  - Stale epoch refusal
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PLACEMENT_WIRE_VERSION,
  type CapacitySample,
  type HostId,
} from "../shared/placement.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import { PlacementPayloadSpool } from "./placement-payloads.ts";
import { PlacementReportSpool, settlePendingReports } from "./placement-report-spool.ts";
import { openPlacementStore, type PlacementStore } from "./placement-store.ts";
import { createWorkerRequestBoundary, type WorkerAuthorization } from "./placement-worker-auth.ts";
import { nodeHttpWorkerLink, PlacementWorkerClient } from "./placement-worker-client.ts";
import { createWorkerTransport } from "./placement-worker-routes.ts";
import {
  PlacementWorkerRuntime,
  type WorkerSpawnResult,
} from "./placement-worker-runtime.ts";
import { startFaultProxy, type FaultProxy } from "./testing/fault-proxy.ts";
import { nonceRuns } from "./testing/two-process.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const sample: CapacitySample = {
  at: 1,
  cores: null,
  loadPerCore: null,
  ramTotalBytes: null,
  ramAvailableBytes: null,
  memoryPressure: null,
  memoryAvailablePercent: null,
  swapTotalBytes: null,
  swapUsedBytes: null,
  diskTotalBytes: null,
  diskFreeBytes: null,
  inodesTotal: null,
  inodesFree: null,
  dataVolume: null,
  rootDiskFreeBytes: null,
};

const nonceScript = fileURLToPath(new URL("./testing/nonce-job.mjs", import.meta.url));

interface ScenarioFixture {
  controllerDir: string;
  workerDir: string;
  nonceDir: string;
  store: PlacementStore;
  payloads: PlacementPayloadSpool;
  leases: PlacementLeaseService;
  server: Server;
  proxy: FaultProxy;
  client: PlacementWorkerClient;
  spool: PlacementReportSpool;
  runtime: PlacementWorkerRuntime;
  secret: string;
  credentialId: string;
}

const cleanupDirs: string[] = [];
const cleanupServers: Server[] = [];
const cleanupProxies: FaultProxy[] = [];
const cleanupStores: PlacementStore[] = [];

afterEach(async () => {
  for (const proxy of cleanupProxies.splice(0)) await proxy.close();
  for (const server of cleanupServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of cleanupStores.splice(0)) store.close();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spawnRealNonceJob(
  job: { jobId: string; leaseId: string; command: string; cwd?: string },
): Promise<WorkerSpawnResult> {
  const child = spawn("sh", ["-c", job.command], {
    cwd: job.cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return Promise.resolve({ pid: child.pid ?? null, done });
}

async function createFixture(options: { epoch?: number } = {}): Promise<ScenarioFixture> {
  const epoch = options.epoch ?? 0;
  const baseDir = mkdtempSync(join(tmpdir(), "bf-scenario-"));
  cleanupDirs.push(baseDir);

  const controllerDir = join(baseDir, "controller");
  const workerDir = join(baseDir, "worker");
  const nonceDir = join(baseDir, "nonce");
  mkdirSync(nonceDir, { recursive: true });

  const store = openPlacementStore(controllerDir, controllerId);
  cleanupStores.push(store);
  const payloads = new PlacementPayloadSpool(controllerDir);
  const leases = new PlacementLeaseService({
    hostId: controllerId,
    controller: { controllerId, epoch },
    store,
    payloads,
  });

  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const record: WorkerAuthorization = {
    format: "botfleet-placement-worker",
    version: 1,
    credentialId,
    revision: 1,
    hostId: workerId,
    audience: controllerId,
    role: "execution-worker",
    secretSha256: createHash("sha256").update(secret).digest("hex"),
    revoked: false,
    expiresAt: null,
  };

  const boundary = createWorkerRequestBoundary({
    audience: controllerId,
    source: { read: () => record },
    transport: createWorkerTransport(leases),
    readBody: (req) =>
      new Promise((resolve, reject) => {
        const parts: Buffer[] = [];
        req.on("data", (part: Buffer) => parts.push(part));
        req.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      }),
  });

  const server = createServer((req, res) => {
    void boundary(req, res).catch(() => {
      res.destroy();
    });
  });
  cleanupServers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());

  const proxy = await startFaultProxy({ targetPort: port });
  cleanupProxies.push(proxy);

  const client = new PlacementWorkerClient({
    credential: { credentialId, secret },
    workerHostId: workerId,
    audience: controllerId,
    controller: { controllerId, epoch },
    baseUrl: `http://127.0.0.1:${proxy.port}/`,
    fetchImpl: nodeHttpWorkerLink(),
  });

  const spool = new PlacementReportSpool(workerDir);

  const runtime = new PlacementWorkerRuntime({
    client,
    spool,
    hostId: workerId,
    capabilities: ["shell"],
    dataDir: workerDir,
    sampleProvider: () => ({ ...sample, at: Date.now() }),
    admissionProvider: () => ({ admit: true }),
    spawnJob: (job) => spawnRealNonceJob(job),
    stopJob: async () => {},
  });

  return {
    controllerDir,
    workerDir,
    nonceDir,
    store,
    payloads,
    leases,
    server,
    proxy,
    client,
    spool,
    runtime,
    secret,
    credentialId,
  };
}

describe("Placement Transport T6b: Two-Process Fault Scenarios", () => {
  it("dropped acknowledgement: report replay settles terminal result exactly once", async () => {
    const { leases, proxy, client, spool, runtime, nonceDir } = await createFixture();
    const nonce = "dropped-ack";

    leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-dropped-ack",
      botId: "b",
      threadId: "t",
      cwd: nonceDir,
      timeoutMs: 10_000,
      command: `${process.execPath} ${nonceScript} ${nonceDir} ${nonce}`,
    });

    await runtime.register();
    await runtime.tickHeartbeat();

    // Drop the controller's response on report delivery (the dropped acknowledgement)
    proxy.dropNext("response", (e) => e.path.includes("report"));

    // Pull assignment: acquires lease, saves lease to disk, spawns nonce-job, tries to report
    const { jobId } = await runtime.pullAssignment();
    expect(jobId).toBe("job-dropped-ack");
    if (jobId) await runtime.waitForJob(jobId);

    // The job process ran and finished; exactly one run file was created
    expect(nonceRuns(nonceDir, nonce).length).toBe(1);

    // Controller acted on the report and marked the job completed
    expect(leases.job("job-dropped-ack")?.status).toBe("completed");

    // Because the response was dropped, the spool kept the report row
    expect(spool.pending().length).toBe(1);

    // Replay delivery: settle the pending report against the controller
    const outcomes = await settlePendingReports(spool, client);
    expect(outcomes).toEqual([expect.objectContaining({ jobId: "job-dropped-ack", result: "settled" })]);
    expect(spool.pending().length).toBe(0);

    // Proves exact-once execution: still exactly one run file after replay
    expect(nonceRuns(nonceDir, nonce).length).toBe(1);
  });

  it("disconnect after completion: spooled report waits for reconnect and settles cleanly", async () => {
    const { leases, proxy, client, spool, runtime, nonceDir } = await createFixture();
    const nonce = "disconnect-after";

    leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-disconnect",
      botId: "b",
      threadId: "t",
      cwd: nonceDir,
      timeoutMs: 10_000,
      command: `${process.execPath} ${nonceScript} ${nonceDir} ${nonce}`,
    });

    await runtime.register();
    await runtime.tickHeartbeat();

    // Cut connections and refuse incoming requests as soon as report arrives
    proxy.dropNext("request", (e) => e.path.includes("report"));
    proxy.setRefusing(true);

    const { jobId } = await runtime.pullAssignment();
    expect(jobId).toBe("job-disconnect");
    if (jobId) await runtime.waitForJob(jobId);

    // Job ran once
    expect(nonceRuns(nonceDir, nonce).length).toBe(1);

    // Report remains in spool because link was refused
    expect(spool.pending().length).toBe(1);

    // Restore connectivity
    proxy.setRefusing(false);

    // Settle pending reports
    const outcomes = await settlePendingReports(spool, client);
    expect(outcomes).toEqual([expect.objectContaining({ jobId: "job-disconnect", result: "settled" })]);
    expect(spool.pending().length).toBe(0);

    expect(leases.job("job-disconnect")?.status).toBe("completed");
    expect(nonceRuns(nonceDir, nonce).length).toBe(1);
  });

  it("report replay: controller acknowledges duplicate terminal report idempotently", async () => {
    const { leases, proxy, runtime, nonceDir } = await createFixture();
    const nonce = "report-replay";

    leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-replay",
      botId: "b",
      threadId: "t",
      cwd: nonceDir,
      timeoutMs: 10_000,
      command: `${process.execPath} ${nonceScript} ${nonceDir} ${nonce}`,
    });

    await runtime.register();
    await runtime.tickHeartbeat();
    const { jobId } = await runtime.pullAssignment();
    expect(jobId).toBe("job-replay");
    if (jobId) await runtime.waitForJob(jobId);

    expect(nonceRuns(nonceDir, nonce).length).toBe(1);
    expect(leases.job("job-replay")?.status).toBe("completed");

    // Find the report exchange recorded by the proxy
    const reportExchange = proxy.exchanges().find((e) => e.path.includes("report"));
    expect(reportExchange).toBeDefined();

    if (reportExchange) {
      // Replay the exact report exchange to the controller
      const reply = await proxy.replay(reportExchange);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body.toString("utf8"))).toMatchObject({ accepted: true });
    }

    expect(leases.job("job-replay")?.status).toBe("completed");
    expect(nonceRuns(nonceDir, nonce).length).toBe(1);
  });

  it("controller restart: state survives and restarted controller accepts completion", async () => {
    const fixture = await createFixture();
    const nonce = "controller-restart";

    fixture.leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-ctrl-restart",
      botId: "b",
      threadId: "t",
      cwd: fixture.nonceDir,
      timeoutMs: 10_000,
      command: `${process.execPath} ${nonceScript} ${fixture.nonceDir} ${nonce}`,
    });

    await fixture.runtime.register();
    await fixture.runtime.tickHeartbeat();

    // Worker claims the lease
    const claim = await fixture.client.assignment();
    expect(claim).toMatchObject({ outcome: "accepted", reply: { accepted: true } });
    if (claim.outcome !== "accepted" || !claim.reply.accepted) throw new Error("not claimed");

    const { leaseId } = claim.reply.lease;

    // Simulate controller restart: close HTTP server and close SQLite store
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    fixture.store.close();

    // Reopen store from the same directory
    const reopenedStore = openPlacementStore(fixture.controllerDir, controllerId);
    cleanupStores.push(reopenedStore);
    const reopenedPayloads = new PlacementPayloadSpool(fixture.controllerDir);
    const reopenedLeases = new PlacementLeaseService({
      hostId: controllerId,
      controller: { controllerId, epoch: 0 },
      store: reopenedStore,
      payloads: reopenedPayloads,
    });

    const record: WorkerAuthorization = {
      format: "botfleet-placement-worker",
      version: 1,
      credentialId: fixture.credentialId,
      revision: 1,
      hostId: workerId,
      audience: controllerId,
      role: "execution-worker",
      secretSha256: createHash("sha256").update(fixture.secret).digest("hex"),
      revoked: false,
      expiresAt: null,
    };

    const newBoundary = createWorkerRequestBoundary({
      audience: controllerId,
      source: { read: () => record },
      transport: createWorkerTransport(reopenedLeases),
      readBody: (req) =>
        new Promise((resolve, reject) => {
          const parts: Buffer[] = [];
          req.on("data", (part: Buffer) => parts.push(part));
          req.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        }),
    });

    const newServer = createServer((req, res) => {
      void newBoundary(req, res).catch(() => {
        res.destroy();
      });
    });
    cleanupServers.push(newServer);
    await new Promise<void>((resolve) => newServer.listen(0, "127.0.0.1", resolve));
    const { port: newPort } = z.object({ port: z.number() }).parse(newServer.address());

    // Switch proxy to target the new controller port
    await fixture.proxy.close();
    const newProxy = await startFaultProxy({ targetPort: newPort });
    cleanupProxies.push(newProxy);

    const newClient = new PlacementWorkerClient({
      credential: { credentialId: fixture.credentialId, secret: fixture.secret },
      workerHostId: workerId,
      audience: controllerId,
      controller: { controllerId, epoch: 0 },
      baseUrl: `http://127.0.0.1:${newProxy.port}/`,
      fetchImpl: nodeHttpWorkerLink(),
    });

    // Worker executes job and reports to the reopened controller
    const { done } = await spawnRealNonceJob(
      { jobId: "job-ctrl-restart", leaseId, command: `${process.execPath} ${nonceScript} ${fixture.nonceDir} ${nonce}` },
    );
    await done;

    const reportReply = await newClient.report({
      jobId: "job-ctrl-restart",
      leaseId,
      status: "completed",
      exitCode: 0,
      signal: null,
      endedAt: Date.now(),
    });

    expect(reportReply).toMatchObject({ outcome: "accepted", reply: { accepted: true } });
    expect(reopenedLeases.job("job-ctrl-restart")?.status).toBe("completed");
    expect(nonceRuns(fixture.nonceDir, nonce).length).toBe(1);
  });

  it("worker restart: orphan lease reconciled and reported cleanly on restart", async () => {
    const { leases, client, spool, runtime, workerDir } = await createFixture();

    leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-worker-restart",
      botId: "b",
      threadId: "t",
      cwd: workerDir,
      timeoutMs: 10_000,
      command: "printf test",
    });

    await runtime.register();
    await runtime.tickHeartbeat();

    // Pull assignment claims the job and persists lease to worker-leases.json
    const claim = await client.assignment();
    expect(claim).toMatchObject({ outcome: "accepted", reply: { accepted: true } });
    if (claim.outcome !== "accepted" || !claim.reply.accepted) throw new Error("not claimed");

    // Manually persist the local lease record as runtime does right before spawn
    const { lease } = claim.reply;
    const placementDir = join(workerDir, "placement");
    mkdirSync(placementDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(placementDir, "worker-leases.json"),
      JSON.stringify({
        [lease.jobId]: {
          jobId: lease.jobId,
          leaseId: lease.leaseId,
          controllerId: lease.controllerId,
          epoch: lease.epoch,
          command: "printf test",
          spawnedAt: Date.now(),
          pid: null,
        },
      }),
    );

    // A fresh worker runtime simulates a restarted worker process on the same data directory
    const restartedRuntime = new PlacementWorkerRuntime({
      client,
      spool,
      hostId: workerId,
      capabilities: ["shell"],
      dataDir: workerDir,
      sampleProvider: () => ({ ...sample, at: Date.now() }),
      admissionProvider: () => ({ admit: true }),
      spawnJob: async () => ({ pid: 1, done: Promise.resolve({ exitCode: 0, signal: null }) }),
      stopJob: async () => {},
      isProcessAlive: () => false, // Child process is dead across restart
    });

    // Reconcile orphan leases and settle reports with controller
    await restartedRuntime.reconcileRestart();

    // Terminal report for the dead orphan was spooled and settled
    expect(leases.job("job-worker-restart")?.status).toBe("lost");
    expect(spool.pending().length).toBe(0);
  });

  it("takeover & stale epoch refusal: old epoch rejected and worker converges to current fence", async () => {
    const fixture = await createFixture({ epoch: 0 });
    const { leases, client } = fixture;

    leases.enqueue({
      controllerId,
      epoch: 0,
      version: PLACEMENT_WIRE_VERSION,
      jobId: "job-takeover",
      botId: "b",
      threadId: "t",
      cwd: "/tmp",
      timeoutMs: 10_000,
      command: "echo test",
    });

    // Worker registers at epoch 0
    const reg = await client.register({ capabilities: ["shell"], sample: { ...sample, at: Date.now() } });
    expect(reg).toMatchObject({ outcome: "accepted" });

    // Controller takeover: epoch bumped to 1
    leases.takeover({ version: PLACEMENT_WIRE_VERSION, controllerId, epoch: 1, reconcile: false });

    // Worker client with old epoch 0 attempts assignment: refused with stale reason, adopts new epoch
    const staleAssignment = await client.assignment();
    expect(staleAssignment).toMatchObject({
      outcome: "refused",
      status: 200,
      reason: expect.stringMatching(/stale (?:controller|lease) epoch/),
    });
    expect(client.controller()).toEqual({ controllerId, epoch: 1 });

    // Worker client explicitly configured with stale epoch 0 attempts heartbeat: 409 conflict
    const staleClient = new PlacementWorkerClient({
      credential: { credentialId: fixture.credentialId, secret: fixture.secret },
      workerHostId: workerId,
      audience: controllerId,
      controller: { controllerId, epoch: 0 },
      baseUrl: `http://127.0.0.1:${fixture.proxy.port}/`,
      fetchImpl: nodeHttpWorkerLink(),
    });

    const staleHeartbeat = await staleClient.heartbeat({
      leases: [],
      admission: { admit: true },
      sample: { ...sample, at: Date.now() },
    });
    expect(staleHeartbeat).toMatchObject({
      outcome: "refused",
      status: 409,
      reason: expect.stringMatching(/stale (?:controller|lease) epoch/),
    });
    // Stale client converged to epoch 1 from the 409 response
    expect(staleClient.controller()).toEqual({ controllerId, epoch: 1 });
  });
});
