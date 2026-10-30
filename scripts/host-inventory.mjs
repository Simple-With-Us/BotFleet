#!/usr/bin/env node
import { cpus, freemem, totalmem } from "node:os";
import { execFile as callbackExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(callbackExecFile);
const MiB = 1024 ** 2;

export function aggregateSamples(samples, intervalMs) {
  if (!Array.isArray(samples) || samples.length < 1) throw new Error("at least one sample is required");
  if (samples.some((sample, index) => !Number.isFinite(sample.atMs) || (index > 0 && sample.atMs <= samples[index - 1].atMs))) throw new Error("sample timestamps must be strictly increasing");
  const groups = new Map();
  for (const sample of samples) {
    for (const [id, current] of Object.entries(sample.groups ?? {})) {
      const rows = groups.get(id) ?? [];
      rows.push({ atMs: sample.atMs, ...current });
      groups.set(id, rows);
    }
  }
  const start = samples[0].atMs;
  const end = samples.at(-1).atMs;
  const gaps = samples.slice(1).map((sample, index) => sample.atMs - samples[index].atMs).filter((gap) => gap >= 0);
  return {
    window: { startEpochMs: start, endEpochMs: end, durationMs: Math.max(0, end - start), requestedIntervalMs: intervalMs, observedIntervalMinMs: gaps.length ? Math.min(...gaps) : null, observedIntervalMaxMs: gaps.length ? Math.max(...gaps) : null },
    groups: Object.fromEntries([...groups].map(([id, rows]) => {
      const first = rows[0];
      const identityRequired = rows.some((row) => row.identityRequired === true);
      const hasIdentity = first.identity != null;
      const identityChanged = identityRequired && (!hasIdentity || rows.some((row) => row.identity !== first.identity));
      const rowsForPeak = identityChanged ? rows.filter((row) => hasIdentity && row.identity === first.identity) : rows;
      const peak = (key) => {
        const valid = rowsForPeak.map((row) => row[key]).filter((value) => Number.isFinite(value) && value >= 0);
        return valid.length ? Math.max(...valid) : null;
      };
      const cpu = rowsForPeak.map((row, i) => {
        if (Number.isFinite(row.cpuPercent)) return row.cpuPercent;
        if (i === 0) return null;
        const previous = rowsForPeak[i - 1];
        if (!Number.isFinite(row.cpuUsec) || !Number.isFinite(previous.cpuUsec) || row.cpuUsec < previous.cpuUsec) return null;
        const elapsed = row.atMs - previous.atMs;
        return elapsed > 0 ? ((row.cpuUsec - previous.cpuUsec) / 1000) / elapsed * 100 : null;
      }).filter((value) => value !== null);
      const ioDelta = (key) => {
        if (identityChanged || rows.some((row) => !Number.isFinite(row[key]) || row[key] < 0)) return null;
        const counters = rows.map((row) => row[key]);
        if (counters.some((value, index) => index > 0 && value < counters[index - 1])) return null;
        return counters.at(-1) - counters[0];
      };
      const limitations = [...new Set(rows.flatMap((row) => row.limitations ?? []))];
      if (identityChanged) limitations.push("Process identity changed or was unavailable during the window; peaks use only samples matching the known initial process and counter deltas are unknown");
      return [id, {
        initial: { memoryBytes: Number.isFinite(first.memoryBytes) ? first.memoryBytes : null, cpuPercent: Number.isFinite(first.cpuPercent) ? first.cpuPercent : null, cpuUsec: Number.isFinite(first.cpuUsec) ? first.cpuUsec : null, ioReadBytes: Number.isFinite(first.ioReadBytes) ? first.ioReadBytes : null, ioWriteBytes: Number.isFinite(first.ioWriteBytes) ? first.ioWriteBytes : null },
        peak: { memoryBytes: peak("memoryBytes"), cpuPercentOfOneCore: cpu.length ? Math.max(...cpu) : null },
        observedDelta: { ioReadBytes: ioDelta("ioReadBytes"), ioWriteBytes: ioDelta("ioWriteBytes") },
        samples: rows.length,
        limitations,
      }];
    })),
  };
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
  return platform === "linux" && linuxMeminfo != null ? parseLinuxMemAvailableBytes(linuxMeminfo) : null;
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
  const lines = ["# Host Inventory", "", `- Host: ${report.host.platform}`, `- Window: ${new Date(report.window.startEpochMs).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true })} to ${new Date(report.window.endEpochMs).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true })}`, `- Requested interval: ${report.window.requestedIntervalMs} ms`, "", "| Scope | Initial resident memory | Peak resident memory | Initial CPU | Peak CPU | Read / write delta | Samples |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [id, row] of Object.entries(report.groups)) lines.push(`| ${id} | ${fmt(row.initial.memoryBytes, "bytes")} | ${fmt(row.peak.memoryBytes, "bytes")} | ${fmt(row.initial.cpuPercent, "% of one core")} | ${fmt(row.peak.cpuPercentOfOneCore, "% of one core")} | ${fmt(row.observedDelta.ioReadBytes, "bytes")} / ${fmt(row.observedDelta.ioWriteBytes, "bytes")} | ${row.samples} |`);
  lines.push("", "## Capacity", "", `- Logical CPUs: ${fmt(report.capacity.logicalCpuCount, "cores")}`, `- Memory: ${fmt(report.capacity.totalMemoryBytes, "bytes")} total; ${fmt(report.capacity.availableMemoryBytes, "bytes")} ${availabilityLabel}; ${fmt(report.capacity.freeMemoryBytes, "bytes")} free per Node OS API`, `- Swap: ${report.capacity.swap ? `${fmt(report.capacity.swap.totalBytes, "bytes")} total; ${fmt(report.capacity.swap.usedBytes, "bytes")} used` : "unknown"}`, `- Root disk: ${fmt(report.capacity.disks.root.freeBytes, "bytes")} free; ${fmt(report.capacity.disks.root.freeInodes, "inodes")} free inodes`, `- Data disk: ${fmt(report.capacity.disks.data.freeBytes, "bytes")} free; ${fmt(report.capacity.disks.data.freeInodes, "inodes")} free inodes`, `- OrbStack reservation: ${report.capacity.orbStackReservation ? "explicit input only; not verified by this script" : "unknown / not supplied"}`, "", "## Measurement Limits", ...report.limitations.map((limitation) => `- ${limitation}`), "");
  return lines.join("\n");
}

function fmt(value, unit) { return Number.isFinite(value) ? `${Math.round(value * 100) / 100} ${unit}` : "unknown"; }

async function run(options) {
  validateOptions(options);
  const outputDir = resolve(options.outputDir);
  const startMs = Date.now();
  const deadline = startMs + options.windowSeconds * 1000;
  const platform = process.platform;
  const capacity = await capacities(options, platform);
  const pidConstants = platform === "linux" && options.pids.length ? await linuxPidConstants() : {};
  const unitPaths = await Promise.all(options.units.map(async (unit) => [unit, await linuxUnitCgroup(unit)]));
  const groups = new Map(unitPaths.map(([unit, path]) => [unit, { kind: "cgroup", path }]));
  for (const pid of options.pids) groups.set(`pid:${pid}`, { kind: "pid", pid });
  const samples = [];
  do {
    const atMs = Date.now();
    const rows = await Promise.all([...groups].map(async ([id, source]) => source.kind === "cgroup" ? cgroupSample(id, source.path, atMs) : pidSample(source.pid, atMs, platform, pidConstants)));
    samples.push({ atMs, groups: Object.fromEntries(rows.map(({ id, ...row }) => [id, row])) });
    if (Date.now() >= deadline) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(options.intervalSeconds * 1000, deadline - Date.now())));
  } while (Date.now() < deadline);
  const summary = aggregateSamples(samples, options.intervalSeconds * 1000);
  const limitations = [
    "Capacity is a point-in-time OS reading; this report does not establish a safe budget or enforce limits",
    "Observed peak covers only the selected PIDs or systemd service cgroups and the caller-selected window",
    "No process arguments, environment, credentials, application config or task launches are read",
    "A short interval can miss bursts; counters that reset or disappear are reported as unknown",
    ...(platform === "darwin" ? ["macOS process sampling excludes child processes and does not read per-process I/O", "OrbStack values are caller-supplied and are not verified by this script"] : []),
  ];
  const sourceCommit = await execFile("git", ["-C", new URL("..", import.meta.url).pathname, "rev-parse", "HEAD"], { timeout: 2000, maxBuffer: 1024 }).then(({ stdout }) => stdout.trim()).catch(() => null);
  reportSourceCommitGuard(sourceCommit);
  const report = { schemaVersion: 1, capturedAtEpochMs: Date.now(), sourceCommit, host: { platform }, capacity, window: summary.window, groups: summary.groups, limitations: [...limitations, ...platformMeasurementLimits(platform)] };
  await mkdir(outputDir, { recursive: false }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  await writeFile(resolve(outputDir, "host-inventory.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDir, "host-inventory.md"), renderMarkdown(report), { flag: "wx", mode: 0o600 });
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
