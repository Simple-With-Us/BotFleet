// The host readings behind job admission and the stray-process sweep, from
// fixtures: swap on macOS and Linux, and the job-id extraction that must
// keep nothing else it reads.
import { describe, expect, it } from "vitest";

import { admissionRefusal, createHostProbe, parseDarwinMemoryAvailablePercent, parseDarwinSwap, parseLinuxSwap } from "./admission.ts";
import { parseEnvListing, parseProcStatPgid } from "./sweep.ts";

describe("swap readings", () => {
  it("reads macOS vm.swapusage", () => {
    const percent = parseDarwinSwap("vm.swapusage: total = 17408.00M  used = 16436.69M  free = 971.31M  (encrypted)");
    expect(percent).toBeCloseTo(94.42, 1);
  });
  it("treats a Mac with no swap file yet as no gate", () => {
    expect(parseDarwinSwap("vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)")).toBeNull();
  });
  it("reads Linux /proc/meminfo, and no swap configured is no gate", () => {
    expect(parseLinuxSwap("MemTotal: 1 kB\nSwapTotal:   1000 kB\nSwapFree:    250 kB\n")).toBe(75);
    expect(parseLinuxSwap("SwapTotal:       0 kB\nSwapFree:        0 kB\n")).toBeNull();
  });
  it("admits when a reading is unknown", () => {
    const probe = { swapUsedPercent: () => null, freeDiskBytes: () => null };
    expect(admissionRefusal(probe, { maxSwapPercent: 98, minFreeDiskBytes: 1 }, "/", false)).toBeNull();
  });
});

describe("the sweep's process listing", () => {
  it("keeps only pid, group and job id, and only for well-formed ids", () => {
    const listing = [
      "  101   100 /bin/sh -c pnpm test PATH=/usr/bin BOTFLEET_JOB_ID=job_01JABCDEFGHJKMNPQRSTVWXYZ HOME=/Users/me",
      "  102   102 node server.js API_KEY=do-not-keep",
      "  103   100 sleep 30 BOTFLEET_JOB_ID=job_bad HOME=/Users/me",
      "  104   104 echo BOTFLEET_JOB_ID=job_01JABCDEFGHJKMNPQRSTVWXY1",
    ].join("\n");
    const found = parseEnvListing(listing);
    expect(found).toEqual([
      { pid: 101, pgid: 100, jobId: "job_01JABCDEFGHJKMNPQRSTVWXYZ" },
      { pid: 104, pgid: 104, jobId: "job_01JABCDEFGHJKMNPQRSTVWXY1" },
    ]);
    expect(JSON.stringify(found)).not.toContain("API_KEY");
  });

  it("reads a Linux process group from /proc/<pid>/stat, past a name with spaces", () => {
    expect(parseProcStatPgid("4242 (my (odd) proc) S 1 4240 4240 0 -1")).toBe(4240);
    expect(parseProcStatPgid("garbage")).toBeNull();
  });
});

describe("the host probe", () => {
  const swap = (percent: number) => `vm.swapusage: total = 1000.00M  used = ${percent * 10}.00M  free = ${(100 - percent) * 10}.00M  (encrypted)`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("parses optional XNU memory availability without guessing a pressure category", () => {
    expect(parseDarwinMemoryAvailablePercent(" 12.5\n")).toBe(12.5);
    expect(parseDarwinMemoryAvailablePercent("0")).toBe(0);
    for (const text of ["", "-1", "101", "NaN", "unavailable", "kern.memorystatus_level: 50"]) {
      expect(parseDarwinMemoryAvailablePercent(text)).toBeNull();
    }
  });

  it("shares a bounded asynchronous memory cache and makes failed reads visibly unknown", async () => {
    let now = 0;
    const reads: Array<(value: string) => void> = [];
    let fail = false;
    const probe = createHostProbe({
      platform: "darwin", now: () => now, totalMemory: () => 16 * 1024 ** 3,
      readDarwinSwap: async () => swap(50),
      readDarwinMemoryAvailable: () => fail ? Promise.reject(new Error("unsupported")) : new Promise((resolve) => reads.push(resolve)),
      statfs: () => ({ bsize: 1, blocks: 100, bavail: 50, files: 10, ffree: 5 }),
      readHostLoad: () => ({ cores: 8, load1: 1000 }),
    });
    expect(probe.memoryAvailablePercent?.()).toBeNull();
    expect(reads).toHaveLength(1);
    reads[0]!("25"); await settle();
    expect(probe.memoryAvailablePercent?.()).toBe(25);
    expect(probe.availableMemoryBytes?.()).toBe(4 * 1024 ** 3);
    expect(probe.capacitySample("/fixture")).toMatchObject({ memoryAvailablePercent: 25, ramAvailableBytes: 4 * 1024 ** 3, memoryPressure: null });
    expect(reads).toHaveLength(1);
    now = 11_000; fail = true;
    probe.memoryAvailablePercent?.(); await settle();
    expect(probe.memoryAvailablePercent?.()).toBeNull();
    expect(probe.capacitySample("/fixture").ramAvailableBytes).toBeNull();
  });

  it("keeps memory gates absent by default, enforces explicit floors and admits unknown without a CPU gate", () => {
    const base = { swapUsedPercent: () => 0, freeDiskBytes: () => 10 ** 12, memoryAvailablePercent: () => 1, availableMemoryBytes: () => 1024 };
    const defaults = { maxSwapPercent: 98, minFreeDiskBytes: 1 };
    expect(admissionRefusal(base, defaults, "/fixture", false)).toBeNull();
    expect(admissionRefusal(base, { ...defaults, reservedCpuCores: 10_000 }, "/fixture", false)).toBeNull();
    expect(admissionRefusal(base, { ...defaults, minMemoryAvailablePercent: 10 }, "/fixture", false)).toContain("1.0% memory available");
    expect(admissionRefusal(base, { ...defaults, reservedRamBytes: 2048 }, "/fixture", false)).toContain("available RAM");
    const unknown = { ...base, memoryAvailablePercent: () => null, availableMemoryBytes: () => null };
    expect(admissionRefusal(unknown, { ...defaults, minMemoryAvailablePercent: 10, reservedRamBytes: 2048 }, "/fixture", false)).toBeNull();
  });

  it("answers from its last reading and never waits for the next one", async () => {
    let clock = 0;
    const reads: Array<(text: string) => void> = [];
    const probe = createHostProbe({
      platform: "darwin",
      now: () => clock,
      readDarwinSwap: () => new Promise<string>((resolve) => reads.push(resolve)),
      readDarwinMemoryAvailable: async () => "50",
    });
    // the first reading starts as the probe is built, and is not waited for
    expect(reads).toHaveLength(1);
    expect(probe.swapUsedPercent()).toBeNull();
    reads[0]!(swap(50));
    await settle();
    expect(probe.swapUsedPercent()).toBe(50);
    // fresh: no second read
    clock = 9_000;
    expect(probe.swapUsedPercent()).toBe(50);
    expect(reads).toHaveLength(1);
    // stale: one background read, however many asks, and the old figure answers meanwhile
    clock = 11_000;
    expect(probe.swapUsedPercent()).toBe(50);
    expect(probe.swapUsedPercent()).toBe(50);
    expect(reads).toHaveLength(2);
    reads[1]!(swap(97));
    await settle();
    expect(probe.swapUsedPercent()).toBe(97);
  });

  it("treats a read that failed as unknown, which admits, and tries again later", async () => {
    let clock = 0;
    let reads = 0;
    const probe = createHostProbe({
      platform: "darwin",
      now: () => clock,
      readDarwinMemoryAvailable: async () => "50",
      readDarwinSwap: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(swap(60)) : Promise.reject(new Error("sysctl timed out"));
      },
    });
    await settle();
    expect(probe.swapUsedPercent()).toBe(60);
    clock = 20_000;
    probe.swapUsedPercent();
    await settle();
    expect(probe.swapUsedPercent()).toBeNull();
    expect(reads).toBe(2);
  });

  it("reads Linux's procfs in place, and has no swap figure anywhere else", () => {
    const linux = createHostProbe({ platform: "linux", readLinuxMeminfo: () => "SwapTotal: 1000 kB\nSwapFree: 250 kB\n" });
    expect(linux.swapUsedPercent()).toBe(75);
    expect(createHostProbe({ platform: "win32" }).swapUsedPercent()).toBeNull();
  });
});
