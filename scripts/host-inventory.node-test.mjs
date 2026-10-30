import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSamples, availableMemoryBytes, linuxPidIdentity, MAX_SCOPES, parseLinuxMemAvailableBytes, platformMeasurementLimits, repositoryRootFor, run, validateOptions } from "./host-inventory.mjs";

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
  assert.equal(result.groups["botfleet.service"].peak.cpuPercentOfOneCore, 40);
  assert.deepEqual(result.groups["botfleet.service"].observedDelta, { ioReadBytes: 70, ioWriteBytes: 20 });
  assert.deepEqual(result.groups["botfleet.service"].coverage, { observedSamples: 3, expectedSamples: 3, complete: true });
});

test("marks peaks and counter deltas unknown when a selected scope is absent mid-window", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "unit.service": { memoryBytes: 5, cpuPercent: 2, ioReadBytes: 100, ioWriteBytes: 50 } } },
    { atMs: 20, groups: {} },
    { atMs: 30, groups: { "unit.service": { memoryBytes: 90, cpuPercent: 80, ioReadBytes: 1000, ioWriteBytes: 500 } } },
  ], 10);
  const scope = result.groups["unit.service"];
  assert.equal(scope.initial.memoryBytes, 5);
  assert.deepEqual(scope.peak, { memoryBytes: null, cpuPercentOfOneCore: null });
  assert.deepEqual(scope.observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.deepEqual(scope.coverage, { observedSamples: 2, expectedSamples: 3, complete: false });
  assert.match(scope.limitations.join(" "), /absent from one or more samples/);
});

test("aggregates a large synthetic sample window without argument spreading", () => {
  const samples = Array.from({ length: 150_001 }, (_, index) => ({
    atMs: index,
    groups: { "unit.service": { memoryBytes: index % 17, cpuPercent: index % 13, ioReadBytes: index, ioWriteBytes: index * 2 } },
  }));
  const result = aggregateSamples(samples, 1);
  assert.equal(result.window.observedIntervalMinMs, 1);
  assert.equal(result.window.observedIntervalMaxMs, 1);
  assert.equal(result.window.durationMs, 150_000);
  assert.equal(result.groups["unit.service"].peak.memoryBytes, 16);
  assert.equal(result.groups["unit.service"].peak.cpuPercentOfOneCore, 12);
  assert.deepEqual(result.groups["unit.service"].observedDelta, { ioReadBytes: 150_000, ioWriteBytes: 300_000 });
});

test("reports unknown for unavailable or reset counters and preserves limitation evidence", () => {
  const result = aggregateSamples([
    { atMs: 1, groups: { "pid:17": { memoryBytes: null, cpuUsec: 900, ioReadBytes: 100, limitations: ["counter unavailable"] } } },
    { atMs: 2, groups: { "pid:17": { memoryBytes: null, cpuUsec: 200, ioReadBytes: 5, limitations: ["counter unavailable"] } } },
  ], 1000);
  assert.deepEqual(result.groups["pid:17"].initial, { memoryBytes: null, cpuPercent: null, cpuUsec: 900, ioReadBytes: 100, ioWriteBytes: null });
  assert.deepEqual(result.groups["pid:17"].peak, { memoryBytes: null, cpuPercentOfOneCore: null });
  assert.deepEqual(result.groups["pid:17"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.deepEqual(result.groups["pid:17"].limitations, ["counter unavailable"]);
});

test("marks a counter delta unknown after any mid-window reset", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "unit.service": { memoryBytes: 5, cpuUsec: 100, ioReadBytes: 100, ioWriteBytes: 50 } } },
    { atMs: 20, groups: { "unit.service": { memoryBytes: 6, cpuUsec: 200, ioReadBytes: 10, ioWriteBytes: 10 } } },
    { atMs: 30, groups: { "unit.service": { memoryBytes: 7, cpuUsec: 300, ioReadBytes: 150, ioWriteBytes: 70 } } },
  ], 10);
  assert.deepEqual(result.groups["unit.service"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
});

test("does not combine samples or deltas across a reused PID", () => {
  const result = aggregateSamples([
    { atMs: 10, groups: { "pid:17": { identityRequired: true, identity: "start:old", memoryBytes: 20, cpuPercent: 4, ioReadBytes: 100 } } },
    { atMs: 20, groups: { "pid:17": { identityRequired: true, identity: "start:new", memoryBytes: 90, cpuPercent: 80, ioReadBytes: 1000 } } },
  ], 10);
  assert.equal(result.groups["pid:17"].peak.memoryBytes, 20);
  assert.equal(result.groups["pid:17"].peak.cpuPercentOfOneCore, 4);
  assert.deepEqual(result.groups["pid:17"].observedDelta, { ioReadBytes: null, ioWriteBytes: null });
  assert.match(result.groups["pid:17"].limitations.join(" "), /identity changed/);
  assert.equal(result.groups["pid:17"].initial.cpuPercent, 4);
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

test("extracts Linux PID start identity from stat without depending on the comm field", () => {
  const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "98765"];
  assert.equal(linuxPidIdentity(`42 (process name with ) paren) ${fields.join(" ")}`), "start:98765");
  assert.equal(linuxPidIdentity("42 (short) S 1 2"), null);
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
  assert.match(platformMeasurementLimits("linux").join(" "), /external container daemons/);
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
      /injected second write failure/,
    );
    assert.equal(readFileSync(jsonPath, "utf8"), "replacement belongs to another writer");
    assert.equal(existsSync(movedPath), true);
    assert.equal(existsSync(join(outputDir, "host-inventory.md")), false);
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
  try {
    const report = await run(runOptions(outputDir), injectedRunDependencies({
      wallNow: () => wallSamples.shift() ?? 1_799_999_999_000,
      monotonicNow: () => monotonicMs,
      sleep: async (milliseconds) => { monotonicMs += milliseconds; },
      sampleGroup: async (id) => {
        sampleCount++;
        return { id, memoryBytes: 10 + sampleCount, cpuPercent: 2, ioReadBytes: sampleCount * 100, ioWriteBytes: sampleCount * 10 };
      },
    }));
    assert.equal(sampleCount, 2);
    assert.equal(report.window.startEpochMs, 1_800_000_000_000);
    assert.equal(report.window.endEpochMs, 1_799_999_999_000);
    assert.equal(report.window.durationMs, 1_000);
    assert.equal(report.window.durationClock, "monotonic");
    assert.equal(report.groups["pid:123"].coverage.complete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
