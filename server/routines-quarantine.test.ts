// What the RoutineManager does with a routines.json it cannot use (audit A7).
// It used to fall back to "no routines" on any failure, and its next save then
// replaced the file: every automation the owner had set up, and the history of
// their runs, was gone with no sign of it.  Now an unusable file is moved aside
// (never deleted), the manager starts without it, and the state is logged and
// recorded for the app's banner.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { listDataFaults, resetDataFaults } from "./data-faults.ts";
import { RoutineManager } from "./routines.ts";
import { resetRefusedSaveLog } from "./store-guard.ts";

const dirs: string[] = [];
const NOW = new Date(2026, 7, 17, 8, 0, 0).getTime();

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-quarantine-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

const build = (file: string) =>
  new RoutineManager({
    file,
    now: () => NOW,
    botState: () => "ready" as const,
    createTask: () => ({ threadId: "thread-1" }),
    startTurn: async () => {},
  });

const asideNames = (file: string): string[] =>
  readdirSync(join(file, "..")).filter((name) => name.startsWith("routines.json.corrupt-")).sort();

/** A routines.json with two routines, written by the manager itself, so the shape is the real one. */
function seed(file: string) {
  const manager = build(file);
  manager.create({ name: "Morning", prompt: "Check", botId: "bot-1", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
  manager.create({ name: "Evening", prompt: "Wrap up", botId: "bot-1", schedule: { type: "daily", time: "18:00", weekdays: [1] } });
  manager.flushNow();
  return readFileSync(file, "utf8");
}

describe("RoutineManager with an unusable routines.json", () => {
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetDataFaults();
    resetRefusedSaveLog();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
    resetDataFaults();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("sets truncated JSON aside byte for byte, starts empty, and says so", () => {
    const file = tempFile();
    const truncated = seed(file).slice(0, 120);
    writeFileSync(file, truncated);

    const manager = build(file);

    expect(manager.listRoutines()).toEqual([]);
    const [name] = asideNames(file);
    expect(asideNames(file)).toHaveLength(1);
    expect(readFileSync(join(file, "..", name!), "utf8")).toBe(truncated);
    expect(() => statSync(file)).toThrow();
    expect(listDataFaults()).toEqual([
      expect.objectContaining({ file: "routines.json", kind: "set-aside", setAsideAs: name, writesRefused: false, holdsCleanup: false }),
    ]);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(name!);
  });

  it("saves new routines into a fresh file and leaves the set-aside file alone", () => {
    const file = tempFile();
    const truncated = seed(file).slice(0, 90);
    writeFileSync(file, truncated);
    const manager = build(file);
    const [name] = asideNames(file);

    manager.create({ name: "Fresh", prompt: "New", botId: "bot-1", schedule: { type: "daily", time: "10:00", weekdays: [2] } });
    manager.flushNow();

    expect(JSON.parse(readFileSync(file, "utf8")).routines.map((routine: { name: string }) => routine.name)).toEqual(["Fresh"]);
    expect(readFileSync(join(file, "..", name!), "utf8")).toBe(truncated);
  });

  it.each([
    ["a list", "[]"],
    ["null", "null"],
    ["text", '"text"'],
    ["a number", "42"],
    ["an object whose routines are not a list", '{"routines":"nope"}'],
    ["an object whose runs are not a list", '{"runs":{"a":1}}'],
    ["routines that are all unusable", '{"routines":[1,null]}'],
  ])("starts when the file holds %s, instead of treating it as no routines", (_label, body) => {
    const file = tempFile();
    writeFileSync(file, body);
    const manager = build(file);
    expect(manager.listRoutines()).toEqual([]);
    const [name] = asideNames(file);
    expect(asideNames(file)).toHaveLength(1);
    expect(readFileSync(join(file, "..", name!), "utf8")).toBe(body);
    expect(listDataFaults()[0]).toMatchObject({ file: "routines.json", kind: "set-aside" });
  });

  it("sets an empty file aside", () => {
    const file = tempFile();
    writeFileSync(file, "");
    expect(build(file).listRoutines()).toEqual([]);
    expect(asideNames(file)).toHaveLength(1);
    expect(listDataFaults()[0]?.reason).toContain("empty");
  });

  it("reads a file that starts with a byte-order mark as the healthy file it is", () => {
    const file = tempFile();
    const original = seed(file);
    writeFileSync(file, `﻿${original}`);
    const manager = build(file);
    expect(manager.listRoutines().map((routine) => routine.name).sort()).toEqual(["Evening", "Morning"]);
    expect(asideNames(file)).toEqual([]);
    expect(listDataFaults()).toEqual([]);
  });

  it("keeps the routines it can read when a few entries are damaged, and saves the whole original aside", () => {
    const file = tempFile();
    const disk = JSON.parse(seed(file));
    const damaged = JSON.stringify({ ...disk, routines: [...disk.routines, null, { name: "no id" }], runs: [...disk.runs, 5] });
    writeFileSync(file, damaged);

    const manager = build(file);

    expect(manager.listRoutines().map((routine) => routine.name).sort()).toEqual(["Evening", "Morning"]);
    const [name] = asideNames(file);
    expect(readFileSync(join(file, "..", name!), "utf8")).toBe(damaged);
    expect(listDataFaults()[0]).toMatchObject({ file: "routines.json", kind: "partial", omitted: 3, setAsideAs: name });
    manager.create({ name: "Third", prompt: "x", botId: "bot-1", schedule: { type: "daily", time: "11:00", weekdays: [3] } });
    manager.flushNow();
    expect(JSON.parse(readFileSync(file, "utf8")).routines).toHaveLength(3);
    expect(readFileSync(join(file, "..", name!), "utf8")).toBe(damaged);
  });

  it("does not call a file without receipts or snoozes damaged", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [] }));
    expect(build(file).listRoutines()).toEqual([]);
    expect(asideNames(file)).toEqual([]);
    expect(listDataFaults()).toEqual([]);
  });

  it("round-trips routines through a save and a reload without a notice", () => {
    const file = tempFile();
    seed(file);
    const reloaded = build(file);
    expect(reloaded.listRoutines().map((routine) => routine.name).sort()).toEqual(["Evening", "Morning"]);
    expect(asideNames(file)).toEqual([]);
    expect(listDataFaults()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("refuses to save over a routines.json it could not read, and says so", () => {
    const file = tempFile();
    mkdirSync(file);
    writeFileSync(join(file, "keep.txt"), "x");
    const manager = build(file);
    expect(listDataFaults()).toEqual([expect.objectContaining({ file: "routines.json", kind: "unreadable", writesRefused: true })]);

    manager.create({ name: "In Memory", prompt: "x", botId: "bot-1", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    expect(() => manager.flushNow()).not.toThrow();

    expect(statSync(file).isDirectory()).toBe(true);
    expect(readFileSync(join(file, "keep.txt"), "utf8")).toBe("x");
    expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("not saving"))).toHaveLength(1);
    expect(manager.listRoutines().map((routine) => routine.name)).toEqual(["In Memory"]);
  });
});
