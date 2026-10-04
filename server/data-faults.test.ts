import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHoldReason,
  clearDataFault,
  findSetAsideFiles,
  listDataFaults,
  recordDataFault,
  registerLeftOverSetAsideFiles,
  resetDataFaults,
  rosterIsOnHold,
  type DataFault,
} from "./data-faults.ts";

function fault(overrides: Partial<DataFault> = {}): DataFault {
  return {
    file: "bots.json",
    kind: "set-aside",
    reason: "it is not valid JSON",
    setAsideAs: "bots.json.corrupt-1790000000000",
    omitted: 0,
    sections: [],
    writesRefused: false,
    holdsCleanup: true,
    at: 1790000000000,
    ...overrides,
  };
}

describe("data faults", () => {
  let dir: string;
  beforeEach(() => {
    resetDataFaults();
    dir = mkdtempSync(join(tmpdir(), "botfleet-data-faults-"));
  });
  afterEach(() => {
    resetDataFaults();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one notice per file, newest wins, sorted by file name", () => {
    recordDataFault(fault({ file: "routines.json", setAsideAs: "routines.json.corrupt-1" }));
    recordDataFault(fault({ file: "bots.json", reason: "first" }));
    recordDataFault(fault({ file: "bots.json", reason: "second" }));
    expect(listDataFaults().map((entry) => [entry.file, entry.reason])).toEqual([
      ["bots.json", "second"],
      ["routines.json", "it is not valid JSON"],
    ]);
  });

  it("hands out copies, so a caller cannot edit the registry", () => {
    recordDataFault(fault({ kind: "config-partial", file: "config.json", sections: ["tts"] }));
    const listed = listDataFaults();
    listed[0]!.sections.push("injected");
    listed[0]!.reason = "changed";
    expect(listDataFaults()[0]).toMatchObject({ sections: ["tts"], reason: "it is not valid JSON" });
  });

  it("clears a notice only when its kind is one of the kinds asked for", () => {
    recordDataFault(fault({ file: "config.json", kind: "set-aside" }));
    clearDataFault("config.json", ["config-ignored", "config-partial"]);
    expect(listDataFaults()).toHaveLength(1);
    clearDataFault("config.json", ["set-aside"]);
    expect(listDataFaults()).toHaveLength(0);
    recordDataFault(fault({ file: "config.json", kind: "config-ignored" }));
    clearDataFault("config.json");
    expect(listDataFaults()).toHaveLength(0);
  });

  it("finds set-aside files by name, oldest first, and ignores look-alikes", () => {
    for (const name of [
      "bots.json.corrupt-1790000000500",
      "bots.json.corrupt-1790000000100",
      "groups.json.corrupt-1790000000300-1",
      "config.json.corrupt-1790000000400",
      "bots.json",
      "bots.json.bak",
      "bots.json.corrupt-",
      "bots.json.corrupt-12abc",
      "messages.json.corrupt-1790000000600",
      "notes.corrupt-1790000000700",
    ]) {
      writeFileSync(join(dir, name), "x");
    }
    expect(findSetAsideFiles(dir).map((entry) => entry.name)).toEqual([
      "bots.json.corrupt-1790000000100",
      "groups.json.corrupt-1790000000300-1",
      "config.json.corrupt-1790000000400",
      "bots.json.corrupt-1790000000500",
    ]);
    expect(findSetAsideFiles(join(dir, "missing"))).toEqual([]);
  });

  it("holds the roster and cleanup while a set-aside bots.json or groups.json exists, read from disk", () => {
    expect(rosterIsOnHold(dir)).toBe(false);
    expect(cleanupHoldReason(dir)).toBeNull();

    writeFileSync(join(dir, "routines.json.corrupt-1790000000100"), "x");
    writeFileSync(join(dir, "config.json.corrupt-1790000000200"), "x");
    expect(rosterIsOnHold(dir)).toBe(false);
    expect(cleanupHoldReason(dir)).toBeNull();

    writeFileSync(join(dir, "groups.json.corrupt-1790000000300"), "x");
    expect(rosterIsOnHold(dir)).toBe(false);
    expect(cleanupHoldReason(dir)).toContain("groups.json.corrupt-1790000000300");

    writeFileSync(join(dir, "bots.json.corrupt-1790000000400"), "x");
    expect(rosterIsOnHold(dir)).toBe(true);
    expect(cleanupHoldReason(dir)).toContain("bots.json.corrupt-1790000000400");

    rmSync(join(dir, "bots.json.corrupt-1790000000400"));
    rmSync(join(dir, "groups.json.corrupt-1790000000300"));
    expect(rosterIsOnHold(dir)).toBe(false);
    expect(cleanupHoldReason(dir)).toBeNull();
  });

  it("holds cleanup for a live notice even when no file could be set aside", () => {
    recordDataFault(fault({ kind: "unreadable", setAsideAs: null, writesRefused: true }));
    expect(cleanupHoldReason(dir)).toContain("bots.json");
    clearDataFault("bots.json");
    expect(cleanupHoldReason(dir)).toBeNull();
  });

  it("raises a left-over notice per store at startup, but never over a fresher notice", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bots.json.corrupt-1790000000100"), "x");
    writeFileSync(join(dir, "bots.json.corrupt-1790000000900"), "x");
    writeFileSync(join(dir, "routines.json.corrupt-1790000000200"), "x");
    writeFileSync(join(dir, "groups.json.corrupt-1790000000300"), "x");
    writeFileSync(join(dir, "config.json.corrupt-1790000000400"), "x");
    recordDataFault(fault({ file: "groups.json", kind: "partial", setAsideAs: "groups.json.corrupt-1790000000300" }));

    registerLeftOverSetAsideFiles(dir, 1790000001000);

    const byFile = new Map(listDataFaults().map((entry) => [entry.file, entry]));
    expect([...byFile.keys()].sort()).toEqual(["bots.json", "config.json", "groups.json", "routines.json"]);
    expect(byFile.get("bots.json")).toMatchObject({
      kind: "left-over",
      setAsideAs: "bots.json.corrupt-1790000000900",
      holdsCleanup: true,
      writesRefused: false,
    });
    expect(byFile.get("routines.json")).toMatchObject({ kind: "left-over", holdsCleanup: false });
    // config.json is quarantined by the config lock, in another process, and the copy left behind
    // is the one holding the owner's API keys.  The file that replaced it is healthy, so no other
    // notice would ever name it, and it must not hold the cleanup sweeps either: it decides
    // nothing about which bots or rooms still exist.
    expect(byFile.get("config.json")).toMatchObject({
      kind: "left-over",
      setAsideAs: "config.json.corrupt-1790000000400",
      holdsCleanup: false,
      writesRefused: false,
    });
    expect(byFile.get("groups.json")?.kind).toBe("partial");
  });
});
