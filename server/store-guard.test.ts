import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { listDataFaults, resetDataFaults } from "./data-faults.ts";
import type { JsonValue } from "./schema.ts";
import {
  jsonFailureReason,
  loadGuarded,
  logRefusedSave,
  resetRefusedSaveLog,
  setFileAside,
  stripBom,
  type Interpreted,
} from "./store-guard.ts";

const list = (parsed: JsonValue): Interpreted<JsonValue[]> =>
  Array.isArray(parsed) ? { ok: true, value: parsed, omitted: 0 } : { ok: false, reason: "it is not a list" };

describe("store-guard", () => {
  let dir: string;
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "botfleet-store-guard-"));
    resetDataFaults();
    resetRefusedSaveLog();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
    resetDataFaults();
    rmSync(dir, { recursive: true, force: true });
  });

  const names = (): string[] => readdirSync(dir).sort();

  describe("setFileAside", () => {
    it("renames the file, keeping its bytes and its private mode", () => {
      const file = join(dir, "bots.json");
      writeFileSync(file, "{broken", { mode: 0o600 });
      const moved = setFileAside(file, "move", 1790000000000);
      expect(moved).toEqual({ ok: true, path: join(dir, "bots.json.corrupt-1790000000000") });
      expect(names()).toEqual(["bots.json.corrupt-1790000000000"]);
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000"), "utf8")).toBe("{broken");
      // The mode is only meaningful where the filesystem has permission bits.
      // NTFS has none, so statSync reports 0o666 for every file there and
      // `writeFileSync`'s mode option is ignored; asserting it there would be
      // asserting a property Windows does not have.  What is portable is that
      // the set-aside file is the owner's and not world-writable, which the
      // POSIX branch below already covers.
      if (process.platform !== "win32") {
        expect(statSync(join(dir, "bots.json.corrupt-1790000000000")).mode & 0o777).toBe(0o600);
      }
    });

    it("never reuses a name, however many land in the same millisecond", () => {
      const file = join(dir, "bots.json");
      for (const body of ["one", "two", "three"]) {
        writeFileSync(file, body);
        expect(setFileAside(file, "move", 1790000000000).ok).toBe(true);
      }
      expect(names()).toEqual([
        "bots.json.corrupt-1790000000000",
        "bots.json.corrupt-1790000000000-1",
        "bots.json.corrupt-1790000000000-2",
      ]);
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000"), "utf8")).toBe("one");
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000-2"), "utf8")).toBe("three");
    });

    it("copies without disturbing the original", () => {
      const file = join(dir, "groups.json");
      writeFileSync(file, "[1,2,3]");
      const copied = setFileAside(file, "copy", 1790000000000);
      expect(copied.ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("[1,2,3]");
      expect(readFileSync(join(dir, "groups.json.corrupt-1790000000000"), "utf8")).toBe("[1,2,3]");
    });

    it("reports a file that is already gone as moved, with no path", () => {
      expect(setFileAside(join(dir, "gone.json"), "move", 1)).toEqual({ ok: true, path: null });
    });
  });

  describe("reading", () => {
    it("strips a byte-order mark and nothing else", () => {
      expect(stripBom("﻿[1]")).toBe("[1]");
      expect(stripBom("[1]")).toBe("[1]");
      expect(stripBom("")).toBe("");
    });

    it("describes a JSON failure by position only, never by quoting the text", () => {
      const bad = ['{"key":"sk-fixture-secret-value", oops}', "sk-fixture-secret-value", '{"key":"sk-fixture-secret-value'];
      for (const text of bad) {
        let reason = "";
        try {
          JSON.parse(text);
        } catch (failure) {
          reason = jsonFailureReason(failure instanceof Error ? failure : new Error("?"));
        }
        expect(reason).toMatch(/^it (ends early|is not valid JSON)/);
        expect(reason).not.toContain("sk-fixture");
      }
    });
  });

  describe("loadGuarded", () => {
    const file = () => join(dir, "bots.json");

    it("calls a missing file a first run and records nothing", () => {
      expect(loadGuarded(file(), list)).toEqual({ status: "missing", value: null, writesRefused: false });
      expect(listDataFaults()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it("returns a usable file as it is, with no notice", () => {
      writeFileSync(file(), "[1,2]");
      expect(loadGuarded(file(), list)).toEqual({ status: "ok", value: [1, 2], writesRefused: false });
      expect(names()).toEqual(["bots.json"]);
      expect(listDataFaults()).toEqual([]);
    });

    it("uses a file that starts with a byte-order mark", () => {
      writeFileSync(file(), "﻿[1,2]");
      expect(loadGuarded(file(), list).value).toEqual([1, 2]);
      expect(names()).toEqual(["bots.json"]);
      expect(listDataFaults()).toEqual([]);
    });

    it.each([
      ["empty", "", "it is empty"],
      ["only whitespace", " \n\t", "it is empty"],
      ["truncated", "[1,2", "it ends early"],
      ["not JSON", "garbage", "it is not valid JSON"],
      ["the wrong type", '{"a":1}', "it is not a list"],
    ])("sets aside a file that is %s, and starts without it", (_label, body, reason) => {
      writeFileSync(file(), body);
      const loaded = loadGuarded(file(), list, 1790000000000);
      expect(loaded).toEqual({ status: "set-aside", value: null, writesRefused: false });
      expect(names()).toEqual(["bots.json.corrupt-1790000000000"]);
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000"), "utf8")).toBe(body);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({
          file: "bots.json",
          kind: "set-aside",
          setAsideAs: "bots.json.corrupt-1790000000000",
          writesRefused: false,
          holdsCleanup: true,
          at: 1790000000000,
        }),
      ]);
      expect(listDataFaults()[0]!.reason).toContain(reason);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain("bots.json.corrupt-1790000000000");
      expect(String(error.mock.calls[0]![0])).toContain("Nothing was deleted");
    });

    it("keeps the usable entries, copies the whole original aside, and says how many were left out", () => {
      const original = "[1,2,3,4]";
      writeFileSync(file(), original);
      const keepOdd = (parsed: JsonValue): Interpreted<JsonValue[]> =>
        Array.isArray(parsed)
          ? { ok: true, value: parsed.filter((n) => Number(n) % 2 === 1), omitted: 2 }
          : { ok: false, reason: "it is not a list" };
      const loaded = loadGuarded(file(), keepOdd, 1790000000000);
      expect(loaded).toEqual({ status: "ok", value: [1, 3], writesRefused: false });
      expect(readFileSync(file(), "utf8")).toBe(original);
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000"), "utf8")).toBe(original);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ kind: "partial", omitted: 2, setAsideAs: "bots.json.corrupt-1790000000000", writesRefused: false }),
      ]);
    });

    it("leaves a file it cannot read where it is, and refuses to save over it", () => {
      mkdirSync(file());
      writeFileSync(join(file(), "inside.txt"), "x");
      const loaded = loadGuarded(file(), list);
      expect(loaded).toEqual({ status: "unreadable", value: null, writesRefused: true });
      expect(statSync(file()).isDirectory()).toBe(true);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ kind: "unreadable", writesRefused: true, setAsideAs: null, holdsCleanup: true }),
      ]);
      expect(listDataFaults()[0]!.reason).toContain("EISDIR");
    });

    it("leaves an unusable file where it is when it cannot be moved aside", () => {
      // Make the rename fail the way this platform makes it fail.  On POSIX a
      // read-only folder refuses the new name; on Windows the folder's
      // read-only attribute gates nothing, but a read-only FILE cannot be
      // moved.  The previous version leaned on a filename too long to accept
      // the ".corrupt-<epoch>" suffix, which holds under a 255-byte POSIX name
      // limit but not on NTFS with long paths enabled — there the rename went
      // through and this reported "set-aside" where it means "unreadable".
      const file = join(dir, "bots.json");
      const windows = process.platform === "win32";
      writeFileSync(file, "{ not json");
      if (windows) chmodSync(file, 0o444);
      else chmodSync(dir, 0o555);
      try {
        const loaded = loadGuarded(file, list, 1790000000000);
        expect(loaded).toEqual({ status: "unreadable", value: null, writesRefused: true });
        expect(readFileSync(file, "utf8")).toBe("{ not json");
        // Nothing was set aside, and the original is still the file it was.
        expect(readdirSync(dir)).toEqual(["bots.json"]);
        expect(listDataFaults()[0]).toMatchObject({ kind: "unreadable", writesRefused: true, setAsideAs: null });
        expect(listDataFaults()[0]!.reason).toContain("could not be moved aside");
      } finally {
        if (windows) chmodSync(file, 0o600);
        else chmodSync(dir, 0o755);
      }
    });

    it("refuses to save when the copy of a partly usable file cannot be made", () => {
      const long = join(dir, `${"b".repeat(240)}.json`);
      writeFileSync(long, "[1,2]");
      const dropOne = (parsed: JsonValue): Interpreted<JsonValue[]> =>
        Array.isArray(parsed) ? { ok: true, value: parsed.slice(1), omitted: 1 } : { ok: false, reason: "no" };
      const loaded = loadGuarded(long, dropOne, 1790000000000);
      expect(loaded).toEqual({ status: "ok", value: [2], writesRefused: true });
      expect(listDataFaults()[0]).toMatchObject({ kind: "partial", writesRefused: true, setAsideAs: null });
    });

    it("does not treat a read-only folder as a reason to overwrite", () => {
      writeFileSync(file(), "{ not json");
      chmodSync(dir, 0o555);
      try {
        // Running as root (some CI containers) ignores the mode; there is nothing to prove there.
        try {
          writeFileSync(join(dir, "probe"), "x");
          rmSync(join(dir, "probe"));
          return;
        } catch {
          /* the folder is read-only, as intended */
        }
        const loaded = loadGuarded(file(), list);
        expect(loaded.writesRefused).toBe(true);
        expect(readFileSync(file(), "utf8")).toBe("{ not json");
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });

  it("logs a refused save once per file", () => {
    logRefusedSave(join(dir, "bots.json"));
    logRefusedSave(join(dir, "bots.json"));
    logRefusedSave(join(dir, "groups.json"));
    expect(error).toHaveBeenCalledTimes(2);
  });
});
