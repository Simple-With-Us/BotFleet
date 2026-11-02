// Whether the host can take one more background job right now (jobs P1).
//
// Three gates by default, plus owner-set headroom gates (P-BF-6 B7) that
// exist only when their knob is set.  A job is refused when swap is nearly full,
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
import { readFileSync, realpathSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import type { CapacitySample, StorageState } from "../../shared/placement.ts";
import { loadPerCore, readHostLoad, type HostLoad } from "../drivers/acp/init-deadline.ts";

export interface AdmissionThresholds {
  /** Refuse at or above this share of swap in use.  A host with no swap
   *  configured is never refused for swap. */
  maxSwapPercent: number;
  /** Refuse when the data folder's disk has less than this free. */
  minFreeDiskBytes: number;
  /** Absent means no inode gate; inventory must precede a configured floor. */
  minFreeInodes?: number;
  /** Headroom (P-BF-6 B7): absent means no gate.  There is deliberately no
   *  default for any of these — the numbers are the owner's to choose, and
   *  an unset knob leaves admission exactly as it was.  `reservedCpuCores`
   *  refuses when fewer cores than this are idle by load average; it exists
   *  only when set, so the no-load-gate ruling above still holds by
   *  default.  On macOS it is never an admission input at all (the owner
   *  forbade a CPU cutoff on the Mac, not the setting): the real probe
   *  reports the CPU reading as unknown there, so it fails open. */
  reservedCpuCores?: number;
  /** Refuse when available RAM is below this many bytes.  Absent: no gate. */
  reservedRamBytes?: number;
  /** Refuse when available memory is below this percent of total RAM. */
  minMemoryAvailablePercent?: number;
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
  freeInodes?(path: string): number | null;
  storageState?(): StorageState | null;
  /** One bracketed device/statfs observation for an admission decision. */
  admissionStorageSample?(path: string): AdmissionStorageSample;
  /** Headroom readings, consulted only when a headroom threshold is set. */
  headroomReadings?(): HeadroomReadings;
}

/** Null fields are unknown readings, which admit (fail-open, as everywhere
 *  else in admission). */
export interface HeadroomReadings {
  /** Cores idle by 1-minute load average (`cores − load1`, floored at 0).
   *  Always null (unknown) on macOS: load average there is never an
   *  admission input (see `reservedCpuCores`). */
  availableCpuCores: number | null;
  ramAvailableBytes: number | null;
  memoryAvailablePercent: number | null;
}

interface AdmissionStorageSample {
  storage: StorageState | null;
  freeDiskBytes: number | null;
  freeInodes: number | null;
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

/** macOS `memory_pressure` ends with
 *  `System-wide memory free percentage: 42%` — the share of RAM the kernel
 *  counts as available (free + inactive + purgeable, the same figure
 *  `kern.memorystatus_level` reports). */
export function parseDarwinMemoryAvailablePercent(text: string): number | null {
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/.exec(text);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
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
  /** macOS `memory_pressure`'s output, read without blocking. */
  readDarwinMemoryPressure?: () => Promise<string>;
  /** Whether a memory-headroom knob is set right now.  The Mac
   *  memory-pressure probe runs ONLY when this answers true: with no knob
   *  set there is no extra subprocess and the capacity sample keeps its
   *  previous null memory readings.  Absent means never. */
  memoryHeadroomEnabled?: () => boolean;
  /** `/proc/meminfo`'s text. */
  readLinuxMeminfo?: () => string;
  readHostLoad?: () => HostLoad | null;
  totalMemory?: () => number;
  statfs?: (path: string) => Pick<ReturnType<typeof statfsSync>, "bsize" | "blocks" | "bavail" | "files" | "ffree">;
  readMountinfo?: () => string;
  realPath?: (path: string) => string;
  storageState?: () => StorageState;
}

export interface CapacityHostProbe extends HostProbe {
  capacitySample(path: string): CapacitySample;
}

/** Linux mountinfo uses octal escapes for whitespace and backslashes. */
export function mountForPath(mountinfo: string, path: string): CapacitySample["dataVolume"] {
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const matches = mountinfo.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-")) return [];
    const mountPoint = decode(fields[4]!);
    if (!mountPoint.startsWith("/") || !/^\d+:\d+$/.test(fields[2]!)) return [];
    return path === mountPoint || path.startsWith(mountPoint === "/" ? "/" : `${mountPoint}/`)
      ? [{ device: fields[2]!, mountPoint }] : [];
  });
  return matches.sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0] ?? null;
}

/** A 2 s bound on a command that normally answers in a few milliseconds. */
const sysctlSwap = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("/usr/sbin/sysctl", ["vm.swapusage"], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const darwinMemoryPressure = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/memory_pressure", [], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** The real host.  The probe answers from a reading at most a few seconds
 *  old and never waits for the next one: on macOS the swap figure comes from
 *  a `sysctl` run in the background, because a harness at load 100 or more
 *  that waited on it would stall every stream and route behind it (twice per
 *  `job_start`).  An unreadable figure is "unknown", which admits, because a
 *  broken probe must not switch jobs off — and so does one not read yet, which
 *  is why the first reading is started as the probe is built. */
export function createHostProbe(deps: HostProbeDeps = {}): CapacityHostProbe {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const readDarwinSwap = deps.readDarwinSwap ?? sysctlSwap;
  const readDarwinMemoryPressure = deps.readDarwinMemoryPressure ?? darwinMemoryPressure;
  const memoryHeadroomOn = () => {
    try { return deps.memoryHeadroomEnabled?.() === true; } catch { return false; }
  };
  const readLinuxMeminfo = deps.readLinuxMeminfo ?? (() => readFileSync("/proc/meminfo", "utf8"));
  const diskStats = deps.statfs ?? statfsSync;
  const hostLoad = deps.readHostLoad ?? readHostLoad;
  const memoryTotal = deps.totalMemory ?? totalmem;
  const mountinfo = deps.readMountinfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const realPath = deps.realPath ?? realpathSync;
  let swapAt = Number.NEGATIVE_INFINITY;
  let swapValue: number | null = null;
  let swapTotalBytes: number | null = null;
  let swapUsedBytes: number | null = null;
  let ramAvailableBytes: number | null = null;
  const nonnegative = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;
  let refreshing = false;
  const refreshDarwin = () => {
    if (refreshing) return;
    refreshing = true;
    swapAt = now();
    readDarwinSwap()
      .then(
        (text) => {
          swapValue = parseDarwinSwap(text);
          swapTotalBytes = nonnegative(Number(/total\s*=\s*([\d.]+)M/.exec(text)?.[1] ?? NaN) * 1024 ** 2);
          swapUsedBytes = nonnegative(Number(/used\s*=\s*([\d.]+)M/.exec(text)?.[1] ?? NaN) * 1024 ** 2);
        },
        () => {
          swapValue = null;
          swapTotalBytes = swapUsedBytes = null;
        },
      )
      .finally(() => {
        refreshing = false;
      });
  };
  // Mac available-memory percent, from `memory_pressure`.  Cached and
  // background-refreshed exactly like swap, but only ever read while a
  // memory-headroom knob is set (`memoryHeadroomOn`) — unset knobs mean no
  // subprocess and null readings, as before.
  let memPercentAt = Number.NEGATIVE_INFINITY;
  let memPercent: number | null = null;
  let memRefreshing = false;
  const refreshDarwinMemory = () => {
    if (memRefreshing || platform !== "darwin" || !memoryHeadroomOn()) return;
    memRefreshing = true;
    memPercentAt = now();
    readDarwinMemoryPressure()
      .then(
        (text) => { memPercent = parseDarwinMemoryAvailablePercent(text); },
        () => { memPercent = null; },
      )
      .finally(() => { memRefreshing = false; });
  };
  const darwinMemoryPercent = (): number | null => {
    if (platform !== "darwin") return null;
    if (!memoryHeadroomOn()) {
      // Drop the cache on disable: a later re-enable must not answer from a
      // reading taken before the knob was switched off.
      memPercent = null;
      memPercentAt = Number.NEGATIVE_INFINITY;
      return null;
    }
    if (now() - memPercentAt >= SWAP_CACHE_MS) {
      // Expired (or never read): refresh in the background and answer
      // unknown meanwhile, never the stale figure.
      refreshDarwinMemory();
      return null;
    }
    return memPercent;
  };
  if (platform === "darwin") refreshDarwin();
  const readDataStorage = (path: string) => {
    const before = deps.storageState?.() ?? null;
    let stats: ReturnType<typeof diskStats> | null = null;
    if (before?.online !== false) {
      try { stats = diskStats(path); } catch { /* Unreadable statistics remain unknown. */ }
    }
    const after = deps.storageState?.() ?? before;
    const storage = before?.online === false ? before : after;
    return { storage, stats: storage?.online === false ? null : stats };
  };
  const probe: CapacityHostProbe = {
    storageState: () => deps.storageState?.() ?? null,
    admissionStorageSample(path) {
      const { storage, stats } = readDataStorage(path);
      return {
        storage,
        freeDiskBytes: stats ? nonnegative(Number(stats.bavail) * Number(stats.bsize)) : null,
        freeInodes: stats && Number(stats.files) > 0 ? nonnegative(Number(stats.ffree)) : null,
      };
    },
    swapUsedPercent() {
      if (now() - swapAt < SWAP_CACHE_MS) return swapValue;
      if (platform === "darwin") {
        refreshDarwin();
        return swapValue;
      }
      swapAt = now();
      try {
        // a procfs read: instant, so it needs no background step
        const text = platform === "linux" ? readLinuxMeminfo() : "";
        swapValue = platform === "linux" ? parseLinuxSwap(text) : null;
        const kb = (name: string) => nonnegative(Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? NaN) * 1024);
        swapTotalBytes = kb("SwapTotal");
        const free = kb("SwapFree");
        swapUsedBytes = swapTotalBytes === null || free === null ? null : nonnegative(swapTotalBytes - free);
        ramAvailableBytes = kb("MemAvailable");
      } catch {
        swapValue = null;
        swapTotalBytes = swapUsedBytes = ramAvailableBytes = null;
      }
      return swapValue;
    },
    freeDiskBytes(path) {
      if (deps.storageState?.().online === false) return null;
      try {
        const stats = diskStats(path);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    },
    freeInodes(path) {
      if (deps.storageState?.().online === false) return null;
      try {
        const stats = diskStats(path);
        return Number(stats.files) > 0 ? nonnegative(Number(stats.ffree)) : null;
      } catch { return null; }
    },
    headroomReadings() {
      // Shares the swap/cache refresh, which on Linux also lands
      // MemAvailable; on a Mac the percent comes from the gated
      // memory-pressure probe above.
      probe.swapUsedPercent();
      const safe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
      const load = safe(hostLoad);
      // macOS load average is never an admission input (owner ruling): on
      // a Mac this reading is unknown, so `reservedCpuCores` fails open.
      const availableCpuCores = platform !== "darwin" && load && Number.isFinite(load.load1) && load.load1 >= 0 && Number.isFinite(load.cores) && load.cores > 0
        ? Math.max(0, load.cores - load.load1) : null;
      const total = safe(memoryTotal);
      const ramTotalBytes = total !== null && total > 0 ? nonnegative(total) : null;
      const percent = platform === "darwin" ? darwinMemoryPercent()
        : ramTotalBytes && ramAvailableBytes !== null ? (ramAvailableBytes / ramTotalBytes) * 100 : null;
      const bytes = platform === "darwin"
        ? percent !== null && ramTotalBytes !== null ? Math.round((percent / 100) * ramTotalBytes) : null
        : ramAvailableBytes;
      return { availableCpuCores, ramAvailableBytes: bytes, memoryAvailablePercent: percent };
    },
    capacitySample(path) {
      // The swap/cache read is shared with admission; there is no second sampler.
      probe.swapUsedPercent();
      const safe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
      const load = safe(hostLoad);
      const cores = load && Number.isSafeInteger(load.cores) && load.cores > 0 ? load.cores : null;
      const total = safe(memoryTotal);
      const ramTotalBytes = total !== null && total > 0 ? nonnegative(total) : null;
      // On a Mac the available figure exists only while a memory-headroom
      // knob is set (the gated probe); otherwise both stay null, as before.
      const darwinPercent = platform === "darwin" ? darwinMemoryPercent() : null;
      const darwinAvailable = darwinPercent !== null && ramTotalBytes !== null ? Math.round((darwinPercent / 100) * ramTotalBytes) : null;
      const available = darwinAvailable ?? (ramAvailableBytes !== null && (ramTotalBytes === null || ramAvailableBytes <= ramTotalBytes) ? ramAvailableBytes : null);
      const data = readDataStorage(path);
      const online = data.storage?.online !== false;
      const stats = data.stats;
      const root = safe(() => diskStats("/"));
      const usableDisk = stats && Number(stats.bsize) > 0 && Number(stats.blocks) > 0;
      const inodeTotal = stats && Number(stats.files) > 0 ? nonnegative(Number(stats.files)) : null;
      const diskFreeBytes = usableDisk ? nonnegative(Number(stats.bavail) * Number(stats.bsize)) : null;
      return {
        at: now(), cores, loadPerCore: loadPerCore(load),
        ramTotalBytes, ramAvailableBytes: available,
        memoryAvailablePercent: ramTotalBytes && available !== null ? (available / ramTotalBytes) * 100 : null,
        memoryPressure: null, swapTotalBytes, swapUsedBytes,
        diskTotalBytes: usableDisk ? nonnegative(Number(stats.blocks) * Number(stats.bsize)) : null,
        diskFreeBytes,
        inodesTotal: inodeTotal,
        inodesFree: stats && inodeTotal !== null ? nonnegative(Number(stats.ffree)) : null,
        dataVolume: online && platform === "linux" ? safe(() => mountForPath(mountinfo(), realPath(path))) : null,
        rootDiskFreeBytes: root && Number(root.bsize) > 0 && Number(root.blocks) > 0 ? nonnegative(Number(root.bavail) * Number(root.bsize)) : null,
        storage: data.storage,
      };
    },
  };
  return probe;
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The memory/storage pressure part of admission: swap, free disk, free
 *  inodes, the owner-set headroom gates, and the data volume being offline.
 *  Placement queues on these in every mode (the pressure-gate queue) instead
 *  of refusing, so the registry asks for them separately from the hard
 *  refusals.  The spend ceiling is deliberately absent: unattended spend is
 *  refused, never queued. */
export function pressureRefusal(
  probe: HostProbe,
  thresholds: AdmissionThresholds,
  dataDir: string,
): string | null {
  const storage = probe.admissionStorageSample?.(dataDir);
  if ((storage ? storage.storage : probe.storageState?.())?.online === false) return "Server storage offline: no new background job can start until the data volume is available";
  const swap = probe.swapUsedPercent();
  if (swap !== null && swap >= thresholds.maxSwapPercent) {
    return `This computer is short on memory (swap ${Math.round(swap)}% used), so no new background job can start right now.  Try again later, or tell the user.`;
  }
  const free = storage ? storage.freeDiskBytes : probe.freeDiskBytes(dataDir);
  if (free !== null && free < thresholds.minFreeDiskBytes) {
    return `This computer is short on disk space (${formatGb(free)} free), so no new background job can start right now.  Tell the user.`;
  }
  if (thresholds.minFreeInodes !== undefined) {
    const inodes = storage ? storage.freeInodes : probe.freeInodes?.(dataDir) ?? null;
    if (inodes !== null && inodes < thresholds.minFreeInodes) return "This computer is short on inodes, so no new background job can start right now";
  }
  // Headroom gates (P-BF-6 B7): the same unset-means-no-gate readings
  // `admissionRefusal` checks.  A breach queues like any other pressure.
  const { reservedCpuCores, reservedRamBytes, minMemoryAvailablePercent } = thresholds;
  if (reservedCpuCores !== undefined || reservedRamBytes !== undefined || minMemoryAvailablePercent !== undefined) {
    const headroom = probe.headroomReadings?.() ?? null;
    if (reservedCpuCores !== undefined && headroom?.availableCpuCores !== null && headroom?.availableCpuCores !== undefined && headroom.availableCpuCores < reservedCpuCores) {
      return "This computer is busy (less CPU headroom than the reserved cores), so no new background job can start right now.  Try again later, or tell the user.";
    }
    if (reservedRamBytes !== undefined && headroom?.ramAvailableBytes !== null && headroom?.ramAvailableBytes !== undefined && headroom.ramAvailableBytes < reservedRamBytes) {
      return `This computer is short on memory (${formatGb(headroom.ramAvailableBytes)} available, below the reserved headroom), so no new background job can start right now.  Try again later, or tell the user.`;
    }
    if (minMemoryAvailablePercent !== undefined && headroom?.memoryAvailablePercent !== null && headroom?.memoryAvailablePercent !== undefined && headroom.memoryAvailablePercent < minMemoryAvailablePercent) {
      return `This computer is short on memory (${Math.round(headroom.memoryAvailablePercent)}% available), so no new background job can start right now.  Try again later, or tell the user.`;
    }
  }
  return null;
}

/** Why a new job may not start now, or null when it may.  The text is read
 *  by the model, so it says what to do instead. */
export function admissionRefusal(
  probe: HostProbe,
  thresholds: AdmissionThresholds,
  dataDir: string,
  spendBlocked: boolean,
): string | null {
  const storage = probe.admissionStorageSample?.(dataDir);
  if ((storage ? storage.storage : probe.storageState?.())?.online === false) return "Server storage offline: no new background job can start until the data volume is available";
  if (spendBlocked) {
    return "The spend ceiling for unattended work has been reached, so no new background job can start.  Run the command with bash if it is short, or tell the user.";
  }
  const swap = probe.swapUsedPercent();
  if (swap !== null && swap >= thresholds.maxSwapPercent) {
    return `This computer is short on memory (swap ${Math.round(swap)}% used), so no new background job can start right now.  Try again later, or tell the user.`;
  }
  const free = storage ? storage.freeDiskBytes : probe.freeDiskBytes(dataDir);
  if (free !== null && free < thresholds.minFreeDiskBytes) {
    return `This computer is short on disk space (${formatGb(free)} free), so no new background job can start right now.  Tell the user.`;
  }
  if (thresholds.minFreeInodes !== undefined) {
    const inodes = storage ? storage.freeInodes : probe.freeInodes?.(dataDir) ?? null;
    if (inodes !== null && inodes < thresholds.minFreeInodes) return "This computer is short on inodes, so no new background job can start right now";
  }
  // Headroom gates (P-BF-6 B7): consulted only when the owner set the knob,
  // and each refuses only on a positively-read breach — an unknown reading
  // admits, exactly like swap and disk above.
  const { reservedCpuCores, reservedRamBytes, minMemoryAvailablePercent } = thresholds;
  if (reservedCpuCores !== undefined || reservedRamBytes !== undefined || minMemoryAvailablePercent !== undefined) {
    const headroom = probe.headroomReadings?.() ?? null;
    if (reservedCpuCores !== undefined && headroom?.availableCpuCores !== null && headroom?.availableCpuCores !== undefined && headroom.availableCpuCores < reservedCpuCores) {
      return "This computer is busy (less CPU headroom than the reserved cores), so no new background job can start right now.  Try again later, or tell the user.";
    }
    if (reservedRamBytes !== undefined && headroom?.ramAvailableBytes !== null && headroom?.ramAvailableBytes !== undefined && headroom.ramAvailableBytes < reservedRamBytes) {
      return `This computer is short on memory (${formatGb(headroom.ramAvailableBytes)} available, below the reserved headroom), so no new background job can start right now.  Try again later, or tell the user.`;
    }
    if (minMemoryAvailablePercent !== undefined && headroom?.memoryAvailablePercent !== null && headroom?.memoryAvailablePercent !== undefined && headroom.memoryAvailablePercent < minMemoryAvailablePercent) {
      return `This computer is short on memory (${Math.round(headroom.memoryAvailablePercent)}% available), so no new background job can start right now.  Try again later, or tell the user.`;
    }
  }
  return null;
}
