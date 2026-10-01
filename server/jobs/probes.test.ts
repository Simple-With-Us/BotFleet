// The host readings behind job admission and the stray-process sweep, from
// fixtures: swap on macOS and Linux, and the job-id extraction that must
// keep nothing else it reads.
import { describe, expect, it } from "vitest";

import { admissionRefusal, parseDarwinSwap, parseLinuxSwap } from "./admission.ts";
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
