import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { HostId } from "../shared/placement.ts";
import { loadControllerEpoch } from "./placement-identity.ts";
import { openRollbackPlacementAuthority, type ReadonlyPlacementController } from "./placement-readonly.ts";
import { openPlacementStore, type PlacementStore } from "./placement-store.ts";

const hostId: HostId = "server:11111111-1111-4111-8111-111111111111";
const otherId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];
const stores: Array<PlacementStore | ReadonlyPlacementController> = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "bf-placement-bridge-")); dirs.push(dir); return dir; }
function writer(dir: string) { const store = openPlacementStore(dir, hostId); stores.push(store); return store; }
function reader(dir: string) {
  const authority = openRollbackPlacementAuthority(dir, hostId);
  if (authority.kind !== "readonly") throw new Error("fixture did not select the passive bridge");
  stores.push(authority.reader);
  return authority.reader;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("conservative placement rollback reader", () => {
  it.each(["win32", "freebsd", "aix"] as const)("refuses normalized rollback on unsupported %s without changing retained bytes", (platform) => {
    const dir = fixture();
    writer(dir).close();
    const before = readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)), mode: statSync(join(dir, name)).mode }));
    expect(() => openRollbackPlacementAuthority(dir, hostId, platform)).toThrow(/Placement persistence/);
    expect(readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)), mode: statSync(join(dir, name)).mode }))).toEqual(before);
    const legacy = fixture();
    const marker = join(legacy, "placement-controller.json");
    writeFileSync(marker, JSON.stringify({ controllerId: hostId, epoch: 7 }), { mode: 0o600 });
    const legacyBefore = readFileSync(marker);
    expect(openRollbackPlacementAuthority(legacy, hostId, platform).kind).toBe("legacy");
    expect(readFileSync(marker)).toEqual(legacyBefore);
    expect(readdirSync(legacy)).toEqual(["placement-controller.json"]);
  });

  it("keeps legacy bootstrap unchanged without creating SQLite or payload storage", () => {
    const dir = fixture();
    const legacy = openRollbackPlacementAuthority(dir, hostId);
    expect(legacy.kind).toBe("legacy");
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: hostId, epoch: 0 });
    expect(existsSync(join(dir, "placement.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "placement-payloads"))).toBe(false);
  });
  it("reads fresh WAL commits without checkpointing or changing the logical authority", () => {
    const dir = fixture();
    const store = writer(dir);
    const view = reader(dir);
    expect(view.controller()).toEqual({ controllerId: hostId, epoch: 0 });
    store.transactionScope({ active: true }, (state) => { state.controller = { controllerId: otherId, epoch: 8 }; state.reconcile = true; });
    const dbBytes = readFileSync(store.path);
    const walBytes = readFileSync(`${store.path}-wal`);
    const markerBytes = readFileSync(join(dir, "placement-controller.json"));
    const state = store.readAll();
    expect(view.controller()).toEqual({ controllerId: otherId, epoch: 8 });
    expect(view.controller()).toEqual({ controllerId: otherId, epoch: 8 });
    expect(store.readAll()).toEqual(state);
    expect(readFileSync(store.path)).toEqual(dbBytes);
    expect(readFileSync(`${store.path}-wal`)).toEqual(walBytes);
    expect(readFileSync(join(dir, "placement-controller.json"))).toEqual(markerBytes);
  });
  it("never activates a prepared database even with a matching visible marker", () => {
    const dir = fixture();
    writer(dir).close();
    const db = new DatabaseSync(join(dir, "placement.sqlite"));
    const meta = JSON.parse(String(db.prepare("SELECT json FROM placement_meta").get()?.json));
    db.prepare("UPDATE placement_meta SET json=?").run(JSON.stringify({ ...meta, phase: "prepared" }));
    db.close();
    const bytes = readFileSync(join(dir, "placement.sqlite"));
    expect(() => reader(dir)).toThrow(/Placement persistence/);
    expect(readFileSync(join(dir, "placement.sqlite"))).toEqual(bytes);
  });
  it("opens a fully closed ledger read-only without changing its database bytes", () => {
    const dir = fixture();
    const store = writer(dir);
    store.close();
    const bytes = readFileSync(store.path);
    const view = reader(dir);
    expect(view.controller()).toEqual({ controllerId: hostId, epoch: 0 });
    view.close();
    expect(readFileSync(store.path)).toEqual(bytes);
  });
  it("fails closed for unknown schema, missing database, orphan database and changed marker", () => {
    const dir = fixture();
    writer(dir).close();
    const db = new DatabaseSync(join(dir, "placement.sqlite"));
    db.exec("PRAGMA user_version=2"); db.close();
    expect(() => reader(dir)).toThrow(/Placement persistence/);
    rmSync(join(dir, "placement.sqlite"));
    expect(() => reader(dir)).toThrow(/Placement persistence/);
    const orphan = fixture();
    writeFileSync(join(orphan, "placement.sqlite"), "unexplained", { mode: 0o600 });
    expect(() => openRollbackPlacementAuthority(orphan, hostId)).toThrow(/Placement persistence/);
    const liveDir = fixture();
    writer(liveDir);
    const view = reader(liveDir);
    writeFileSync(join(liveDir, "placement-controller.json"), JSON.stringify({ controllerId: hostId, epoch: 0 }));
    expect(() => view.controller()).toThrow(/Placement persistence/);
  });
  it("rejects public sidecars before opening SQLite and detects permission changes on reads", () => {
    const dir = fixture();
    const store = writer(dir);
    const view = reader(dir);
    chmodSync(`${store.path}-wal`, 0o644);
    expect(() => reader(dir)).toThrow(/Placement persistence/);
    expect(() => view.controller()).toThrow(/Placement persistence/);
    chmodSync(`${store.path}-wal`, 0o600);
    expect(view.controller()).toEqual({ controllerId: hostId, epoch: 0 });
  });
});
