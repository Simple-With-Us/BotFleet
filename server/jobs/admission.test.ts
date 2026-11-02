// The optional headroom gates: absent thresholds never refuse, set
// thresholds refuse only on a known breached reading, and an unknown
// reading admits (the same policy as every other admission gate).
import { describe, expect, it } from "vitest";

import { admissionRefusal, type AdmissionThresholds, type HostProbe } from "./admission.ts";
import { resolveJobsSettings } from "./registry.ts";

const base: AdmissionThresholds = { maxSwapPercent: 98, minFreeDiskBytes: 1 };

function probe(readings: { percent?: number | null; mb?: number | null; cores?: number | null } = {}): HostProbe {
  return {
    swapUsedPercent: () => null,
    freeDiskBytes: () => null,
    memoryAvailablePercent: () => readings.percent ?? null,
    memoryAvailableMb: () => readings.mb ?? null,
    usableCpuCores: () => readings.cores ?? null,
  };
}

describe("optional headroom admission knobs", () => {
  it("admits with every knob unset, even at zero readings", () => {
    expect(admissionRefusal(probe({ percent: 0, mb: 0, cores: 0 }), base, "/", false)).toBeNull();
    const admission = resolveJobsSettings(undefined).admission;
    expect(admission.reservedCpuCores).toBeUndefined();
    expect(admission.reservedRamMb).toBeUndefined();
    expect(admission.minMemoryAvailablePercent).toBeUndefined();
  });

  it("refuses on a known breach of each set knob, naming the reason", () => {
    expect(admissionRefusal(probe({ percent: 5 }), { ...base, minMemoryAvailablePercent: 10 }, "/", false)).toContain("available memory");
    expect(admissionRefusal(probe({ mb: 100 }), { ...base, reservedRamMb: 512 }, "/", false)).toContain("reserved RAM headroom");
    expect(admissionRefusal(probe({ cores: 4 }), { ...base, reservedCpuCores: 3.5 }, "/", false)).toContain("reserved CPU headroom");
  });

  it("admits at or above each set knob, including exactly one core left", () => {
    expect(admissionRefusal(probe({ percent: 10 }), { ...base, minMemoryAvailablePercent: 10 }, "/", false)).toBeNull();
    expect(admissionRefusal(probe({ mb: 512 }), { ...base, reservedRamMb: 512 }, "/", false)).toBeNull();
    expect(admissionRefusal(probe({ cores: 4 }), { ...base, reservedCpuCores: 3 }, "/", false)).toBeNull();
  });

  it("admits when a set knob's reading is unknown or the probe lacks it", () => {
    const set: AdmissionThresholds = { ...base, minMemoryAvailablePercent: 90, reservedRamMb: 999999, reservedCpuCores: 64 };
    expect(admissionRefusal(probe(), set, "/", false)).toBeNull();
    const bare: HostProbe = { swapUsedPercent: () => null, freeDiskBytes: () => null };
    expect(admissionRefusal(bare, set, "/", false)).toBeNull();
  });

  it("resolves configured values clamped, with no defaults invented", () => {
    const admission = resolveJobsSettings({ admission: { reservedCpuCores: 99, reservedRamMb: 512.9, minMemoryAvailablePercent: -1 } }).admission;
    expect(admission.reservedCpuCores).toBe(64);
    expect(admission.reservedRamMb).toBe(512);
    expect(admission.minMemoryAvailablePercent).toBe(0);
  });
});
