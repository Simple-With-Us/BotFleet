import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type ControllerEpoch, type HostId } from "../shared/placement.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import { PlacementPayloadSpool } from "./placement-payloads.ts";
import { openPlacementStore, type PlacementStore } from "./placement-store.ts";
import { createWorkerRequestBoundary, type WorkerAuthorization } from "./placement-worker-auth.ts";
import { createWorkerTransport } from "./placement-worker-routes.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const otherId: HostId = "mac:33333333-3333-4333-8333-333333333333";
const initial: ControllerEpoch = { controllerId, epoch: 0 };
const fence = { ...initial, version: PLACEMENT_WIRE_VERSION };
const sample: CapacitySample = {
  at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null,
  memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null,
  diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null, dataVolume: null, rootDiskFreeBytes: null,
};
const replySchema = z.record(z.string(), z.json());
type Reply = z.infer<typeof replySchema>;
const dirs: string[] = [];
const stores: PlacementStore[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => { server.close(resolve); });
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function controller(dir = mkdtempSync(join(tmpdir(), "bf-worker-routes-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = openPlacementStore(dir, controllerId);
  stores.push(store);
  const clock = { now: 1000 };
  const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads: new PlacementPayloadSpool(dir), now: () => clock.now });
  return { dir, store, service, clock };
}

function credentialFor(hostId: HostId) {
  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const record: WorkerAuthorization = { format: "botfleet-placement-worker", version: 1, credentialId, revision: 1, hostId, audience: controllerId, role: "execution-worker", secretSha256: createHash("sha256").update(secret).digest("hex"), revoked: false, expiresAt: null };
  return { record, authorization: `BotFleet-Worker bfw1.${credentialId}.${secret}` };
}

/** The real worker boundary over real HTTP, with credentials from memory. */
async function harness(service: PlacementLeaseService | null, hosts: readonly HostId[] = [workerId, otherId]) {
  const credentials = new Map(hosts.map((hostId) => [hostId, credentialFor(hostId)]));
  const boundary = createWorkerRequestBoundary({
    audience: controllerId,
    source: { read: (id) => {
      const found = [...credentials.values()].find((entry) => entry.record.credentialId === id);
      if (!found) throw new Error("unknown credential");
      return found.record;
    } },
    readBody: (req) => new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch (error) { reject(error); } });
    }),
    transport: service ? createWorkerTransport(service) : undefined,
  });
  const server = createServer((req, res) => {
    void boundary(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const send = async <Message>(intent: string, message: Message, hostId: HostId = workerId, envelopeHost: HostId = hostId) => {
    const credential = credentials.get(hostId);
    if (!credential) throw new Error("fixture host has no credential");
    // Not fetch:  it adds a sec-fetch-mode header, and the boundary refuses every sec-* header.
    return new Promise<{ status: number; body: Reply }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port, method: "POST", path: `/api/placement/worker/${intent}`, agent: false,
        headers: { authorization: credential.authorization, "content-type": "application/json" },
      }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: replySchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8"))) }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ authVersion: "1", hostId: envelopeHost, audience: controllerId, role: "execution-worker", message }));
    });
  };
  return { send };
}

const job = (jobId = "job-1", command = "printf 'fixture-payload'") => ({ ...fence, jobId, botId: "bot-a", threadId: "thread-a", cwd: "/fixture", timeoutMs: 60_000, command });
const register = (hostId: HostId = workerId) => ({ ...fence, hostId, role: "worker", capabilities: ["shell"], sample });
const heartbeat = (leases: string[] = [], hostId: HostId = workerId, admit = true) => ({ ...fence, hostId, leases, admission: { admit }, sample });
const report = (leaseId: string, jobId = "job-1") => ({ ...fence, jobId, leaseId, hostId: workerId, status: "completed", exitCode: 0, signal: null, endedAt: 2000 });
async function enrolled(send: Awaited<ReturnType<typeof harness>>["send"], hostId: HostId = workerId) {
  expect((await send("register", register(hostId), hostId)).body).toMatchObject({ accepted: true });
  expect((await send("heartbeat", heartbeat([], hostId), hostId)).status).toBe(200);
}
const leaseIdOf = (body: Reply) =>z.object({ lease: z.object({ leaseId: z.string() }) }).parse(body).lease.leaseId;

describe("placement worker routes", () => {
  it("still answers 503 for a valid envelope when no transport is passed", async () => {
    const { send } = await harness(null);
    const answer = await send("register", register());
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: "Worker transport is not active" });
  });

  it("runs one job from assignment to report", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    const assigned = await send("assignment", fence);
    expect(assigned.body).toMatchObject({ accepted: true, lease: { jobId: "job-1", host: workerId } });
    const leaseId = leaseIdOf(assigned.body);
    expect((await send("payload", { ...fence, jobId: "job-1", leaseId })).body)
      .toMatchObject({ accepted: true, command: "printf 'fixture-payload'", cwd: "/fixture", timeoutMs: 60_000 });
    await send("heartbeat", heartbeat([leaseId]));
    expect(service.job("job-1")?.status).toBe("running");
    expect((await send("report", report(leaseId))).body).toMatchObject({ accepted: true });
    expect(service.job("job-1")?.status).toBe("completed");
  });

  it("replays the same lease after a lost acknowledgement, and never issues a second", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    const first = leaseIdOf((await send("assignment", fence)).body);
    expect(leaseIdOf((await send("assignment", fence)).body)).toBe(first);
    expect(service.jobsList().filter((entry) => entry.leaseId === first)).toHaveLength(1);
  });

  it("replays the same lease from a restarted controller", async () => {
    const before = controller();
    const { send } = await harness(before.service);
    before.service.enqueue(job());
    await enrolled(send);
    const first = leaseIdOf((await send("assignment", fence)).body);
    const after = controller(before.dir);
    const restarted = await harness(after.service);
    await enrolled(restarted.send);
    expect(leaseIdOf((await restarted.send("assignment", fence)).body)).toBe(first);
    expect((await restarted.send("payload", { ...fence, jobId: "job-1", leaseId: first })).body).toMatchObject({ accepted: true });
  });

  it("settles a replayed report once", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    const leaseId = leaseIdOf((await send("assignment", fence)).body);
    expect((await send("report", report(leaseId))).body).toMatchObject({ accepted: true });
    expect((await send("report", report(leaseId))).body).toMatchObject({ accepted: true });
    expect(service.job("job-1")?.report?.endedAt).toBe(2000);
    expect((await send("report", { ...report(leaseId), endedAt: 3000 })).body).toMatchObject({ accepted: false });
  });

  it("gives the oldest eligible job first, and a second host cannot take a held one", async () => {
    const { service, clock } = controller();
    const { send } = await harness(service);
    service.enqueue(job("job-b"));
    clock.now = 2000;
    service.enqueue(job("job-a"));
    await enrolled(send);
    await enrolled(send, otherId);
    const firstHost = await send("assignment", fence);
    expect(firstHost.body).toMatchObject({ lease: { jobId: "job-b", host: workerId } });
    const secondHost = await send("assignment", fence, otherId);
    expect(secondHost.body).toMatchObject({ lease: { jobId: "job-a", host: otherId } });
    expect((await send("assignment", fence, otherId)).body).toMatchObject({ lease: { jobId: "job-a" } });
  });

  it("skips a job this host cannot run, and answers when nothing is eligible", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    await enrolled(send);
    expect((await send("assignment", fence)).body).toMatchObject({ accepted: false, reason: "no job is eligible for this host" });
    service.enqueue(job("needs-mac", "xcodebuild -version"));
    service.enqueue(job("plain"));
    expect((await send("assignment", fence)).body).toMatchObject({ lease: { jobId: "plain" } });
  });

  it("holds work back from a worker that is not admitting", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await send("register", register());
    await send("heartbeat", heartbeat([], workerId, false));
    expect((await send("assignment", fence)).body).toMatchObject({ accepted: false });
    expect(service.job("job-1")?.status).toBe("queued");
  });

  it("refuses a stale epoch and names the current pair", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    const leaseId = leaseIdOf((await send("assignment", fence)).body);
    service.takeover({ ...fence, epoch: 5, reconcile: false });
    const current = { controllerId, epoch: 5 };
    expect((await send("assignment", fence)).body).toMatchObject({ accepted: false, ...current });
    expect((await send("payload", { ...fence, jobId: "job-1", leaseId })).body).toMatchObject({ accepted: false, ...current });
    expect((await send("stop-receipt", { ...fence, jobId: "job-1", leaseId })).body).toMatchObject({ accepted: false, ...current });
    expect((await send("heartbeat", heartbeat([leaseId]))).status).toBe(409);
  });

  it("never lets one host read or settle another host's lease", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    await enrolled(send, otherId);
    const leaseId = leaseIdOf((await send("assignment", fence)).body);
    expect((await send("payload", { ...fence, jobId: "job-1", leaseId }, otherId)).body).toMatchObject({ accepted: false });
    expect(JSON.stringify((await send("payload", { ...fence, jobId: "job-1", leaseId }, otherId)).body)).not.toContain("fixture-payload");
    expect((await send("stop-receipt", { ...fence, jobId: "job-1", leaseId }, otherId)).body).toMatchObject({ accepted: false });
    expect((await send("report", { ...report(leaseId), hostId: otherId }, otherId)).body).toMatchObject({ accepted: false });
    expect(service.job("job-1")?.status).toBe("dispatching");
  });

  it("refuses a body that names another host, and a worker claiming the controller role", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    expect((await send("register", register(otherId))).status).toBe(403);
    expect((await send("register", { ...register(), role: "controller" })).status).toBe(403);
    expect((await send("heartbeat", heartbeat([], otherId))).status).toBe(403);
    expect((await send("report", { ...report("lease-x"), hostId: otherId })).status).toBe(403);
    expect((await send("register", register(), workerId, otherId)).status).toBe(403);
  });

  it("does not let assignment or payload name a host at all", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    expect((await send("assignment", { ...fence, hostId: otherId })).status).toBe(400);
    expect((await send("payload", { ...fence, hostId: otherId, jobId: "j", leaseId: "l" })).status).toBe(400);
  });

  it("answers 400 for a malformed message", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    for (const intent of ["register", "heartbeat", "assignment", "payload", "report", "stop-receipt"]) {
      expect((await send(intent, { nonsense: true })).status, intent).toBe(400);
    }
  });

  it("acknowledges a delivered stop without settling the lease", async () => {
    const { service } = controller();
    const { send } = await harness(service);
    service.enqueue(job());
    await enrolled(send);
    const leaseId = leaseIdOf((await send("assignment", fence)).body);
    service.stop({ ...fence, jobId: "job-1", leaseId, reason: "owner stop" });
    expect((await send("heartbeat", heartbeat([leaseId]))).body).toMatchObject({ pendingStops: [leaseId] });
    expect((await send("stop-receipt", { ...fence, jobId: "job-1", leaseId })).body).toMatchObject({ accepted: true });
    expect((await send("heartbeat", heartbeat([leaseId]))).body).toMatchObject({ pendingStops: [leaseId] });
    await send("report", { ...report(leaseId), status: "killed", exitCode: null, signal: "SIGTERM" });
    expect((await send("heartbeat", heartbeat([]))).body).toMatchObject({ pendingStops: [] });
  });
});
