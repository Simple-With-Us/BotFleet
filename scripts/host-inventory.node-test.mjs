import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSamples, availableMemoryBytes, cgroupSample, linuxPidIdentity, MAX_SCOPES, parseLinuxMemAvailableBytes, parseMacCpuTimeUsec, pidSample, platformMeasurementLimits, readSourceCommit, repositoryRootFor, run, runWithCliSignalHandlers, validateOptions } from "./host-inventory.mjs";

test("prints help when invoked through a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "host-inventory-symlink-"));
  try {
    const entry = fileURLToPath(new URL("./host-inventory.mjs", import.meta.url));
    const alias = join(directory, "inventory.mjs");
    symlinkSync(entry, alias);
    const result = spawnSync(process.execPath, [alias, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: node scripts\/host-inventory\.mjs/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aggregates initial baseline, peak memory and sampled CPU without inventing missing counters", () => {
  const result = aggregateSamples([
    { atMs: 1000, groups: { "botfleet.service": { memoryBytes: 10, cpuUsec: 1000, ioReadBytes: 40, ioWriteBytes: 15 } } },
    { atMs: 2000, groups: { "botfleet.service": { memoryBytes: 15, cpuUsec: 401000, ioReadBytes: 80, ioWriteBytes: 25 } } },
    { atMs: 3000, groups: { "botfleet.service": { memoryBytes: 13, cpuUsec: 601000, ioReadBytes: 110, ioWriteBytes: 35 } } },
  ], 1000);
  assert.deepEqual(result.window, { startEpochMs: 1000, endEpochMs: 3000, durationMs: 2000, durationClock: "monotonic", requestedIntervalMs: 1000, observedIntervalMinMs: 1000, observedIntervalMaxMs: 1000 });
  assert.equal(result.groups["botfleet.service"].initial.memoryBytes, 10);
  assert.equal(result.groups["botfleet.service"].peak.memoryBytes, 15);
  assert.equal(result.groups["botfleet.service"].memoryKind, "unknown");
  assert.equal(result.groups["botfleet.service"].peak.cpuPercentOfOneCoreEstimate, 40);
  assert.deepEqual(result.groups["botfleet.service"].peak.cpuPercentOfOneCoreEstimateRange, { minimum: 40, maximum: 40 });
  assert.deepEqual(result.groups["botfleet.service"].observedDelta, { ioReadBytes: 70, ioWriteBytes: 20 });
  assert.deepEqual(result.groups["botfleet.service"].coverage, { observedSamples: 3, expectedSamples: 3, complete: true });
});

test("marks peaks and counter deltas unknown when a selected scope is absent mid-window", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "unit.service": { memoryBytes: 5, cpuPercentOSAverage: 2, ioReadBytes: 100, ioWriteBytes: 50 } } },
    { atMs: 20, groups: {} },
    { atMs: 30, groups: { "unit.service": { memoryBytes: 90, cpuPercentOSAverage: 80, ioReadBytes: 1000, ioWriteBytes: 500 } } },
  ], 10);
  const scope = result.groups["unit.service"];
  assert.equal(scope.initial.memoryBytes, 5);
  assert.deepEqual(scope.peak, { memoryBytes: null, cpuPercentOfOneCoreEstimate: null, cpuPercentOfOneCoreEstimateRange: null });
  assert.deepEqual(scope.observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.deepEqual(scope.coverage, { observedSamples: 2, expectedSamples: 3, complete: false });
  assert.match(scope.limitations.join(" "), /absent from one or more samples/);
});

test("aggregates a large synthetic sample window without argument spreading", () => {
  const samples = Array.from({ length: 150_001 }, (_, index) => ({
    atMs: index,
    groups: { "unit.service": { memoryBytes: index % 17, cpuUsec: index * 120, ioReadBytes: index, ioWriteBytes: index * 2 } },
  }));
  const result = aggregateSamples(samples, 1);
  assert.equal(result.window.observedIntervalMinMs, 1);
  assert.equal(result.window.observedIntervalMaxMs, 1);
  assert.equal(result.window.durationMs, 150_000);
  assert.equal(result.groups["unit.service"].peak.memoryBytes, 16);
  assert.equal(result.groups["unit.service"].peak.cpuPercentOfOneCoreEstimate, 12);
  assert.deepEqual(result.groups["unit.service"].observedDelta, { ioReadBytes: 150_000, ioWriteBytes: 300_000 });
});

test("reports unknown for unavailable or reset counters and preserves limitation evidence", () => {
  const result = aggregateSamples([
    { atMs: 1, groups: { "pid:17": { memoryBytes: null, cpuUsec: 900, ioReadBytes: 100, limitations: ["counter unavailable"] } } },
    { atMs: 2, groups: { "pid:17": { memoryBytes: null, cpuUsec: 200, ioReadBytes: 5, limitations: ["counter unavailable"] } } },
  ], 1000);
  assert.deepEqual(result.groups["pid:17"].initial, { memoryBytes: null, memoryKind: "unknown", cpuPercentOSAverage: null, cpuUsec: 900, ioReadBytes: 100, ioWriteBytes: null });
  assert.deepEqual(result.groups["pid:17"].peak, { memoryBytes: null, cpuPercentOfOneCoreEstimate: null, cpuPercentOfOneCoreEstimateRange: null });
  assert.deepEqual(result.groups["pid:17"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.deepEqual(result.groups["pid:17"].limitations, ["counter unavailable", "CPU counter or read-time bounds were unavailable or decreased; full-window interval CPU estimate is unknown"]);
});

test("marks a counter delta unknown after any mid-window reset", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "unit.service": { memoryBytes: 5, cpuUsec: 100, ioReadBytes: 100, ioWriteBytes: 50 } } },
    { atMs: 20, groups: { "unit.service": { memoryBytes: 6, cpuUsec: 200, ioReadBytes: 10, ioWriteBytes: 10 } } },
    { atMs: 30, groups: { "unit.service": { memoryBytes: 7, cpuUsec: 300, ioReadBytes: 150, ioWriteBytes: 70 } } },
  ], 10);
  assert.deepEqual(result.groups["unit.service"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
});

test("marks the full-window CPU peak unknown after a mid-window counter reset and recovery", () => {
  const result = aggregateSamples([
    { atMs: 0, groups: { "unit.service": { cpuUsec: 1_000, ioReadBytes: 10 } } },
    { atMs: 100, groups: { "unit.service": { cpuUsec: 101_000, ioReadBytes: 20 } } },
    { atMs: 200, groups: { "unit.service": { cpuUsec: 10, ioReadBytes: 30 } } },
    { atMs: 300, groups: { "unit.service": { cpuUsec: 500_010, ioReadBytes: 40 } } },
  ], 100);
  assert.equal(result.groups["unit.service"].peak.cpuPercentOfOneCoreEstimate, null);
  assert.match(result.groups["unit.service"].limitations.join(" "), /CPU counter or read-time bounds were unavailable or decreased/);
});

test("requires complete host-memory samples before reporting a sampled minimum", () => {
  const result = aggregateSamples([
    { atMs: 1, availableMemoryBytes: 500, groups: {} },
    { atMs: 2, availableMemoryBytes: null, groups: {} },
    { atMs: 3, availableMemoryBytes: 300, groups: {} },
  ], 1);
  assert.deepEqual(result.availableMemory, { minimumBytes: null, observedSamples: 2, expectedSamples: 3, complete: false });
});

test("does not combine cgroup counters or peaks across a recreated unit directory", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "unit.service": { identityRequired: true, identity: "dev:1:ino:2", memoryBytes: 100, memoryKind: "cgroupCharged", cpuUsec: 10_000, ioReadBytes: 100 } } },
    { atMs: 20, groups: { "unit.service": { identityRequired: true, identity: "dev:1:ino:3", memoryBytes: 900, memoryKind: "cgroupCharged", cpuUsec: 500_000, ioReadBytes: 900 } } },
  ], 10);
  assert.equal(result.groups["unit.service"].peak.memoryBytes, 100);
  assert.equal(result.groups["unit.service"].peak.cpuPercentOfOneCoreEstimate, null);
  assert.deepEqual(result.groups["unit.service"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
});

test("does not combine samples or deltas across a reused PID", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "pid:17": { identityRequired: true, identity: "start:old", memoryBytes: 20, cpuPercentOSAverage: 4, ioReadBytes: 100 } } },
    { atMs: 20, groups: { "pid:17": { identityRequired: true, identity: "start:new", memoryBytes: 90, cpuPercentOSAverage: 80, ioReadBytes: 1000 } } },
  ], 10);
  assert.equal(result.groups["pid:17"].peak.memoryBytes, 20);
  assert.equal(result.groups["pid:17"].peak.cpuPercentOfOneCoreEstimate, null);
  assert.deepEqual(result.groups["pid:17"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.match(result.groups["pid:17"].limitations.join(" "), /identity changed/);
  assert.equal(result.groups["pid:17"].initial.cpuPercentOSAverage, 4);
  const unavailableIdentity = aggregateSamples([
    { atMs: 30, groups: { "pid:18": { identityRequired: true, memoryBytes: 3 } } },
    { atMs: 40, groups: { "pid:18": { identityRequired: true, identity: "start:later", memoryBytes: 9 } } },
  ], 10);
  assert.equal(unavailableIdentity.groups["pid:18"].peak.memoryBytes, null);
});

test("rejects non-monotonic sample timestamps", () => {
  assert.throws(() => aggregateSamples([{ atMs: 20, groups: {} }, { atMs: 20, groups: {} }], 10), /strictly increasing/);
  assert.throws(() => aggregateSamples([{ atMs: 20, groups: {} }, { atMs: 19, groups: {} }], 10), /strictly increasing/);
});

test("parses Linux MemAvailable and leaves unsupported or absent platform readings unknown", () => {
  const meminfo = "MemTotal: 8192 kB\nMemFree: 100 kB\nMemAvailable: 2048 kB\n";
  assert.equal(parseLinuxMemAvailableBytes(meminfo), 2048 * 1024);
  assert.equal(parseLinuxMemAvailableBytes("MemTotal: 8192 kB\nMemFree: 100 kB\n"), null);
  assert.equal(availableMemoryBytes("darwin", meminfo), null);
  assert.equal(availableMemoryBytes("linux"), null);
});

test("parses cumulative macOS ps CPU time formats and rejects malformed values", () => {
  assert.equal(parseMacCpuTimeUsec("01:02"), 62_000_000);
  assert.equal(parseMacCpuTimeUsec("02:01:02.5"), 7_262_500_000);
  assert.equal(parseMacCpuTimeUsec("3-02:01:02.000007"), ((3 * 24 + 2) * 3600 + 62) * 1_000_000 + 7);
  assert.equal(parseMacCpuTimeUsec("60:00.00"), 3_600_000_000);
  assert.equal(parseMacCpuTimeUsec("123:45.67"), 7_425_670_000);
  assert.equal(parseMacCpuTimeUsec("1-24:00:00"), null);
  assert.equal(parseMacCpuTimeUsec("24:00:00"), null);
  assert.equal(parseMacCpuTimeUsec("00:61"), null);
  assert.equal(parseMacCpuTimeUsec("unknown"), null);
});

test("CPU interval estimate uses each counter read window instead of batch start times", () => {
  const result = aggregateSamples([
    { atMs: 0, groups: { "pid:123": { cpuUsec: 500_000, cpuTimeBounds: { startAtMs: 490, endAtMs: 510 } } } },
    { atMs: 1000, groups: { "pid:123": { cpuUsec: 1_500_000, cpuTimeBounds: { startAtMs: 1490, endAtMs: 1510 } } } },
  ], 1000);
  assert.equal(result.groups["pid:123"].peak.cpuPercentOfOneCoreEstimate, 100);
  assert.ok(result.groups["pid:123"].peak.cpuPercentOfOneCoreEstimateRange.minimum < 100);
  assert.ok(result.groups["pid:123"].peak.cpuPercentOfOneCoreEstimateRange.maximum > 100);
});

test("cgroup samples require a stable directory identity and label memory.current as charged memory", async () => {
  const info = { dev: 7, ino: 19, isDirectory: () => true };
  const contents = {
    "memory.current": "4096\n",
    "cpu.stat": "usage_usec 250000\n",
    "io.stat": "8:0 rbytes=100 wbytes=20\n",
  };
  const stable = await cgroupSample("service", "/fixture/cgroup", 10, {
    stat: async () => info,
    readFile: async (path) => contents[path.split("/").at(-1)],
  });
  assert.equal(stable.identity, "dev:7:ino:19");
  assert.equal(stable.memoryBytes, 4096);
  assert.equal(stable.memoryKind, "cgroupCharged");
  assert.equal(stable.identityRequired, true);
  assert.match(stable.limitations.join(" "), /descendant cgroups/);

  let statCalls = 0;
  const replaced = await cgroupSample("service", "/fixture/cgroup", 20, {
    stat: async () => ({ ...info, ino: ++statCalls === 1 ? 19 : 20 }),
    readFile: async (path) => contents[path.split("/").at(-1)],
  });
  assert.equal(replaced.identity, null);
  assert.equal(replaced.memoryBytes, null);
  assert.equal(replaced.cpuUsec, null);
  assert.match(replaced.limitations.join(" "), /identity changed/);
  const unreadable = await cgroupSample("service", "/fixture/cgroup", 30, {
    stat: async () => { throw new Error("unreadable fixture directory"); },
    readFile: async () => "4096\n",
  });
  assert.equal(unreadable.identity, null);
  assert.equal(unreadable.memoryKind, "cgroupCharged");
  assert.equal(unreadable.memoryBytes, null);
});

test("source revision metadata distinguishes clean, dirty and unreadable checkout state", async () => {
  const calls = [];
  const exec = async (_command, args) => {
    calls.push(args.at(-1));
    return { stdout: args.includes("rev-parse") ? `${"a".repeat(40)}\n` : " M scripts/file.mjs\n" };
  };
  const dirty = await readSourceCommit(new URL("file:///fixture/repo/scripts/host-inventory.mjs"), exec);
  assert.deepEqual(dirty, { revision: "a".repeat(40), workingTreeDirty: true });
  assert.deepEqual(calls, ["HEAD", "--untracked-files=all"]);
  const unreadable = await readSourceCommit(new URL("file:///fixture/repo/scripts/host-inventory.mjs"), async (_command, args) => {
    if (args.includes("rev-parse")) return { stdout: `${"b".repeat(40)}\n` };
    throw new Error("status unavailable");
  });
  assert.deepEqual(unreadable, { revision: "b".repeat(40), workingTreeDirty: null });
  const clean = await readSourceCommit(new URL("file:///fixture/repo/scripts/host-inventory.mjs"), async (_command, args) => ({ stdout: args.includes("rev-parse") ? `${"c".repeat(40)}\n` : "" }));
  assert.deepEqual(clean, { revision: "c".repeat(40), workingTreeDirty: false });
});

test("extracts Linux PID start identity from stat without depending on the comm field", () => {
  const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "98765"];
  assert.equal(linuxPidIdentity(`42 (process name with ) paren) ${fields.join(" ")}`), "start:98765");
  assert.equal(linuxPidIdentity("42 (short) S 1 2"), null);
});

test("Linux PID sampling validates identity before metric reads and again afterward", async () => {
  const makeStat = (startTicks, userTicks = 10, systemTicks = 5) => {
    const fields = Array.from({ length: 20 }, (_, index) => String(index));
    fields[0] = "S";
    fields[11] = String(userTicks);
    fields[12] = String(systemTicks);
    fields[19] = String(startTicks);
    return `432 (fixture process) ${fields.join(" ")}`;
  };
  const readWithStarts = (starts) => {
    const calls = [];
    let statReads = 0;
    const readProcFile = async (path) => {
      calls.push(path);
      if (path.endsWith("/stat")) return makeStat(starts[Math.min(statReads++, starts.length - 1)]);
      if (path.endsWith("/statm")) return "100 50 0 0 0 0 0\n";
      return "read_bytes: 80\nwrite_bytes: 40\n";
    };
    let time = 100;
    return { calls, readProcFile, monotonicNow: () => time += 2 };
  };
  const stableReader = readWithStarts([1234, 1234]);
  const stable = await pidSample(432, 0, "linux", { pageSize: 4096, clockTicks: 100 }, stableReader);
  assert.equal(stable.identity, "start:1234");
  assert.equal(stable.memoryBytes, 50 * 4096);
  assert.equal(stable.cpuUsec, 150_000);
  assert.deepEqual(stable.cpuTimeBounds, { startAtMs: 102, endAtMs: 104 });
  assert.deepEqual(stableReader.calls.map((path) => path.split("/").at(-1)), ["stat", "statm", "io", "stat"]);

  const replacedReader = readWithStarts([1234, 5678]);
  const replaced = await pidSample(432, 0, "linux", { pageSize: 4096, clockTicks: 100 }, replacedReader);
  assert.equal(replaced.identity, null);
  assert.equal(replaced.memoryBytes, null);
  assert.equal(replaced.cpuUsec, null);
  assert.equal(replaced.ioReadBytes, null);
});

test("requires explicit bounded selections and report paths, and rejects unsupported platform units", () => {
  assert.throws(() => validateOptions({}, "linux"), /--output-dir is required/);
  const common = { outputDir: "/tmp/report", windowSeconds: 60, intervalSeconds: 5, rootPath: "/", dataPath: "/data" };
  assert.throws(() => validateOptions({ ...common, pid: 42 }, "linux"), /select at least one/);
  assert.throws(() => validateOptions({ ...common, pids: [0] }, "linux"), /positive integer/);
  assert.throws(() => validateOptions({ ...common, units: ["bad unit.service"] }, "linux"), /explicit systemd/);
  assert.throws(() => validateOptions({ ...common, units: ["botfleet.service"] }, "darwin"), /supported only on Linux/);
  assert.throws(() => validateOptions({ ...common, pids: [42], orbCpu: 2 }, "linux"), /apply only to a Mac/);
  assert.doesNotThrow(() => validateOptions({ ...common, pids: [42] }, "darwin"));
  assert.match(platformMeasurementLimits("darwin").join(" "), /excludes child processes/);
  assert.match(platformMeasurementLimits("linux").join(" "), /Docker scopes/);
  assert.match(platformMeasurementLimits("freebsd").join(" "), /unsupported/);
});

test("deduplicates scope selections before enforcing the 32-scope implementation limit", async () => {
  const common = { outputDir: "/tmp/report", windowSeconds: 60, intervalSeconds: 5, rootPath: "/", dataPath: "/data" };
  const accepted = { ...common, pids: Array.from({ length: 40 }, () => 42), units: Array.from({ length: 10 }, () => "botfleet.service") };
  assert.doesNotThrow(() => validateOptions(accepted, "linux"));
  assert.deepEqual(accepted.pids, [42]);
  assert.deepEqual(accepted.units, ["botfleet.service"]);
  assert.equal(MAX_SCOPES, 32);
  const atLimit = { ...common, pids: Array.from({ length: MAX_SCOPES }, (_, index) => index + 1) };
  assert.doesNotThrow(() => validateOptions(atLimit, "linux"));
  const overLimit = { ...common, pids: Array.from({ length: MAX_SCOPES + 1 }, (_, index) => index + 1) };
  assert.throws(() => validateOptions(overLimit, "linux"), /at most 32 unique/);

  const root = mkdtempSync(join(tmpdir(), "host-inventory-scope-limit-"));
  let capacityReads = 0;
  let samples = 0;
  try {
    await assert.rejects(
      run(runOptions(join(root, "reports"), { pids: Array.from({ length: MAX_SCOPES + 1 }, (_, index) => index + 1) }), injectedRunDependencies({
        readCapacity: async () => { capacityReads++; throw new Error("capacity must not be read"); },
        sampleGroup: async () => { samples++; throw new Error("sample must not run"); },
      })),
      /at most 32 unique/,
    );
    assert.equal(capacityReads, 0);
    assert.equal(samples, 0);
    assert.equal(existsSync(join(root, "reports")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decodes repository paths containing spaces from module URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "host inventory fixture "));
  try {
    mkdirSync(join(root, "scripts"));
    const moduleURL = new URL("file://" + join(root, "scripts", "host-inventory.mjs"));
    assert.equal(resolve(repositoryRootFor(moduleURL)), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runOptions(outputDir, overrides = {}) {
  return {
    outputDir,
    windowSeconds: 2,
    intervalSeconds: 1,
    rootPath: "/fixture-root",
    dataPath: "/fixture-data",
    pids: [123],
    units: [],
    ...overrides,
  };
}

function injectedRunDependencies(overrides = {}) {
  let monotonicMs = 0;
  return {
    platform: "linux",
    wallNow: () => 1_800_000_000_000 + monotonicMs,
    monotonicNow: () => monotonicMs,
    sleep: async (milliseconds) => { monotonicMs += milliseconds; },
    readCapacity: async () => ({
      logicalCpuCount: 1, totalMemoryBytes: 1024, availableMemoryBytes: 512, freeMemoryBytes: 256,
      disks: { root: { freeBytes: 100, freeInodes: 10 }, data: { freeBytes: 100, freeInodes: 10 } },
      swap: null, orbStackReservation: null,
    }),
    readAvailableMemory: async () => 512,
    readPidConstants: async () => ({}),
    sampleGroup: async (id) => ({ id, memoryBytes: 10, cpuPercent: 1, ioReadBytes: 100, ioWriteBytes: 50 }),
    readSourceCommit: async () => null,
    ...overrides,
  };
}

test("preexisting report targets and missing output parents fail before any probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-preflight-"));
  try {
    for (const existingName of ["host-inventory.json", "host-inventory.md"]) {
      const outputDir = join(root, existingName.replaceAll(".", "-"));
      mkdirSync(outputDir);
      const existingPath = join(outputDir, existingName);
      writeFileSync(existingPath, `keep ${existingName}`);
      let samples = 0;
      let capacityReads = 0;
      await assert.rejects(
        run(runOptions(outputDir), injectedRunDependencies({
          readCapacity: async () => { capacityReads++; throw new Error("capacity must not be read"); },
          sampleGroup: async () => { samples++; throw new Error("sample must not run"); },
        })),
        /already exists/,
      );
      assert.equal(samples, 0);
      assert.equal(capacityReads, 0);
      assert.equal(readFileSync(existingPath, "utf8"), `keep ${existingName}`);
      assert.deepEqual(readdirSync(outputDir), [existingName]);
    }

    const missingParent = join(root, "missing-parent", "reports");
    let samples = 0;
    let capacityReads = 0;
    await assert.rejects(
      run(runOptions(missingParent), injectedRunDependencies({
        readCapacity: async () => { capacityReads++; throw new Error("capacity must not be read"); },
        sampleGroup: async () => { samples++; throw new Error("sample must not run"); },
      })),
      /without creating missing parents/,
    );
    assert.equal(samples, 0);
    assert.equal(capacityReads, 0);
    assert.equal(existsSync(missingParent), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second artifact write failure removes only this run's reserved files", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-rollback-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const keepPath = join(outputDir, "previous-evidence.txt");
  writeFileSync(keepPath, "keep previous evidence");
  try {
    await assert.rejects(
      run(runOptions(outputDir), injectedRunDependencies({
        writeArtifact: async (target, contents) => {
          if (target.kind === "markdown") throw new Error("injected second write failure");
          await target.handle.writeFile(contents);
        },
      })),
      /injected second write failure/,
    );
    assert.deepEqual(readdirSync(outputDir), ["previous-evidence.txt"]);
    assert.equal(readFileSync(keepPath, "utf8"), "keep previous evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback leaves a report target replaced by another caller untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-replaced-target-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const jsonPath = join(outputDir, "host-inventory.json");
  const movedPath = join(outputDir, "owned-file-moved-by-fixture");
  try {
    await assert.rejects(
      run(runOptions(outputDir), injectedRunDependencies({
        writeArtifact: async (target, contents) => {
          if (target.kind === "markdown") throw new Error("injected second write failure");
          await target.handle.writeFile(contents);
          // Simulate another writer replacing our pathname after reservation.
          renameSync(target.path, movedPath);
          writeFileSync(target.path, "replacement belongs to another writer");
        },
      })),
      /report target changed during collection: json/,
    );
    assert.equal(readFileSync(jsonPath, "utf8"), "replacement belongs to another writer");
    assert.equal(existsSync(movedPath), true);
    assert.equal(existsSync(join(outputDir, "host-inventory.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful output is refused if a reserved pathname is replaced during writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-success-replacement-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const jsonPath = join(outputDir, "host-inventory.json");
  const movedPath = join(outputDir, "reserved-json-moved");
  try {
    await assert.rejects(
      run(runOptions(outputDir), injectedRunDependencies({
        writeArtifact: async (target, contents) => {
          await target.handle.writeFile(contents);
          if (target.kind === "json") {
            renameSync(target.path, movedPath);
            writeFileSync(target.path, "foreign replacement");
          }
        },
      })),
      /report target changed during collection: json/,
    );
    assert.equal(readFileSync(jsonPath, "utf8"), "foreign replacement");
    assert.equal(existsSync(movedPath), true);
    assert.equal(existsSync(join(outputDir, "host-inventory.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed descriptor stat closes the handle and preserves its unverified reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-fstat-failure-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const jsonPath = join(outputDir, "host-inventory.json");
  let closed = false;
  let capacityReads = 0;
  try {
    await assert.rejects(
      run(runOptions(outputDir), injectedRunDependencies({
        openReportFile: async (...args) => {
          const handle = await open(...args);
          return {
            stat: async () => { throw new Error("injected descriptor stat failure"); },
            close: async () => { closed = true; await handle.close(); },
          };
        },
        readCapacity: async () => { capacityReads++; throw new Error("capacity read must not occur"); },
      })),
      /injected descriptor stat failure/,
    );
    assert.equal(closed, true);
    assert.equal(capacityReads, 0);
    assert.equal(existsSync(jsonPath), true);
    assert.equal(readFileSync(jsonPath, "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wall-clock backsteps do not invalidate monotonic sampling duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-clock-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  let monotonicMs = 0;
  const wallSamples = [1_800_000_000_000, 1_799_999_999_000, 1_799_999_999_000];
  let sampleCount = 0;
  const available = [500, 300, 700];
  try {
    const report = await run(runOptions(outputDir), injectedRunDependencies({
      wallNow: () => wallSamples.shift() ?? 1_799_999_999_000,
      monotonicNow: () => monotonicMs,
      sleep: async (milliseconds) => { monotonicMs += milliseconds; },
      readAvailableMemory: async () => available.shift() ?? null,
      sampleGroup: async (id) => {
        sampleCount++;
        return { id, memoryBytes: 10 + sampleCount, memoryKind: "resident", cpuPercentOSAverage: 2, cpuUsec: sampleCount * 100_000, ioReadBytes: sampleCount * 100, ioWriteBytes: sampleCount * 10 };
      },
    }));
    assert.equal(sampleCount, 3);
    assert.equal(report.window.startEpochMs, 1_800_000_000_000);
    assert.equal(report.window.endEpochMs, 1_799_999_999_000);
    assert.equal(report.window.durationMs, 2_000);
    assert.equal(report.window.durationClock, "monotonic");
    assert.equal(report.groups["pid:123"].coverage.complete, true);
    assert.equal(report.capacity.sampledMinimumAvailableMemoryBytes, 300);
    assert.deepEqual(report.capacity.availableMemoryCoverage, { observedSamples: 3, expectedSamples: 3, complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run writes an interrupted partial report without installing process signal handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-inventory-interrupted-"));
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const controller = new AbortController();
  const listenersBefore = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  try {
    const report = await run(runOptions(outputDir), injectedRunDependencies({
      signal: controller.signal,
      sleep: async () => { controller.abort("SIGTERM"); return false; },
      readAvailableMemory: async () => 400,
    }));
    assert.equal(report.interrupted, true);
    assert.equal(report.interruptedBy, "SIGTERM");
    assert.equal(report.window.durationMs, 0);
    assert.match(readFileSync(join(outputDir, "host-inventory.md"), "utf8"), /interrupted by SIGTERM; partial window/);
    assert.deepEqual({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }, listenersBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI signal wrapper aborts its collector and restores both process listeners", async () => {
  const listenersBefore = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const outcome = await runWithCliSignalHandlers({}, async (_options, { signal }) => {
    process.emit("SIGTERM");
    return { aborted: signal.aborted, reason: signal.reason };
  });
  assert.deepEqual(outcome, { aborted: true, reason: "SIGTERM" });
  assert.deepEqual({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }, listenersBefore);
});
