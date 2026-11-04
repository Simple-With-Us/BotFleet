// The placement contract:  the real worker client, through the real HTTP boundary,
// to the real lease service on a real SQLite store.  One process only;  the
// two-process proof is T6b.  Production passes no transport, so none of this is
// reachable there until T9.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type HostId } from "../shared/placement.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import { PlacementPayloadSpool } from "./placement-payloads.ts";
import { openPlacementStore, type PlacementStore } from "./placement-store.ts";
import { createWorkerRequestBoundary, type WorkerAuthorization } from "./placement-worker-auth.ts";
import { nodeHttpWorkerLink, PlacementWorkerClient } from "./placement-worker-client.ts";
import { createWorkerTransport } from "./placement-worker-routes.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const sample: CapacitySample = { at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null, memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null, diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null, dataVolume: null, rootDiskFreeBytes: null };
let store: PlacementStore | undefined; let server: Server | undefined; let dir = "";
afterEach(async () => {
  if (server) await new Promise((resolve) => { server?.close(resolve); });
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup(link: typeof fetch) {
  dir = mkdtempSync(join(tmpdir(), "bf-contract-"));
  store = openPlacementStore(dir, controllerId);
  const service = new PlacementLeaseService({ hostId: controllerId, controller: { controllerId, epoch: 0 }, store, payloads: new PlacementPayloadSpool(dir) });
  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const record: WorkerAuthorization = { format: "botfleet-placement-worker", version: 1, credentialId, revision: 1, hostId: workerId, audience: controllerId, role: "execution-worker", secretSha256: createHash("sha256").update(secret).digest("hex"), revoked: false, expiresAt: null };
  const boundary = createWorkerRequestBoundary({
    audience: controllerId, source: { read: () => record }, transport: createWorkerTransport(service),
    readBody: (req) => new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch (error) { reject(error); } });
    }),
  });
  server = createServer((req, res) => { void boundary(req, res); });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const client = new PlacementWorkerClient({ credential: { credentialId, secret }, workerHostId: workerId, audience: controllerId, controller: { controllerId, epoch: 0 }, baseUrl: `http://127.0.0.1:${port}/`, fetchImpl: link });
  return { service, client };
}

it("real client, real boundary, real lease service, over node:http", async () => {
  const { service, client } = await setup(nodeHttpWorkerLink());
  service.enqueue({ controllerId, epoch: 0, version: PLACEMENT_WIRE_VERSION, jobId: "job-1", botId: "b", threadId: "t", cwd: "/fixture", timeoutMs: 60_000, command: "printf ok" });
  expect(await client.register({ capabilities: ["shell"], sample })).toMatchObject({ outcome: "accepted" });
  expect(await client.heartbeat({ leases: [], admission: { admit: true }, sample })).toMatchObject({ outcome: "accepted" });
  const assigned = await client.assignment();
  expect(assigned).toMatchObject({ outcome: "accepted", reply: { accepted: true, lease: { jobId: "job-1", host: workerId } } });
  if (assigned.outcome !== "accepted" || !assigned.reply.accepted) throw new Error("no lease");
  const { leaseId } = assigned.reply.lease;
  const payload = await client.payload({ jobId: "job-1", leaseId });
  expect(payload).toMatchObject({ outcome: "accepted", reply: { command: "printf ok", cwd: "/fixture", timeoutMs: 60_000 } });
  expect(await client.stopReceipt({ jobId: "job-1", leaseId })).toMatchObject({ outcome: "accepted" });
  expect(await client.heartbeat({ leases: [leaseId], admission: { admit: true }, sample })).toMatchObject({ outcome: "accepted" });
  expect(await client.report({ jobId: "job-1", leaseId, status: "completed", exitCode: 0, signal: null, endedAt: 2000 })).toMatchObject({ outcome: "accepted" });
  // A report whose answer was lost is sent again and must not settle twice.
  expect(await client.report({ jobId: "job-1", leaseId, status: "completed", exitCode: 0, signal: null, endedAt: 2000 })).toMatchObject({ outcome: "accepted" });
  expect(service.job("job-1")?.status).toBe("completed");
});

// Node's fetch adds sec-fetch-mode, which the boundary treats as a browser.
it("real fetch is refused by the boundary", async () => {
  const { client } = await setup(fetch);
  const answer = await client.register({ capabilities: ["shell"], sample });
  expect(answer).toMatchObject({ outcome: "refused", status: 403 });
});
