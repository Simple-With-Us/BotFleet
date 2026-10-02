// The host readings behind job admission and the stray-process sweep, from
// fixtures: swap on macOS and Linux, and the job-id extraction that must
// keep nothing else it reads.
import { describe, expect, it } from "vitest";

import { admissionRefusal, createHostProbe, parseDarwinSwap, parseLinuxSwap } from "./admission.ts";
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

  it("answers from its last reading and never waits for the next one", async () => {
    let clock = 0;
    const reads: Array<(text: string) => void> = [];
    const probe = createHostProbe({
      platform: "darwin",
      now: () => clock,
      readDarwinSwap: () => new Promise<string>((resolve) => reads.push(resolve)),
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
