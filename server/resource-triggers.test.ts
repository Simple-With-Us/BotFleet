import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_INIT_LOAD_FACTOR } from "./drivers/acp/init-deadline.ts";
import { DEFAULT_ADMISSION } from "./jobs/admission.ts";
import {
  crossed,
  ResourceTriggerManager,
  sampleHost,
  valueFor,
  webhookDispatchHoldReason,
  webhookDispatchHot,
  type HostSample,
} from "./resource-triggers.ts";

function sample(partial: Partial<HostSample> = {}): HostSample {
  return {
    at: 1_000,
    diskFreeGb: 120,
    diskUsedPct: 70,
    ramUsedPct: 40,
    swapUsedPct: 10,
    swapUsedGb: 0.2,
    swapTotalGb: 2,
    load1m: 2,
    ...partial,
  };
}

describe("webhookDispatchHot", () => {
  const cores = 10;
  const load = (load1: number) => ({ load1, cores });

  it("admits when swap and load are unknown or under both ceilings", () => {
    expect(webhookDispatchHot({ swapUsedPercent: null, load: null })).toBe(false);
    expect(webhookDispatchHot({ swapUsedPercent: Number.NaN, load: null })).toBe(false);
    expect(
      webhookDispatchHot({
        swapUsedPercent: DEFAULT_ADMISSION.maxSwapPercent - 0.1,
        load: load(cores * MAX_INIT_LOAD_FACTOR - 0.1),
      }),
    ).toBe(false);
  });

  it("is hot at the jobs admission swap ceiling or the ACP init load ceiling", () => {
    expect(
      webhookDispatchHot({ swapUsedPercent: DEFAULT_ADMISSION.maxSwapPercent, load: null }),
    ).toBe(true);
    expect(
      webhookDispatchHot({ swapUsedPercent: null, load: load(cores * MAX_INIT_LOAD_FACTOR) }),
    ).toBe(true);
    // Ordinary Mac swap percent is not hot.  The admission ceiling is.
    expect(webhookDispatchHot({ swapUsedPercent: 94, load: load(cores) })).toBe(false);
  });

  it("names load per core and swap percent on the hold reason", () => {
    expect(
      webhookDispatchHoldReason({
        swapUsedPercent: 98.4,
        load: load(35),
      }),
    ).toBe("Host is busy (load 3.5 per core, swap 98%)");
    expect(
      webhookDispatchHoldReason({
        swapUsedPercent: null,
        load: load(40),
      }),
    ).toBe("Host is busy (load 4 per core, swap unknown)");
    expect(
      webhookDispatchHoldReason({
        swapUsedPercent: 99,
        load: null,
      }),
    ).toBe("Host is busy (load unknown per core, swap 99%)");
  });

  it("returns no reason when the host is cool enough to dispatch", () => {
    expect(webhookDispatchHoldReason({ swapUsedPercent: null, load: null })).toBeNull();
    expect(webhookDispatchHoldReason({ swapUsedPercent: 94, load: load(cores) })).toBeNull();
  });
});

describe("resource trigger math", () => {
  it("treats below as <= and above as >=", () => {
    expect(crossed("below", 80, 80)).toBe(true);
    expect(crossed("below", 80, 79.9)).toBe(true);
    expect(crossed("below", 80, 80.1)).toBe(false);
    expect(crossed("above", 16, 16)).toBe(true);
    expect(crossed("above", 16, 15.9)).toBe(false);
  });

  it("reads each metric from the sample", () => {
    const s = sample({ diskFreeGb: 41.2, swapUsedPct: 91, load1m: 22 });
    expect(valueFor("disk_free_gb", s)).toBe(41.2);
    expect(valueFor("swap_used_pct", s)).toBe(91);
    expect(valueFor("load_1m", s)).toBe(22);
  });

  it("exposes absolute swap so a dynamic swap store still reads as pressure", () => {
    // macOS resizes the swap store, so used/total hovers near 90% at both 2GB and 20GB.
    const light = sample({ swapUsedPct: 90, swapUsedGb: 1.8, swapTotalGb: 2 });
    const heavy = sample({ swapUsedPct: 90, swapUsedGb: 18, swapTotalGb: 20 });
    expect(valueFor("swap_used_pct", light)).toBe(valueFor("swap_used_pct", heavy));
    expect(crossed("above", 8, valueFor("swap_used_gb", light)!)).toBe(false);
    expect(crossed("above", 8, valueFor("swap_used_gb", heavy)!)).toBe(true);
  });
});

describe("sampleHost", () => {
  it("reports disk free and used% for the same volume", () => {
    const s = sampleHost();
    expect(s.diskFreeGb).toBeGreaterThan(0);
    expect(s.diskUsedPct).toBeGreaterThanOrEqual(0);
    expect(s.diskUsedPct).toBeLessThanOrEqual(100);
    expect(s.ramUsedPct).toBeGreaterThan(0);
    expect(s.ramUsedPct).toBeLessThanOrEqual(100);
  });
});

describe("ResourceTriggerManager", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function make(now: { t: number }, host: { current: HostSample }, admission = { open: true }) {
    const dir = mkdtempSync(join(tmpdir(), "bf-resource-"));
    dirs.push(dir);
    const queued: string[] = [];
    const manager = new ResourceTriggerManager({
      file: join(dir, "resource-triggers.json"),
      now: () => now.t,
      sample: () => host.current,
      botState: () => "ready",
      admit: () => admission.open,
      enqueue: (input) => {
        queued.push(input.triggerId);
        return { id: `run-${queued.length}` };
      },
      pendingRuns: () => 0,
    });
    return { manager, queued, admission };
  }

  it("preserves a trigger breach while scheduler admission is fenced", () => {
    const now = { t: 1_000 };
    const host = { current: sample({ diskFreeGb: 40 }) };
    const { manager, queued, admission } = make(now, host, { open: false });
    const trigger = manager.create({
      name: "Disk low",
      prompt: "Clean the disk",
      botId: "housekeeper",
      metric: "disk_free_gb",
      cmp: "below",
      threshold: 80,
      cooldownMinutes: 45,
      sustainSamples: 1,
    });
    expect(manager.tick()).toHaveLength(0);
    expect(queued).toHaveLength(0);

    admission.open = true;
    expect(manager.tick()).toHaveLength(1);
    expect(queued).toEqual([trigger.id]);
  });

  it("fires once then respects cooldown", () => {
    const now = { t: 1_000 };
    const host = { current: sample({ diskFreeGb: 40 }) };
    const { manager, queued } = make(now, host);
    const trigger = manager.create({
      name: "Disk low",
      prompt: "Clean the disk",
      botId: "housekeeper",
      metric: "disk_free_gb",
      cmp: "below",
      threshold: 80,
      cooldownMinutes: 45,
      sustainSamples: 1,
    });
    expect(manager.tick()).toHaveLength(1);
    expect(queued).toEqual([trigger.id]);
    expect(manager.tick()).toHaveLength(0);
    now.t += 44 * 60_000;
    expect(manager.tick()).toHaveLength(0);
    now.t += 2 * 60_000;
    expect(manager.tick()).toHaveLength(1);
    expect(queued).toEqual([trigger.id, trigger.id]);
  });

  it("requires a sustained breach before firing", () => {
    // A `du` sweep or a build can take 1m load from 12 to 120 and back inside a single
    // 30s sample.  Waking a bot for that spike is noise, so N consecutive samples must
    // breach before the trigger fires.
    const now = { t: 1_000 };
    const host = { current: sample({ load1m: 40 }) };
    const { manager, queued } = make(now, host);
    manager.create({
      name: "Load",
      prompt: "Check load",
      botId: "housekeeper",
      metric: "load_1m",
      cmp: "above",
      threshold: 16,
      sustainSamples: 3,
    });
    expect(manager.tick()).toHaveLength(0);
    expect(manager.tick()).toHaveLength(0);
    expect(manager.tick()).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

  it("resets the streak when pressure clears", () => {
    const now = { t: 1_000 };
    const host = { current: sample({ load1m: 40 }) };
    const { manager, queued } = make(now, host);
    manager.create({
      name: "Load",
      prompt: "Check load",
      botId: "housekeeper",
      metric: "load_1m",
      cmp: "above",
      threshold: 16,
      sustainSamples: 3,
    });
    expect(manager.tick()).toHaveLength(0);
    expect(manager.tick()).toHaveLength(0);
    host.current = sample({ load1m: 2 }); // recovered -- streak must restart
    expect(manager.tick()).toHaveLength(0);
    host.current = sample({ load1m: 40 });
    expect(manager.tick()).toHaveLength(0);
    expect(manager.tick()).toHaveLength(0);
    expect(manager.tick()).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

  it("does not fire a paused trigger", () => {
    const now = { t: 1_000 };
    const host = { current: sample({ load1m: 40 }) };
    const { manager, queued } = make(now, host);
    manager.create({
      name: "Load",
      prompt: "Check load",
      botId: "housekeeper",
      metric: "load_1m",
      cmp: "above",
      threshold: 16,
      enabled: false,
    });
    expect(manager.tick()).toHaveLength(0);
    expect(queued).toEqual([]);
  });
});
