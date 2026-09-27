// The ACP initialize deadline: an engine base, stretched by host load, capped,
// and overridable per instance.  Pure functions — the load is injected, so
// nothing here depends on how busy the test machine happens to be.
import { describe, expect, it } from "vitest";

import {
  decodeInitTimeoutMs,
  DEFAULT_INIT_TIMEOUT_MS,
  describeInitDeadline,
  describeSlowInit,
  initLoadFactor,
  MAX_INIT_LOAD_FACTOR,
  MAX_INIT_TIMEOUT_MS,
  MIN_INIT_TIMEOUT_MS,
  readHostLoad,
  resolveInitDeadline,
} from "./init-deadline.ts";

describe("initLoadFactor", () => {
  it("keeps the base on an idle or normally busy host", () => {
    expect(initLoadFactor(null)).toBe(1);
    expect(initLoadFactor({ load1: 0, cores: 10 })).toBe(1);
    expect(initLoadFactor({ load1: 10, cores: 10 })).toBe(1);
  });

  it("stretches with the run queue per core, up to the cap", () => {
    expect(initLoadFactor({ load1: 20, cores: 10 })).toBe(2);
    expect(initLoadFactor({ load1: 25, cores: 10 })).toBe(2.5);
    // The load this Mac was measured at while DSH boots took 24-52 s.
    expect(initLoadFactor({ load1: 470, cores: 10 })).toBe(MAX_INIT_LOAD_FACTOR);
  });

  it("ignores a reading it cannot use", () => {
    expect(initLoadFactor({ load1: Number.NaN, cores: 10 })).toBe(1);
    expect(initLoadFactor({ load1: 5, cores: 0 })).toBe(1);
  });
});

describe("resolveInitDeadline", () => {
  it("defaults to 60 s on a quiet host", () => {
    const deadline = resolveInitDeadline({ load: { load1: 2, cores: 10 } });
    expect(deadline).toEqual({ timeoutMs: DEFAULT_INIT_TIMEOUT_MS, loadPerCore: 0.2, pinned: false });
  });

  it("uses the engine's own base and scales it by load", () => {
    expect(resolveInitDeadline({ engineBaseMs: 120_000, load: { load1: 5, cores: 10 } }).timeoutMs).toBe(120_000);
    expect(resolveInitDeadline({ engineBaseMs: 60_000, load: { load1: 20, cores: 10 } }).timeoutMs).toBe(120_000);
  });

  it("never scales past the ceiling", () => {
    const deadline = resolveInitDeadline({ engineBaseMs: 120_000, load: { load1: 470, cores: 10 } });
    expect(deadline.timeoutMs).toBe(MAX_INIT_TIMEOUT_MS);
  });

  it("takes an instance override exactly, whatever the load", () => {
    const deadline = resolveInitDeadline({
      configured: 1_500,
      engineBaseMs: 120_000,
      load: { load1: 470, cores: 10 },
    });
    expect(deadline).toEqual({ timeoutMs: 1_500, loadPerCore: 47, pinned: true });
  });

  it("falls back to the default for a nonsense engine base", () => {
    expect(resolveInitDeadline({ engineBaseMs: 0, load: null }).timeoutMs).toBe(DEFAULT_INIT_TIMEOUT_MS);
    expect(resolveInitDeadline({ engineBaseMs: Number.NaN, load: null }).timeoutMs).toBe(DEFAULT_INIT_TIMEOUT_MS);
  });
});

describe("decodeInitTimeoutMs", () => {
  it("accepts only a bounded whole number of milliseconds", () => {
    expect(decodeInitTimeoutMs(MIN_INIT_TIMEOUT_MS)).toBe(MIN_INIT_TIMEOUT_MS);
    expect(decodeInitTimeoutMs(MAX_INIT_TIMEOUT_MS)).toBe(MAX_INIT_TIMEOUT_MS);
    expect(decodeInitTimeoutMs(MIN_INIT_TIMEOUT_MS - 1)).toBeUndefined();
    expect(decodeInitTimeoutMs(MAX_INIT_TIMEOUT_MS + 1)).toBeUndefined();
    expect(decodeInitTimeoutMs(1_500.5)).toBeUndefined();
    expect(decodeInitTimeoutMs("90000")).toBeUndefined();
    expect(decodeInitTimeoutMs(undefined)).toBeUndefined();
  });
});

describe("describeInitDeadline", () => {
  it("names the budget and the load, and nothing from the turn", () => {
    expect(describeInitDeadline({ timeoutMs: 180_000, loadPerCore: 4.24, pinned: false })).toBe(
      "after 180 s (host load 4.2 per core)",
    );
    expect(describeInitDeadline({ timeoutMs: 1_500, loadPerCore: null, pinned: true })).toBe(
      "after 2 s (instance setting)",
    );
    expect(describeInitDeadline({ timeoutMs: 60_000, loadPerCore: null, pinned: false })).toBe("after 60 s");
  });
});

describe("describeSlowInit", () => {
  it("reports elapsed time against the budget", () => {
    expect(describeSlowInit(72_400, { timeoutMs: 240_000, loadPerCore: 2.04, pinned: false })).toBe(
      "initialize answered after 72 s (deadline 240 s, host load 2.0 per core)",
    );
    expect(describeSlowInit(31_000, { timeoutMs: 60_000, loadPerCore: null, pinned: false })).toBe(
      "initialize answered after 31 s (deadline 60 s)",
    );
  });
});

describe("readHostLoad", () => {
  it("returns a usable reading or null, never throws", () => {
    const load = readHostLoad();
    if (load) {
      expect(load.cores).toBeGreaterThan(0);
      expect(load.load1).toBeGreaterThanOrEqual(0);
    } else {
      expect(load).toBeNull();
    }
  });
});
