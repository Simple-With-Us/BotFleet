import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSamples, availableMemoryBytes, linuxPidIdentity, parseLinuxMemAvailableBytes, platformMeasurementLimits, validateOptions } from "./host-inventory.mjs";

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
  assert.deepEqual(result.window, { startEpochMs: 1000, endEpochMs: 3000, durationMs: 2000, requestedIntervalMs: 1000, observedIntervalMinMs: 1000, observedIntervalMaxMs: 1000 });
  assert.equal(result.groups["botfleet.service"].initial.memoryBytes, 10);
  assert.equal(result.groups["botfleet.service"].peak.memoryBytes, 15);
  assert.equal(result.groups["botfleet.service"].peak.cpuPercentOfOneCore, 40);
  assert.deepEqual(result.groups["botfleet.service"].observedDelta, { ioReadBytes: 70, ioWriteBytes: 20 });
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
