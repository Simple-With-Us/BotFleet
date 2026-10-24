// A routine's command allowlist through RoutineManager:  validated on save,
// kept on disk, snapshotted on each run, and handed to the turn it dispatches.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import type { ToolPolicy } from "./tool-policy.ts";

const dirs: string[] = [];

const POLICY = {
  mode: "allowlist",
  commands: [{ argv0: "/Users/jay/.local/bin/agent-sync", sub: ["whoami"], flags: { "--json": { value: "none" } } }],
  writePaths: ["/Users/jay/apps/state/plumber/line.md"],
};

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-policy-"));
  dirs.push(dir);
  let task = 0;
  const threads = new Set<string>();
  const keys = new Map<string, string>();
  const turns: Array<{ prompt: string; toolPolicy?: ToolPolicy }> = [];
  const gate = { admitting: true };
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"),
    now: () => new Date(2026, 9, 11, 8, 0, 0).getTime(),
    botState: () => "ready",
    admit: () => gate.admitting,
    canStart: () => true,
    turnLive: () => true,
    createTask: (_botId, _title, _activate, automationKey) => {
      const threadId = `thread-${++task}`;
      threads.add(threadId);
      if (automationKey) keys.set(automationKey, threadId);
      return { threadId };
    },
    taskForKey: (_botId, automationKey) => keys.get(automationKey),
    stampKey: (_botId, threadId, automationKey) => {
      keys.set(automationKey, threadId);
    },
    taskExists: (_botId, threadId) => threads.has(threadId),
    startTurn: async (_botId, _threadId, prompt, _runOn, _trigger, _onError, turnOpts) => {
      turns.push({ prompt, toolPolicy: turnOpts?.toolPolicy });
    },
  };
  return { manager: new RoutineManager(options), options, turns, gate };
}

const daily = { type: "daily" as const, time: "09:00", weekdays: [1] };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("routine toolPolicy", () => {
  it("round-trips through sanitizeInput and the routines file", () => {
    const h = harness();
    const created = h.manager.create({ name: "Backup Health", prompt: "Check", botId: "bot", schedule: daily, toolPolicy: POLICY });
    expect(created.toolPolicy).toEqual({ ...POLICY, readPaths: [], commands: [{ ...POLICY.commands[0], args: [], positionals: 0 }] });
    h.manager.flushNow();
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()[0]!.toolPolicy).toEqual(created.toolPolicy);
  });

  it("refuses an invalid allowlist and one on a cloud run", () => {
    const h = harness();
    expect(() =>
      h.manager.create({ name: "Bad", prompt: "Check", botId: "bot", schedule: daily, toolPolicy: { mode: "allowlist", commands: [{ argv0: "agent-sync" }] } }),
    ).toThrow(/Command allowlist/);
    expect(() =>
      h.manager.create({ name: "Cloud", prompt: "Check", botId: "bot", runOn: "cloud", schedule: daily, toolPolicy: POLICY }),
    ).toThrow(/must run on the bot/);
    expect(h.manager.listRoutines()).toHaveLength(0);
  });

  it("hands the allowlist to the turn it dispatches, and an ordinary routine none", async () => {
    const h = harness();
    const held = h.manager.create({ name: "Held", prompt: "Held prompt", botId: "bot", schedule: daily, toolPolicy: POLICY });
    h.manager.runNow(held.id);
    await h.manager.tick();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.toolPolicy).toEqual(held.toolPolicy);

    const h2 = harness();
    const plain = h2.manager.create({ name: "Plain", prompt: "Plain prompt", botId: "bot", schedule: daily });
    h2.manager.runNow(plain.id);
    await h2.manager.tick();
    expect(h2.turns[0]!.toolPolicy).toBeUndefined();
  });

  it("dispatches a queued run with the allowlist it was queued with, even after the routine dropped it", async () => {
    const h = harness();
    // hold admission so the run is still queued when the routine changes
    h.gate.admitting = false;
    const routine = h.manager.create({ name: "Held", prompt: "Held prompt", botId: "bot", schedule: daily, toolPolicy: POLICY });
    const run = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    expect(h.turns).toHaveLength(0);
    expect(run.toolPolicy).toEqual(routine.toolPolicy);
    h.manager.update(routine.id, { toolPolicy: null });
    h.gate.admitting = true;
    await h.manager.tick();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.toolPolicy).toEqual(routine.toolPolicy);
  });

  it("never folds a run into one held to a different allowlist", async () => {
    const h = harness();
    h.gate.admitting = false;
    const routine = h.manager.create({ name: "Held", prompt: "Held prompt", botId: "bot", schedule: daily, toolPolicy: POLICY });
    h.manager.runNow(routine.id);
    await h.manager.tick();
    // the owner narrows the allowlist, then a second delivery queues
    h.manager.update(routine.id, { toolPolicy: { ...POLICY, writePaths: [] } });
    const newer = h.manager.runNow(routine.id)!;
    expect(newer.toolPolicy?.writePaths).toEqual([]);
    h.gate.admitting = true;
    await h.manager.tick();
    // Two turns, each under its own allowlist (this harness never reports the
    // bot busy, so both dispatch in one tick), and neither folded into the other.
    expect(h.turns.map((t) => t.toolPolicy?.writePaths).sort()).toEqual([[], POLICY.writePaths]);
    expect(h.manager.listRuns().every((r) => r.coalescedInto === undefined)).toBe(true);
  });

  it("keeps the allowlist when an update omits it and removes it on an explicit null", () => {
    const h = harness();
    const routine = h.manager.create({ name: "Held", prompt: "Held prompt", botId: "bot", schedule: daily, toolPolicy: POLICY });
    expect(h.manager.update(routine.id, { name: "Renamed" })!.toolPolicy).toEqual(routine.toolPolicy);
    const cleared = h.manager.update(routine.id, { toolPolicy: null })!;
    expect(cleared.toolPolicy).toBeUndefined();
    expect(Object.hasOwn(cleared, "toolPolicy")).toBe(false);
  });

  it("fails a run whose stored allowlist was hand-edited into something invalid instead of dropping it", async () => {
    const h = harness();
    // Run Now kicks a tick at once;  hold admission so the run stays queued
    // until the hand edit below is on disk.
    h.gate.admitting = false;
    const routine = h.manager.create({ name: "Held", prompt: "Held prompt", botId: "bot", schedule: daily, toolPolicy: POLICY });
    const run = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    // a hand edit of routines.json, made on disk and read back
    h.manager.flushNow();
    const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
    for (const queued of disk.runs) if (queued.id === run.id) queued.toolPolicy = { mode: "allowlist", commands: [{ argv0: "touch" }] };
    writeFileSync(h.options.file!, JSON.stringify(disk));
    h.manager.stop();
    h.gate.admitting = true;
    const reloaded = new RoutineManager(h.options);
    await reloaded.tick();
    expect(h.turns).toHaveLength(0);
    expect(reloaded.listRuns().find((r) => r.id === run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/Command allowlist/) });
  });
});
