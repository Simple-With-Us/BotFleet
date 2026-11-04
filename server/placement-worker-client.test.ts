import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type HostId } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";
import { createWorkerRequestBoundary, privateWorkerAuthorizationSource, type WorkerAuthorization } from "./placement-worker-auth.ts";
import { nodeHttpWorkerLink, PlacementWorkerClient, workerAuthorizationHeader, type WorkerCredential } from "./placement-worker-client.ts";

const audience: HostId = "server:11111111-1111-4111-8111-111111111111";
const worker: HostId = "mac:22222222-2222-4222-8222-222222222222";
const baseUrl = "http://127.0.0.1:8799";
const credential: WorkerCredential = {
  credentialId: "3f6b5a1e-2222-4222-8222-222222222222",
  secret: "aa".repeat(32),
};
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

const parsedBody = z.record(z.string(), z.unknown());

interface ObservedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: z.infer<typeof parsedBody>;
}

/** The reply fixture vocabulary: every field the scripted link may return. */
interface FixtureReply {
  error?: string;
  accepted?: boolean;
  reason?: string;
  controllerId?: string;
  epoch?: number;
  pendingStops?: string[];
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  jobId?: string;
  leaseId?: string;
  lease?: { controllerId: string; epoch: number; leaseId: string; jobId: string; host: string };
}

function jsonResponse(status: number, body: FixtureReply): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}


/** A fake link that records the exact request and answers from a script. */
function scriptedLink(respond: (observed: ObservedRequest) => Response) {
  const requests: ObservedRequest[] = [];
  const client = new PlacementWorkerClient({
    credential,
    workerHostId: worker,
    audience,
    controller: { controllerId: audience, epoch: 0 },
    baseUrl,
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of new Headers(init?.headers)) headers[name.toLowerCase()] = value;
      const observed: ObservedRequest = {
        url: String(url),
        method: init?.method ?? "GET",
        headers,
        body: parsedBody.parse(JSON.parse(String(init?.body ?? "{}"))),
      };
      requests.push(observed);
      return respond(observed);
    },
  });
  return { client, requests };
}

describe("worker client request shape", () => {
  it("posts the envelope, the fence and the credential on the intent route", async () => {
    const { client, requests } = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 0, accepted: true }));
    const reply = await client.register({ capabilities: ["shell"], sample });
    expect(reply.outcome).toBe("accepted");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`${baseUrl}/api/placement/worker/register`);
    expect(request.method).toBe("POST");
    expect(request.headers["authorization"]).toBe(workerAuthorizationHeader(credential));
    expect(request.headers["content-type"]).toBe("application/json; charset=utf-8");
    // The reserved envelope matches #1565's shape, and the fence carries the
    // wire version with the believed controller pair.
    expect(request.body.authVersion).toBe("1");
    expect(request.body.hostId).toBe(worker);
    expect(request.body.audience).toBe(audience);
    expect(request.body.role).toBe("execution-worker");
    expect(request.body.controllerId).toBe(audience);
    expect(request.body.epoch).toBe(0);
    expect(request.body.version).toBe(PLACEMENT_WIRE_VERSION);
    // classifyWorkerRequest refuses duplicate or forbidden headers, so the
    // client sends none of them in the first place.
    expect(Object.keys(request.headers).sort()).toEqual(["authorization", "content-type"]);
  });

  it("carries no per-intent identity: the envelope is the only host id a body has", async () => {
    const { client, requests } = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 0, accepted: true }));
    const reply = await client.report({ jobId: "job-1", leaseId: "lease-1", status: "completed", exitCode: 0, signal: null, endedAt: 5 });
    expect(reply.outcome).toBe("accepted");
    expect(requests[0]?.url).toBe(`${baseUrl}/api/placement/worker/report`);
    // The worker route builds the wire message from the verified credential,
    // so the intent fields name no host and no role; the reserved envelope
    // keys are the only identity the body carries.
    expect(Object.keys(requests[0]?.body ?? {}).sort()).toEqual([
      "audience", "authVersion", "controllerId", "endedAt", "epoch", "exitCode", "hostId", "jobId", "leaseId", "role", "signal", "status", "version",
    ]);
    expect(requests[0]?.body.hostId).toBe(worker);
  });

  it("rejects a malformed credential or host id at construction", () => {
    // SAFETY: the runtime constructor check under test is what validates the
    // host id shape; the assertion only lets a runtime-invalid value reach it.
    const badHost = "not-a-host".slice(0) as HostId;
    expect(() => new PlacementWorkerClient({
      credential: { credentialId: "not-a-uuid", secret: credential.secret },
      workerHostId: worker, audience, controller: { controllerId: audience, epoch: 0 }, baseUrl,
      fetchImpl: async () => jsonResponse(200, {}),
    })).toThrow(TypeError);
    expect(() => new PlacementWorkerClient({
      credential,
      workerHostId: badHost, audience, controller: { controllerId: audience, epoch: 0 }, baseUrl,
      fetchImpl: async () => jsonResponse(200, {}),
    })).toThrow(TypeError);
    expect(() => new PlacementWorkerClient({
      credential, workerHostId: worker, audience, controller: { controllerId: audience, epoch: 0 },
      baseUrl: "ftp://127.0.0.1:8799",
      fetchImpl: async () => jsonResponse(200, {}),
    })).toThrow(TypeError);
  });
});

describe("worker client reply handling", () => {
  it("parses a heartbeat and adopts the controller pair it carries", async () => {
    const { client } = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 7, pendingStops: ["lease-9"] }));
    const reply = await client.heartbeat({ leases: ["lease-1"], admission: { admit: true }, sample });
    expect(reply.outcome).toBe("accepted");
    expect(reply.outcome === "accepted" && reply.reply.pendingStops).toEqual(["lease-9"]);
    expect(client.controller()).toEqual({ controllerId: audience, epoch: 7 });
  });

  it("surfaces an accepted:false reply as refused with its reason", async () => {
    const { client } = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 0, accepted: false, reason: "no queued job job-1 on this controller" }));
    const reply = await client.assignment();
    expect(reply).toMatchObject({ outcome: "refused", status: 200, reason: "no queued job job-1 on this controller" });
  });

  it("adopts a strictly newer epoch from a refusal so the worker converges after a takeover", async () => {
    const { client } = scriptedLink(() => jsonResponse(409, { controllerId: audience, epoch: 12, error: "stale controller epoch 0; the controller is here at epoch 12" }));
    const reply = await client.report({ jobId: "job-1", leaseId: "lease-1", status: "completed", exitCode: 0, signal: null, endedAt: 5 });
    expect(reply.outcome).toBe("refused");
    expect(client.controller()).toEqual({ controllerId: audience, epoch: 12 });
  });

  it("never adopts an older or equal-but-different controller pair", async () => {
    const takeover: HostId = "server:99999999-9999-4999-8999-999999999999";
    const started = new PlacementWorkerClient({
      credential, workerHostId: worker, audience,
      controller: { controllerId: audience, epoch: 12 }, baseUrl,
      fetchImpl: async () => jsonResponse(409, { controllerId: takeover, epoch: 0, error: "stale" }),
    });
    await started.report({ jobId: "job-1", leaseId: "lease-1", status: "completed", exitCode: 0, signal: null, endedAt: 5 });
    // A same-epoch different controller or an older epoch is never adopted
    // from a refusal: the believed pair stays the pair this worker trusts.
    expect(started.controller()).toEqual({ controllerId: audience, epoch: 12 });
  });

  it("classifies a 503 as inactive and other statuses as refused", async () => {
    const inactive = scriptedLink(() => jsonResponse(503, { error: "Worker transport is not active" }));
    const reply = await inactive.client.register({ capabilities: ["shell"], sample });
    expect(reply).toMatchObject({ outcome: "inactive", reason: "Worker transport is not active" });
    const refused = scriptedLink(() => jsonResponse(403, { error: "Worker request refused" }));
    const other = await refused.client.register({ capabilities: ["shell"], sample });
    expect(other).toMatchObject({ outcome: "refused", status: 403, reason: "Worker request refused" });
  });

  it("fails the link on a transport error, a non-JSON reply and a reply that is not the wire shape", async () => {
    const thrown = new PlacementWorkerClient({
      credential, workerHostId: worker, audience, controller: { controllerId: audience, epoch: 0 }, baseUrl,
      fetchImpl: async () => { throw new Error("connection reset"); },
    });
    const thrownReply = await thrown.report({ jobId: "j", leaseId: "l", status: "completed", exitCode: 0, signal: null, endedAt: 5 });
    expect(thrownReply.outcome).toBe("link-failed");
    const nonJson = new PlacementWorkerClient({
      credential, workerHostId: worker, audience, controller: { controllerId: audience, epoch: 0 }, baseUrl,
      fetchImpl: async () => new Response("<html>", { status: 200 }),
    });
    const nonJsonReply = await nonJson.report({ jobId: "j", leaseId: "l", status: "completed", exitCode: 0, signal: null, endedAt: 5 });
    expect(nonJsonReply.outcome).toBe("link-failed");
    const wrongWire = scriptedLink(() => jsonResponse(200, { accepted: true }));
    const wrongWireReply = await wrongWire.client.heartbeat({ leases: [], admission: { admit: true }, sample });
    expect(wrongWireReply.outcome).toBe("link-failed");
  });

  it("parses the payload and stop-receipt reply shapes the plan names", async () => {
    const payload = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 0, accepted: true, command: "true", cwd: "/tmp", timeoutMs: 60_000 }));
    const payloadReply = await payload.client.payload({ jobId: "job-1", leaseId: "lease-1" });
    expect(payloadReply.outcome === "accepted" && payloadReply.reply.command).toBe("true");
    expect(payloadReply.outcome === "accepted" && payloadReply.reply.cwd).toBe("/tmp");
    expect(payloadReply.outcome === "accepted" && payloadReply.reply.timeoutMs).toBe(60_000);
    expect(payload.requests[0]?.url).toBe(`${baseUrl}/api/placement/worker/payload`);
    const receipt = scriptedLink(() => jsonResponse(200, { controllerId: audience, epoch: 0, accepted: true, jobId: "job-1", leaseId: "lease-1" }));
    const receiptReply = await receipt.client.stopReceipt({ jobId: "job-1", leaseId: "lease-1" });
    expect(receiptReply.outcome === "accepted" && receiptReply.reply.jobId).toBe("job-1");
    expect(receipt.requests[0]?.url).toBe(`${baseUrl}/api/placement/worker/stop-receipt`);
  });

  it("gets through the real boundary over the real node:http link", async () => {
    // The whole chain is real here: the node:http link builds the request,
    // #1565's createWorkerRequestBoundary classifies and verifies it, and
    // the boundary's own 503 answer is what the client parses.  A standard
    // fetch would fail this chain before the credential is read, because it
    // injects sec-fetch-mode and the boundary refuses every sec-* header.
    const dir = mkdtempSync(join(tmpdir(), "bf-worker-link-"));
    const parent = join(dir, "placement-worker-authorizations");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const record: WorkerAuthorization = {
      format: "botfleet-placement-worker", version: 1, credentialId: credential.credentialId, revision: 1,
      hostId: worker, audience, role: "execution-worker",
      secretSha256: createHash("sha256").update(credential.secret).digest("hex"),
      revoked: false, expiresAt: null,
    };
    writeFileAtomic(join(parent, `${record.credentialId}.json`), JSON.stringify(record), { mode: 0o600, exactMode: true });
    const boundary = createWorkerRequestBoundary({
      audience,
      source: privateWorkerAuthorizationSource(dir),
      readBody: (req) => new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("error", reject);
        req.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (error) { reject(error); }
        });
      }),
    });
    const server = createServer((req, res) => { void boundary(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: the listen callback above resolved, so the address is the
    // listening IPv4 address and its port is the one to dial.
    const port = (server.address() as { port: number }).port;
    const live = new PlacementWorkerClient({
      credential, workerHostId: worker, audience,
      controller: { controllerId: audience, epoch: 0 },
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: nodeHttpWorkerLink(),
    });
    try {
      // A request whose body is exactly the reserved envelope gets through
      // the whole chain over the real link: the boundary classifies it,
      // verifies the credential against the private source, and answers its
      // own 503, which is not the 403 an unclassified request would draw.
      const envelopeOnly = await nodeHttpWorkerLink()(`http://127.0.0.1:${port}/api/placement/worker/register`, {
        method: "POST",
        headers: { "authorization": workerAuthorizationHeader(credential), "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ authVersion: "1", hostId: worker, audience, role: "execution-worker" }),
      });
      expect(envelopeOnly.status).toBe(503);
      expect(await envelopeOnly.json()).toEqual({ error: "Worker transport is not active" });
      // A wrong secret is refused by the boundary itself.
      const impostor = new PlacementWorkerClient({
        credential: { credentialId: credential.credentialId, secret: "bb".repeat(32) },
        workerHostId: worker, audience,
        controller: { controllerId: audience, epoch: 0 },
        baseUrl: `http://127.0.0.1:${port}`,
        fetchImpl: nodeHttpWorkerLink(),
      });
      const refused = await impostor.register({ capabilities: ["shell"], sample });
      expect(refused).toMatchObject({ outcome: "refused", status: 403, reason: "Worker request refused" });
      // The client's real body adds the fence and intent fields to the
      // envelope, and #1565's strict whole-body envelope parse refuses that
      // today; #1577 changes the check to the reserved-key subset this
      // slice's plan requires, and this assertion is where it lands.
      const enriched = await live.register({ capabilities: ["shell"], sample });
      expect(enriched).toMatchObject({ outcome: "refused", status: 403, reason: "Worker request refused" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
