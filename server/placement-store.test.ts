import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLACEMENT_WIRE_VERSION, type CapacitySample, type ClaimReply, type ControllerEpoch, type HostId, type Lease, type ReportMessage } from "../shared/placement.ts";
import { loadControllerEpoch } from "./placement-identity.ts";
import { PlacementLeaseService, placementLeaseRoute, type LeaseResult } from "./placement-leases.ts";
import { PLACEMENT_QUEUE_WINDOW_MS, PlacementPayloadSpool, type PlacementPayloads } from "./placement-payloads.ts";
import { commandDigest, openPlacementAuthority, openPlacementStore, placementFingerprint, PLACEMENT_ACTIVE_LIMIT, PLACEMENT_RECENT_LIMIT, type PlacementStore } from "./placement-store.ts";

const controllerId: HostId = "server:11111111-1111-4111-8111-111111111111";
const workerId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const otherId: HostId = "server:33333333-3333-4333-8333-333333333333";
const initial: ControllerEpoch = { controllerId, epoch: 0 };
const fence = { ...initial, version: PLACEMENT_WIRE_VERSION };
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };
const sample: CapacitySample = {
  at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null,
  memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null,
  diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null, dataVolume: null, rootDiskFreeBytes: null,
};
const dirs: string[] = [];
const stores: PlacementStore[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "bf-placement-store-")); dirs.push(dir); return dir; }
function open(dir: string) { const store = openPlacementStore(dir, controllerId); stores.push(store); return store; }
function create(dir = fixture(), clock = { now: 1000 }, maxCount?: number, queueWindowMs = PLACEMENT_QUEUE_WINDOW_MS) {
  const store = open(dir);
  const payloads = new PlacementPayloadSpool(dir, maxCount);
  const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads, now: () => clock.now, queueWindowMs: () => queueWindowMs });
  return { dir, store, payloads, service, clock };
}
function ready(service: PlacementLeaseService, current = fence, hostId = workerId) {
  service.register({ ...current, hostId, role: "worker", capabilities: ["shell", "macos", "desktop"], sample });
  service.heartbeat({ ...current, hostId, leases: [], admission: { admit: true }, sample });
}
function message(jobId = "job-1", command = "printf 'fixture-payload'", current = fence) {
  return { ...current, jobId, botId: "bot-a", threadId: "thread-a", cwd: "/fixture", timeoutMs: 60_000, command };
}
function claimed(result: LeaseResult<ClaimReply>): Lease {
  if (!result.ok || !result.reply.accepted) throw new Error("Fixture claim was refused");
  return result.reply.lease;
}
function finalReport(lease: Lease): ReportMessage {
  return { version: PLACEMENT_WIRE_VERSION, controllerId: lease.controllerId, epoch: lease.epoch, hostId: lease.host, leaseId: lease.leaseId, jobId: lease.jobId, status: "completed", exitCode: 0, signal: null, endedAt: 2000 };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("transactional placement authority", () => {
  it("creates a missing data root before canonicalizing it", () => {
    const root = join(fixture(), "missing", "data");
    expect(() => new PlacementPayloadSpool(root)).not.toThrow();
    expect(statSync(join(root, "placement-payloads", "pending-commands")).mode & 0o777).toBe(0o700);
  });

  it("reopens a symlinked data root with the same durable authority and private payload namespace", () => {
    const root = fixture();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, alias);
    const first = create(alias);
    expect(first.service.enqueue(message())).toMatchObject({ reply: { accepted: true } });
    const before = readdirSync(join(actual, "placement-payloads", "pending-commands"));
    first.store.close();
    const authority = openPlacementAuthority(alias, controllerId);
    expect(authority.kind).toBe("sqlite");
    if (authority.kind !== "sqlite") throw new Error("Fixture unexpectedly opened legacy authority");
    stores.push(authority.store);
    const payloads = new PlacementPayloadSpool(alias);
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: authority.store, payloads, now: () => first.clock.now });
    expect(service.job("job-1")?.command).toBe(message().command);
    expect(service.enqueue(message())).toMatchObject({ reply: { accepted: true, duplicate: true } });
    expect(readdirSync(join(actual, "placement-payloads", "pending-commands"))).toEqual(before);
    expect(statSync(join(actual, "placement-payloads", "pending-commands")).mode & 0o777).toBe(0o700);
  });

  it.each(["placement-payloads", "pending-commands"])("still refuses a symlinked %s inside a symlinked data root", (component) => {
    const root = fixture();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    const outside = join(root, "outside");
    mkdirSync(actual, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(actual, alias);
    const parent = component === "placement-payloads" ? actual : join(actual, "placement-payloads");
    if (parent !== actual) mkdirSync(parent, { mode: 0o700 });
    symlinkSync(outside, join(parent, component));
    expect(() => new PlacementPayloadSpool(alias)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(parent, component)).isSymbolicLink()).toBe(true);
  });

  it("refuses the actual unsupported runtime before opening a store even with a Linux injection", () => {
    const absent = join(fixture(), "must-remain-absent");
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    if (!original) throw new Error("Missing platform descriptor");
    try {
      Object.defineProperty(process, "platform", { ...original, value: "win32" });
      expect(() => openPlacementStore(absent, controllerId, "linux")).toThrow(/Placement persistence/);
    } finally { Object.defineProperty(process, "platform", original); }
    expect(existsSync(absent)).toBe(false);
  });

  it.each(["win32", "freebsd", "aix"] as const)("refuses SQLite activation and reopening on %s without modifying legacy or migrated evidence", (platform) => {
    const absent = join(fixture(), "must-remain-absent");
    expect(() => openPlacementStore(absent, controllerId, platform)).toThrow(/Placement persistence/);
    expect(existsSync(absent)).toBe(false);
    const legacy = fixture();
    const path = join(legacy, "placement-controller.json");
    const bytes = JSON.stringify({ controllerId, epoch: 7 });
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() => openPlacementStore(legacy, controllerId, platform)).toThrow(/Placement persistence/);
    expect(readdirSync(legacy)).toEqual(["placement-controller.json"]);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const existing = fixture(); open(existing).close();
    const before = readdirSync(existing).map((name) => ({ name, bytes: readFileSync(join(existing, name)), mode: statSync(join(existing, name)).mode }));
    expect(() => openPlacementStore(existing, controllerId, platform)).toThrow(/Placement persistence/);
    expect(() => openPlacementAuthority(existing, controllerId, platform)).toThrow(/Placement persistence/);
    expect(readdirSync(existing).map((name) => ({ name, bytes: readFileSync(join(existing, name)), mode: statSync(join(existing, name)).mode }))).toEqual(before);
  });

  it("preserves normal legacy boot on an unsupported placement host without enabling SQLite or private payloads", () => {
    const dir = fixture();
    const first = openPlacementAuthority(dir, controllerId, "win32");
    expect(first.kind).toBe("legacy");
    if (first.kind !== "legacy") throw new Error("Fixture unexpectedly opened SQLite");
    expect(first.controllerStore.read()).toEqual(initial);
    const before = readFileSync(join(dir, "placement-controller.json"));
    const again = openPlacementAuthority(dir, controllerId, "win32");
    expect(again.kind).toBe("legacy");
    expect(readFileSync(join(dir, "placement-controller.json"))).toEqual(before);
    expect(readdirSync(dir)).toEqual(["placement-controller.json"]);
  });

  it("keeps ordinary bootstrap on strict legacy JSON until an explicit verified activation marker exists", () => {
    const dir = fixture();
    const authority = openPlacementAuthority(dir, controllerId);
    expect(authority.kind).toBe("legacy");
    if (authority.kind !== "legacy") throw new Error("fixture unexpectedly activated SQLite");
    expect(authority.controllerStore.read()).toEqual(initial);
    expect(existsSync(join(dir, "placement.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "placement-payloads"))).toBe(false);
    expect(loadControllerEpoch(dir, controllerId)).toEqual(initial);
    open(dir).close();
    const activated = openPlacementAuthority(dir, controllerId);
    expect(activated.kind).toBe("sqlite");
    if (activated.kind === "sqlite") { stores.push(activated.store); expect(activated.store.read().controller).toEqual(initial); }
  });
  it("migrates the exact private epoch to one UUID-bound database and makes older strict readers fail closed", () => {
    const dir = fixture();
    writeFileSync(join(dir, "placement-controller.json"), JSON.stringify({ controllerId: workerId, epoch: 7 }), { mode: 0o600 });
    const store = open(dir);
    expect(store.read()).toEqual({ controller: { controllerId: workerId, epoch: 7 }, reconcile: false, jobs: [], leases: [], pendingStops: [] });
    expect(() => loadControllerEpoch(dir, controllerId)).toThrow(/invalid/);
    const marker = JSON.parse(readFileSync(join(dir, "placement-controller.json"), "utf8"));
    expect(marker).toMatchObject({ format: "botfleet-placement-sqlite", version: 1, migrationId: expect.any(String) });
    for (const name of readdirSync(dir).filter((name) => name.startsWith("placement.sqlite"))) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(store.path);
    try {
      expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(JSON.parse(String(database.prepare("SELECT json FROM placement_meta").get()?.json)).migrationId).toBe(marker.migrationId);
    } finally { database.close(); }
    store.close();
    expect(open(dir).read().controller).toEqual({ controllerId: workerId, epoch: 7 });
  });

  it("persists enqueue metadata without command text and retains immutable dedupe after terminal display hiding", () => {
    const current = create();
    const command = "printf 'private-command-that-must-stay-in-spool'";
    expect(current.service.enqueue(message("job-1", command))).toMatchObject({ reply: { accepted: true } });
    const stateJson = JSON.stringify(current.store.read());
    expect(stateJson).not.toContain(command);
    expect(stateJson).toContain("payloadDigest");
    current.store.close();
    const restarted = create(current.dir);
    expect(restarted.service.job("job-1")?.command).toBe(command);
    expect(restarted.service.enqueue(message("job-1", command))).toMatchObject({ reply: { accepted: true, duplicate: true } });
    expect(restarted.service.enqueue({ ...message("job-1", command), cwd: "/other" })).toMatchObject({ ok: false });
    ready(restarted.service);
    const lease = claimed(restarted.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    const report = finalReport(lease);
    expect(restarted.service.report(report)).toMatchObject({ reply: { accepted: true } });
    restarted.store.transaction((state) => { state.jobs[0]!.hidden = true; });
    expect(restarted.service.jobsList()).toEqual([]);
    expect(restarted.service.report(report)).toMatchObject({ reply: { accepted: true } });
    expect(restarted.service.report({ ...report, reason: "different final report" })).toMatchObject({ reply: { accepted: false } });
    expect(restarted.service.enqueue(message("job-1", command))).toMatchObject({ reply: { accepted: true, duplicate: true, status: "completed" } });
    expect(restarted.service.enqueue(message("job-1", "different"))).toMatchObject({ ok: false });
    expect(restarted.store.read().leases).toMatchObject([{ ...lease, state: "settled" }]);
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toEqual([]);
    expect(() => restarted.store.transaction((state) => { state.jobs = []; state.leases = []; })).toThrow();
  });

  it("replays a lost claim acknowledgement with the same issuing lease after restart and fresh readiness", () => {
    const first = create();
    first.service.enqueue(message());
    ready(first.service);
    const lease = claimed(first.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    first.store.close();
    const restarted = create(first.dir);
    expect(restarted.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: false } });
    restarted.service.register({ ...fence, hostId: workerId, role: "worker", capabilities: ["shell"], sample });
    expect(restarted.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: false, reason: expect.stringMatching(/fresh worker heartbeat/) } });
    restarted.service.heartbeat({ ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample });
    expect(claimed(restarted.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }))).toEqual(lease);
    expect(restarted.store.read().leases).toHaveLength(1);
    expect(restarted.service.dispatch({ ...message(), lease })).toMatchObject({ reply: { accepted: true } });
  });

  it("keeps pending stops through omitted heartbeat leases and persists every leased status without requeueing", () => {
    const first = create();
    first.service.enqueue(message());
    ready(first.service);
    const lease = claimed(first.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    first.service.stop({ ...fence, jobId: lease.jobId, leaseId: lease.leaseId, reason: "fixture stop" });
    first.service.heartbeat({ ...fence, hostId: workerId, leases: [lease.leaseId], admission: { admit: true }, sample });
    expect(first.store.read().jobs[0]?.status).toBe("running");
    const heartbeat = { ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample };
    expect(first.service.heartbeat(heartbeat)).toMatchObject({ reply: { pendingStops: [lease.leaseId] } });
    first.store.close();
    const restarted = create(first.dir);
    expect(restarted.service.job("job-1")?.status).toBe("running");
    expect(restarted.service.sweepUnreachable()).toEqual(["job-1"]);
    expect(restarted.service.job("job-1")?.status).toBe("worker-unreachable");
    restarted.store.close();
    const again = create(first.dir);
    ready(again.service);
    expect(again.service.heartbeat(heartbeat)).toMatchObject({ reply: { pendingStops: [lease.leaseId] } });
    expect(again.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: false } });
    expect(again.service.releaseLease({ ...fence, hostId: workerId, jobId: "job-1", leaseId: lease.leaseId }))
      .toMatchObject({ reply: { accepted: false, reason: expect.stringMatching(/verified worker revocation/) } });
    expect(again.service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true } });
    expect(again.store.read().pendingStops).toEqual([]);
    expect(again.store.read().jobs[0]?.status).toBe("completed");
  });

  it("atomically persists takeover reconciliation and the original lease fence, allowing settlement but no reissue", () => {
    const first = create();
    first.service.enqueue(message());
    ready(first.service);
    const lease = claimed(first.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    expect(first.service.takeover({ ...fence, controllerId: otherId, epoch: 5, reconcile: true })).toMatchObject({ reply: { accepted: true, orphanedJobIds: ["job-1"] } });
    first.store.close();
    const restarted = create(first.dir);
    expect(restarted.service.reconciling()).toBe(true);
    expect(restarted.service.job("job-1")?.ranAfterTakeover).toBe(true);
    expect(restarted.store.read().leases).toMatchObject([{ ...lease, state: "active" }]);
    const current = { ...fence, controllerId: otherId, epoch: 5 };
    ready(restarted.service, current);
    expect(restarted.service.claim({ ...current, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: false } });
    expect(restarted.service.dispatch({ ...message("job-1", "printf 'fixture-payload'", current), lease })).toMatchObject({ reply: { accepted: false } });
    expect(restarted.service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true, epoch: 5 } });
    expect(restarted.service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true, epoch: 5 } });
    expect(restarted.service.release({ ...current, toControllerId: controllerId })).toMatchObject({ reply: { accepted: true, epoch: 6 } });
    restarted.store.close();
    expect(create(first.dir).service.reconciling()).toBe(false);
  });

  it("retains released lease tombstones and rejects their delayed dispatch after requeue and restart", () => {
    const current = create();
    current.service.enqueue(message());
    ready(current.service);
    const lease = claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    // Internal fixture stands in for the future verified durable worker receipt.
    current.store.transaction((state) => {
      state.leases[0]!.state = "released";
      state.leases[0]!.revocationId = "fixture-verified-worker-revocation";
      const job = state.jobs[0]!;
      job.status = "queued";
      delete job.host;
      delete job.leaseId;
    });
    current.store.close();
    const reopened = create(current.dir);
    ready(reopened.service);
    expect(reopened.service.dispatch({ ...message(), lease })).toMatchObject({ reply: { accepted: false, reason: "lease_conflict" } });
    const replacement = claimed(reopened.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    expect(replacement.leaseId).not.toBe(lease.leaseId);
    expect(reopened.store.read().leases).toHaveLength(2);
    expect(() => reopened.store.transaction((state) => { state.leases.shift(); })).toThrow();
  });

  it("refuses commit failure without acknowledging or mutating memory, while retaining a safe orphan payload for retry", () => {
    const current = create();
    let fail = false;
    const failure: PlacementStore = {
      ...current.store,
      path: current.store.path, read: () => current.store.read(), close() {},
      transactionScope: (scope, change) => current.store.transactionScope(scope, (state) => {
        const result = change(state);
        if (fail && state.jobs.length > 0) throw new Error("fixture commit failure");
        return result;
      }),
      transaction: (change) => current.store.transaction((state) => {
        const result = change(state);
        if (fail && state.jobs.length > 0) throw new Error("fixture commit failure");
        return result;
      }),
    };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: failure, payloads: current.payloads });
    fail = true;
    expect(placementLeaseRoute(owner, "enqueue", message(), service)).toMatchObject({ status: 503 });
    expect(service.jobsList()).toEqual([]);
    expect(current.store.read().jobs).toEqual([]);
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toHaveLength(1);
    fail = false;
    expect(service.enqueue(message())).toMatchObject({ reply: { accepted: true } });
    ready(service);
    fail = true;
    expect(placementLeaseRoute(owner, "claim", { ...fence, hostId: workerId, jobId: "job-1" }, service)).toMatchObject({ status: 503 });
    expect(service.job("job-1")?.status).toBe("queued");
    expect(current.store.read().leases).toEqual([]);
    expect(placementLeaseRoute(owner, "takeover", { ...fence, controllerId: otherId, epoch: 2, reconcile: true }, service)).toMatchObject({ status: 503 });
    expect(service.controller()).toEqual(initial);
    expect(service.reconciling()).toBe(false);
  });

  it("holds missing or corrupt payloads without reconstructing them from retries or dispatches", () => {
    const current = create();
    current.service.enqueue(message());
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    const path = join(payloadDir, readdirSync(payloadDir)[0]!);
    writeFileSync(path, "damaged");
    ready(current.service);
    expect(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: false } });
    expect(current.service.enqueue(message())).toMatchObject({ reply: { accepted: true, duplicate: true } });
    expect(readFileSync(path, "utf8")).toBe("damaged");
    rmSync(path);
    current.store.close();
    const reopened = create(current.dir);
    ready(reopened.service);
    const lease: Lease = { ...initial, host: workerId, leaseId: "delayed", jobId: "job-1" };
    expect(reopened.service.dispatch({ ...message(), lease })).toMatchObject({ reply: { accepted: false } });
    expect(reopened.store.read().leases).toEqual([]);
    expect(reopened.service.job("job-1")?.status).toBe("queued");
  });

  it("reclaims unreferenced rollback publications under the writer lock without losing committed payloads or count capacity", () => {
    const current = create(undefined, { now: 1000 }, 1);
    let fail = false;
    const failure: PlacementStore = {
      ...current.store,
      path: current.store.path, read: () => current.store.read(), close() {},
      transactionScope: (scope, change) => current.store.transactionScope(scope, (state) => {
        const result = change(state);
        if (fail && state.jobs.length > 0) throw new Error("fixture commit failure");
        return result;
      }),
      transaction: (change) => current.store.transaction((state) => {
        const result = change(state);
        if (fail && state.jobs.length > 0) throw new Error("fixture commit failure");
        return result;
      }),
    };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: failure, payloads: current.payloads, now: () => 1000 });
    fail = true;
    expect(placementLeaseRoute(owner, "enqueue", message("unaccepted"), service)).toMatchObject({ status: 503 });
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    const orphan = join(payloadDir, readdirSync(payloadDir)[0]!);
    linkSync(orphan, join(payloadDir, ".interrupted-publication.tmp"));
    current.store.close();
    const reopened = create(current.dir, { now: 1000 }, 1);
    expect(reopened.store.read().jobs).toEqual([]);
    expect(readdirSync(payloadDir)).toEqual([]);
    expect(reopened.service.enqueue(message())).toMatchObject({ reply: { accepted: true } });
    const committed = join(payloadDir, readdirSync(payloadDir)[0]!);
    linkSync(committed, join(payloadDir, ".extra-publication.tmp"));
    reopened.store.close();
    const again = create(current.dir, { now: 1000 }, 1);
    expect(readdirSync(payloadDir)).toHaveLength(1);
    expect(again.service.job("job-1")?.command).toBe(message().command);
    ready(again.service);
    expect(again.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: true } });
  });

  it("bounds commands and count, durably expires only queued work, and retains unresolved execution payloads", () => {
    const current = create(undefined, { now: 1000 }, 2);
    expect(placementLeaseRoute(owner, "enqueue", message("too-long", "x".repeat(16_001)), current.service).status).toBe(400);
    current.service.enqueue(message());
    current.service.enqueue(message("job-2"));
    expect(placementLeaseRoute(owner, "enqueue", message("job-3"), current.service).status).toBe(503);
    ready(current.service);
    const lease = claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    current.clock.now += PLACEMENT_QUEUE_WINDOW_MS + 1;
    current.service.sweepUnreachable();
    expect(current.service.expireQueued(fence)).toEqual(["job-2"]);
    expect(current.store.read().jobs.map((job) => job.status)).toEqual(["worker-unreachable", "lost"]);
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toHaveLength(1);
    ready(current.service);
    expect(current.service.claim({ ...fence, hostId: workerId, jobId: "job-2" })).toMatchObject({ reply: { accepted: false } });
    expect(current.store.read().leases).toMatchObject([{ ...lease, state: "active" }]);
    expect(current.service.enqueue(message("job-3"))).toMatchObject({ reply: { accepted: true } });
  });

  it("retains never-issued expiry and fingerprint dedupe across restart and display pruning without allocating a lease", () => {
    const current = create(undefined, { now: 1000 }, undefined, 60_000);
    current.service.enqueue(message());
    current.clock.now = 61_001;
    expect(current.service.expireQueued({ ...fence, epoch: 1 })).toEqual([]);
    expect(current.store.readAll().jobs[0]?.status).toBe("queued");
    expect(current.service.expireQueued(fence)).toEqual(["job-1"]);
    const expired = current.store.readAll().jobs[0]!;
    expect(expired).toMatchObject({ status: "lost", queueExpiry: { deadlineAt: 61_000, expiredAt: 61_001 }, report: { status: "lost", exitCode: null, signal: null, endedAt: 61_001 } });
    expect(expired.host).toBeUndefined(); expect(expired.leaseId).toBeUndefined();
    expect(current.store.readAll().leases).toEqual([]);
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toEqual([]);
    expect(() => current.store.transaction((state) => { state.jobs[0]!.queueExpiry!.deadlineAt++; })).toThrow();
    current.store.transaction((state) => { state.jobs[0]!.hidden = true; });
    current.store.close();
    const reopened = create(current.dir, current.clock, undefined, 60_000);
    expect(reopened.service.jobsList()).toEqual([]);
    expect(reopened.service.enqueue(message())).toMatchObject({ reply: { accepted: true, duplicate: true, status: "lost" } });
    expect(placementLeaseRoute(owner, "enqueue", message("job-1", "different"), reopened.service)).toMatchObject({ status: 409 });
    const forged = { ...fence, jobId: "job-1", hostId: workerId, leaseId: "never-issued", status: "lost", exitCode: null, signal: null, endedAt: 61_001, queueExpiry: expired.queueExpiry };
    expect(placementLeaseRoute(owner, "report", forged, reopened.service)).toMatchObject({ status: 400 });
    expect(reopened.store.readAll().jobs[0]).toEqual({ ...expired, hidden: true });
    expect(reopened.store.readAll().leases).toEqual([]);
  });

  it.each(["before-sweep", "before-maintenance-transaction"] as const)("preserves queued work after takeover %s until maintenance presents the current fence", (timing) => {
    const current = create(undefined, { now: 1000 }, undefined, 60_000);
    current.service.enqueue(message());
    const other = create(current.dir, current.clock, undefined, 60_000);
    const expected = { ...fence };
    let beforeTransaction: (() => void) | undefined;
    const store: PlacementStore = { ...current.store, close() {}, transactionScope: (scope, change) => {
      const pending = beforeTransaction;
      beforeTransaction = undefined;
      pending?.();
      return current.store.transactionScope(scope, change);
    } };
    let windowReads = 0;
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads: current.payloads, now: () => current.clock.now, queueWindowMs: () => { windowReads++; return 60_000; } });
    const scheduledSweep = () => service.sweepUnreachable(61_001);
    const scheduledMaintenance = () => service.expireQueued(expected);
    const before = current.store.readAll();
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    const rawBefore = readdirSync(payloadDir).map((name) => ({ name, bytes: readFileSync(join(payloadDir, name)) }));
    const takeover = () => {
      expect(other.service.takeover({ ...fence, controllerId: otherId, epoch: 2, reconcile: true })).toMatchObject({ reply: { accepted: true } });
    };
    current.clock.now = 61_001;
    if (timing === "before-sweep") takeover();
    else beforeTransaction = takeover;
    expect(scheduledMaintenance()).toEqual([]);
    expect(scheduledSweep()).toEqual([]);
    const after = current.store.readAll();
    expect(after.controller).toEqual({ controllerId: otherId, epoch: 2 });
    expect(after.jobs).toEqual(before.jobs);
    expect(after.leases).toEqual(before.leases);
    expect(after.pendingStops).toEqual(before.pendingStops);
    expect(readdirSync(payloadDir).map((name) => ({ name, bytes: readFileSync(join(payloadDir, name)) }))).toEqual(rawBefore);
    expect(windowReads).toBe(0);
    expect(service.expireQueued({ ...expected, controllerId: otherId, epoch: 2 })).toEqual(["job-1"]);
    expect(windowReads).toBe(1);
    expect(current.store.readAll().jobs[0]).toMatchObject({ status: "lost", queueExpiry: { deadlineAt: 61_000, expiredAt: 61_001 } });
    expect(current.store.readAll().leases).toEqual([]);
    expect(readdirSync(payloadDir)).toEqual([]);
  });

  it("keeps queued metadata and raw payload intact when expiry cannot commit, then retries safely", () => {
    const current = create(undefined, { now: 1000 }, undefined, 60_000);
    current.service.enqueue(message());
    let fail = false;
    const store: PlacementStore = { ...current.store, close() {}, transactionScope: (scope, change) => current.store.transactionScope(scope, (state) => {
      const result = change(state);
      if (fail && state.jobs.some((job) => job.queueExpiry)) throw new Error("fixture expiry commit failure");
      return result;
    }) };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads: current.payloads, now: () => current.clock.now, queueWindowMs: () => 60_000 });
    const before = current.store.readAll();
    const raw = readdirSync(join(current.dir, "placement-payloads", "pending-commands"));
    fail = true; current.clock.now = 61_001;
    expect(() => service.expireQueued(fence)).toThrow(/Placement persistence/);
    expect(current.store.readAll()).toEqual(before);
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toEqual(raw);
    expect(service.job("job-1")?.command).toBe(message().command);
    fail = false;
    const database = new DatabaseSync(current.store.path);
    try {
      database.exec("CREATE TRIGGER fixture_expiry_failure BEFORE UPDATE ON placement_jobs WHEN NEW.active=0 AND OLD.active=1 BEGIN SELECT RAISE(FAIL,'fixture expiry write failure'); END");
      expect(() => service.expireQueued(fence)).toThrow(/Placement persistence/);
      expect(current.store.readAll()).toEqual(before);
      expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toEqual(raw);
      database.exec("DROP TRIGGER fixture_expiry_failure");
      expect(service.expireQueued(fence)).toEqual(["job-1"]);
    } finally { database.close(); }
    expect(current.store.readAll().jobs[0]?.status).toBe("lost");
    expect(current.store.readAll().leases).toEqual([]);
  });

  it("freshly fences admission if another controller takes over after durable expiry maintenance", () => {
    const current = create(undefined, { now: 1000 }, undefined, 60_000);
    current.service.enqueue(message());
    const other = create(current.dir, current.clock, undefined, 60_000);
    let intercept = false;
    const store: PlacementStore = { ...current.store, close() {}, transactionScope: (scope, change) => {
      const result = current.store.transactionScope(scope, change);
      if (intercept) {
        intercept = false;
        expect(other.service.takeover({ ...fence, controllerId: otherId, epoch: 2, reconcile: true })).toMatchObject({ reply: { accepted: true } });
      }
      return result;
    } };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads: current.payloads, now: () => current.clock.now, queueWindowMs: () => 60_000 });
    current.clock.now = 61_001; intercept = true;
    expect(service.enqueue(message("new-after-expiry"))).toMatchObject({ reply: { accepted: false, controllerId: otherId, epoch: 2 } });
    expect(current.store.readAll()).toMatchObject({ controller: { controllerId: otherId, epoch: 2 }, jobs: [{ jobId: "job-1", status: "lost" }], leases: [] });
    expect(readdirSync(join(current.dir, "placement-payloads", "pending-commands"))).toEqual([]);
  });

  it("frees all five hundred slots only after durable expiry and successful payload cleanup, without pruning terminal history", () => {
    const current = create(undefined, { now: 1000 }, PLACEMENT_ACTIVE_LIMIT, 60_000);
    current.store.transaction((state) => {
      for (let index = 0; index < PLACEMENT_ACTIVE_LIMIT; index++) {
        const metadata = { jobId: `expiry-${index}`, botId: "fixture", threadId: "expiry", cwd: "/fixture", timeoutMs: 1000, payloadDigest: commandDigest("true"), queuedAt: 1000, status: "queued" as const };
        state.jobs.push({ ...metadata, fingerprint: placementFingerprint(metadata) });
      }
    });
    for (const job of current.store.readAll().jobs) current.payloads.put(job, "true");
    const witness = open(current.dir);
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    let blockRemoval = true;
    let cleanupFailed = false;
    let verifiedTerminal = false;
    const payloads: PlacementPayloads = {
      put: (job, command) => {
        expect(witness.readAll().jobs.filter((entry) => entry.queueExpiry)).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
        expect(readdirSync(payloadDir)).toEqual([]);
        return current.payloads.put(job, command);
      },
      read: (job) => current.payloads.read(job),
      remove: (job) => {
        if (!verifiedTerminal) { expect(witness.readAll().jobs.every((entry) => entry.status === "lost")).toBe(true); verifiedTerminal = true; }
        if (blockRemoval) { cleanupFailed = true; throw new Error("fixture terminal cleanup unavailable"); }
        current.payloads.remove(job);
      },
      reconcile: (jobs) => {
        if (cleanupFailed && blockRemoval) throw new Error("fixture orphan cleanup unavailable");
        current.payloads.reconcile(jobs);
      },
    };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: current.store, payloads, now: () => current.clock.now, queueWindowMs: () => 60_000 });
    expect(placementLeaseRoute(owner, "enqueue", message("before-expiry"), service)).toMatchObject({ status: 409 });
    expect(readdirSync(payloadDir)).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    current.clock.now = 61_001;
    expect(service.expireQueued(fence)).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    expect(verifiedTerminal).toBe(true);
    expect(current.store.readScope({ active: true }).jobs).toEqual([]);
    expect(readdirSync(payloadDir)).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    expect(placementLeaseRoute(owner, "enqueue", message("after-expiry"), service)).toMatchObject({ status: 503 });
    expect(current.store.readAll().jobs).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    blockRemoval = false;
    expect(service.enqueue(message("after-expiry"))).toMatchObject({ reply: { accepted: true } });
    expect(readdirSync(payloadDir)).toHaveLength(1);
    expect(current.store.readScope({ active: true }).jobs).toMatchObject([{ jobId: "after-expiry" }]);
    expect(current.store.readAll().jobs).toHaveLength(PLACEMENT_ACTIVE_LIMIT + 1);
    expect(current.store.readAll().leases).toEqual([]);
  });

  it("serializes native claim versus expiry races and never expires an already issued lease", async () => {
    const storeModule = new URL("./placement-store.ts", import.meta.url).href;
    const serviceModule = new URL("./placement-leases.ts", import.meta.url).href;
    const payloadModule = new URL("./placement-payloads.ts", import.meta.url).href;
    const script = `import {openPlacementStore} from ${JSON.stringify(storeModule)}; import {PlacementLeaseService} from ${JSON.stringify(serviceModule)}; import {PlacementPayloadSpool} from ${JSON.stringify(payloadModule)};
      const store=openPlacementStore(process.argv[1],process.argv[2]); let now=1000;
      const service=new PlacementLeaseService({hostId:process.argv[2],controller:${JSON.stringify(initial)},store,payloads:new PlacementPayloadSpool(process.argv[1]),now:()=>now,queueWindowMs:()=>60000});
      const fence=${JSON.stringify(fence)}; const sample=${JSON.stringify(sample)};
      service.register({...fence,hostId:${JSON.stringify(workerId)},role:'worker',capabilities:['shell'],sample});
      service.heartbeat({...fence,hostId:${JSON.stringify(workerId)},leases:[],admission:{admit:true},sample});
      process.stdout.write('READY:'); process.stdin.once('data',()=>{let accepted;
        if(process.argv[3]==='expire'){now=61001;accepted=service.expireQueued(fence).length>0}
        else {const result=service.claim({...fence,hostId:${JSON.stringify(workerId)},jobId:'job-1'});accepted=result.ok&&result.reply.accepted}
        process.stdout.write(JSON.stringify({accepted}));store.close()});`;
    function start(dir: string, action: string) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, controllerId, action], { stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let stderr = "";
      child.stderr.on("data", (data) => { stderr += String(data); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (data) => { output += String(data); if (output.startsWith("READY:")) resolve(); });
        child.once("error", reject);
        child.once("close", () => { if (!output.startsWith("READY:")) reject(new Error(stderr)); });
      });
      const done = new Promise<{ accepted: boolean }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(JSON.parse(output.slice("READY:".length))) : reject(new Error(stderr)));
      });
      return { child, ready, done };
    }
    for (const order of ["claim-first", "expiry-first", "concurrent"]) {
      const current = create(undefined, { now: 1000 }, undefined, 60_000);
      current.service.enqueue(message()); current.store.close();
      const claim = start(current.dir, "claim"); await claim.ready;
      const expiry = start(current.dir, "expire");
      try {
        await expiry.ready;
        if (order === "claim-first") { claim.child.stdin.end("go"); await claim.done; expiry.child.stdin.end("go"); }
        else if (order === "expiry-first") { expiry.child.stdin.end("go"); await expiry.done; claim.child.stdin.end("go"); }
        else { claim.child.stdin.end("go"); expiry.child.stdin.end("go"); }
        const results = await Promise.all([claim.done, expiry.done]);
        expect(results.filter((result) => result.accepted)).toHaveLength(1);
        if (order === "claim-first") expect(results[0].accepted).toBe(true);
        if (order === "expiry-first") expect(results[1].accepted).toBe(true);
        const state = open(current.dir).readAll();
        if (results[0].accepted) {
          expect(state.jobs[0]).toMatchObject({ status: "dispatching" });
          expect(state.jobs[0]?.queueExpiry).toBeUndefined();
          expect(state.leases).toHaveLength(1);
        } else {
          expect(state.jobs[0]).toMatchObject({ status: "lost", queueExpiry: { deadlineAt: 61_000 } });
          expect(state.leases).toEqual([]);
        }
      } finally { claim.child.kill("SIGKILL"); expiry.child.kill("SIGKILL"); }
    }
  }, 30_000);

  it("reads the existing queue deadline lazily and never expires another writer's newly claimed payload after commit", () => {
    const current = create();
    current.service.enqueue(message());
    const other = create(current.dir);
    ready(other.service);
    let initialized = false;
    let intercept = false;
    const store: PlacementStore = {
      ...current.store,
      path: current.store.path, read: () => current.store.read(), close() {},
      transactionScope: (scope, change) => {
        const result = current.store.transactionScope(scope, change);
        if (intercept) {
          current.clock.now += 60_001;
          expect(other.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: true } });
        }
        return result;
      },
      transaction: (change) => {
        const result = current.store.transaction(change);
        if (intercept) {
          current.clock.now += 60_001;
          expect(other.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: true } });
        }
        return result;
      },
    };
    const service = new PlacementLeaseService({
      hostId: controllerId, controller: initial, store, payloads: current.payloads, now: () => current.clock.now,
      queueWindowMs: () => { if (!initialized) throw new Error("settings not initialized"); return 60_000; },
    });
    initialized = true;
    intercept = true;
    service.register({ ...fence, hostId: otherId, role: "worker", capabilities: ["shell"], sample });
    intercept = false;
    expect(current.store.read().jobs[0]?.status).toBe("dispatching");
    expect(current.payloads.read(current.store.read().jobs[0]!)).toBe(message().command);
    service.sweepUnreachable();
    expect(current.store.read().jobs[0]?.status).toBe("worker-unreachable");
    expect(current.payloads.read(current.store.read().jobs[0]!)).toBe(message().command);
  });

  it("fails closed on missing database, mismatched marker, unknown schema, corrupt data and missing legacy marker", () => {
    for (const damage of ["missing-db", "uuid", "schema", "corrupt", "missing-marker"] as const) {
      const dir = fixture();
      const store = open(dir);
      store.close();
      const markerPath = join(dir, "placement-controller.json");
      if (damage === "missing-db") rmSync(store.path);
      if (damage === "uuid") {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        marker.migrationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        writeFileSync(markerPath, JSON.stringify(marker));
      }
      if (damage === "schema") { const db = new DatabaseSync(store.path); db.exec("PRAGMA user_version = 2"); db.close(); }
      if (damage === "corrupt") writeFileSync(store.path, "not a SQLite database");
      if (damage === "missing-marker") rmSync(markerPath);
      expect(() => openPlacementStore(dir, controllerId), damage).toThrow();
      if (damage === "missing-marker") expect(existsSync(markerPath)).toBe(false);
    }
  });

  it("preserves malformed, over-permissive or held-lock legacy state instead of resetting it", () => {
    const dir = fixture();
    const path = join(dir, "placement-controller.json");
    writeFileSync(path, "damaged", { mode: 0o600 });
    expect(() => openPlacementStore(dir, controllerId)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("damaged");
    writeFileSync(path, JSON.stringify(initial));
    chmodSync(path, 0o644);
    expect(() => openPlacementStore(dir, controllerId)).toThrow();
    chmodSync(path, 0o600);
    mkdirSync(join(dir, "placement-controller.lock"));
    expect(() => openPlacementStore(dir, controllerId)).toThrow();
    expect(existsSync(join(dir, "placement.sqlite"))).toBe(false);
  });

  it("refuses loose, symbolic or hard-linked WAL/SHM entries before native SQLite can open them", () => {
    const module = new URL("./placement-store.ts", import.meta.url).href;
    for (const suffix of ["-wal", "-shm"]) for (const damage of ["loose", "symlink", "hardlink"]) {
      const dir = fixture();
      const store = open(dir);
      store.close();
      chmodSync(dir, 0o755);
      const side = `${store.path}${suffix}`;
      rmSync(side, { force: true });
      const foreign = join(dir, "foreign");
      writeFileSync(foreign, "unrelated fixture bytes", { mode: 0o600 });
      if (damage === "loose") {
        writeFileSync(side, "private sidecar fixture", { mode: 0o644 });
        chmodSync(side, 0o644);
      }
      if (damage === "symlink") symlinkSync(foreign, side);
      if (damage === "hardlink") linkSync(foreign, side);
      const script = `import {openPlacementStore} from ${JSON.stringify(module)}; try {openPlacementStore(process.argv[1],process.argv[2]);process.stdout.write('opened')}catch{process.stdout.write('blocked')}`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir, controllerId], { encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout, `${suffix}/${damage}`).toBe("blocked");
      expect(readFileSync(foreign, "utf8")).toBe("unrelated fixture bytes");
      if (damage === "loose") expect(statSync(side).mode & 0o777).toBe(0o644);
      if (damage === "symlink") expect(lstatSync(side).isSymbolicLink()).toBe(true);
      if (damage === "hardlink") expect(statSync(foreign).nlink).toBe(2);
    }
  });

  it("checks live sidecar permissions before reads or acknowledgements without repairing foreign files", () => {
    const current = create();
    const side = `${current.store.path}-wal`;
    expect(existsSync(side)).toBe(true);
    chmodSync(side, 0o644);
    expect(() => current.store.read()).toThrow();
    expect(placementLeaseRoute(owner, "enqueue", message(), current.service)).toMatchObject({ status: 503 });
    expect(statSync(side).mode & 0o777).toBe(0o644);
    chmodSync(side, 0o600);
    expect(current.store.read().jobs).toEqual([]);
  });

  it("rejects a real SQLite write failure before acknowledging and leaves both the queue and lease history unchanged", () => {
    const current = create();
    current.service.enqueue(message());
    ready(current.service);
    const db = new DatabaseSync(current.store.path);
    try {
      db.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON placement_jobs BEGIN SELECT RAISE(FAIL, 'fixture write failure'); END");
      expect(placementLeaseRoute(owner, "claim", { ...fence, hostId: workerId, jobId: "job-1" }, current.service)).toMatchObject({ status: 503 });
      expect(current.service.job("job-1")?.status).toBe("queued");
      expect(current.store.read().leases).toEqual([]);
      db.exec("DROP TRIGGER fixture_fail");
      expect(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).toMatchObject({ reply: { accepted: true } });
    } finally { db.close(); }
  });

  it("reopens and deduplicates every terminal report status", () => {
    for (const status of ["completed", "failed", "killed", "lost"] as const) {
      const current = create();
      current.service.enqueue(message());
      ready(current.service);
      const lease = claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
      const report = { ...finalReport(lease), status };
      current.service.report(report);
      current.store.close();
      const reopened = create(current.dir);
      expect(reopened.service.job("job-1")?.status).toBe(status);
      expect(reopened.service.report(report)).toMatchObject({ reply: { accepted: true } });
      expect(reopened.store.read().leases).toMatchObject([{ ...lease, state: "settled" }]);
    }
  });

  it("recovers verified prepared migrations killed before or after publishing the UUID marker without stealing locks", () => {
    const module = new URL("./placement-store.ts", import.meta.url).href;
    for (const stage of ["before", "after"]) {
      const dir = fixture();
      writeFileSync(join(dir, "placement-controller.json"), JSON.stringify({ controllerId, epoch: 7 }), { mode: 0o600 });
      const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(String(to).endsWith('placement-controller.json')){if(process.argv[3]==='before')process.kill(process.pid,'SIGKILL'); rename(from,to); process.kill(process.pid,'SIGKILL')} return rename(from,to)}; syncBuiltinESMExports(); const {openPlacementStore}=await import(${JSON.stringify(module)}); openPlacementStore(process.argv[1],process.argv[2]);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir, controllerId, stage], { encoding: "utf8", timeout: 10_000 });
      expect(result.signal, result.stderr).toBe("SIGKILL");
      expect(existsSync(join(dir, "placement.sqlite"))).toBe(true);
      expect(existsSync(join(dir, "placement-controller.lock"))).toBe(true);
      expect(() => openPlacementStore(dir, controllerId)).toThrow();
      // The child is verified dead; remove only its abandoned empty fixture lock.
      rmdirSync(join(dir, "placement-controller.lock"));
      const barrierScript = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const sync=fs.fsyncSync; fs.fsyncSync=(fd)=>{if(fs.fstatSync(fd).isDirectory())throw Error('fixture directory barrier failure');sync(fd)};syncBuiltinESMExports();const {openPlacementStore}=await import(${JSON.stringify(module)});try{openPlacementStore(process.argv[1],process.argv[2]);process.stdout.write('opened')}catch{process.stdout.write('blocked')}`;
      const blocked = spawnSync(process.execPath, ["--input-type=module", "-e", barrierScript, dir, controllerId], { encoding: "utf8", timeout: 10_000 });
      expect(blocked.status, blocked.stderr).toBe(0);
      expect(blocked.stdout).toBe("blocked");
      const prepared = new DatabaseSync(join(dir, "placement.sqlite"));
      try { expect(JSON.parse(String(prepared.prepare("SELECT json FROM placement_meta").get()?.json)).phase).toBe("prepared"); }
      finally { prepared.close(); }
      const recovered = open(dir);
      expect(recovered.read().controller).toEqual({ controllerId, epoch: 7 });
      expect(() => loadControllerEpoch(dir, controllerId)).toThrow(/invalid/);
      recovered.close();
      const active = spawnSync(process.execPath, ["--input-type=module", "-e", barrierScript, dir, controllerId], { encoding: "utf8", timeout: 10_000 });
      expect(active.status, active.stderr).toBe(0);
      expect(active.stdout).toBe("blocked");
    }
  });

  it("rolls back an interrupted SQLite write transaction and retains committed native-Node claim/report acknowledgements lost to a crash", () => {
    const current = create();
    current.service.enqueue(message());
    const path = current.store.path;
    current.store.close();
    const rollbackScript = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); const state=JSON.parse(String(db.prepare('SELECT json FROM placement_state').get().json)); state.controller.epoch=9; db.prepare('UPDATE placement_state SET json=? WHERE id=1').run(JSON.stringify(state)); process.kill(process.pid,'SIGKILL');`;
    const rollback = spawnSync(process.execPath, ["--input-type=module", "-e", rollbackScript, path], { encoding: "utf8", timeout: 10_000 });
    expect(rollback.signal, rollback.stderr).toBe("SIGKILL");
    expect(open(current.dir).read().controller).toEqual(initial);
    const storeModule = new URL("./placement-store.ts", import.meta.url).href;
    const serviceModule = new URL("./placement-leases.ts", import.meta.url).href;
    const payloadModule = new URL("./placement-payloads.ts", import.meta.url).href;
    const script = `import {openPlacementStore} from ${JSON.stringify(storeModule)}; import {PlacementLeaseService} from ${JSON.stringify(serviceModule)}; import {PlacementPayloadSpool} from ${JSON.stringify(payloadModule)}; const store=openPlacementStore(process.argv[1],process.argv[2]); const service=new PlacementLeaseService({hostId:process.argv[2],controller:${JSON.stringify(initial)},store,payloads:new PlacementPayloadSpool(process.argv[1]),now:()=>1000}); const fence=${JSON.stringify(fence)}; const sample=${JSON.stringify(sample)}; service.register({...fence,hostId:process.argv[3],role:'worker',capabilities:['shell'],sample}); service.heartbeat({...fence,hostId:process.argv[3],leases:[],admission:{admit:true},sample}); const result=service.claim({...fence,hostId:process.argv[3],jobId:'job-1'}); if(!result.ok||!result.reply.accepted)throw Error('native claim refused'); if(process.argv[4]==='report'){const lease=result.reply.lease; service.report({...fence,jobId:'job-1',hostId:lease.host,leaseId:lease.leaseId,status:'completed',exitCode:0,signal:null,endedAt:2000})} process.kill(process.pid,'SIGKILL');`;
    for (const action of ["claim", "report"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, current.dir, controllerId, workerId, action], { encoding: "utf8", timeout: 10_000 });
      expect(result.signal, result.stderr).toBe("SIGKILL");
      const reopened = create(current.dir);
      const state = reopened.store.read();
      expect(state.leases).toHaveLength(1);
      const lease = state.leases[0]!;
      if (action === "claim") {
        ready(reopened.service);
        expect(claimed(reopened.service.claim({ ...fence, hostId: workerId, jobId: "job-1" })).leaseId).toBe(lease.leaseId);
      } else expect(reopened.service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true } });
      reopened.store.close();
    }
  });

  it("reclaims a native-process payload publication killed before enqueue commit and restores an empty ledger's one-record capacity", () => {
    const current = create(undefined, { now: 1000 }, 1);
    current.store.close();
    const storeModule = new URL("./placement-store.ts", import.meta.url).href;
    const serviceModule = new URL("./placement-leases.ts", import.meta.url).href;
    const payloadModule = new URL("./placement-payloads.ts", import.meta.url).href;
    const script = `import {openPlacementStore} from ${JSON.stringify(storeModule)}; import {PlacementLeaseService} from ${JSON.stringify(serviceModule)}; import {PlacementPayloadSpool} from ${JSON.stringify(payloadModule)}; const put=PlacementPayloadSpool.prototype.put; PlacementPayloadSpool.prototype.put=function(job,command){put.call(this,job,command);process.kill(process.pid,'SIGKILL')}; const store=openPlacementStore(process.argv[1],process.argv[2]); const service=new PlacementLeaseService({hostId:process.argv[2],controller:${JSON.stringify(initial)},store,payloads:new PlacementPayloadSpool(process.argv[1],1),now:()=>1000}); service.enqueue(${JSON.stringify(message())});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, current.dir, controllerId], { encoding: "utf8", timeout: 10_000 });
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    expect(readdirSync(payloadDir)).toHaveLength(1);
    const reopened = create(current.dir, { now: 1000 }, 1);
    expect(reopened.store.read().jobs).toEqual([]);
    expect(readdirSync(payloadDir)).toEqual([]);
    expect(reopened.service.enqueue(message("accepted-after-recovery"))).toMatchObject({ reply: { accepted: true } });
  });

  it("serializes two native-process claims and claim versus takeover without duplicate allocation", async () => {
    const storeModule = new URL("./placement-store.ts", import.meta.url).href;
    const serviceModule = new URL("./placement-leases.ts", import.meta.url).href;
    const payloadModule = new URL("./placement-payloads.ts", import.meta.url).href;
    const script = `import {openPlacementStore} from ${JSON.stringify(storeModule)}; import {PlacementLeaseService} from ${JSON.stringify(serviceModule)}; import {PlacementPayloadSpool} from ${JSON.stringify(payloadModule)}; const store=openPlacementStore(process.argv[1],process.argv[2]); const service=new PlacementLeaseService({hostId:process.argv[2],controller:${JSON.stringify(initial)},store,payloads:new PlacementPayloadSpool(process.argv[1]),now:()=>1000}); const fence=${JSON.stringify(fence)}; const sample=${JSON.stringify(sample)}; service.register({...fence,hostId:process.argv[3],role:'worker',capabilities:['shell'],sample}); service.heartbeat({...fence,hostId:process.argv[3],leases:[],admission:{admit:true},sample}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{const result=process.argv[4]==='claim'?service.claim({...fence,hostId:process.argv[3],jobId:'job-1'}):service.takeover({...fence,controllerId:process.argv[3],epoch:1,reconcile:true}); process.stdout.write(JSON.stringify(result)); store.close()});`;
    function start(dir: string, worker: HostId, action: string) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, controllerId, worker, action], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += String(data); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (data) => { output += String(data); if (output.startsWith("ready\n")) resolve(); });
        child.once("error", reject);
        child.once("exit", (code) => { if (code) reject(new Error(stderr)); });
      });
      const done = new Promise<{ ok: boolean; reply: { accepted: boolean } }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(JSON.parse(output.slice("ready\n".length))) : reject(new Error(stderr)));
      });
      return { child, ready, done };
    }
    for (const secondAction of ["claim", "takeover"]) {
      const current = create();
      current.service.enqueue(message());
      current.store.close();
      const a = start(current.dir, workerId, "claim");
      await a.ready;
      const b = start(current.dir, otherId, secondAction);
      try {
        await b.ready;
        a.child.stdin.end("go");
        b.child.stdin.end("go");
        const results = await Promise.all([a.done, b.done]);
        const state = open(current.dir).read();
        if (secondAction === "claim") {
          expect(results.filter((result) => result.ok && result.reply.accepted)).toHaveLength(1);
          expect(state.leases).toHaveLength(1);
        } else {
          expect(state.controller).toEqual({ controllerId: otherId, epoch: 1 });
          expect(state.leases.length).toBeLessThanOrEqual(1);
          if (state.leases.length) {
            expect(state.leases[0]?.epoch).toBe(0);
            expect(state.jobs[0]?.ranAfterTakeover).toBe(true);
          }
        }
      } finally {
        a.child.kill("SIGKILL");
        b.child.kill("SIGKILL");
      }
    }
  }, 20_000);

  it("measures retained history while avoiding unchanged state writes and repeated terminal payload I/O", () => {
    const current = create();
    const retained = 2000;
    current.store.transaction((state) => {
      for (let index = 0; index < retained; index++) {
        const job = {
          jobId: `retained-${index}`, botId: "fixture", threadId: "history", cwd: "/fixture", timeoutMs: 1000,
          payloadDigest: commandDigest("true"), queuedAt: 1000, status: "completed" as const,
          host: workerId, leaseId: `retained-lease-${index}`, report: { status: "completed" as const, exitCode: 0, signal: null, endedAt: 2000 },
        };
        state.jobs.push({ ...job, fingerprint: placementFingerprint(job) });
        state.leases.push({ ...initial, leaseId: job.leaseId, jobId: job.jobId, host: workerId, state: "settled" });
      }
    });
    let reads = 0;
    let removals = 0;
    const payloads: PlacementPayloads = {
      put: (job, command) => current.payloads.put(job, command),
      read: (job) => { reads++; return current.payloads.read(job); },
      remove: (job) => { removals++; current.payloads.remove(job); },
      reconcile: (jobs) => current.payloads.reconcile(jobs),
    };
    const db = new DatabaseSync(current.store.path);
    try {
      db.exec("CREATE TABLE fixture_state_writes (id INTEGER); CREATE TRIGGER fixture_measure AFTER UPDATE ON placement_state BEGIN INSERT INTO fixture_state_writes VALUES (1); END");
      const start = performance.now();
      const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: current.store, payloads, now: () => 1000 });
      const initializationMs = performance.now() - start;
      const beforeReads = reads;
      const beforeRemovals = removals;
      ready(service);
      const rpcStart = performance.now();
      for (let index = 0; index < 20; index++) service.heartbeat({ ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample });
      const elapsedMs = performance.now() - rpcStart;
      expect(db.prepare("SELECT count(*) AS n FROM fixture_state_writes").get()?.n).toBe(0);
      expect(reads - beforeReads).toBe(0);
      expect(removals - beforeRemovals).toBe(0);
      expect(current.store.read().leases).toHaveLength(retained);
      console.info("placement-history measurement", JSON.stringify({ retained, rpcs: 20, initializationMs: Math.round(initializationMs), elapsedMs: Math.round(elapsedMs), payloadReads: reads - beforeReads, terminalRemovals: removals - beforeRemovals, stateWrites: 0 }));
    } finally { db.close(); }
  });

  it("keeps twenty steady-state heartbeats free of payload I/O with five hundred unresolved commands", () => {
    const current = create();
    current.store.transaction((state) => {
      for (let index = 0; index < PLACEMENT_ACTIVE_LIMIT; index++) {
        const job = { jobId: `active-${index}`, botId: "fixture", threadId: "heartbeat", cwd: "/fixture", timeoutMs: 1000,
          payloadDigest: commandDigest("true"), queuedAt: 1000, status: "queued" as const };
        state.jobs.push({ ...job, fingerprint: placementFingerprint(job) });
      }
    });
    for (const job of current.store.readAll().jobs) current.payloads.put(job, "true");
    const work = { reads: 0, puts: 0, removals: 0, reconciliations: 0, scannedEntries: 0 };
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    const payloads: PlacementPayloads = {
      put: (job, command) => { work.puts++; current.payloads.put(job, command); },
      read: (job) => { work.reads++; return current.payloads.read(job); },
      remove: (job) => { work.removals++; current.payloads.remove(job); },
      reconcile: (jobs) => { work.reconciliations++; work.scannedEntries += readdirSync(payloadDir).length; current.payloads.reconcile(jobs); },
    };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store: current.store, payloads, now: () => 1000 });
    ready(service);
    Object.assign(work, { reads: 0, puts: 0, removals: 0, reconciliations: 0, scannedEntries: 0 });
    current.store.resetMetrics();
    const before = current.store.readAll();
    for (let index = 0; index < 20; index++) expect(service.heartbeat({ ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample })).toMatchObject({ ok: true });
    console.info("placement-active-heartbeat payload work", JSON.stringify({ active: PLACEMENT_ACTIVE_LIMIT, rpcs: 20, ...work }));
    expect(work).toEqual({ reads: 0, puts: 0, removals: 0, reconciliations: 0, scannedEntries: 0 });
    expect(current.store.metrics().rowsWritten).toBe(0);
    expect(current.store.readAll()).toEqual(before);
    expect(readdirSync(payloadDir)).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    claimed(service.claim({ ...fence, hostId: workerId, jobId: "active-0" }));
    expect(work.reads).toBe(1);
    expect(service.dispatch({ ...message("active-1", "true"), timeoutMs: 1000, lease: { ...initial, host: workerId, jobId: "active-1", leaseId: "fixture-dispatch" } })).toMatchObject({ reply: { accepted: true } });
    expect(work.reads).toBe(2);
    expect(work.reconciliations).toBe(0);
    expect(work.removals).toBe(0);
  });

  it("reconciles admission under its writer lock and removes terminal payload only after a separately witnessed commit", () => {
    const current = create();
    const witness = open(current.dir);
    let insideWriter = false;
    let reconciliations = 0;
    const removals: { insideWriter: boolean; committedStatus: string | undefined }[] = [];
    const store: PlacementStore = { ...current.store, close() {}, transactionScope: (scope, change) => current.store.transactionScope(scope, (state) => {
      insideWriter = true;
      try { return change(state); } finally { insideWriter = false; }
    }) };
    const payloads: PlacementPayloads = {
      put: (job, command) => current.payloads.put(job, command), read: (job) => current.payloads.read(job),
      reconcile: (jobs) => { expect(insideWriter).toBe(true); reconciliations++; current.payloads.reconcile(jobs); },
      remove: (job) => {
        removals.push({ insideWriter, committedStatus: witness.readScope({ jobIds: [job.jobId] }).jobs[0]?.status });
        current.payloads.remove(job);
      },
    };
    const service = new PlacementLeaseService({ hostId: controllerId, controller: initial, store, payloads, now: () => 1000 });
    expect(reconciliations).toBe(1);
    service.enqueue(message());
    expect(reconciliations).toBe(2);
    ready(service);
    const lease = claimed(service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    expect(service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true } });
    expect(removals).toEqual([{ insideWriter: false, committedStatus: "completed" }]);
    expect(service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true } });
    service.heartbeat({ ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample });
    expect(removals).toHaveLength(1);
    expect(reconciliations).toBe(2);
  });

  it("keeps indexed hot-path row work constant at two thousand and twenty thousand retained jobs, including cold pruned IDs", () => {
    const measurements = [];
    for (const retained of [2000, 20_000]) {
      const current = create();
      current.store.transaction((state) => {
        for (let index = 0; index < retained; index++) {
          const job = {
            jobId: `cold-${index}`, botId: "fixture", threadId: "history", cwd: "/fixture", timeoutMs: 1000,
            payloadDigest: commandDigest("true"), queuedAt: 1000, status: "completed" as const,
            host: workerId, leaseId: `cold-lease-${index}`, hidden: index < retained - PLACEMENT_RECENT_LIMIT,
            report: { status: "completed" as const, exitCode: 0, signal: null, endedAt: 2000 },
          };
          state.jobs.push({ ...job, fingerprint: placementFingerprint(job) });
          state.leases.push({ ...initial, leaseId: job.leaseId, jobId: job.jobId, host: workerId, state: "settled" });
        }
        state.leases.push({ ...initial, jobId: "cold-0", leaseId: "cold-released", host: workerId, state: "released", revocationId: "fixture-verified-revocation" });
      });
      current.store.resetMetrics();
      const started = performance.now();
      for (let index = 0; index < 20; index++) expect(current.service.controller()).toEqual(initial);
      ready(current.service);
      for (let index = 0; index < 20; index++) current.service.heartbeat({ ...fence, hostId: workerId, leases: [], admission: { admit: true }, sample });
      expect(current.service.claim({ ...fence, hostId: workerId, jobId: "absent" })).toMatchObject({ reply: { accepted: false } });
      expect(current.service.enqueue(message("hot"))).toMatchObject({ reply: { accepted: true } });
      const lease = claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "hot" }));
      current.service.heartbeat({ ...fence, hostId: workerId, leases: [lease.leaseId], admission: { admit: true }, sample });
      current.service.report(finalReport(lease));
      const cold = { ...fence, jobId: "cold-0", botId: "fixture", threadId: "history", cwd: "/fixture", timeoutMs: 1000, command: "true" };
      expect(current.service.enqueue(cold)).toMatchObject({ reply: { accepted: true, duplicate: true, status: "completed" } });
      const coldLease = { ...initial, jobId: "cold-0", leaseId: "cold-lease-0", host: workerId };
      expect(current.service.report(finalReport(coldLease))).toMatchObject({ reply: { accepted: true } });
      expect(current.service.report({ ...finalReport(coldLease), exitCode: 1 })).toMatchObject({ reply: { accepted: false } });
      expect(current.service.dispatch({ ...cold, lease: { ...coldLease, leaseId: "cold-released" } })).toMatchObject({ reply: { accepted: false, reason: "lease_conflict" } });
      expect(current.service.job("cold-0")?.report).toMatchObject({ status: "completed" });
      const display = current.service.jobsList();
      expect(display).toHaveLength(PLACEMENT_RECENT_LIMIT);
      expect(display.some((job) => job.jobId === "cold-0")).toBe(false);
      const work = current.store.metrics();
      expect(work.rowsRead).toBeLessThan(400);
      expect(work.queries).toBeLessThan(400);
      expect(work.rowsWritten).toBeLessThan(10);
      measurements.push(work);
      console.info("normalized-placement scaling", JSON.stringify({ retained, ...work, elapsedMs: Math.round(performance.now() - started) }));
      expect(current.store.readAll().jobs).toHaveLength(retained + 1);
      expect(current.store.readAll().leases).toHaveLength(retained + 2);
      const db = new DatabaseSync(current.store.path);
      try {
        const plan = JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM placement_jobs WHERE job_id=?").all("cold-0"));
        expect(plan).toContain("INDEX");
        expect(plan).not.toContain("SCAN placement_jobs");
      } finally { db.close(); }
    }
    expect(measurements[1]).toEqual(measurements[0]);
  }, 60_000);

  it("refuses the existing five-hundred unresolved bound before payload acceptance and frees capacity only after terminal settlement", () => {
    const current = create();
    current.service.enqueue(message());
    ready(current.service);
    const lease = claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    current.store.transaction((state) => {
      for (let index = 1; index < PLACEMENT_ACTIVE_LIMIT; index++) {
        const job = { jobId: `held-${index}`, botId: "fixture", threadId: "held", cwd: "/fixture", timeoutMs: 1000, payloadDigest: commandDigest("true"), queuedAt: 1000, status: "queued" as const };
        state.jobs.push({ ...job, fingerprint: placementFingerprint(job) });
      }
    });
    const payloadDir = join(current.dir, "placement-payloads", "pending-commands");
    const before = readdirSync(payloadDir);
    expect(placementLeaseRoute(owner, "enqueue", message("capacity-refused"), current.service)).toMatchObject({ status: 409 });
    expect(readdirSync(payloadDir)).toEqual(before);
    expect(current.store.readScope({ jobIds: ["capacity-refused"] }).jobs).toEqual([]);
    expect(current.service.report(finalReport(lease))).toMatchObject({ reply: { accepted: true } });
    expect(current.service.enqueue(message("capacity-reclaimed"))).toMatchObject({ reply: { accepted: true } });
    expect(current.store.readScope({ active: true }).jobs).toHaveLength(PLACEMENT_ACTIVE_LIMIT);
    expect(current.store.readAll().jobs).toHaveLength(PLACEMENT_ACTIVE_LIMIT + 1);
    expect(current.service.enqueue(message())).toMatchObject({ reply: { accepted: true, duplicate: true, status: "completed" } });
    expect(current.store.readScope({ leaseIds: [lease.leaseId] }).leases).toMatchObject([{ ...lease, state: "settled" }]);
  });

  it("pins header and rows to one read snapshot when another writer commits takeover between queries", () => {
    const current = create();
    current.service.enqueue(message());
    ready(current.service);
    claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    const writer = create(current.dir);
    const prepare = DatabaseSync.prototype.prepare;
    let armed = true;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (armed && sql.startsWith("SELECT * FROM placement_jobs WHERE active=1")) {
        armed = false;
        expect(writer.service.takeover({ ...fence, controllerId: otherId, epoch: 1, reconcile: true })).toMatchObject({ reply: { accepted: true } });
      }
      return prepare.call(this, sql);
    });
    try {
      const snapshot = current.store.readScope({ active: true });
      expect(armed).toBe(false);
      expect(snapshot.controller).toEqual(initial);
      expect(snapshot.jobs[0]?.ranAfterTakeover).toBeUndefined();
    } finally { spy.mockRestore(); }
    const next = current.store.readScope({ active: true });
    expect(next.controller).toEqual({ controllerId: otherId, epoch: 1 });
    expect(next.jobs[0]?.ranAfterTakeover).toBe(true);
  });

  it("rejects an unreleased blob-format database rather than silently upgrading its version-one marker", () => {
    const current = create();
    current.store.close();
    const db = new DatabaseSync(current.store.path);
    try {
      const meta = JSON.parse(String(db.prepare("SELECT json FROM placement_meta").get()?.json));
      delete meta.storage;
      db.prepare("UPDATE placement_meta SET json=? WHERE id=1").run(JSON.stringify(meta));
    } finally { db.close(); }
    expect(() => openPlacementStore(current.dir, controllerId)).toThrow();
    expect(JSON.parse(readFileSync(join(current.dir, "placement-controller.json"), "utf8")).format).toBe("botfleet-placement-sqlite");
  });

  it("requires a fresh active scope and orphan marking before an epoch transition can commit", () => {
    const current = create();
    current.service.enqueue(message());
    ready(current.service);
    claimed(current.service.claim({ ...fence, hostId: workerId, jobId: "job-1" }));
    expect(() => current.store.transactionScope({}, (state) => { state.controller = { controllerId: otherId, epoch: 1 }; })).toThrow();
    expect(() => current.store.transactionScope({ active: true }, (state) => { state.controller = { controllerId: otherId, epoch: 1 }; })).toThrow();
    expect(current.service.controller()).toEqual(initial);
    expect(current.service.takeover({ ...fence, controllerId: otherId, epoch: 1, reconcile: true })).toMatchObject({ reply: { accepted: true } });
    expect(current.store.readScope({ active: true }).jobs[0]?.ranAfterTakeover).toBe(true);
  });
});
