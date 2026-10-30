import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { EnforcementState, HostId, HostPlatform, HostResourcesReport } from "../shared/placement.ts";
import type { AdmissionThresholds, CapacityHostProbe } from "./jobs/admission.ts";

const CGROUP_FILES = ["cpu.max", "memory.high", "memory.max", "memory.swap.max", "pids.max", "io.max", "io.weight"] as const;
export interface HostResourcesDeps {
  hostId: HostId;
  version: string | null;
  platform: HostPlatform;
  dataDir: string;
  probe: CapacityHostProbe;
  thresholds: () => AdmissionThresholds;
  readText?: (path: string) => string;
}
export type HostResourcesResponse =
  | { status: 200; body: HostResourcesReport }
  | { status: 403 | 501; body: { error: string } };
interface HostResourceCaller { localOwner: boolean; fromCompanion: boolean; viaNamedTunnel: boolean }
type HostResourcesEndpointDeps = Omit<HostResourcesDeps, "platform"> & { platform: NodeJS.Platform };
type HostResourceSampler = (deps: HostResourcesDeps) => HostResourcesReport;

/** Bound repeated owner requests without adding a timer or a stale config view. */
export function createHostResourcesResponder(deps: HostResourcesEndpointDeps, now = () => performance.now()) {
  let cached: { at: number; settings: string; report: HostResourcesReport } | undefined;
  const sample: HostResourceSampler = (supported) => {
    const at = now();
    const settings = JSON.stringify(supported.thresholds());
    if (cached && at >= cached.at && at - cached.at < 1000 && cached.settings === settings) return cached.report;
    const report = hostResourcesReport(supported);
    cached = { at, settings, report };
    return report;
  };
  return (caller: HostResourceCaller) => hostResourcesResponse(caller, deps, sample);
}

/** The companion bearer is intentionally outside the host-owner boundary. */
export function hostResourcesResponse(
  caller: HostResourceCaller,
  deps: HostResourcesEndpointDeps,
  sample: HostResourceSampler = hostResourcesReport,
): HostResourcesResponse {
  if (!caller.localOwner || caller.fromCompanion || caller.viaNamedTunnel) {
    return { status: 403, body: { error: "Host resources are available only through the local owner or authenticated server gate" } };
  }
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return { status: 501, body: { error: "Host resource reporting is not available on this platform" } };
  }
  return { status: 200, body: sample({ ...deps, platform: deps.platform }) };
}

/** Resolve only this process's unified cgroup, respecting the mount's root. */
export function ownCgroupDirectory(cgroup: string, mountinfo: string): string | null {
  const path = /^0::([^\n]+)$/m.exec(cgroup)?.[1];
  if (!path?.startsWith("/") || path.split("/").includes("..")) return null;
  const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields[separator + 1] !== "cgroup2") continue;
    const root = decode(fields[3]!);
    const mount = decode(fields[4]!);
    if (!root.startsWith("/") || !mount.startsWith("/") || root.split("/").includes("..") || mount.split("/").includes("..")) continue;
    if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) continue;
    return posix.join(mount, root === "/" ? path : path.slice(root.length));
  }
  return null;
}

const finiteLimit = (raw: string | null): boolean => raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw));
const gate = (): EnforcementState => ({ kind: "gateOnly" });
const unsupported = (reason: string): EnforcementState => ({ kind: "unsupported", reason });

/** Kernel io.max keys whole block devices; resolve a partition through sysfs. */
export function ioDeviceForVolume(device: string, read: (path: string) => string | null): string | null {
  const isDevice = (value: string | null): value is string => value !== null && /^\d+:\d+$/.test(value);
  if (!isDevice(device)) return null;
  const block = `/sys/dev/block/${device}`;
  if (read(`${block}/dev`) !== device) return null;
  const partition = read(`${block}/partition`);
  if (partition === null) return device;
  if (!/^[1-9]\d*$/.test(partition)) return null;
  // Preserve /../ until kernel path lookup: the block entry is a sysfs symlink.
  const parent = read(`${block}/../dev`);
  return isDevice(parent) && parent !== device ? parent : null;
}

/** Read-back is evidence; desired config and drop-in contents are never consulted. */
export function hostResourcesReport(deps: HostResourcesDeps): HostResourcesReport {
  const read = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const safeRead = (path: string): string | null => { try { return read(path).trim(); } catch { return null; } };
  const sample = deps.probe.capacitySample(deps.dataDir);
  const storage = deps.probe.storageState?.() ?? null;
  const thresholds = deps.thresholds();
  const enforcement: HostResourcesReport["enforcement"] = {
    cpu: { kind: "priorityOnly" }, memory: gate(), swap: gate(), disk: gate(),
    inodes: unsupported("No inode admission gate is active"),
    io: unsupported("No I/O rate enforcement observed"),
  };
  if (sample.swapTotalBytes === 0) {
    enforcement.swap = unsupported("No swap is configured");
    enforcement.memory = unsupported("No swap is configured; no RAM budget check is active");
  } else if (sample.swapTotalBytes === null || sample.swapUsedBytes === null) {
    enforcement.memory = enforcement.swap = { kind: "notApplied", reason: "Swap reading unavailable; admission permits unknown readings", restartRequired: false };
  }
  if (sample.diskFreeBytes === null) enforcement.disk = { kind: "notApplied", reason: "Disk reading unavailable; admission permits unknown readings", restartRequired: false };
  const memoryConfigured = thresholds.reservedRamBytes !== undefined || thresholds.minMemoryAvailablePercent !== undefined;
  if (memoryConfigured) enforcement.memory =
    (thresholds.reservedRamBytes !== undefined && sample.ramAvailableBytes === null) ||
    (thresholds.minMemoryAvailablePercent !== undefined && sample.memoryAvailablePercent === null)
      ? { kind: "notApplied", reason: "Memory reading unavailable; admission permits unknown readings", restartRequired: false }
      : gate();
  if (thresholds.minFreeInodes !== undefined) enforcement.inodes = sample.inodesFree !== null
    ? gate() : { kind: "notApplied", reason: "Inode reading unavailable; admission permits unknown readings", restartRequired: false };
  if (storage?.online === false) enforcement.disk = { kind: "notApplied", reason: "Server storage offline; new jobs are refused", restartRequired: false };
  const observedLimits: Record<string, string | null> = Object.fromEntries(CGROUP_FILES.map((file) => [file, null]));
  const limitations = [
    memoryConfigured ? "Available memory is checked before jobs start; no aggregate job memory cap or watchdog is active" : "Memory admission currently checks swap; no available-RAM gate is configured",
    "Disk is an admission gate; no disk quota is observed",
    "Memory pressure categories are not inferred from available-memory percentage",
  ];
  if (deps.platform === "linux") {
    const cgroup = safeRead("/proc/self/cgroup");
    const mounts = safeRead("/proc/self/mountinfo");
    const directory = cgroup !== null && mounts !== null ? ownCgroupDirectory(cgroup, mounts) : null;
    for (const file of CGROUP_FILES) observedLimits[file] = directory ? safeRead(posix.join(directory, file)) : null;
    const cpu = /^(\d+) (\d+)$/.exec(observedLimits["cpu.max"] ?? "");
    if (cpu && Number(cpu[1]) > 0 && Number(cpu[2]) > 0 && cpu.slice(1).every((part) => Number.isSafeInteger(Number(part)))) {
      enforcement.cpu = { kind: "kernelCap", mechanism: "cgroup v2 CPU quota, whole server" };
    }
    if (finiteLimit(observedLimits["memory.max"]!)) enforcement.memory = { kind: "kernelCap", mechanism: "cgroup v2 memory.max, whole server; a runaway job can stop the harness" };
    if (finiteLimit(observedLimits["memory.swap.max"]!)) enforcement.swap = { kind: "kernelCap", mechanism: "cgroup v2 memory.swap.max, whole server" };
    const io = observedLimits["io.max"];
    const ioDevice = sample.dataVolume ? ioDeviceForVolume(sample.dataVolume.device, safeRead) : null;
    if (io == null || !sample.dataVolume || ioDevice === null) {
      enforcement.io = { kind: "notApplied", reason: "I/O limits or the data volume's whole block device could not be read; I/O enforcement is unknown", restartRequired: false };
      limitations.push("I/O limits or the data volume's whole block device could not be read; I/O enforcement is unknown");
    } else if (io.split("\n").some((line) => line.split(/\s/)[0] === ioDevice && /(?:^|\s)(?:rbps|wbps|riops|wiops)=[1-9]\d*(?:\s|$)/.test(line))) {
      enforcement.io = { kind: "kernelCap", mechanism: "cgroup v2 device I/O rate, whole server" };
    }
    if (!directory) limitations.push("This process's cgroup v2 could not be resolved; kernel enforcement is unknown");
    limitations.push("Read-back covers this cgroup, not ancestor limits or a per-job cgroup");
    limitations.push("Containers started through an external daemon can run outside this cgroup");
    limitations.push("I/O rates cover only the listed devices; disk space remains an admission gate");
    limitations.push("memory.high throttles memory use; it is not a hard memory cap");
  } else {
    limitations.push("Mac jobs use nice, taskpolicy utility when available and per-process CPU time; full CPU speed remains allowed");
    limitations.push("macOS provides no kernel cap for the aggregate resident memory of a job tree");
  }
  return {
    hostId: deps.hostId, version: deps.version, platform: deps.platform,
    capabilities: deps.platform === "darwin" ? ["shell", "macos", "desktop"] : ["shell"],
    sample, storage,
    admission: { ...thresholds, unknownReading: "admit" },
    enforcement, observedLimits, limitations,
  };
}
