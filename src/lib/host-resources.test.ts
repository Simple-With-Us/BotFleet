// Settings → Resources helpers: the saved-vs-applied copy is exact (the
// plan's enforcement sentences and recipe 9's mismatch lines), every number
// carries its unit, and times read Central 12-hour.
import { describe, expect, it } from "vitest";
import type { CapacitySample, EnforcementState, HostResourcesReport } from "../../shared/placement.ts";
import {
  admissionRows,
  enforcementSentence,
  formatBytes,
  formatCentralTime,
  formatCount,
  hostNoun,
  hostResourcesReportSchema,
  hostSubtitle,
  nextRefreshState,
  noCapacitySentence,
  resourceRows,
} from "./host-resources";

const GB = 1024 ** 3;

function sample(overrides: Partial<CapacitySample> = {}): CapacitySample {
  return {
    at: Date.UTC(2026, 9, 29, 19, 14, 0),
    cores: 10,
    loadPerCore: 2.41,
    ramTotalBytes: 32 * GB,
    ramAvailableBytes: 20 * GB,
    memoryPressure: null,
    memoryAvailablePercent: 63,
    swapTotalBytes: 4 * GB,
    swapUsedBytes: 3 * GB,
    diskTotalBytes: 100 * GB,
    diskFreeBytes: 60 * GB,
    inodesTotal: 6_000_000,
    inodesFree: 5_000_000,
    dataVolume: { device: "8:16", mountPoint: "/mnt/fleet-extra" },
    rootDiskFreeBytes: 10 * GB,
    storage: { online: true, dataDevice: "8:16", rootDevice: "8:1" },
    ...overrides,
  };
}

function gate(): EnforcementState {
  return { kind: "gateOnly" };
}

function report(overrides: Partial<HostResourcesReport> = {}): HostResourcesReport {
  return {
    hostId: "mac:12345678-1234-1234-1234-123456789012",
    version: "1.2.3",
    platform: "darwin",
    capabilities: ["shell", "macos", "desktop"],
    sample: sample(),
    storage: { online: true, dataDevice: "8:16", rootDevice: "8:1" },
    admission: {
      maxSwapPercent: 98,
      minFreeDiskBytes: 2 * GB,
      unknownReading: "admit",
    },
    enforcement: {
      cpu: { kind: "priorityOnly" },
      memory: gate(),
      swap: gate(),
      disk: gate(),
      inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
      io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
    },
    observedLimits: {},
    limitations: ["Disk is an admission gate; no disk quota is observed"],
    ...overrides,
  };
}

describe("enforcementSentence", () => {
  it("reads the exact copy per EnforcementState, and nothing else", () => {
    expect(enforcementSentence({ kind: "kernelCap", mechanism: "cgroup v2 memory.max, whole server" }, "the server")).toBe(
      "Enforced by the system (cgroup v2 memory.max, whole server)",
    );
    expect(enforcementSentence({ kind: "stopWhenOver" }, "the server")).toBe(
      "Watched: jobs are stopped if they exceed it",
    );
    expect(enforcementSentence(gate(), "this Mac")).toBe("Checked before each job starts");
    expect(enforcementSentence({ kind: "priorityOnly" }, "this Mac")).toBe(
      "Full speed allowed.  Jobs run at background priority",
    );
    expect(enforcementSentence({ kind: "unsupported", reason: "No swap is configured" }, "this Mac")).toBe(
      "Not enforced on this Mac: No swap is configured",
    );
    expect(
      enforcementSentence(
        { kind: "notApplied", reason: "Disk reading unavailable; admission permits unknown readings", restartRequired: false },
        "the server",
      ),
    ).toBe("Not applied: Disk reading unavailable; admission permits unknown readings");
  });

  it("never says limit or cap outside a kernelCap row", () => {
    const states: EnforcementState[] = [
      { kind: "stopWhenOver" },
      gate(),
      { kind: "priorityOnly" },
      { kind: "unsupported", reason: "No inode admission gate is active" },
      { kind: "notApplied", reason: "Server storage offline; new jobs are refused", restartRequired: false },
    ];
    for (const state of states) {
      const sentence = enforcementSentence(state, "the server").toLowerCase();
      expect(sentence).not.toContain("limit");
      expect(sentence).not.toContain("cap");
    }
  });
});

describe("formatters", () => {
  it("puts a unit on every byte count", () => {
    expect(formatBytes(32 * GB)).toBe("32.0 GB");
    expect(formatBytes(2 * GB)).toBe("2.0 GB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(0)).toBe("0 bytes");
  });

  it("formats counts with grouped digits and the word, never a bare number", () => {
    expect(formatCount(5_000_000, "inode")).toBe("5,000,000 inodes");
    expect(formatCount(1, "core")).toBe("1 core");
    expect(formatCount(10, "core")).toBe("10 cores");
  });

  it("reads Central 12-hour", () => {
    // 19:14 UTC on Oct 29 is 2:14 PM CDT.
    const text = formatCentralTime(Date.UTC(2026, 9, 29, 19, 14, 0));
    expect(text).toContain("2:14 PM");
    expect(text).toMatch(/CDT|CST/);
  });

  it("names this Mac and the server without host names", () => {
    expect(hostNoun(report())).toBe("this Mac");
    expect(
      hostNoun(report({ hostId: "server:12345678-1234-1234-1234-123456789012", platform: "linux" })),
    ).toBe("the server");
  });

  it("subtitles the host card with platform, version and capabilities", () => {
    expect(hostSubtitle(report())).toBe("macOS · 1.2.3 · shell, macos, desktop");
  });
});

describe("admissionRows saved vs applied", () => {
  it("shows unset headroom knobs as Not set, never as a number", () => {
    const rows = admissionRows(report());
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey.reservedCpuCores!.saved).toBe("Not set");
    expect(byKey.reservedRam!.saved).toBe("Not set");
    expect(byKey.minMemoryAvailablePercent!.saved).toBe("Not set");
    expect(byKey.minFreeInodes!.saved).toBe("Not set");
    expect(byKey.minFreeInodes!.applied).toBe("Not set: no gate");
    expect(byKey.reservedCpuCores!.mismatch).toBeNull();
  });

  it("keeps the saved number and shows Not applied with the reason on a failed read", () => {
    const r = report({
      enforcement: {
        cpu: { kind: "priorityOnly" },
        memory: gate(),
        swap: gate(),
        disk: {
          kind: "notApplied",
          reason: "Disk reading unavailable; admission permits unknown readings",
          restartRequired: false,
        },
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const disk = admissionRows(r).find((row) => row.key === "minFreeDisk")!;
    expect(disk.saved).toBe("2.0 GB");
    expect(disk.applied).toBe("Not applied: Disk reading unavailable; admission permits unknown readings");
    expect(disk.mismatch).toBe(disk.applied);
  });

  it("shows a saved Mac CPU reservation as never applied, not as a gate", () => {
    const r = report({ admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, reservedCpuCores: 2, unknownReading: "admit" } });
    const cpu = admissionRows(r).find((row) => row.key === "reservedCpuCores")!;
    expect(cpu.saved).toBe("2 cores");
    expect(cpu.applied).toContain("Not applied on this Mac");
    expect(cpu.mismatch).toBe(cpu.applied);
  });

  it("reads the no-capacity sentence when a reservation covers detected capacity", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, reservedRamBytes: 32 * GB, unknownReading: "admit" },
    });
    const ram = admissionRows(r).find((row) => row.key === "reservedRam")!;
    expect(ram.mismatch).toBe(noCapacitySentence("the server"));
    expect(ram.mismatch).toContain("New jobs will wait here until you lower it");
  });

  it("rounds the available-memory percent instead of printing fractions", () => {
    const r = report({ sample: sample({ ramAvailableBytes: 20 * GB, memoryAvailablePercent: 62.5 }) });
    const memory = resourceRows(r).find((row) => row.key === "memory")!;
    expect(memory.use).toContain("63% of total");
    expect(memory.use).not.toContain("62.5");
  });

  it("keeps headroom gates enforced on a swapless host", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      sample: sample({ swapTotalBytes: 0, swapUsedBytes: 0 }),
      admission: {
        maxSwapPercent: 98,
        minFreeDiskBytes: 2 * GB,
        reservedRamBytes: 1 * GB,
        minMemoryAvailablePercent: 10,
        unknownReading: "admit",
      },
      enforcement: {
        cpu: { kind: "priorityOnly" },
        memory: { kind: "unsupported", reason: "No swap is configured; no RAM budget check is active" },
        swap: { kind: "unsupported", reason: "No swap is configured" },
        disk: gate(),
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const byKey = Object.fromEntries(admissionRows(r).map((row) => [row.key, row]));
    expect(byKey.reservedRam!.applied).toBe("1.0 GB");
    expect(byKey.reservedRam!.mismatch).toBeNull();
    expect(byKey.minMemoryAvailablePercent!.applied).toBe("10%");
    expect(byKey.minMemoryAvailablePercent!.mismatch).toBeNull();
    // The swap gate itself stays honestly unsupported; only the memory
    // headroom gates the scheduler still enforces read as gates.
    expect(byKey.maxSwapPercent!.applied).toBe("Not enforced on the server: No swap is configured");
    const memory = resourceRows(r).find((row) => row.key === "memory")!;
    expect(memory.enforcement).toBe("Checked before each job starts");
  });

  it("still reports memory unenforced on a swapless host with no headroom knobs", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      sample: sample({ swapTotalBytes: 0, swapUsedBytes: 0 }),
      enforcement: {
        cpu: { kind: "priorityOnly" },
        memory: { kind: "unsupported", reason: "No swap is configured; no RAM budget check is active" },
        swap: { kind: "unsupported", reason: "No swap is configured" },
        disk: gate(),
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const byKey = Object.fromEntries(admissionRows(r).map((row) => [row.key, row]));
    expect(byKey.reservedRam!.saved).toBe("Not set");
    const memory = resourceRows(r).find((row) => row.key === "memory")!;
    expect(memory.enforcement).toBe("Not enforced on the server: No swap is configured; no RAM budget check is active");
  });

  it("fails a saved Linux CPU reservation closed when cpu is not applied", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, reservedCpuCores: 2, unknownReading: "admit" },
      enforcement: {
        cpu: {
          kind: "notApplied",
          reason: "CPU reading unavailable; admission permits unknown readings",
          restartRequired: false,
        },
        memory: gate(),
        swap: gate(),
        disk: gate(),
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const cpu = admissionRows(r).find((row) => row.key === "reservedCpuCores")!;
    expect(cpu.saved).toBe("2 cores");
    expect(cpu.applied).toBe("Not applied: CPU reading unavailable; admission permits unknown readings");
    expect(cpu.mismatch).toBe(cpu.applied);
  });

  it("keeps a saved Linux CPU reservation applied under a live cpu gate", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, reservedCpuCores: 2, unknownReading: "admit" },
    });
    const cpu = admissionRows(r).find((row) => row.key === "reservedCpuCores")!;
    expect(cpu.saved).toBe("2 cores");
    expect(cpu.applied).toBe("2 cores");
    expect(cpu.mismatch).toBeNull();
  });

  it("reads the Linux CPU no-capacity sentence when the reservation covers all cores", () => {
    const r = report({
      platform: "linux",
      hostId: "server:12345678-1234-1234-1234-123456789012",
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, reservedCpuCores: 10, unknownReading: "admit" },
    });
    const cpu = admissionRows(r).find((row) => row.key === "reservedCpuCores")!;
    expect(cpu.mismatch).toBe(noCapacitySentence("the server"));
  });

  it("keeps the not-applied reason when an over-capacity disk floor also fires", () => {
    const r = report({
      sample: sample({ diskTotalBytes: 100 * GB }),
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 200 * GB, unknownReading: "admit" },
      enforcement: {
        cpu: { kind: "priorityOnly" },
        memory: gate(),
        swap: gate(),
        disk: {
          kind: "notApplied",
          reason: "Disk reading unavailable; admission permits unknown readings",
          restartRequired: false,
        },
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const disk = admissionRows(r).find((row) => row.key === "minFreeDisk")!;
    expect(disk.applied).toBe("Not applied: Disk reading unavailable; admission permits unknown readings");
    expect(disk.mismatch).toBe(disk.applied);
  });

  it("reads the disk no-capacity sentence when the floor covers detected capacity", () => {
    const r = report({
      sample: sample({ diskTotalBytes: 100 * GB }),
      admission: { maxSwapPercent: 98, minFreeDiskBytes: 200 * GB, unknownReading: "admit" },
    });
    const disk = admissionRows(r).find((row) => row.key === "minFreeDisk")!;
    expect(disk.mismatch).toBe(noCapacitySentence("this Mac"));
  });

  it("shows a swap gate against no swap as not enforced, not as applied", () => {
    const r = report({
      sample: sample({ swapTotalBytes: 0, swapUsedBytes: 0 }),
      enforcement: {
        cpu: { kind: "priorityOnly" },
        memory: { kind: "unsupported", reason: "No swap is configured; no RAM budget check is active" },
        swap: { kind: "unsupported", reason: "No swap is configured" },
        disk: gate(),
        inodes: { kind: "unsupported", reason: "No inode admission gate is active" },
        io: { kind: "unsupported", reason: "No I/O rate enforcement observed" },
      },
    });
    const swap = admissionRows(r).find((row) => row.key === "maxSwapPercent")!;
    expect(swap.saved).toBe("98%");
    expect(swap.applied).toBe("Not enforced on this Mac: No swap is configured");
    expect(swap.mismatch).toBe(swap.applied);
  });
});

describe("resourceRows", () => {
  it("says an unknown reading is not checked, with the sample time", () => {
    const r = report({ sample: sample({ diskFreeBytes: null }) });
    const disk = resourceRows(r).find((row) => row.key === "disk")!;
    expect(disk.use).toContain("Unknown");
    expect(disk.enforcement).toContain("not checked before jobs start");
    expect(disk.enforcement).toContain("2:14 PM");
  });

  it("raises the red storage-offline row with the mount point", () => {
    const r = report({ sample: sample({ storage: { online: false, dataDevice: null, rootDevice: "8:1" } }) });
    const disk = resourceRows(r).find((row) => row.key === "disk")!;
    expect(disk.alert).toContain("/mnt/fleet-extra is not mounted");
    expect(disk.alert).toContain("stopped admitting jobs");
  });

  it("keeps the Mac CPU row at full speed with background priority", () => {
    const cpu = resourceRows(report()).find((row) => row.key === "cpu")!;
    expect(cpu.detected).toBe("10 cores");
    expect(cpu.use).toContain("Load 2.41 per core");
    expect(cpu.enforcement).toBe("Full speed allowed.  Jobs run at background priority");
  });

  it("never renders a null reading as zero", () => {
    const r = report({
      sample: sample({
        cores: null,
        ramTotalBytes: null,
        ramAvailableBytes: null,
        memoryAvailablePercent: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        diskTotalBytes: null,
        diskFreeBytes: null,
        inodesTotal: null,
        inodesFree: null,
        rootDiskFreeBytes: null,
        loadPerCore: null,
      }),
    });
    for (const row of resourceRows(r)) {
      if (row.key === "io") continue;
      expect(row.detected).not.toContain("0 GB");
      expect(row.use).not.toContain("0 GB");
    }
  });
});

describe("nextRefreshState", () => {
  it("keeps the last report under a refreshing flag from ready", () => {
    const ready = report();
    const next = nextRefreshState({ status: "ready", report: ready });
    expect(next).toEqual({ status: "refreshing", report: ready });
  });

  it("stays refreshing while a fetch is already in flight", () => {
    const refreshing = { status: "refreshing", report: report() } as const;
    expect(nextRefreshState(refreshing)).toBe(refreshing);
  });

  it("loads clean from loading or error, where no report exists", () => {
    expect(nextRefreshState({ status: "loading" })).toEqual({ status: "loading" });
    expect(nextRefreshState({ status: "error", message: "nope" })).toEqual({ status: "loading" });
  });
});

describe("hostResourcesReportSchema", () => {
  it("accepts the report shape and refuses anything else", () => {
    expect(hostResourcesReportSchema.safeParse(report()).success).toBe(true);
    expect(hostResourcesReportSchema.safeParse(null).success).toBe(false);
    expect(hostResourcesReportSchema.safeParse({ error: "nope" }).success).toBe(false);
    expect(hostResourcesReportSchema.safeParse({ ...report(), admission: undefined }).success).toBe(false);
  });
});
