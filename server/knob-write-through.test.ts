import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { KNOB_FIELDS } from "./knob-map.ts";
import {
  patchChangesInfisicalConnection,
  writeThroughKnobs,
  type KnobWriteThroughDeps,
} from "./knob-write-through.ts";

const baseDeps = (overrides: Partial<KnobWriteThroughDeps> = {}): KnobWriteThroughDeps => ({
  enabled: true,
  writeThrough: true,
  environment: "prod",
  unreachable: false,
  knownNames: new Set<string>(),
  sourceOf: () => "file",
  writeSecret: async () => {},
  ...overrides,
});

describe("patchChangesInfisicalConnection", () => {
  it("flags connection keys and ignores the refresh cadence", () => {
    expect(patchChangesInfisicalConnection({ infisical: { projectId: "abc" } })).toBe(true);
    expect(patchChangesInfisicalConnection({ infisical: { clientSecret: "x" } })).toBe(true);
    expect(patchChangesInfisicalConnection({ infisical: { refreshMinutes: 5 } })).toBe(false);
    expect(patchChangesInfisicalConnection({ infisical: { enabled: false } })).toBe(false);
    expect(patchChangesInfisicalConnection({})).toBe(false);
  });
});

describe("writeThroughKnobs", () => {
  it("writes to the vault FIRST and only then drops the patch copy", async () => {
    const order: string[] = [];
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const result = await writeThroughKnobs(patch, baseDeps({
      writeSecret: async (name, value) => {
        order.push(`vault:${name}=${value}`);
      },
    }));
    // The tombstone runs after the vault write: observe it by re-reading the
    // patch only once the helper has resolved.
    expect(result).toEqual({ ok: true, written: ["jobs.defaultMinutes"] });
    expect(order).toEqual(["vault:BOTFLEET_JOBS_DEFAULT_MINUTES=30"]);
    expect(patch.jobs).toBeUndefined();
  });

  it("prunes sections emptied by the tombstone, recursively", async () => {
    const patch: Partial<AppConfig> = {
      jobs: { admission: { maxSwapPercent: 90 }, enabled: true },
    };
    const result = await writeThroughKnobs(patch, baseDeps());
    expect(result.ok).toBe(true);
    expect(patch.jobs).toEqual({ enabled: true });
  });

  it("does nothing when the patch carries no knobs", async () => {
    const writeSecret = vi.fn();
    const patch: Partial<AppConfig> = { profile: { name: "Jay" } };
    const result = await writeThroughKnobs(patch, baseDeps({ writeSecret }));
    expect(result).toEqual({ ok: true, written: [] });
    expect(writeSecret).not.toHaveBeenCalled();
    expect(patch.profile?.name).toBe("Jay");
  });

  it("does nothing when the store is not enabled", async () => {
    const writeSecret = vi.fn();
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const result = await writeThroughKnobs(patch, baseDeps({ enabled: false, writeSecret }));
    expect(result).toEqual({ ok: true, written: [] });
    expect(writeSecret).not.toHaveBeenCalled();
    expect(patch.jobs?.defaultMinutes).toBe(30);
  });

  it("refuses the whole save with 409 when write-through is off and the vault manages the knob", async () => {
    const writeSecret = vi.fn();
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const result = await writeThroughKnobs(
      patch,
      baseDeps({
        writeThrough: false,
        knownNames: new Set(["BOTFLEET_JOBS_DEFAULT_MINUTES"]),
        writeSecret,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(result.field).toBe("jobs.defaultMinutes");
    expect(result.infisicalName).toBe("BOTFLEET_JOBS_DEFAULT_MINUTES");
    expect(result.error).toContain("managed by Infisical");
    expect(writeSecret).not.toHaveBeenCalled();
    // Nothing was written anywhere: the patch is untouched for the caller to
    // answer with.
    expect(patch.jobs?.defaultMinutes).toBe(30);
  });

  it("refuses with 503 when the store is unreachable and cannot say what it manages", async () => {
    const writeSecret = vi.fn();
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const result = await writeThroughKnobs(patch, baseDeps({ unreachable: true, writeSecret }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(503);
    expect(writeSecret).not.toHaveBeenCalled();
    expect(patch.jobs?.defaultMinutes).toBe(30);
  });

  it("treats a fresh name as managed when write-through is on", async () => {
    const calls: Array<[string, string]> = [];
    const patch: Partial<AppConfig> = { jobs: { defaultMinutes: 30 } };
    const result = await writeThroughKnobs(
      patch,
      baseDeps({
        knownNames: new Set<string>(),
        sourceOf: () => "none",
        writeSecret: async (name, value) => {
          calls.push([name, value]);
        },
      }),
    );
    expect(result).toEqual({ ok: true, written: ["jobs.defaultMinutes"] });
    expect(calls).toEqual([["BOTFLEET_JOBS_DEFAULT_MINUTES", "30"]]);
  });

  it("reports a failed write as 502 with what already landed, and tombstones nothing", async () => {
    const patch: Partial<AppConfig> = {
      jobs: { defaultMinutes: 30, maxMinutes: 120 },
    };
    const result = await writeThroughKnobs(
      patch,
      baseDeps({
        writeSecret: async (name) => {
          if (name === "BOTFLEET_JOBS_MAX_MINUTES") throw new Error("store exploded");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(502);
    expect(result.written).toEqual(["jobs.defaultMinutes"]);
    expect(result.failed).toEqual(["jobs.maxMinutes"]);
    expect(result.error).toContain("Already written to Infisical");
    // The local config is untouched on failure — no tombstones.
    expect(patch.jobs?.defaultMinutes).toBe(30);
    expect(patch.jobs?.maxMinutes).toBe(120);
  });

  it("serialises every knob kind the way the resolver reads it back", async () => {
    const calls = new Map<string, string>();
    const patch: Partial<AppConfig> = {
      jobs: { defaultMinutes: 30, cpuCores: 4 },
      observability: { tracesSampleRate: 0.5 },
      usage: { spendCeilingUsd: 25.5 },
      infisical: { refreshMinutes: 10 },
    };
    const result = await writeThroughKnobs(
      patch,
      baseDeps({
        writeSecret: async (name, value) => {
          calls.set(name, value);
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls.get("BOTFLEET_JOBS_DEFAULT_MINUTES")).toBe("30");
    expect(calls.get("BOTFLEET_JOBS_CPU_CORES")).toBe("4");
    expect(calls.get("BOTFLEET_TRACES_SAMPLE_RATE")).toBe("0.5");
    expect(calls.get("BOTFLEET_SPEND_CEILING_USD")).toBe("25.5");
    expect(calls.get("BOTFLEET_INFISICAL_REFRESH_MINUTES")).toBe("10");
    expect(KNOB_FIELDS.length).toBe(12);
  });
});
