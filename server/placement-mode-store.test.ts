import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION, type HostId } from "../shared/placement.ts";
import { openControllerEpochStore } from "./placement-identity.ts";
import { PlacementLeaseService } from "./placement-leases.ts";
import { PlacementModeStore, placementModeRead, placementModeWrite } from "./placement-mode-store.ts";

/** The stored record, read back the way the store writes it. */
const storedRecord = z.object({
  schema: z.literal(1),
  mode: z.string(),
  controllerId: z.string(),
  epoch: z.number(),
  serverId: z.string().nullable(),
  allowOverflowToThisMac: z.boolean(),
  appliedAt: z.number(),
}).strict();

const controllerId: HostId = "mac:11111111-1111-4111-8111-111111111111";
const otherController: HostId = "mac:33333333-3333-4333-8333-333333333333";
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };
const stranger = { localOwner: false, fromCompanion: false, viaNamedTunnel: false };

/** The real lease service over its durable epoch store, so the record's epoch
 *  is the lease service's epoch and not a number the test made up. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bf-placement-mode-"));
  const epochStore = openControllerEpochStore(dir, controllerId);
  const leases = new PlacementLeaseService({
    hostId: controllerId,
    controller: epochStore.read(),
    controllerStore: epochStore,
  });
  const store = new PlacementModeStore(join(dir, "jobs"), {
    controller: () => leases.controller(),
    hostId: controllerId,
    now: () => 1_700_000_000_000,
  });
  return { dir, leases, store, path: join(dir, "jobs", "placement-mode.json") };
}

const serverFirst = { mode: "serverFirst", controllerId, epoch: 0, serverId: controllerId, allowOverflowToThisMac: false } as const;

describe("the placement mode record", () => {
  it("reports This Mac Only and acknowledges nothing before a record is written", () => {
    const { store } = fixture();
    const view = store.read();
    expect(view.record.mode).toBe("localOnly");
    expect(view.record.epoch).toBe(0);
    expect(view.acknowledged).toBe(false);
    expect(view.appliedAt).toBeNull();
  });

  it("keeps the mode and the epoch across a restart of the store", () => {
    const { dir, store, path } = fixture();
    const written = store.apply(serverFirst);
    expect(written.ok).toBe(true);

    // A restart: a new store over the same data directory, as a fresh
    // process would open it.
    const restarted = new PlacementModeStore(join(dir, "jobs"), {
      controller: () => ({ controllerId, epoch: 0 }),
      hostId: controllerId,
      now: () => 1_800_000_000_000,
    });
    const view = restarted.read();
    expect(view.record.mode).toBe("serverFirst");
    expect(view.record.epoch).toBe(0);
    expect(view.record.controllerId).toBe(controllerId);
    expect(view.acknowledged).toBe(true);
    expect(view.appliedAt).toBe(1_700_000_000_000);
    // The restart did not rewrite the record.
    expect(storedRecord.parse(JSON.parse(readFileSync(path, "utf8"))).appliedAt).toBe(1_700_000_000_000);
  });

  it("refuses a stale write with the current controller pair and keeps the record", () => {
    const { leases, store } = fixture();
    expect(store.apply(serverFirst).ok).toBe(true);

    // The controller role moves on, so the old fence is stale.
    const takeover = leases.takeover({ version: PLACEMENT_WIRE_VERSION, controllerId: otherController, epoch: 1, reconcile: false });
    expect(takeover.ok && takeover.reply.accepted).toBe(true);

    const stale = store.apply(serverFirst);
    expect(stale.ok).toBe(false);
    expect(stale.ok ? "" : stale.reason).toMatch(/stale controller epoch 0/);
    expect(stale.ok || stale.kind !== "stale-fence" ? null : stale.controller).toEqual({ controllerId: otherController, epoch: 1 });
    // The refused write changed nothing.
    expect(store.read().record.mode).toBe("serverFirst");
    expect(store.read().acknowledged).toBe(false);
  });

  it("refuses a write from another controller at the current epoch", () => {
    const { store } = fixture();
    const refused = store.apply({ ...serverFirst, controllerId: otherController });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toMatch(/stale controller epoch/);
  });

  it("keeps one epoch and not two: the record holds the lease service's epoch", () => {
    const { store, path } = fixture();
    expect(store.apply(serverFirst).ok).toBe(true);
    const raw = storedRecord.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(raw.epoch).toBe(0);
    expect(Object.keys(raw).filter((key) => key.toLowerCase().includes("epoch"))).toEqual(["epoch"]);
  });

  it("holds the record in a private file", () => {
    const { store, path } = fixture();
    expect(store.apply(serverFirst).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("fails closed on an unreadable record and preserves it", () => {
    const { dir, store, path } = fixture();
    mkdirSync(join(dir, "jobs"), { recursive: true });
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(() => store.read()).toThrow(/mode record is invalid/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("fails closed on a record ahead of the controller fence", () => {
    const { dir, store, path } = fixture();
    mkdirSync(join(dir, "jobs"), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 1, mode: "serverFirst", controllerId, epoch: 5, serverId: controllerId, allowOverflowToThisMac: false, appliedAt: 1 }), { mode: 0o600 });
    expect(() => store.read()).toThrow(/ahead of the controller fence/);
  });

  it("refuses a mode that does not match its server", () => {
    const { store } = fixture();
    const noServer = store.apply({ ...serverFirst, serverId: null });
    expect(noServer.ok).toBe(false);
    expect(noServer.ok ? "" : noServer.reason).toMatch(/needs a server/);
    expect(noServer.ok || noServer.kind !== "invalid-mode" ? "wrong" : "invalid-mode").toBe("invalid-mode");
    const otherServer = store.apply({ ...serverFirst, serverId: otherController });
    expect(otherServer.ok).toBe(false);
    expect(otherServer.ok ? "" : otherServer.reason).toMatch(/names server/);
    const localWithServer = store.apply({ mode: "localOnly", controllerId, epoch: 0, serverId: controllerId, allowOverflowToThisMac: false });
    expect(localWithServer.ok).toBe(false);
    expect(localWithServer.ok ? "" : localWithServer.reason).toMatch(/names no server/);
  });

  it("answers 400 for a mode that does not match its server, and carries no controller state", () => {
    const { store } = fixture();
    const response = placementModeWrite(owner, { ...serverFirst, serverId: null }, store);
    expect(response.status).toBe(400);
    expect(response.status === 400 ? response.body : null).toEqual({ error: expect.stringMatching(/needs a server/) });
  });

  it("reports a post-commit flush failure without reporting a failed write", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-mode-"));
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const logged: string[] = [];
    const jobsDir = join(dir, "jobs");
    // Write and traverse, but no read:  the record can be written, and the
    // directory cannot be opened for the flush that follows the commit.
    mkdirSync(jobsDir, { recursive: true, mode: 0o300 });
    const store = new PlacementModeStore(jobsDir, {
      controller: () => leases.controller(),
      hostId: controllerId,
      now: () => 1_700_000_000_000,
      log: (message) => logged.push(message),
    });
    const write = store.apply(serverFirst);
    // The rename is the commit, so the record is written and the write is
    // acknowledged, and the flush failure is reported instead of refused.
    expect(write.ok).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/directory flush failed/);
    expect(store.read().acknowledged).toBe(true);
    chmodSync(jobsDir, 0o700);
  });

  it("refuses a write that could not be committed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-placement-mode-"));
    const epochStore = openControllerEpochStore(dir, controllerId);
    const leases = new PlacementLeaseService({
      hostId: controllerId,
      controller: epochStore.read(),
      controllerStore: epochStore,
    });
    const jobsDir = join(dir, "jobs");
    // Read and traverse, but no write:  the record cannot be written at all.
    mkdirSync(jobsDir, { recursive: true, mode: 0o500 });
    const store = new PlacementModeStore(jobsDir, {
      controller: () => leases.controller(),
      hostId: controllerId,
      now: () => 1_700_000_000_000,
    });
    const response = placementModeWrite(owner, serverFirst, store);
    expect(response.status).toBe(503);
    expect(response.status === 503 ? response.body : null).toMatchObject({ error: expect.stringMatching(/could not be written/) });
    chmodSync(jobsDir, 0o700);
  });

  it("removes its temporary files", () => {
    const { dir } = fixture();
    rmSync(dir, { recursive: true, force: true });
    expect(() => statSync(dir)).toThrow();
  });
});

describe("the placement mode route", () => {
  it("answers the owner and refuses everyone else", () => {
    const { store } = fixture();
    expect(placementModeRead(owner, store).status).toBe(200);
    expect(placementModeRead(stranger, store).status).toBe(403);
    expect(placementModeRead({ localOwner: true, fromCompanion: true, viaNamedTunnel: false }, store).status).toBe(403);
    expect(placementModeRead({ localOwner: true, fromCompanion: false, viaNamedTunnel: true }, store).status).toBe(403);
    expect(placementModeWrite(stranger, serverFirst, store).status).toBe(403);
  });

  it("refuses a body it does not understand", () => {
    const { store } = fixture();
    expect(placementModeWrite(owner, { ...serverFirst, extra: true }, store).status).toBe(400);
    expect(placementModeWrite(owner, { ...serverFirst, epoch: -1 }, store).status).toBe(400);
    expect(placementModeWrite(owner, { ...serverFirst, mode: "whatever" }, store).status).toBe(400);
  });

  it("answers 409 with the current pair for a stale write", () => {
    const { leases, store } = fixture();
    const takeover = leases.takeover({ version: PLACEMENT_WIRE_VERSION, controllerId: otherController, epoch: 1, reconcile: false });
    expect(takeover.ok && takeover.reply.accepted).toBe(true);
    const response = placementModeWrite(owner, serverFirst, store);
    expect(response.status).toBe(409);
    expect(response.status === 409 ? response.body : null).toMatchObject({ controllerId: otherController, epoch: 1 });
  });

  it("answers the live fence with the record it holds", () => {
    const { store } = fixture();
    expect(placementModeWrite(owner, serverFirst, store).status).toBe(200);
    const response = placementModeRead(owner, store);
    expect(response.status).toBe(200);
    expect(response.status === 200 ? response.body : null).toMatchObject({
      controllerId,
      epoch: 0,
      mode: "serverFirst",
      serverId: controllerId,
      acknowledged: true,
      appliedAt: 1_700_000_000_000,
      reason: null,
    });
  });
});
