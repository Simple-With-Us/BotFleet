import { describe, expect, it, vi } from "vitest";
import { denyReason } from "../companion/src/routes.ts";
import { createHostProbe, type CapacityHostProbe } from "./jobs/admission.ts";
import { hostResourcesReport, hostResourcesResponse, ownCgroupDirectory, type HostResourcesDeps } from "./host-resources.ts";

const cgroupMount = "29 24 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw";
const meminfo = "MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\nSwapTotal: 4194304 kB\nSwapFree: 3145728 kB\n";
const disk = { bsize: 4096, blocks: 1000, bavail: 250, files: 100, ffree: 40 };
function probe(platform: NodeJS.Platform = "linux") {
  return createHostProbe({
    platform, now: () => 1000, readLinuxMeminfo: () => meminfo,
    readHostLoad: () => ({ load1: 32, cores: 8 }), totalMemory: () => 16 * 1024 ** 3,
    statfs: () => disk, realPath: (path) => path, readMountinfo: () => "41 29 8:16 / /data rw - ext4 /dev/fixture rw\n29 1 8:1 / / rw - ext4 /dev/root rw",
    readDarwinSwap: async () => "total = 4096.00M used = 1024.00M free = 3072.00M",
  });
}
function deps(files: Record<string, string> = {}): HostResourcesDeps {
  return {
    hostId: "server:11111111-1111-4111-8111-111111111111", version: "fixture-version", platform: "linux", dataDir: "/data/jobs", probe: probe(),
    thresholds: () => ({ maxSwapPercent: 91, minFreeDiskBytes: 1234 }),
    readText: (path) => {
      const text = ({ "/proc/self/cgroup": "0::/system.slice/botfleet-fixture.service", "/proc/self/mountinfo": cgroupMount, ...files })[path];
      if (text === undefined) throw new Error("fixture file unavailable");
      return text;
    },
  };
}
const file = (name: string) => `/sys/fs/cgroup/system.slice/botfleet-fixture.service/${name}`;

describe("host capacity probe", () => {
  it("uses admission's cached swap reading and disk filesystem with exact units", () => {
    const read = vi.fn(() => meminfo);
    const p = createHostProbe({ platform: "linux", now: () => 1000, readLinuxMeminfo: read, statfs: () => disk, readHostLoad: () => ({ load1: 32, cores: 8 }), totalMemory: () => 16 * 1024 ** 3, realPath: (path) => path, readMountinfo: () => "29 1 8:1 / / rw - ext4 /dev/root rw" });
    expect(p.swapUsedPercent()).toBe(25);
    expect(p.capacitySample("/data")).toMatchObject({
      cores: 8, loadPerCore: 4, ramTotalBytes: 16 * 1024 ** 3, ramAvailableBytes: 8 * 1024 ** 3, memoryAvailablePercent: 50,
      swapTotalBytes: 4 * 1024 ** 3, swapUsedBytes: 1024 ** 3, diskTotalBytes: 4096000, diskFreeBytes: 1024000,
      inodesTotal: 100, inodesFree: 40, rootDiskFreeBytes: 1024000, memoryPressure: null,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(p.freeDiskBytes("/data")).toBe(1024000);
  });

  it("preserves unknown and absent swap rather than claiming zero usage", () => {
    const p = createHostProbe({ platform: "linux", readLinuxMeminfo: () => { throw new Error("unavailable"); }, totalMemory: () => NaN, readHostLoad: () => null, statfs: () => { throw new Error("offline"); }, realPath: (path) => path, readMountinfo: () => { throw new Error("unavailable"); } });
    const sample = p.capacitySample("/data");
    for (const [key, value] of Object.entries(sample)) if (key !== "at") expect(value, key).toBeNull();
    const noSwap = createHostProbe({ platform: "linux", readLinuxMeminfo: () => "SwapTotal: 0 kB\nSwapFree: 0 kB\n", totalMemory: () => 100, readHostLoad: () => null, statfs: () => disk, realPath: (path) => path, readMountinfo: () => "" });
    expect(noSwap.swapUsedPercent()).toBeNull();
    expect(noSwap.capacitySample("/data").swapTotalBytes).toBe(0);
  });

  it("does not turn macOS free pages into an invented memory-availability signal", async () => {
    const p = probe("darwin");
    await Promise.resolve();
    const sample = p.capacitySample("/data");
    expect(sample.ramAvailableBytes).toBeNull();
    expect(sample.memoryAvailablePercent).toBeNull();
    expect(sample.memoryPressure).toBeNull();
    expect(sample.swapUsedBytes).toBe(1024 ** 3);
  });

  it("resolves data-directory aliases and keeps unsupported inode statistics unknown", () => {
    const p = createHostProbe({ platform: "linux", readLinuxMeminfo: () => meminfo, totalMemory: () => 100,
      readHostLoad: () => null, statfs: () => ({ ...disk, files: 0, ffree: 0 }), realPath: () => "/data/real-folder",
      readMountinfo: () => "29 1 8:16 / /data rw - ext4 /dev/fixture rw" });
    expect(p.capacitySample("/alias")).toMatchObject({ dataVolume: { device: "8:16", mountPoint: "/data" }, inodesTotal: null, inodesFree: null });
  });
});

describe("observed enforcement", () => {
  it("reads finite limits only from the current process's cgroup", () => {
    const d = deps({ [file("cpu.max")]: "200000 100000", [file("memory.max")]: "1073741824", [file("memory.high")]: "536870912", [file("memory.swap.max")]: "0", [file("io.max")]: "8:16 rbps=123456 wbps=max", [file("pids.max")]: "200" });
    const report = hostResourcesReport(d);
    expect(report.enforcement.cpu.kind).toBe("kernelCap");
    expect(report.enforcement.memory.kind).toBe("kernelCap");
    expect(report.enforcement.swap.kind).toBe("kernelCap");
    expect(report.enforcement.io.kind).toBe("kernelCap");
    expect(report.enforcement.disk.kind).toBe("gateOnly");
    expect(report.enforcement.inodes.kind).toBe("unsupported");
    expect(report.observedLimits["memory.swap.max"]).toBe("0");
    expect(report.capabilities).toEqual(["shell"]);
    expect(report.admission).toEqual({ maxSwapPercent: 91, minFreeDiskBytes: 1234, unknownReading: "admit" });
    expect(report.sample.dataVolume).toEqual({ device: "8:16", mountPoint: "/data" });
    expect(report.limitations.join(" ")).toMatch(/outside this cgroup/);
  });

  it("never treats desired settings, memory.high, weights, unlimited or malformed values as caps", () => {
    for (const value of ["max", "-1", "garbage", "99999999999999999999999999999"]) {
      const report = hostResourcesReport(deps({ [file("memory.max")]: value, [file("memory.high")]: "123", [file("cpu.max")]: "max 100000", [file("io.max")]: "8:16 rbps=max wbps=max", [file("io.weight")]: "default 200" }));
      expect(report.enforcement.memory.kind).toBe("gateOnly");
      expect(report.enforcement.cpu.kind).toBe("priorityOnly");
      expect(report.enforcement.io.kind).toBe("unsupported");
    }
    const missing = hostResourcesReport({ ...deps(), readText: () => { throw new Error("unreadable"); } });
    expect(Object.values(missing.observedLimits).every((value) => value === null)).toBe(true);
    expect(missing.limitations.join(" ")).toMatch(/enforcement is unknown/);
    expect(hostResourcesReport(deps({ [file("io.max")]: "8:32 rbps=1000" })).enforcement.io.kind).toBe("unsupported");
  });

  it("reports honest macOS gates and background priority without reading Linux files", () => {
    const read = vi.fn(() => { throw new Error("must not read cgroups on Mac"); });
    const report = hostResourcesReport({ ...deps(), platform: "darwin", probe: probe("darwin"), readText: read });
    expect(read).not.toHaveBeenCalled();
    expect(report.capabilities).toEqual(["shell", "macos", "desktop"]);
    expect(Object.values(report.enforcement).some((state) => state.kind === "kernelCap")).toBe(false);
    expect(report.enforcement.cpu.kind).toBe("priorityOnly");
  });

  it("does not label unreadable admission probes as active protection", () => {
    const p = createHostProbe({ platform: "linux", readLinuxMeminfo: () => { throw new Error("offline"); },
      totalMemory: () => 100, readHostLoad: () => null, statfs: () => { throw new Error("offline"); },
      realPath: (path) => path, readMountinfo: () => "" });
    const report = hostResourcesReport({ ...deps(), probe: p });
    expect(report.enforcement.memory.kind).toBe("notApplied");
    expect(report.enforcement.swap.kind).toBe("notApplied");
    expect(report.enforcement.disk.kind).toBe("notApplied");
    expect(report.admission.unknownReading).toBe("admit");
  });
});

describe("host owner route boundary", () => {
  it("refuses remote, companion and named-tunnel callers before any sampling", () => {
    const p: CapacityHostProbe = { capacitySample: () => { throw new Error("must not sample"); }, swapUsedPercent: () => null, freeDiskBytes: () => null };
    for (const caller of [
      { localOwner: false, fromCompanion: false, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: true, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: false, viaNamedTunnel: true },
    ]) expect(hostResourcesResponse(caller, { ...deps(), probe: p }).status).toBe(403);
    expect(denyReason({ method: "GET", path: "/api/host/resources", authenticated: true })?.status).toBe(404);
    expect(hostResourcesResponse({ localOwner: true, fromCompanion: false, viaNamedTunnel: false }, deps()).status).toBe(200);
  });

});

it("resolves cgroup v2 mount roots and rejects v1, traversal and mismatched roots", () => {
  expect(ownCgroupDirectory("0::/system.slice/botfleet-fixture.service", cgroupMount)).toBe("/sys/fs/cgroup/system.slice/botfleet-fixture.service");
  expect(ownCgroupDirectory("0::/a/b", "29 24 0:26 /a /sys/fs/cgroup rw - cgroup2 cgroup rw")).toBe("/sys/fs/cgroup/b");
  expect(ownCgroupDirectory("1:memory:/a", cgroupMount)).toBeNull();
  expect(ownCgroupDirectory("0::/a/../b", cgroupMount)).toBeNull();
  expect(ownCgroupDirectory("0::/other", "29 24 0:26 /a /sys/fs/cgroup rw - cgroup2 cgroup rw")).toBeNull();
});
