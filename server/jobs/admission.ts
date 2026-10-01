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

import { execFileSync } from "node:child_process";
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

/** The real host.  Each read is bounded (a 2 s `sysctl`), cached for a few
 *  seconds, and never throws: an unreadable figure is "unknown", which
 *  admits, because a broken probe must not switch jobs off. */
export function createHostProbe(): HostProbe {
  let swapAt = 0;
  let swapValue: number | null = null;
  return {
    swapUsedPercent() {
      const now = Date.now();
      if (now - swapAt < SWAP_CACHE_MS) return swapValue;
      swapAt = now;
      try {
        if (process.platform === "darwin") {
          swapValue = parseDarwinSwap(execFileSync("/usr/sbin/sysctl", ["vm.swapusage"], { encoding: "utf8", timeout: 2_000 }));
        } else if (process.platform === "linux") {
          swapValue = parseLinuxSwap(readFileSync("/proc/meminfo", "utf8"));
        } else {
          swapValue = null;
        }
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
