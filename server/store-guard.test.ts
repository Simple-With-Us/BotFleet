import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
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

/** Keeps the odd numbers, and counts what it left out the way a real store does. */
const keepOdd = (parsed: JsonValue): Interpreted<JsonValue[]> => {
  if (!Array.isArray(parsed)) return { ok: false, reason: "it is not a list" };
  const kept = parsed.filter((n) => Number(n) % 2 === 1);
  return { ok: true, value: kept, omitted: parsed.length - kept.length };
};

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
      // The marker stands in for a credential so nothing here is shaped like a real key, and so a
      // scanner cannot read the fixture as one.  It still has to be absent from the reason, which
      // is the whole point of the test.
      const bad = ['{"key":"REDACTED_TEST_MARKER", oops}', "REDACTED_TEST_MARKER", '{"key":"REDACTED_TEST_MARKER'];
      for (const text of bad) {
        let reason = "";
        try {
          JSON.parse(text);
        } catch (failure) {
          reason = jsonFailureReason(failure instanceof Error ? failure : new Error("?"));
        }
        expect(reason).toMatch(/^it (ends early|is not valid JSON)/);
        expect(reason).not.toContain("REDACTED_TEST_MARKER");
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
      const loaded = loadGuarded(file(), keepOdd, 1790000000000);
      expect(loaded).toEqual({ status: "ok", value: [1, 3], writesRefused: false });
      // The original now holds only what was kept; the copy holds all of it.
      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual([1, 3]);
      expect(readFileSync(join(dir, "bots.json.corrupt-1790000000000"), "utf8")).toBe(original);
      expect(names()).toEqual(["bots.json", "bots.json.corrupt-1790000000000"]);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ kind: "partial", omitted: 2, setAsideAs: "bots.json.corrupt-1790000000000", writesRefused: false }),
      ]);
    });

    it("does not copy the same damage aside again on the next start", () => {
      writeFileSync(file(), "[1,2,3,4]");
      loadGuarded(file(), keepOdd, 1790000000000);
      resetDataFaults();
      error.mockClear();
      const again = loadGuarded(file(), keepOdd, 1790000000001);
      expect(again).toEqual({ status: "ok", value: [1, 3], writesRefused: false });
      expect(names()).toEqual(["bots.json", "bots.json.corrupt-1790000000000"]);
      expect(listDataFaults()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it("refuses to save, and keeps the copy, when the cleaned file cannot be written back", () => {
      // The write-back goes through a temporary name beside the file that is longer than the
      // ".corrupt-<epoch>" name the copy takes, so a file name sized to sit exactly at the 255-unit
      // name limit once the copy's suffix is added lets the copy succeed and makes the write-back
      // fail.  Ask the platform first, as the move-aside test below does, and say so when it
      // declines to enforce the limit.
      const base = `${"c".repeat(228)}.json`;
      const long = join(dir, base);
      const copyName = `${base}.corrupt-1790000000000`;
      expect(copyName).toHaveLength(255);
      let enforced = false;
      try {
        writeFileSync(join(dir, copyName), "probe");
        rmSync(join(dir, copyName));
        try {
          writeFileSync(join(dir, `${base}.${"t".repeat(43)}`), "probe");
          rmSync(join(dir, `${base}.${"t".repeat(43)}`));
        } catch {
          enforced = true;
        }
      } catch {
        /* the copy's own name is refused here, so this case cannot be set up */
      }
      const original = "[1,2,3,4]";
      writeFileSync(long, original);
      const loaded = loadGuarded(long, keepOdd, 1790000000000);
      // The copy holds the whole original in every case.
      expect(readFileSync(join(dir, copyName), "utf8")).toBe(original);
      expect(names()).toEqual([base, copyName]);
      if (!enforced) {
        expect(loaded).toEqual({ status: "ok", value: [1, 3], writesRefused: false });
        expect(JSON.parse(readFileSync(long, "utf8"))).toEqual([1, 3]);
        return;
      }
      expect(loaded).toEqual({ status: "ok", value: [1, 3], writesRefused: true });
      // Neither file was lost: the original is untouched and the durable copy is still there.
      expect(readFileSync(long, "utf8")).toBe(original);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ kind: "partial", omitted: 2, setAsideAs: copyName, writesRefused: true }),
      ]);
      expect(listDataFaults()[0]!.reason).toContain("the cleaned file could not be written back (");
      expect(String(error.mock.calls[0]![0])).toContain(`will not save to ${base}`);
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
      // Make the platform refuse the rename, then CHECK that it did before
      // asserting anything about what the guard does about it.
      //
      // There is no portable way to force this from outside.  A read-only
      // folder refuses a new name on POSIX but gates nothing on Windows, where
      // a folder's read-only attribute is only a display hint.  A read-only
      // FILE is refused on neither: the first Windows run of this branch
      // proved NTFS will still move one.  A name already taken does not work
      // either, because the guard deliberately walks to a free name, and
      // rename(2) replaces a dangling symlink rather than failing on it.  So
      // the honest test is the one that asks the platform first, and says so
      // when the platform declines to be asked.  An earlier version here
      // assumed a filename too long for its ".corrupt-<epoch>" suffix, which
      // holds under a 255-byte POSIX name limit but not on NTFS with long
      // paths — the guard then reported "set-aside" where this means
      // "unreadable", the opposite of the property, for a whole CI run.
      const windows = process.platform === "win32";
      const file = join(dir, "bots.json");
      writeFileSync(file, "{ not json");
      if (windows) chmodSync(file, 0o444);
      else chmodSync(dir, 0o555);
      try {
        const probe = setFileAside(file, "move", 1790000000000);
        if (probe.ok) {
          // The mode was not enforced (root, or a filesystem without permission bits), so the
          // refusal was never set up.  Undo the probe's move so the directory is left as found,
          // then assert the outcome that did happen rather than returning silently: the bytes
          // must still be in the original file, byte for byte.  POSIX takes the branch below on
          // every run.
          if (probe.path) renameSync(probe.path, file);
          expect(readFileSync(file, "utf8")).toBe("{ not json");
          expect(readdirSync(dir)).toEqual(["bots.json"]);
          return;
        }
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
