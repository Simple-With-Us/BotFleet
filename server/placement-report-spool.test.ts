import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type HostId, type ReportMessage } from "../shared/placement.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import type { WorkerPrincipal } from "./placement-worker-auth.ts";
import { PlacementWorkerClient, type WorkerCredential } from "./placement-worker-client.ts";
import { PlacementReportSpool, PLACEMENT_REPORT_MAX_ATTEMPTS, settlePendingReports } from "./placement-report-spool.ts";

const audience: HostId = "server:11111111-1111-4111-8111-111111111111";
const worker: HostId = "mac:22222222-2222-4222-8222-222222222222";
const baseUrl = "http://127.0.0.1:8799";
const fence = { version: PLACEMENT_WIRE_VERSION, controllerId: audience, epoch: 0 };
const credential: WorkerCredential = {
  credentialId: "3f6b5a1e-2222-4222-8222-222222222222",
  secret: "aa".repeat(32),
};
const principal: WorkerPrincipal = { credentialId: credential.credentialId, hostId: worker, audience, role: "execution-worker" };
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

const dirs: string[] = [];
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bf-report-spool-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leaseFixture(nowValue = 1_000) {
  const now = { value: nowValue };
  const leases = new PlacementLeaseService({
    volatileForTests: true,
    hostId: audience,
    controller: { controllerId: audience, epoch: 0 },
    now: () => now.value,
  });
  return { now, leases };
}

/** The worker's lease on a claimed job, through the real lease book. */
function claimOneJob(leases: PlacementLeaseService) {
  const register = leases.register({ ...fence, hostId: worker, role: "worker", capabilities: ["shell"], sample });
  expect(register.ok && register.reply.accepted).toBe(true);
  const enqueue = leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
  expect(enqueue.ok && enqueue.reply.accepted).toBe(true);
  const claim = leases.claim({ ...fence, hostId: worker, jobId: "job-1" });
  if (!claim.ok || !claim.reply.accepted || !claim.reply.lease) throw new Error("fixture claim failed");
  return { jobId: "job-1", leaseId: claim.reply.lease.leaseId };
}

/** The reply fixture vocabulary: every field the fixture controller may
 *  return, named once so helpers take a domain type at their boundary. */
interface FixtureReply {
  error?: string;
  accepted?: boolean;
  reason?: string;
  controllerId?: string;
  epoch?: number;
  pendingStops?: string[];
  command?: string;
  payloadDigest?: string;
  jobId?: string;
  leaseId?: string;
}

function jsonResponse(status: number, body: FixtureReply): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The stripped worker body: the intent fields the client sends after the
 *  reserved envelope keys are removed, parsed once at the fixture boundary. */
const fixtureBodySchema = z.object({
  epoch: z.number().optional(),
  jobId: z.string().optional(),
  leaseId: z.string().optional(),
  status: z.enum(["completed", "failed", "killed", "lost"]).optional(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  endedAt: z.number().optional(),
  reason: z.string().optional(),
  leases: z.array(z.string()).optional(),
  admission: z.object({ admit: z.boolean(), reason: z.string().optional() }).strip().optional(),
}).strip();
type FixtureBody = z.infer<typeof fixtureBodySchema>;

/** The fixture controller builds each wire message field by field from the
 *  parsed body; a required field that is missing fails the fixture loudly
 *  instead of leaking a default into the lease book. */
function fixtureRegister(body: FixtureBody): Parameters<PlacementLeaseService["register"]>[0] {
  return {
    version: PLACEMENT_WIRE_VERSION,
    controllerId: audience,
    epoch: body.epoch ?? 0,
    hostId: principal.hostId,
    role: "worker",
    capabilities: ["shell"],
    sample,
  };
}

function fixtureHeartbeat(body: FixtureBody): Parameters<PlacementLeaseService["heartbeat"]>[0] {
  return {
    version: PLACEMENT_WIRE_VERSION,
    controllerId: audience,
    epoch: body.epoch ?? 0,
    hostId: principal.hostId,
    leases: body.leases ?? [],
    admission: body.admission ?? { admit: false, reason: "the fixture worker is not admitting work" },
    sample,
  };
}

function fixtureReport(body: FixtureBody): Parameters<PlacementLeaseService["report"]>[0] {
  if (body.jobId === undefined || body.leaseId === undefined || body.status === undefined || body.endedAt === undefined) {
    throw new Error("fixture report is missing a required field");
  }
  return {
    version: PLACEMENT_WIRE_VERSION,
    controllerId: audience,
    epoch: body.epoch ?? 0,
    jobId: body.jobId,
    leaseId: body.leaseId,
    hostId: principal.hostId,
    status: body.status,
    exitCode: body.exitCode ?? null,
    signal: body.signal ?? null,
    endedAt: body.endedAt,
    reason: body.reason,
  };
}

/** An in-process controller for one worker: the reserved envelope keys are
 *  checked the way the boundary must see them, the envelope keys are
 *  stripped, and the real placement lease service answers.
 *
 *  Finding recorded for the T2 route: #1565's workerEnvelopeMatches
 *  strict-parses the whole body, so a body that adds the fence and intent
 *  fields to the reserved envelope fails that check.  The plan requires
 *  bodies that keep the envelope and add the fence, so the worker route
 *  must check the reserved keys as a subset (as this helper does) or relax
 *  the strict parse when the routes land. */
function inProcessController(
  leases: PlacementLeaseService,
  options: { dropReportAck?: boolean } = {},
): typeof fetch {
  return async (url, init) => {
    const intent = String(url).split("/api/placement/worker/")[1] ?? "";
    const requestBody = z.record(z.string(), z.unknown()).safeParse(JSON.parse(String(init?.body ?? "{}")));
    if (!requestBody.success) return jsonResponse(403, { error: "Worker request refused" });
    const intentBody = fixtureBodySchema.safeParse(requestBody.data);
    if (!intentBody.success) return jsonResponse(403, { error: "Worker request refused" });
    const envelope = requestBody.data;
    const envelopeMatches = envelope.authVersion === "1" && envelope.hostId === worker && envelope.audience === audience && envelope.role === "execution-worker";
    if (!envelopeMatches) return jsonResponse(403, { error: "Worker request refused" });
    if (intent === "assignment" || intent === "payload" || intent === "stop-receipt") {
      return jsonResponse(503, { error: "Worker transport is not active" });
    }
    // The worker route registers this principal as a worker and builds the
    // wire messages from the verified credential: the host id comes from the
    // principal, never from a body field.  This is the T2 route's contract.
    const result = intent === "register" ? leases.register(fixtureRegister(intentBody.data))
      : intent === "heartbeat" ? leases.heartbeat(fixtureHeartbeat(intentBody.data))
      : leases.report(fixtureReport(intentBody.data));
    if (!result.ok) return jsonResponse(409, { error: result.reason, ...result.controller });
    if (intent === "report" && options.dropReportAck) {
      // The controller applied the report above, and the acknowledgement is
      // dropped on the way back: the work happened, the worker cannot know.
      throw new Error("connection reset before the acknowledgement arrived");
    }
    return jsonResponse(200, { ...result.reply });
  };
}

function client(leases: PlacementLeaseService, options: { dropReportAck?: boolean } = {}): PlacementWorkerClient {
  return new PlacementWorkerClient({
    credential, workerHostId: worker, audience,
    controller: { controllerId: audience, epoch: 0 },
    baseUrl,
    fetchImpl: inProcessController(leases, options),
  });
}

function terminalMessage(leaseId: string, endedAt = 1_005, jobId = "job-1"): ReportMessage {
  return { ...fence, jobId, leaseId, hostId: worker, status: "completed", exitCode: 0, signal: null, endedAt };
}

describe("report spool durability", () => {
  it("a row is durable on disk before add returns and a fresh instance reads it back", () => {
    const dir = fixtureDir();
    const spool = new PlacementReportSpool(dir);
    expect(spool.add(terminalMessage("lease-1"))).toBe(true);
    // The row must already be on disk: a crash right after add() replays it.
    // A fresh instance over the same data directory sees exactly that row.
    const fresh = new PlacementReportSpool(dir);
    expect(fresh.pending()).toHaveLength(1);
    expect(fresh.pending()[0]?.message.jobId).toBe("job-1");
    expect(fresh.has("job-1")).toBe(true);
  });

  it("an identical row is already pending; a different result for the same job is a conflict", () => {
    const dir = fixtureDir();
    const spool = new PlacementReportSpool(dir);
    expect(spool.add(terminalMessage("lease-1"))).toBe(true);
    expect(spool.add(terminalMessage("lease-1"))).toBe(false);
    expect(spool.pending()).toHaveLength(1);
    expect(() => spool.add(terminalMessage("lease-1", 9_999))).toThrow(/already durable/);
    expect(() => spool.add(terminalMessage("lease-2", 1_005, "job-2"))).not.toThrow();
  });

  it("a damaged row is skipped from delivery and counted, never crashed on", () => {
    const dir = fixtureDir();
    const spool = new PlacementReportSpool(dir);
    spool.add(terminalMessage("lease-1"));
    writeFileSync(join(dir, "placement", "reports", "report-" + "0".repeat(32) + ".json"), "{ truncated", { mode: 0o600 });
    const rowsAfter = spool.pending();
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.message.jobId).toBe("job-1");
    expect(spool.damaged()).toBe(1);
  });

  it("failures are counted per row and bounded, and remove is idempotent", async () => {
    const dir = fixtureDir();
    const spool = new PlacementReportSpool(dir);
    spool.add(terminalMessage("lease-1"));
    expect(spool.recordFailure("job-1")).toBe(1);
    expect(spool.pending()[0]?.attempts).toBe(1);
    spool.remove("job-1");
    spool.remove("job-1");
    expect(spool.has("job-1")).toBe(false);
    expect(() => spool.recordFailure("job-1")).toThrow(/no pending terminal report/);
  });
});

describe("settle-once against the in-process lease service", () => {
  it("a dropped acknowledgement then replay settles the terminal result exactly once", async () => {
    const dir = fixtureDir();
    const { leases } = leaseFixture();
    const { leaseId } = claimOneJob(leases);
    const spool = new PlacementReportSpool(dir);
    const message = terminalMessage(leaseId);
    expect(spool.add(message)).toBe(true);

    // First delivery: the controller applies the report, then the
    // acknowledgement is dropped on the way back.
    const first = await settlePendingReports(spool, client(leases, { dropReportAck: true }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ jobId: "job-1", result: "kept" });
    expect(first[0]?.attempts).toBe(1);
    // The controller's lease book already holds the terminal result.
    const applied = leases.job("job-1");
    expect(applied?.status).toBe("completed");
    expect(applied?.report).toEqual({ status: "completed", exitCode: 0, signal: null, endedAt: 1_005 });

    // Restart: a fresh spool and client over the same data directory replay
    // the identical row, the lease book answers it idempotently, and the
    // settled result is unchanged by the replay.
    const freshSpool = new PlacementReportSpool(dir);
    expect(freshSpool.pending()).toHaveLength(1);
    const second = await settlePendingReports(freshSpool, client(leases));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ jobId: "job-1", result: "settled" });
    expect(freshSpool.pending()).toHaveLength(0);
    expect(freshSpool.damaged()).toBe(0);
    const settled = leases.job("job-1");
    expect(settled?.status).toBe("completed");
    expect(settled?.report).toEqual({ status: "completed", exitCode: 0, signal: null, endedAt: 1_005 });
    // And the lease history settled exactly once: a replay of the identical
    // report is accepted and applies nothing twice.
    const replay = leases.report(message);
    expect(replay.ok && replay.reply.accepted).toBe(true);
    expect(leases.job("job-1")?.report).toEqual({ status: "completed", exitCode: 0, signal: null, endedAt: 1_005 });
  });

  it("a stale-epoch refusal keeps the row without burning an attempt", async () => {
    const dir = fixtureDir();
    const { leases } = leaseFixture();
    const { leaseId } = claimOneJob(leases);
    const spool = new PlacementReportSpool(dir);
    spool.add(terminalMessage(leaseId));
    // A takeover moved the controller to epoch 4 before the report arrives.
    const takeover = leases.takeover({ ...fence, controllerId: audience, epoch: 4, reconcile: false });
    expect(takeover.ok && takeover.reply.accepted).toBe(true);
    const outcomes = await settlePendingReports(spool, client(leases));
    expect(outcomes[0]).toMatchObject({ jobId: "job-1", result: "kept", attempts: 0 });
    expect(spool.pending()).toHaveLength(1);
    expect(spool.pending()[0]?.attempts).toBe(0);
  });

  it("rows past the attempt cap are exhausted and left in place", async () => {
    const dir = fixtureDir();
    const { leases } = leaseFixture();
    const { leaseId } = claimOneJob(leases);
    const spool = new PlacementReportSpool(dir);
    spool.add(terminalMessage(leaseId));
    for (let attempt = 0; attempt < PLACEMENT_REPORT_MAX_ATTEMPTS; attempt += 1) spool.recordFailure("job-1");
    const outcomes = await settlePendingReports(spool, client(leases));
    expect(outcomes[0]).toMatchObject({ jobId: "job-1", result: "exhausted", attempts: PLACEMENT_REPORT_MAX_ATTEMPTS });
    expect(spool.has("job-1")).toBe(true);
  });

  it("an inactive transport keeps every row without accounting attempts", async () => {
    const dir = fixtureDir();
    const { leases } = leaseFixture();
    const { leaseId } = claimOneJob(leases);
    const spool = new PlacementReportSpool(dir);
    spool.add(terminalMessage(leaseId));
    const inactive = new PlacementWorkerClient({
      credential, workerHostId: worker, audience,
      controller: { controllerId: audience, epoch: 0 }, baseUrl,
      fetchImpl: async () => jsonResponse(503, { error: "Worker transport is not active" }),
    });
    const outcomes = await settlePendingReports(spool, inactive);
    expect(outcomes[0]).toMatchObject({ jobId: "job-1", result: "kept", attempts: 0 });
    expect(spool.has("job-1")).toBe(true);
    expect(spool.pending()[0]?.attempts).toBe(0);
  });
});
