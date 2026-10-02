// Whether the host can take one more background job right now (jobs P1).
//
// Three gates, and only three.  A job is refused when swap is nearly full,
// when the data folder's disk is nearly full, or when the rolling spend
// ceiling has tripped (a job's wake turns are unattended spend).  There is
// deliberately NO load-average gate: on the owner's Mac load ran 76–173 in
// every sample the panel took, so any load gate would switch the feature off
// for good (decision doc, Dissent).
//
// The swap default is not 90%.  This Mac's swap already sits near 90–94% in
// ordinary use, and macOS grows the swap file set on demand, so used/total
// hovers high without the machine being in trouble.  The gate is for the
// last few percent, and the owner can move it (`jobs.admission`).

import { execFile } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";

export interface AdmissionThresholds {
  /** Refuse at or above this share of swap in use.  A host with no swap
   *  configured is never refused for swap. */
  maxSwapPercent: number;
  /** Refuse when the data folder's disk has less than this free. */
  minFreeDiskBytes: number;
}

export const DEFAULT_ADMISSION: AdmissionThresholds = {
  maxSwapPercent: 98,
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
};

/** What admission reads off the host.  Injected so the gate is tested
 *  without a Mac under pressure. */
export interface HostProbe {
  /** Percent of swap in use, or null when unknown or no swap exists. */
  swapUsedPercent(): number | null;
  /** Bytes free to this user on the disk holding `path`, or null. */
  freeDiskBytes(path: string): number | null;
}

/** `sysctl vm.swapusage` on macOS:
 *  `total = 17408.00M  used = 16436.69M  free = 971.31M  (encrypted)`. */
export function parseDarwinSwap(text: string): number | null {
  const total = /total\s*=\s*([\d.]+)M/.exec(text);
  const used = /used\s*=\s*([\d.]+)M/.exec(text);
  if (!total || !used) return null;
  const t = Number(total[1]);
  const u = Number(used[1]);
  if (!Number.isFinite(t) || !Number.isFinite(u) || t <= 0) return null;
  return (u / t) * 100;
}

/** `/proc/meminfo` on Linux: `SwapTotal:  2097148 kB` / `SwapFree: …`. */
export function parseLinuxSwap(text: string): number | null {
  const total = /^SwapTotal:\s+(\d+)/m.exec(text);
  const free = /^SwapFree:\s+(\d+)/m.exec(text);
  if (!total || !free) return null;
  const t = Number(total[1]);
  const f = Number(free[1]);
  if (t <= 0) return null;
  return ((t - f) / t) * 100;
}

const SWAP_CACHE_MS = 10_000;

/** What `createHostProbe` reads the host with.  Injected so the probe is
 *  tested without a Mac under pressure. */
export interface HostProbeDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  /** `sysctl vm.swapusage`'s output, read without blocking. */
  readDarwinSwap?: () => Promise<string>;
  /** `/proc/meminfo`'s text. */
  readLinuxMeminfo?: () => string;
}

/** A 2 s bound on a command that normally answers in a few milliseconds. */
const sysctlSwap = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("/usr/sbin/sysctl", ["vm.swapusage"], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** The real host.  The probe answers from a reading at most a few seconds
 *  old and never waits for the next one: on macOS the swap figure comes from
 *  a `sysctl` run in the background, because a harness at load 100 or more
 *  that waited on it would stall every stream and route behind it (twice per
 *  `job_start`).  An unreadable figure is "unknown", which admits, because a
 *  broken probe must not switch jobs off — and so does one not read yet, which
 *  is why the first reading is started as the probe is built. */
export function createHostProbe(deps: HostProbeDeps = {}): HostProbe {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const readDarwinSwap = deps.readDarwinSwap ?? sysctlSwap;
  const readLinuxMeminfo = deps.readLinuxMeminfo ?? (() => readFileSync("/proc/meminfo", "utf8"));
  let swapAt = Number.NEGATIVE_INFINITY;
  let swapValue: number | null = null;
  let refreshing = false;
  const refreshDarwin = () => {
    if (refreshing) return;
    refreshing = true;
    swapAt = now();
    readDarwinSwap()
      .then(
        (text) => {
          swapValue = parseDarwinSwap(text);
        },
        () => {
          swapValue = null;
        },
      )
      .finally(() => {
        refreshing = false;
      });
  };
  if (platform === "darwin") refreshDarwin();
  return {
    swapUsedPercent() {
      if (now() - swapAt < SWAP_CACHE_MS) return swapValue;
      if (platform === "darwin") {
        refreshDarwin();
        return swapValue;
      }
      swapAt = now();
      try {
        // a procfs read: instant, so it needs no background step
        swapValue = platform === "linux" ? parseLinuxSwap(readLinuxMeminfo()) : null;
      } catch {
        swapValue = null;
      }
      return swapValue;
    },
    freeDiskBytes(path) {
      try {
        const stats = statfsSync(path);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    },
  };
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Why a new job may not start now, or null when it may.  The text is read
 *  by the model, so it says what to do instead. */
export function admissionRefusal(
  probe: HostProbe,
  thresholds: AdmissionThresholds,
  dataDir: string,
  spendBlocked: boolean,
): string | null {
  if (spendBlocked) {
    return "The spend ceiling for unattended work has been reached, so no new background job can start.  Run the command with bash if it is short, or tell the user.";
  }
  const swap = probe.swapUsedPercent();
  if (swap !== null && swap >= thresholds.maxSwapPercent) {
    return `This computer is short on memory (swap ${Math.round(swap)}% used), so no new background job can start right now.  Try again later, or tell the user.`;
  }
  const free = probe.freeDiskBytes(dataDir);
  if (free !== null && free < thresholds.minFreeDiskBytes) {
    return `This computer is short on disk space (${formatGb(free)} free), so no new background job can start right now.  Tell the user.`;
  }
  return null;
}
