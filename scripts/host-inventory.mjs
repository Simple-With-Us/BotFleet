#!/usr/bin/env node
import { cpus, freemem, totalmem } from "node:os";
import { execFile as callbackExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, statfs, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(callbackExecFile);
const MiB = 1024 ** 2;
export const MAX_SCOPES = 32;

export function aggregateSamples(samples, intervalMs) {
  if (!Array.isArray(samples) || samples.length < 1) throw new Error("at least one sample is required");
  const accumulator = new SampleAccumulator(intervalMs);
  for (const sample of samples) accumulator.add(sample);
  return accumulator.finish();
}

class SampleAccumulator {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.sampleCount = 0;
    this.previousAtMs = null;
    this.startAtMs = null;
    this.endAtMs = null;
    this.startEpochMs = null;
    this.endEpochMs = null;
    this.minGapMs = null;
    this.maxGapMs = null;
    this.groups = new Map();
  }

  add(sample) {
    if (!Number.isFinite(sample.atMs) || (this.previousAtMs !== null && sample.atMs <= this.previousAtMs)) {
      throw new Error("sample timestamps must be strictly increasing");
    }
    if (this.sampleCount === 0) {
      this.startAtMs = sample.atMs;
      this.startEpochMs = Number.isFinite(sample.epochMs) ? sample.epochMs : sample.atMs;
    } else {
      const gap = sample.atMs - this.previousAtMs;
      this.minGapMs = this.minGapMs === null ? gap : Math.min(this.minGapMs, gap);
      this.maxGapMs = this.maxGapMs === null ? gap : Math.max(this.maxGapMs, gap);
    }
    this.endAtMs = sample.atMs;
    this.endEpochMs = Number.isFinite(sample.epochMs) ? sample.epochMs : sample.atMs;
    const incoming = sample.groups ?? {};

    for (const [id, state] of this.groups) {
      if (!Object.hasOwn(incoming, id)) this.miss(state);
    }
    for (const [id, row] of Object.entries(incoming)) {
      let state = this.groups.get(id);
      if (!state) {
        state = this.newGroup(this.sampleCount);
        this.groups.set(id, state);
      }
      this.observe(state, row, sample.atMs);
    }
    this.previousAtMs = sample.atMs;
    this.sampleCount++;
  }

  newGroup(missingBeforeFirstObservation) {
    return {
      initial: { memoryBytes: null, cpuPercent: null, cpuUsec: null, ioReadBytes: null, ioWriteBytes: null },
      observedSamples: 0,
      missingSamples: missingBeforeFirstObservation,
      missing: missingBeforeFirstObservation > 0,
      identityRequired: false,
      initialIdentity: null,
      identityKnownAtStart: missingBeforeFirstObservation === 0,
      identityChanged: missingBeforeFirstObservation > 0,
      peakMemoryBytes: null,
      peakCPUPercent: null,
      previousCPU: null,
      firstReadBytes: null,
      lastReadBytes: null,
      readDeltaValid: true,
      firstWriteBytes: null,
      lastWriteBytes: null,
      writeDeltaValid: true,
      limitations: new Set(),
    };
  }

  miss(state) {
    state.missing = true;
    state.missingSamples++;
    state.readDeltaValid = false;
    state.writeDeltaValid = false;
    state.previousCPU = null;
    state.limitations.add("Scope was absent from one or more samples; interval peaks and counter deltas are unknown");
  }

  observe(state, row, atMs) {
    state.observedSamples++;
    for (const limitation of row.limitations ?? []) state.limitations.add(limitation);
    if (state.observedSamples === 1) {
      state.initial = {
        memoryBytes: finiteNonnegative(row.memoryBytes),
        cpuPercent: finiteNonnegative(row.cpuPercent),
        cpuUsec: finiteNonnegative(row.cpuUsec),
        ioReadBytes: finiteNonnegative(row.ioReadBytes),
        ioWriteBytes: finiteNonnegative(row.ioWriteBytes),
      };
      state.initialIdentity = row.identity ?? null;
      state.identityRequired = row.identityRequired === true;
      state.identityKnownAtStart = !state.identityRequired || state.initialIdentity !== null;
      if (!state.identityKnownAtStart) state.identityChanged = true;
    } else if (row.identityRequired === true || state.identityRequired) {
      state.identityRequired = true;
      if (!state.identityKnownAtStart || row.identity == null || row.identity !== state.initialIdentity) {
        state.identityChanged = true;
      }
    }

    const sameInitialIdentity = !state.identityRequired ||
      (state.identityKnownAtStart && row.identity != null && row.identity === state.initialIdentity);
    if (sameInitialIdentity) {
      state.peakMemoryBytes = maxNonnegative(state.peakMemoryBytes, row.memoryBytes);
      if (Number.isFinite(row.cpuPercent) && row.cpuPercent >= 0) {
        state.peakCPUPercent = maxNonnegative(state.peakCPUPercent, row.cpuPercent);
      } else if (Number.isFinite(row.cpuUsec) && row.cpuUsec >= 0 && state.previousCPU !== null &&
          (!state.identityRequired || state.previousCPU.identity === row.identity)) {
        const elapsed = atMs - state.previousCPU.atMs;
        if (elapsed > 0 && row.cpuUsec >= state.previousCPU.cpuUsec) {
          const percent = ((row.cpuUsec - state.previousCPU.cpuUsec) / 1000) / elapsed * 100;
          state.peakCPUPercent = maxNonnegative(state.peakCPUPercent, percent);
        }
      }
    }
    if (state.identityRequired && row.identity != null &&
        (!state.identityKnownAtStart || row.identity !== state.initialIdentity)) {
      state.identityChanged = true;
    }
    state.previousCPU = Number.isFinite(row.cpuUsec) && row.cpuUsec >= 0
      ? { atMs, cpuUsec: row.cpuUsec, identity: row.identity }
      : null;

    this.observeCounter(state, "read", row.ioReadBytes);
    this.observeCounter(state, "write", row.ioWriteBytes);
    if (state.identityChanged) {
      state.readDeltaValid = false;
      state.writeDeltaValid = false;
    }
  }

  observeCounter(state, kind, value) {
    const valid = Number.isFinite(value) && value >= 0;
    const firstKey = kind === "read" ? "firstReadBytes" : "firstWriteBytes";
    const lastKey = kind === "read" ? "lastReadBytes" : "lastWriteBytes";
    const validKey = kind === "read" ? "readDeltaValid" : "writeDeltaValid";
    if (!valid) {
      state[validKey] = false;
      return;
    }
    if (state[lastKey] !== null && value < state[lastKey]) state[validKey] = false;
    if (state[firstKey] === null) state[firstKey] = value;
    state[lastKey] = value;
  }

  finish() {
    const groupRows = {};
    for (const [id, state] of this.groups) {
      const incomplete = state.missing || state.observedSamples !== this.sampleCount;
      if (incomplete) state.missing = true;
      if (state.identityChanged) {
        state.limitations.add("Process identity changed or was unavailable during the window; peaks use only samples matching the known initial process and counter deltas are unknown");
      }
      groupRows[id] = {
        initial: state.initial,
        peak: {
          memoryBytes: state.missing ? null : state.peakMemoryBytes,
          cpuPercentOfOneCore: state.missing ? null : state.peakCPUPercent,
        },
        observedDelta: {
          ioReadBytes: !state.missing && state.readDeltaValid && state.firstReadBytes !== null && state.lastReadBytes !== null
            ? state.lastReadBytes - state.firstReadBytes : null,
          ioWriteBytes: !state.missing && state.writeDeltaValid && state.firstWriteBytes !== null && state.lastWriteBytes !== null
            ? state.lastWriteBytes - state.firstWriteBytes : null,
        },
        samples: state.observedSamples,
        coverage: { observedSamples: state.observedSamples, expectedSamples: this.sampleCount, complete: !state.missing },
        limitations: [...state.limitations],
      };
    }
    return {
      window: {
        startEpochMs: this.startEpochMs,
        endEpochMs: this.endEpochMs,
        durationMs: this.startAtMs === null ? null : this.endAtMs - this.startAtMs,
        durationClock: "monotonic",
        requestedIntervalMs: this.intervalMs,
        observedIntervalMinMs: this.minGapMs,
        observedIntervalMaxMs: this.maxGapMs,
      },
      groups: groupRows,
    };
  }
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function maxNonnegative(previous, value) {
  return Number.isFinite(value) && value >= 0 ? (previous === null ? value : Math.max(previous, value)) : previous;
}

function parseArgs(argv) {
  const options = { pids: [], units: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--output-dir") options.outputDir = value();
    else if (arg === "--window-seconds") options.windowSeconds = Number(value());
    else if (arg === "--interval-seconds") options.intervalSeconds = Number(value());
    else if (arg === "--data-path") options.dataPath = value();
    else if (arg === "--root-path") options.rootPath = value();
    else if (arg === "--pid") options.pids.push(Number(value()));
    else if (arg === "--unit") options.units.push(value());
    else if (arg === "--orbstack-reserved-cpu") options.orbCpu = Number(value());
    else if (arg === "--orbstack-reserved-memory-mib") options.orbMemoryMiB = Number(value());
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

export function validateOptions(options, platform = process.platform) {
  if (options.help) return;
  options.pids ??= [];
  options.units ??= [];
  if (!options.outputDir) throw new Error("--output-dir is required; choose a dedicated report directory");
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1 || options.windowSeconds > 7 * 24 * 3600) throw new Error("--window-seconds must be between 1 and 604800");
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > options.windowSeconds) throw new Error("--interval-seconds must be between 1 and the window");
  if (!options.dataPath || !options.rootPath) throw new Error("--data-path and --root-path are required");
  if (!options.pids.length && !options.units.length) throw new Error("select at least one --pid or --unit");
  options.pids = [...new Set(options.pids)];
  options.units = [...new Set(options.units)];
  if (options.pids.length + options.units.length > MAX_SCOPES) {
    throw new Error(`select at most ${MAX_SCOPES} unique PIDs and service units`);
  }
  if (options.pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) throw new Error("--pid must be a positive integer");
  if (options.units.some((unit) => !/^[A-Za-z0-9_.@:-]+\.service$/.test(unit))) throw new Error("--unit must be an explicit systemd .service unit name");
  if (options.units.length && platform !== "linux") throw new Error("--unit is supported only on Linux; select explicit --pid values on this platform");
  if (options.orbCpu !== undefined && (!Number.isFinite(options.orbCpu) || options.orbCpu < 0)) throw new Error("OrbStack CPU reservation must be a verified non-negative number");
  if (options.orbMemoryMiB !== undefined && (!Number.isFinite(options.orbMemoryMiB) || options.orbMemoryMiB < 0)) throw new Error("OrbStack memory reservation must be a verified non-negative number");
  if ((options.orbCpu !== undefined || options.orbMemoryMiB !== undefined) && platform !== "darwin") throw new Error("OrbStack reservation inputs apply only to a Mac report");
}

export function platformMeasurementLimits(platform) {
  if (platform === "darwin") return ["macOS process sampling excludes child processes", "macOS ps CPU percentage is sampled and per-process I/O is not read", "Mac PID start time is used as identity; if unavailable, cross-sample peaks and deltas are not combined", "OrbStack values are caller-supplied and are not verified by this script"];
  if (platform === "linux") return ["Linux PID sampling excludes child processes", "PID RSS and CPU use system page-size and clock-tick values when getconf is available", "PID I/O counters may be unavailable", "Cgroup metrics cover only the selected service cgroup and may omit delegated descendants or external container daemons"];
  return ["Process and service resource counters are unsupported on this platform"];
}

async function diskCapacity(path) {
  try {
    const s = await statfs(path);
    return { path, totalBytes: Number(s.blocks * s.bsize), freeBytes: Number(s.bavail * s.bsize), freeInodes: Number(s.ffree) };
  } catch (error) {
    return { path, totalBytes: null, freeBytes: null, freeInodes: null, unknown: error?.code ?? "statfs failed" };
  }
}

async function linuxSwap() {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const total = /^SwapTotal:\s+(\d+) kB$/m.exec(text);
    const free = /^SwapFree:\s+(\d+) kB$/m.exec(text);
    return total && free ? { totalBytes: Number(total[1]) * 1024, usedBytes: (Number(total[1]) - Number(free[1])) * 1024 } : null;
  } catch { return null; }
}

async function linuxUnitCgroup(unit) {
  const { stdout } = await execFile("systemctl", ["show", "--property=ControlGroup", "--value", unit], { timeout: 3000, maxBuffer: 1024 });
  const group = stdout.trim();
  if (!group.startsWith("/") || group.split("/").includes("..")) throw new Error(`could not resolve cgroup for ${unit}`);
  return `/sys/fs/cgroup${group}`;
}

async function cgroupSample(id, directory, atMs) {
  const get = async (name) => { try { return await readFile(`${directory}/${name}`, "utf8"); } catch { return null; } };
  const memory = Number.parseInt((await get("memory.current")) ?? "", 10);
  const cpu = /^usage_usec\s+(\d+)$/m.exec((await get("cpu.stat")) ?? "");
  const io = await get("io.stat");
  let readBytes = 0, writeBytes = 0, foundIo = false;
  for (const line of (io ?? "").split("\n")) for (const field of line.split(/\s+/).slice(1)) {
    const match = /^(rbytes|wbytes)=(\d+)$/.exec(field);
    if (match) { foundIo = true; if (match[1] === "rbytes") readBytes += Number(match[2]); else writeBytes += Number(match[2]); }
  }
  return { id, atMs, memoryBytes: Number.isFinite(memory) ? memory : null, cpuUsec: cpu ? Number(cpu[1]) : null, ioReadBytes: foundIo ? readBytes : null, ioWriteBytes: foundIo ? writeBytes : null, limitations: ["Cgroup metrics include processes in this service cgroup only; delegated descendants and external container daemons may be elsewhere"] };
}

async function pidSample(pid, atMs, platform, linuxConstants = {}) {
  if (platform === "linux") {
    try {
      const [stat, statm, io] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/statm`, "utf8"), readFile(`/proc/${pid}/io`, "utf8").catch(() => "")]);
      const identity = linuxPidIdentity(stat);
      const fields = linuxPidFields(stat);
      if (!identity || linuxPidIdentity(await readFile(`/proc/${pid}/stat`, "utf8")) !== identity) return { id: `pid:${pid}`, atMs, identityRequired: true, memoryBytes: null, cpuUsec: null, ioReadBytes: null, ioWriteBytes: null, limitations: ["PID exited or changed identity during sampling; sample metrics are unknown"] };
      const ticks = Number(fields[11]) + Number(fields[12]);
      const rssPages = Number(statm.split(/\s+/)[1]);
      const read = /^read_bytes:\s+(\d+)$/m.exec(io), write = /^write_bytes:\s+(\d+)$/m.exec(io);
      return { id: `pid:${pid}`, atMs, identity, identityRequired: true, memoryBytes: Number.isFinite(rssPages) && linuxConstants.pageSize ? rssPages * linuxConstants.pageSize : null, cpuUsec: Number.isFinite(ticks) && linuxConstants.clockTicks ? ticks * 1e6 / linuxConstants.clockTicks : null, ioReadBytes: read ? Number(read[1]) : null, ioWriteBytes: write ? Number(write[1]) : null, limitations: ["PID scope excludes child processes", ...(!identity ? ["PID identity unavailable; cross-sample peaks and deltas are not combined"] : []), ...(!linuxConstants.pageSize ? ["RSS unavailable because system page size could not be read"] : []), ...(!linuxConstants.clockTicks ? ["PID CPU unavailable because clock tick rate could not be read"] : []), "I/O counters are per-process and may be unavailable"] };
    } catch { return { id: `pid:${pid}`, atMs, identityRequired: true, memoryBytes: null, cpuUsec: null, ioReadBytes: null, ioWriteBytes: null, limitations: ["PID was unavailable or exited during sample"] }; }
  }
  try {
    const { stdout } = await execFile("/bin/ps", ["-o", "pid=,rss=,%cpu=,lstart=", "-p", String(pid)], { timeout: 2000, maxBuffer: 1024 });
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)\s*$/.exec(stdout);
    if (!match || Number(match[1]) !== pid) throw new Error("missing process");
    const identity = match[4].trim() || null;
    return { id: `pid:${pid}`, atMs, identity, identityRequired: true, memoryBytes: Number(match[2]) * 1024, cpuPercent: Number(match[3]), cpuUsec: null, ioReadBytes: null, ioWriteBytes: null, limitations: ["PID scope excludes child processes", ...(!identity ? ["PID start time unavailable; cross-sample peaks and deltas are not combined"] : []), "macOS ps CPU percentage is sampled and I/O counters are not read"] };
  } catch { return { id: `pid:${pid}`, atMs, identityRequired: true, memoryBytes: null, cpuUsec: null, ioReadBytes: null, ioWriteBytes: null, limitations: ["PID was unavailable or exited during sample", "macOS PID CPU and I/O counters are unavailable"] }; }
}

function linuxPidFields(stat) {
  const close = stat.lastIndexOf(")");
  return close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/); // Fields after comm: state is field 3.
}

export function linuxPidIdentity(stat) {
  const startTimeTicks = linuxPidFields(stat)[19];
  return startTimeTicks && /^\d+$/.test(startTimeTicks) ? `start:${startTimeTicks}` : null;
}

async function capacities(options, platform) {
  const disks = { root: await diskCapacity(options.rootPath), data: await diskCapacity(options.dataPath) };
  const linuxMemory = platform === "linux" ? await linuxMemAvailable() : null;
  const common = { logicalCpuCount: cpus().length || null, totalMemoryBytes: totalmem() || null, availableMemoryBytes: linuxMemory, freeMemoryBytes: freemem() || null, disks, swap: platform === "linux" ? await linuxSwap() : null };
  if (platform === "darwin") {
    try {
      const { stdout } = await execFile("/usr/sbin/sysctl", ["vm.swapusage"], { timeout: 2000, maxBuffer: 1024 });
      const values = Object.fromEntries([...stdout.matchAll(/(total|used|free)\s*=\s*([\d.]+)([MG])/g)].map((m) => [m[1], Number(m[2]) * (m[3] === "G" ? 1024 ** 3 : MiB)]));
      common.swap = Number.isFinite(values.total) && Number.isFinite(values.used) ? { totalBytes: values.total, usedBytes: values.used } : null;
    } catch { common.swap = null; }
  }
  return { ...common, orbStackReservation: options.orbCpu !== undefined || options.orbMemoryMiB !== undefined ? { cpuCores: options.orbCpu ?? null, memoryBytes: options.orbMemoryMiB === undefined ? null : options.orbMemoryMiB * MiB, provenance: "explicit caller input; not verified by this script" } : null };
}

async function linuxMemAvailable() {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    return availableMemoryBytes("linux", text);
  } catch { return null; }
}

export function parseLinuxMemAvailableBytes(meminfo) {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

export function availableMemoryBytes(platform, linuxMeminfo = null) {
  return platform === "linux" && linuxMeminfo !== null ? parseLinuxMemAvailableBytes(linuxMeminfo) : null;
}

async function linuxPidConstants() {
  const readPositiveInteger = async (name) => execFile("getconf", [name], { timeout: 2000, maxBuffer: 128 }).then(({ stdout }) => {
    const value = Number(stdout.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }).catch(() => null);
  const [pageSize, clockTicks] = await Promise.all([readPositiveInteger("PAGESIZE"), readPositiveInteger("CLK_TCK")]);
  return { pageSize, clockTicks };
}

export function renderMarkdown(report) {
  const availabilityLabel = report.host.platform === "linux" ? "available (MemAvailable)" : "available (not reported)";
  const start = new Date(report.window.startEpochMs).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true });
  const end = new Date(report.window.endEpochMs).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true });
  const lines = ["# Host Inventory", "", `- Host: ${report.host.platform}`, `- Window wall-clock boundaries: ${start} to ${end}`, `- Observed duration: ${fmt(report.window.durationMs, "ms")} (monotonic clock)`, `- Requested interval: ${report.window.requestedIntervalMs} ms`, "", "| Scope | Initial resident memory | Peak resident memory | Initial CPU | Peak CPU | Read / write delta | Sample coverage |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [id, row] of Object.entries(report.groups)) lines.push(`| ${id} | ${fmt(row.initial.memoryBytes, "bytes")} | ${fmt(row.peak.memoryBytes, "bytes")} | ${fmt(row.initial.cpuPercent, "% of one core")} | ${fmt(row.peak.cpuPercentOfOneCore, "% of one core")} | ${fmt(row.observedDelta.ioReadBytes, "bytes")} / ${fmt(row.observedDelta.ioWriteBytes, "bytes")} | ${row.coverage.observedSamples}/${row.coverage.expectedSamples} |`);
  lines.push("", "## Capacity", "", `- Logical CPUs: ${fmt(report.capacity.logicalCpuCount, "cores")}`, `- Memory: ${fmt(report.capacity.totalMemoryBytes, "bytes")} total; ${fmt(report.capacity.availableMemoryBytes, "bytes")} ${availabilityLabel}; ${fmt(report.capacity.freeMemoryBytes, "bytes")} free per Node OS API`, `- Swap: ${report.capacity.swap ? `${fmt(report.capacity.swap.totalBytes, "bytes")} total; ${fmt(report.capacity.swap.usedBytes, "bytes")} used` : "unknown"}`, `- Root disk: ${fmt(report.capacity.disks.root.freeBytes, "bytes")} free; ${fmt(report.capacity.disks.root.freeInodes, "inodes")} free inodes`, `- Data disk: ${fmt(report.capacity.disks.data.freeBytes, "bytes")} free; ${fmt(report.capacity.disks.data.freeInodes, "inodes")} free inodes`, `- OrbStack reservation: ${report.capacity.orbStackReservation ? "explicit input only; not verified by this script" : "unknown / not supplied"}`, "", "## Measurement Limits", ...report.limitations.map((limitation) => `- ${limitation}`), "");
  return lines.join("\n");
}

function fmt(value, unit) { return Number.isFinite(value) ? `${Math.round(value * 100) / 100} ${unit}` : "unknown"; }

async function prepareOutputTargets(outputDir) {
  await mkdir(outputDir, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw new Error("output directory could not be created without creating missing parents");
  });
  const directory = await lstat(outputDir).catch(() => null);
  const uid = process.getuid();
  if (!directory?.isDirectory() || directory.isSymbolicLink() ||
      (uid !== null && directory.uid !== uid) || (directory.mode & 0o022) !== 0) {
    throw new Error("output directory must be a user-owned directory that is not writable by other users");
  }
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_CLOEXEC ?? 0);
  const targets = [];
  try {
    for (const [kind, name] of [["json", "host-inventory.json"], ["markdown", "host-inventory.md"]]) {
      const path = resolve(outputDir, name);
      const handle = await open(path, flags, 0o600);
      const info = await handle.stat();
      const target = { kind, path, handle, closed: false, identity: null };
      targets.push(target);
      target.identity = { dev: info.dev, ino: info.ino, uid: info.uid };
      if (!info.isFile() || info.nlink !== 1 || (uid !== null && info.uid !== uid) || (info.mode & 0o077) !== 0) {
        throw new Error("report target is not a private, exclusively created regular file");
      }
    }
    return targets;
  } catch (error) {
    await cleanupOutputTargets(targets);
    if (error?.code === "EEXIST") throw new Error("report target already exists; choose a new output directory");
    throw error;
  }
}

async function cleanupOutputTargets(targets) {
  for (const target of targets) {
    if (!target.closed) {
      try { await target.handle.close(); } catch {}
      target.closed = true;
    }
    if (!target.identity) continue;
    try {
      const current = await lstat(target.path);
      if (current.isFile() && current.nlink === 1 &&
          current.dev === target.identity.dev && current.ino === target.identity.ino &&
          current.uid === target.identity.uid &&
          current.uid === process.getuid()) {
        await unlink(target.path);
      }
    } catch {}
  }
}

async function closeOutputTargets(targets) {
  for (const target of targets) {
    if (!target.closed) {
      await target.handle.close();
      target.closed = true;
    }
  }
}

export function repositoryRootFor(moduleURL) {
  return fileURLToPath(new URL("..", moduleURL));
}

async function readSourceCommit(moduleURL = import.meta.url, runExecFile = execFile) {
  try {
    const { stdout } = await runExecFile("git", ["-C", repositoryRootFor(moduleURL), "rev-parse", "HEAD"], { timeout: 2000, maxBuffer: 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function run(options, dependencies = {}) {
  validateOptions(options);
  const targets = await prepareOutputTargets(resolve(options.outputDir));
  try {
    const platform = dependencies.platform ?? process.platform;
    const wallNow = dependencies.wallNow ?? Date.now;
    const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
    const capacity = await (dependencies.readCapacity ?? capacities)(options, platform);
    const pidConstants = options.pids.length && platform === "linux"
      ? await (dependencies.readPidConstants ?? linuxPidConstants)()
      : {};
    const resolveUnit = dependencies.resolveUnitCgroup ?? linuxUnitCgroup;
    const unitPaths = await Promise.all(options.units.map(async (unit) => [unit, await resolveUnit(unit)]));
    const groups = new Map(unitPaths.map(([unit, path]) => [unit, { kind: "cgroup", path }]));
    for (const pid of options.pids) groups.set(`pid:${pid}`, { kind: "pid", pid });
    const sampleGroup = dependencies.sampleGroup ?? (async (id, source, atMs) =>
      source.kind === "cgroup"
        ? cgroupSample(id, source.path, atMs)
        : pidSample(source.pid, atMs, platform, pidConstants));
    const accumulator = new SampleAccumulator(options.intervalSeconds * 1000);
    const startAtMs = monotonicNow();
    const deadline = startAtMs + options.windowSeconds * 1000;
    do {
      const atMs = monotonicNow();
      const epochMs = wallNow();
      const rows = await Promise.all([...groups].map(([id, source]) => sampleGroup(id, source, atMs)));
      accumulator.add({ atMs, epochMs, groups: Object.fromEntries(rows.map(({ id, ...row }) => [id, row])) });
      const now = monotonicNow();
      const remaining = deadline - now;
      if (remaining <= 0) break;
      await sleep(Math.min(options.intervalSeconds * 1000, remaining));
    } while (monotonicNow() < deadline);

    const summary = accumulator.finish();
    const limitations = [
      "Capacity is a point-in-time OS reading; this report does not establish a safe budget or enforce limits",
      "Observed peak covers only the selected PIDs or systemd service cgroups and the caller-selected window",
      "No process arguments, environment, credentials, application config or task launches are read",
      "Sampled duration and intervals use a monotonic clock; wall-clock boundaries are recorded as observed and may move backwards if system time changes",
      "A short interval can miss bursts; counters that reset, disappear or lack complete scope coverage are reported as unknown",
      `At most ${MAX_SCOPES} unique scopes can be selected; this is a collector safety bound, not a runtime or resource budget`,
      ...(platform === "darwin" ? ["macOS process sampling excludes child processes and does not read per-process I/O", "OrbStack values are caller-supplied and are not verified by this script"] : []),
    ];
    const sourceCommit = await (dependencies.readSourceCommit ?? readSourceCommit)();
    reportSourceCommitGuard(sourceCommit);
    const report = {
      schemaVersion: 1,
      capturedAtEpochMs: wallNow(),
      sourceCommit,
      host: { platform },
      capacity,
      window: summary.window,
      groups: summary.groups,
      limitations: [...limitations, ...platformMeasurementLimits(platform)],
    };
    const writeArtifact = dependencies.writeArtifact ?? ((target, contents) => target.handle.writeFile(contents));
    await writeArtifact(targets[0], `${JSON.stringify(report, null, 2)}\n`);
    await writeArtifact(targets[1], renderMarkdown(report));
    await Promise.all(targets.map((target) => target.handle.sync()));
    await closeOutputTargets(targets);
    return report;
  } catch (error) {
    await cleanupOutputTargets(targets);
    throw error;
  }
}

function reportSourceCommitGuard(sourceCommit) {
  if (sourceCommit !== null && !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) throw new Error("git returned an invalid source commit identifier");
}

function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/host-inventory.mjs --output-dir DIR --window-seconds N --interval-seconds N --root-path PATH --data-path PATH (--pid PID | --unit NAME) [--pid PID ...] [--unit NAME ...] [--orbstack-reserved-cpu N --orbstack-reserved-memory-mib N]\n");
    } else await run(options);
  } catch (error) {
    process.stderr.write(`host-inventory: ${error.message}\n`);
    process.exitCode = 2;
  }
}
