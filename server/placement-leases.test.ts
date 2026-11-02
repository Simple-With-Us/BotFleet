import { describe, expect, it } from "vitest";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type HostId } from "../shared/placement.ts";
import { PlacementLeaseService, placementLeaseRoute } from "./placement-leases.ts";

const controllerId: HostId = "mac:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "server:22222222-2222-4222-8222-222222222222";
const otherController: HostId = "mac:33333333-3333-4333-8333-333333333333";
const fence = { version: PLACEMENT_WIRE_VERSION, controllerId, epoch: 0 };
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };
// SAFETY: the lease schemas only validate the sample's `at` field and the
// service never reads the sample; the assertion supplies the unread
// CapacitySample shape the message types require.
const sample = { at: 1 } as CapacitySample;

function service(nowValue = 1_000) {
  const now = { value: nowValue };
  return {
    now,
    leases: new PlacementLeaseService({
      hostId: controllerId,
      controller: { controllerId, epoch: 0 },
      now: () => now.value,
    }),
  };
}

describe("placement lease compare-and-set", () => {
  it("rejects an epoch-mismatched claim without touching the queue", () => {
    const { leases } = service();
    expect(leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample }).ok).toBe(true);
    expect(leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 }).ok).toBe(true);
    const stale = leases.claim({ ...fence, controllerId: otherController, hostId: workerId, jobId: "job-1" });
    expect(stale.ok).toBe(true);
    expect(stale.ok && stale.reply.accepted).toBe(false);
    expect(stale.ok && !stale.reply.accepted ? stale.reply.reason : "").toMatch(/stale controller/);
    expect(leases.job("job-1")?.status).toBe("queued");
  });

  it("enqueues idempotently: a replayed job id answers with the existing record", () => {
    const { leases } = service();
    const message = { ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 };
    const first = leases.enqueue(message);
    const second = leases.enqueue(message);
    expect(first.ok && first.reply.accepted).toBe(true);
    expect(second.ok && second.reply).toMatchObject({ accepted: true, duplicate: true, jobId: "job-1", status: "queued" });
    expect(leases.jobsList()).toHaveLength(1);
  });

  it("reports idempotently: the first report settles the job, a replay is acknowledged", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-1" });
    expect(claim.ok && claim.reply.accepted).toBe(true);
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";
    const report = { ...fence, jobId: "job-1", leaseId, hostId: workerId, status: "completed" as const, exitCode: 0, signal: null, endedAt: 2_000 };
    expect(leases.report(report).ok).toBe(true);
    const replay = leases.report(report);
    expect(replay.ok && replay.reply.accepted).toBe(true);
    expect(leases.job("job-1")?.status).toBe("completed");
    expect(leases.jobsList()).toHaveLength(1);
  });

  it("never re-dispatches a worker-unreachable job: the sweep marks, never requeues", () => {
    const { now, leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-1" });
    expect(claim.ok && claim.reply.accepted).toBe(true);
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";
    now.value += 60_000;
    expect(leases.sweepUnreachable()).toEqual(["job-1"]);
    expect(leases.job("job-1")?.status).toBe("worker-unreachable");
    // A second sweep changes nothing, and no new claim can take the job.
    expect(leases.sweepUnreachable()).toEqual([]);
    const reclaim = leases.claim({ ...fence, hostId: workerId, jobId: "job-1" });
    expect(reclaim.ok && reclaim.reply.accepted).toBe(false);
    expect(reclaim.ok && !reclaim.reply.accepted ? reclaim.reply.reason : "").toMatch(/never re-dispatched/);
    // The lease still belongs to the quiet worker; nothing was requeued.
    expect(leases.job("job-1")).toMatchObject({ status: "worker-unreachable", leaseId, host: workerId });
    expect(leases.jobsList()).toHaveLength(1);
  });

  it("refuses a claim from a host that cannot run the command", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-x", botId: "bot-a", threadId: "t", command: "xcodebuild -scheme App build", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-x" });
    expect(claim.ok && claim.reply.accepted).toBe(false);
    expect(claim.ok && !claim.reply.accepted ? claim.reply.reason : "").toMatch(/cannot run this job/);
  });
});

describe("placement lease route boundary", () => {
  it("keeps the owner gate and rejects malformed messages without a new credential type", () => {
    const { leases } = service();
    const register = { ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample };
    expect(placementLeaseRoute(owner, "register", register, leases).status).toBe(200);
    for (const caller of [
      { localOwner: false, fromCompanion: false, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: true, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: false, viaNamedTunnel: true },
    ]) expect(placementLeaseRoute(caller, "register", register, leases).status).toBe(403);
    expect(placementLeaseRoute(owner, "enqueue", { ...fence, jobId: "" }, leases).status).toBe(400);
  });
});
