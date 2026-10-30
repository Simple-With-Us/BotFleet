import { copyFileSync, mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStorageDevice, storageDeviceGuard, STORAGE_OFFLINE_EXIT_CODE } from "./storage-device.ts";
import { admissionRefusal, createHostProbe } from "./jobs/admission.ts";
import { resolveJobsSettings } from "./jobs/registry.ts";
import { hostResourcesReport } from "./host-resources.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("dedicated-volume device guard", () => {
  it("keeps the copied bootstrap checker independent of the code checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "bf-storage-bootstrap-"));
    const copy = join(root, "check-storage.mjs");
    copyFileSync(new URL("../deploy/linux-server/check-storage.mjs", import.meta.url), copy);
    try {
      const code = `import { checkStorageDevice } from ${JSON.stringify(pathToFileURL(copy).href)}; process.stdout.write(JSON.stringify(checkStorageDevice('/fixture-data', path => ({dev: path === '/' ? 1 : 2}))));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ online: true, rootDevice: "1", dataDevice: "2" });
    } finally { await removeTempDir(root); }
  });
  it("refuses root, missing and invalid devices without writing anything", () => {
    expect(checkStorageDevice("/data", () => ({ dev: 1 })).reason).toContain("is on the root device; refusing to start");
    expect(checkStorageDevice("/data", () => { throw new Error("offline"); }).online).toBe(false);
    expect(checkStorageDevice("/data", () => ({ dev: NaN })).online).toBe(false);
    expect(checkStorageDevice("/data", (path) => ({ dev: path === "/" ? 1n : 2n }))).toEqual({ online: true, rootDevice: "1", dataDevice: "2" });
  });

  it("pins the first safe device and refuses mount loss or replacement", () => {
    let data = 2;
    const guard = storageDeviceGuard("/data", (path) => ({ dev: path === "/" ? 1 : data }));
    expect(guard.initial.online).toBe(true);
    data = 1;
    expect(guard.sample().online).toBe(false);
    data = 3;
    expect(guard.sample().reason).toContain("changed device");
    data = 2;
    expect(guard.sample().online).toBe(true);
  });

  it("refuses admission and data-disk reads while still reporting root disk separately", () => {
    const reads: string[] = [];
    const state = { online: false, dataDevice: "1", rootDevice: "1", reason: "offline" };
    const probe = createHostProbe({ platform: "linux", storageState: () => state, readLinuxMeminfo: () => "", readHostLoad: () => null, totalMemory: () => 1,
      statfs: (path) => { reads.push(path); return { bsize: 1, blocks: 100, bavail: 50, files: 100, ffree: 0 }; }, realPath: (path) => path, readMountinfo: () => "" });
    expect(admissionRefusal(probe, { maxSwapPercent: 98, minFreeDiskBytes: 1 }, "/data", false)).toContain("Server storage offline");
    const report = hostResourcesReport({ hostId: "server:11111111-1111-4111-8111-111111111111", version: null, platform: "linux", dataDir: "/data", probe,
      thresholds: () => ({ maxSwapPercent: 98, minFreeDiskBytes: 1, minFreeInodes: 1 }), readText: () => { throw new Error("fixture"); } });
    expect(report.storage?.online).toBe(false);
    expect(report.sample.diskFreeBytes).toBeNull();
    expect(report.sample.rootDiskFreeBytes).toBe(50);
    expect(reads).toEqual(["/"]);
    expect(report.enforcement.disk).toMatchObject({ kind: "notApplied", reason: expect.stringContaining("Server storage offline") });
    expect(report.enforcement.inodes).toMatchObject({ kind: "notApplied", reason: expect.stringContaining("Server storage offline") });
    const noInodeGate = hostResourcesReport({ hostId: "server:11111111-1111-4111-8111-111111111111", version: null, platform: "linux", dataDir: "/data", probe,
      thresholds: () => ({ maxSwapPercent: 98, minFreeDiskBytes: 1 }), readText: () => { throw new Error("fixture"); } });
    expect(noInodeGate.enforcement.inodes).toEqual({ kind: "unsupported", reason: "No inode admission gate is active" });
    expect(noInodeGate.enforcement.disk).toMatchObject({ kind: "notApplied", reason: expect.stringContaining("Server storage offline") });
  });

  it("refuses a device loss during one disk/inode observation without retrying unknown readings", () => {
    let dataDevice = 2;
    let deviceChecks = 0;
    let diskReads = 0;
    const guard = storageDeviceGuard("/data", (path) => ({ dev: path === "/" ? 1 : dataDevice }));
    const probe = createHostProbe({ platform: "linux", readLinuxMeminfo: () => "", storageState: () => { deviceChecks++; return guard.sample(); },
      statfs: () => { diskReads++; dataDevice = 1; return { bsize: 1, blocks: 100, bavail: 50, files: 100, ffree: 50 }; } });
    expect(admissionRefusal(probe, { maxSwapPercent: 98, minFreeDiskBytes: 1, minFreeInodes: 1 }, "/data", false)).toContain("Server storage offline");
    expect(diskReads).toBe(1);
    expect(deviceChecks).toBe(2);
  });

  it.skipIf(process.platform === "win32")("checks storage before opening an application log or starting the harness", async () => {
    const root = mkdtempSync(join(tmpdir(), "bf-storage-boot-"));
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "logs"));
    const nodeStub = join(root, "fixture-node");
    writeFileSync(nodeStub, "#!/bin/sh\ncase \"$1\" in */check-storage.mjs) echo 'data dir fixture is on the root device; refusing to start' >&2; exit 78;; *) echo 'unexpected harness execution' >&2; exit 99;; esac\n", { mode: 0o700 });
    try {
      const result = spawnSync("/bin/sh", [new URL("../deploy/linux-server/start.sh", import.meta.url).pathname, root, new URL("..", import.meta.url).pathname.replace(/\/$/, ""), nodeStub], { encoding: "utf8" });
      expect(result.status).toBe(STORAGE_OFFLINE_EXIT_CODE);
      expect(result.stderr).toContain("is on the root device; refusing to start");
      expect(existsSync(join(root, "logs", "server.log"))).toBe(false);
      expect(existsSync(join(root, "data", "host-id"))).toBe(false);
    } finally { await removeTempDir(root); }
  });
});

describe("optional inode floor", () => {
  const probe = { swapUsedPercent: () => 0, freeDiskBytes: () => 100, freeInodes: () => 0 };
  it("keeps the floor absent by default and refuses below an explicit floor", () => {
    expect(resolveJobsSettings(undefined).admission.minFreeInodes).toBeUndefined();
    expect(admissionRefusal(probe, { maxSwapPercent: 98, minFreeDiskBytes: 1 }, "/data", false)).toBeNull();
    expect(admissionRefusal(probe, { maxSwapPercent: 98, minFreeDiskBytes: 1, minFreeInodes: 10 }, "/data", false)).toContain("short on inodes");
    expect(resolveJobsSettings({ admission: { minFreeInodes: 10.9 } }).admission.minFreeInodes).toBe(10);
    expect(resolveJobsSettings({ admission: { minFreeInodes: -1 } }).admission.minFreeInodes).toBe(0);
    expect(admissionRefusal({ ...probe, freeInodes: () => null }, { maxSwapPercent: 98, minFreeDiskBytes: 1, minFreeInodes: 10 }, "/data", false)).toBeNull();
  });
});
