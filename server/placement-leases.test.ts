import { describe, expect, it } from "vitest";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type HostId } from "../shared/placement.ts";
import { PlacementLeaseService, placementLeaseRoute } from "./placement-leases.ts";

const controllerId: HostId = "mac:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "server:22222222-2222-4222-8222-222222222222";
const otherController: HostId = "mac:33333333-3333-4333-8333-333333333333";
const fence = { version: PLACEMENT_WIRE_VERSION, controllerId, epoch: 0 };
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };
// A complete capacity sample: the route parses it strictly, so the helper
// carries every field the wire shape requires.  The service never reads it.
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

  it("refuses a higher epoch instead of adopting it, keeping its own pair", () => {
    const { leases } = service();
    expect(leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample }).ok).toBe(true);
    expect(leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 }).ok).toBe(true);
    const bumped = leases.claim({ ...fence, epoch: 7, controllerId: workerId, hostId: workerId, jobId: "job-1" });
    expect(bumped.ok && bumped.reply.accepted).toBe(false);
    expect(bumped.ok && !bumped.reply.accepted ? bumped.reply.reason : "").toMatch(/stale controller/);
    // The fence never adopted the bumped pair: the controller is untouched
    // and the job is still queued for the real controller.
    expect(leases.controller()).toEqual({ controllerId, epoch: 0 });
    expect(leases.job("job-1")?.status).toBe("queued");
  });

  it("rejects a replayed job id with a different payload as a conflict", () => {
    const { leases } = service();
    const message = { ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 };
    expect(leases.enqueue(message).ok).toBe(true);
    const conflict = leases.enqueue({ ...message, command: "rm -rf /tmp/other" });
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok ? conflict.reason : "").toMatch(/different payload/);
    // The stored job is untouched: the conflicting command was never queued.
    expect(leases.job("job-1")).toMatchObject({ command: "true", status: "queued" });
    expect(placementLeaseRoute(owner, "enqueue", { ...message, command: "other" }, leases).status).toBe(409);
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

  it("binds a report to the holding host and the full result, not the lease id alone", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-1", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-1" });
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";
    // A different host holding a leaked lease id settles nothing.
    const foreign = leases.report({ ...fence, jobId: "job-1", leaseId, hostId: otherController, status: "completed" as const, exitCode: 0, signal: null, endedAt: 2_000 });
    expect(foreign.ok && foreign.reply.accepted).toBe(false);
    expect(leases.job("job-1")?.status).toBe("dispatching");
    // The holding host's report settles the job.
    const report = { ...fence, jobId: "job-1", leaseId, hostId: workerId, status: "completed" as const, exitCode: 0, signal: null, endedAt: 2_000 };
    expect(leases.report(report).ok).toBe(true);
    // A replay with a different signal is a different result, not a replay.
    const resignal = leases.report({ ...report, signal: "SIGKILL" });
    expect(resignal.ok && resignal.reply.accepted).toBe(false);
    expect(leases.job("job-1")).toMatchObject({ status: "completed", report: { status: "completed", exitCode: 0, signal: null, endedAt: 2_000 } });
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

  it("dispatches idempotently on the active lease and refuses a second distinct lease or mismatched payload", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-d", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });

    const lease = { controllerId, epoch: 0, leaseId: "lease-1", jobId: "job-d", host: workerId };
    const staleLease = leases.dispatch({
      ...fence,
      lease: { ...lease, epoch: 3 },
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(staleLease.ok && staleLease.reply.accepted).toBe(false);
    expect(staleLease.ok && staleLease.reply.reason).toMatch(/stale lease epoch/);

    const badPayload = leases.dispatch({
      ...fence,
      lease,
      command: "false",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(badPayload.ok && badPayload.reply.accepted).toBe(false);
    expect(badPayload.ok && badPayload.reply.reason).toMatch(/does not match the queued job/);

    const dispatched = leases.dispatch({
      ...fence,
      lease,
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(dispatched.ok && dispatched.reply).toEqual({
      accepted: true,
      leaseId: "lease-1",
      controllerId,
      epoch: 0,
    });
    expect(leases.job("job-d")).toMatchObject({
      status: "dispatching",
      host: workerId,
      leaseId: "lease-1",
      placedReason: "dispatched to an eligible host",
    });

    // Exact replay is idempotent and returns accepted: true without re-dispatching.
    const replay = leases.dispatch({
      ...fence,
      lease,
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(replay.ok && replay.reply.accepted).toBe(true);

    // A second distinct leaseId for the same job is refused.
    const duplicate = leases.dispatch({
      ...fence,
      lease: { ...lease, leaseId: "lease-2" },
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(duplicate.ok && duplicate.reply.accepted).toBe(false);
    expect(duplicate.ok && duplicate.reply.reason).toMatch(/never leased twice/);

    // Reusing an existing leaseId for a different jobId is rejected with lease_conflict.
    leases.enqueue({ ...fence, jobId: "job-d2", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    const collided = leases.dispatch({
      ...fence,
      lease: { controllerId, epoch: 0, leaseId: "lease-1", jobId: "job-d2", host: workerId },
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    expect(collided.ok && collided.reply).toEqual({
      accepted: false,
      leaseId: "lease-1",
      reason: "lease_conflict",
      controllerId,
      epoch: 0,
    });
    expect(leases.job("job-d2")?.status).toBe("queued");
  });

  it("retains pendingStops across intervening heartbeats while a stopped job is still dispatching", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-early-stop", botId: "bot-a", threadId: "t", command: "sleep 30", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-early-stop" });
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";

    expect(leases.stop({ ...fence, jobId: "job-early-stop", leaseId, reason: "stop before ack" }).ok).toBe(true);

    // Intervening heartbeat before worker acknowledges holding the lease must NOT prune the pending stop.
    const preAckHb = leases.heartbeat({
      ...fence,
      hostId: workerId,
      leases: [],
      admission: { admit: true },
      sample,
    });
    expect(preAckHb.ok && preAckHb.reply.pendingStops).toEqual([leaseId]);
    expect(leases.job("job-early-stop")?.status).toBe("dispatching");

    // Subsequent heartbeat where the worker reports holding the lease still delivers the pending stop.
    const ackHb = leases.heartbeat({
      ...fence,
      hostId: workerId,
      leases: [leaseId],
      admission: { admit: true },
      sample,
    });
    expect(ackHb.ok && ackHb.reply.pendingStops).toEqual([leaseId]);
    expect(leases.job("job-early-stop")?.status).toBe("running");

    // Once the worker stops holding the lease on a subsequent heartbeat, the pending stop is pruned.
    const postStopHb = leases.heartbeat({
      ...fence,
      hostId: workerId,
      leases: [],
      admission: { admit: true },
      sample,
    });
    expect(postStopHb.ok && postStopHb.reply.pendingStops).toEqual([]);
  });

  it("delivers pendingStops on heartbeat for a stopped lease and prunes once dropped or reported", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-s", botId: "bot-a", threadId: "t", command: "sleep 30", cwd: "/tmp", timeoutMs: 60_000 });
    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-s" });
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";

    const stopped = leases.stop({ ...fence, jobId: "job-s", leaseId, reason: "owner cancelled" });
    expect(stopped.ok && stopped.reply).toEqual({
      accepted: true,
      jobId: "job-s",
      leaseId,
      controllerId,
      epoch: 0,
    });
    expect(leases.job("job-s")?.stopReason).toBe("owner cancelled");

    // While the worker still reports holding the lease, heartbeat returns it in pendingStops.
    const hbRunning = leases.heartbeat({
      ...fence,
      hostId: workerId,
      leases: [leaseId],
      admission: { admit: true },
      sample,
    });
    expect(hbRunning.ok && hbRunning.reply.pendingStops).toEqual([leaseId]);
    expect(leases.job("job-s")?.status).toBe("running");

    // Once the worker settles the job via report, the stop is cleared and terminal stop is refused.
    leases.report({
      ...fence,
      jobId: "job-s",
      leaseId,
      hostId: workerId,
      status: "killed",
      exitCode: null,
      signal: "SIGTERM",
      endedAt: 2_000,
    });
    const afterReportHb = leases.heartbeat({
      ...fence,
      hostId: workerId,
      leases: [],
      admission: { admit: true },
      sample,
    });
    expect(afterReportHb.ok && afterReportHb.reply.pendingStops).toEqual([]);

    const stopTerminal = leases.stop({ ...fence, jobId: "job-s", leaseId, reason: "late stop" });
    expect(stopTerminal.ok && stopTerminal.reply.accepted).toBe(false);
    expect(stopTerminal.ok && stopTerminal.reply.reason).toMatch(/already killed/);
  });

  it("refuses clean controller release while jobs are active and bumps epoch once drained", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-r", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });

    const blocked = leases.release({ ...fence, toControllerId: workerId });
    expect(blocked.ok && blocked.reply).toEqual({
      accepted: false,
      reason: "Finish or stop 1 active job before releasing the controller",
      controllerId,
      epoch: 0,
    });
    expect(leases.controller()).toEqual({ controllerId, epoch: 0 });

    const claim = leases.claim({ ...fence, hostId: workerId, jobId: "job-r" });
    const leaseId = claim.ok && claim.reply.accepted ? claim.reply.lease.leaseId : "";
    leases.report({
      ...fence,
      jobId: "job-r",
      leaseId,
      hostId: workerId,
      status: "completed",
      exitCode: 0,
      signal: null,
      endedAt: 2_000,
    });

    const released = leases.release({ ...fence, toControllerId: workerId });
    expect(released.ok && released.reply).toEqual({
      accepted: true,
      releasedFromEpoch: 0,
      controllerId: workerId,
      epoch: 1,
    });
    expect(leases.controller()).toEqual({ controllerId: workerId, epoch: 1 });
  });

  it("adopts a strictly higher epoch on takeover and marks in-flight jobs ranAfterTakeover", () => {
    const { leases } = service();
    leases.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    leases.enqueue({ ...fence, jobId: "job-inflight", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    leases.enqueue({ ...fence, jobId: "job-queued", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 });
    leases.claim({ ...fence, hostId: workerId, jobId: "job-inflight" });

    // Equal or lower epoch is refused.
    const sameEpoch = leases.takeover({
      version: PLACEMENT_WIRE_VERSION,
      controllerId: otherController,
      epoch: 0,
      reconcile: true,
    });
    expect(sameEpoch.ok && sameEpoch.reply.accepted).toBe(false);
    expect(leases.controller()).toEqual({ controllerId, epoch: 0 });

    // Strictly higher epoch is adopted and surfaces orphaned in-flight jobs.
    const taken = leases.takeover({
      version: PLACEMENT_WIRE_VERSION,
      controllerId: otherController,
      epoch: 2,
      reconcile: true,
    });
    expect(taken.ok && taken.reply).toEqual({
      accepted: true,
      reconcile: true,
      orphanedJobIds: ["job-inflight"],
      controllerId: otherController,
      epoch: 2,
    });
    expect(leases.controller()).toEqual({ controllerId: otherController, epoch: 2 });
    expect(leases.reconciling()).toBe(true);
    expect(leases.job("job-inflight")?.ranAfterTakeover).toBe(true);
    expect(leases.job("job-queued")?.ranAfterTakeover).toBeUndefined();
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

  it("parses the sample strictly and bounds host ids at the boundary", () => {
    const { leases } = service();
    const register = { ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample };
    expect(placementLeaseRoute(owner, "register", register, leases).status).toBe(200);
    // Unknown sample keys fail closed instead of passing through silently.
    expect(placementLeaseRoute(owner, "register", { ...register, sample: { ...sample, futureField: 1 } }, leases).status).toBe(400);
    // A partial sample is not the wire shape either.
    expect(placementLeaseRoute(owner, "register", { ...register, sample: { at: 1 } }, leases).status).toBe(400);
    // Overlong host ids are rejected before the regex ever runs.
    const longHost = `mac:${"a".repeat(200)}`;
    expect(placementLeaseRoute(owner, "register", { ...register, hostId: longHost }, leases).status).toBe(400);
  });

  it("routes dispatch, stop, release-controller, and takeover through the validated boundary", () => {
    const { leases } = service();
    expect(placementLeaseRoute(owner, "register", { ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample }, leases).status).toBe(200);
    expect(placementLeaseRoute(owner, "enqueue", { ...fence, jobId: "job-route", botId: "bot-a", threadId: "t", command: "true", cwd: "/tmp", timeoutMs: 60_000 }, leases).status).toBe(200);

    const dispatchRes = placementLeaseRoute(owner, "dispatch", {
      ...fence,
      lease: { controllerId, epoch: 0, leaseId: "lease-route", jobId: "job-route", host: workerId },
      command: "true",
      cwd: "/tmp",
      timeoutMs: 60_000,
    }, leases);
    expect(dispatchRes).toEqual({
      status: 200,
      body: { accepted: true, leaseId: "lease-route", controllerId, epoch: 0 },
    });

    const stopRes = placementLeaseRoute(owner, "stop", {
      ...fence,
      jobId: "job-route",
      leaseId: "lease-route",
      reason: "stop from route",
    }, leases);
    expect(stopRes).toEqual({
      status: 200,
      body: { accepted: true, jobId: "job-route", leaseId: "lease-route", controllerId, epoch: 0 },
    });

    const takeoverRes = placementLeaseRoute(owner, "takeover", {
      version: PLACEMENT_WIRE_VERSION,
      controllerId: otherController,
      epoch: 1,
      reconcile: true,
    }, leases);
    expect(takeoverRes).toEqual({
      status: 200,
      body: {
        accepted: true,
        reconcile: true,
        orphanedJobIds: ["job-route"],
        controllerId: otherController,
        epoch: 1,
      },
    });

    // Settle the in-flight job under the new controller epoch, then release the controller cleanly.
    expect(placementLeaseRoute(owner, "report", {
      version: PLACEMENT_WIRE_VERSION,
      controllerId: otherController,
      epoch: 1,
      jobId: "job-route",
      leaseId: "lease-route",
      hostId: workerId,
      status: "killed",
      exitCode: null,
      signal: "SIGTERM",
      endedAt: 3_000,
    }, leases).status).toBe(200);

    const releaseControllerRes = placementLeaseRoute(owner, "release-controller", {
      version: PLACEMENT_WIRE_VERSION,
      controllerId: otherController,
      epoch: 1,
      toControllerId: controllerId,
    }, leases);
    expect(releaseControllerRes).toEqual({
      status: 200,
      body: {
        accepted: true,
        releasedFromEpoch: 1,
        controllerId,
        epoch: 2,
      },
    });
  });
});
