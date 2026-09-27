// The rule these cover: a transcript log never grows past its cap, and what
// the cap displaces is still readable until the generation after next. The
// caps themselves are 64 MB and 16 MB in production; every test here passes
// its own small cap, so the behaviour is pinned without writing megabytes.
import { type appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendBounded,
  removeTranscriptLogs,
  EVENTS_LOG_MAX_BYTES,
  NATIVE_LOG_MAX_BYTES,
  ORPHAN_MAX_AGE_MS,
  describeOrphanSweep,
  describeSweep,
  rotatedPath,
  sweepOrphanedTranscripts,
  sweepTranscriptLogs,
  transcriptLogPaths,
  trimToTail,
} from "./transcript-retention.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "omb-transcript-retention-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A record of a FIXED width, so a cap can be expressed in whole lines — the
 * two-digit `n` is what keeps every line the same number of bytes. */
const record = (n: number) => JSON.stringify({ n: String(n).padStart(2, "0"), pad: "x".repeat(20) }) + "\n";
const lines = (text: string) => text.split("\n").filter(Boolean);
const ns = (text: string) => lines(text).map((l) => Number(JSON.parse(l).n));

describe("appendBounded", () => {
  it("rotates when the next append would cross the cap", () => {
    const dir = tmp();
    const file = join(dir, "t1.ndjson");
    const width = Buffer.byteLength(record(1));
    const cap = width * 3;

    for (let n = 1; n <= 3; n++) appendBounded(file, record(n), cap);
    // three records fit exactly; nothing has rotated yet
    expect(existsSync(rotatedPath(file))).toBe(false);
    expect(lines(readFileSync(file, "utf8"))).toHaveLength(3);

    appendBounded(file, record(4), cap);
    expect(ns(readFileSync(rotatedPath(file), "utf8"))).toEqual([1, 2, 3]);
    expect(ns(readFileSync(file, "utf8"))).toEqual([4]);
    expect(statSync(file).size).toBeLessThanOrEqual(cap);
  });

  it("keeps exactly one rotated generation", () => {
    const dir = tmp();
    const file = join(dir, "t2.ndjson");
    const cap = Buffer.byteLength(record(1)) * 2;
    for (let n = 1; n <= 7; n++) appendBounded(file, record(n), cap);

    expect(readdirSync(dir).sort()).toEqual(["t2.ndjson", "t2.ndjson.1"]);
    // two caps' worth on disk, never more, whatever the thread has run
    expect(statSync(file).size + statSync(rotatedPath(file)).size).toBeLessThanOrEqual(cap * 2);
    expect([...ns(readFileSync(rotatedPath(file), "utf8")), ...ns(readFileSync(file, "utf8"))]).toEqual([5, 6, 7]);
  });

  it("writes a record larger than the cap rather than dropping it", () => {
    const dir = tmp();
    const file = join(dir, "t3.ndjson");
    const huge = JSON.stringify({ big: "y".repeat(500) }) + "\n";
    appendBounded(file, huge, 64);
    expect(readFileSync(file, "utf8")).toBe(huge);
    expect(existsSync(rotatedPath(file))).toBe(false);
  });

  it("counts the file it found on disk, so a restart does not forget its size", () => {
    const dir = tmp();
    const file = join(dir, "t4.ndjson");
    const width = Buffer.byteLength(record(1));
    // written by an "earlier run": nothing is cached for this path
    writeFileSync(file, record(1) + record(2));
    appendBounded(file, record(3), width * 2);
    expect(ns(readFileSync(rotatedPath(file), "utf8"))).toEqual([1, 2]);
    expect(ns(readFileSync(file, "utf8"))).toEqual([3]);
  });

  it("uses the writer it is handed and applies the file mode", () => {
    const dir = tmp();
    const file = join(dir, "t5.ndjson");
    const seen: Array<{ file: string; data: string }> = [];
    const append: typeof appendFileSync = (path, data) => {
      seen.push({ file: String(path), data: String(data) });
    };
    appendBounded(file, record(1), 1024, { mode: 0o600 }, append);
    // the injected writer is the one that touches disk — the event bus tests
    // fail the write there, and must keep failing there
    expect(seen).toEqual([{ file, data: record(1) }]);
    expect(existsSync(file)).toBe(false);

    appendBounded(file, record(2), 1024, { mode: 0o600 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("trimToTail", () => {
  it("keeps the newest whole lines and cuts on a line boundary", () => {
    const dir = tmp();
    const file = join(dir, "t1.ndjson");
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(file, body);

    // a cap of three and a half records: the window opens inside record 7,
    // and the cut moves forward to the boundary rather than keeping half of it
    const cap = width * 3 + Math.floor(width / 2);
    const reclaimed = trimToTail(file, cap);
    // every kept line parses: no half record at the head
    expect(ns(readFileSync(file, "utf8"))).toEqual([8, 9, 10]);
    expect(reclaimed).toBe(width * 7);
    expect(statSync(file).size).toBeLessThanOrEqual(cap);
    // the copy left nothing behind
    expect(readdirSync(dir)).toEqual(["t1.ndjson"]);
  });

  it("is idempotent: a file already inside the cap is untouched", () => {
    const dir = tmp();
    const file = join(dir, "t2.ndjson");
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(file, body);

    expect(trimToTail(file, width * 4)).toBeGreaterThan(0);
    const once = readFileSync(file, "utf8");
    expect(trimToTail(file, width * 4)).toBe(0);
    expect(trimToTail(file, width * 4)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("leaves a file whose last record is bigger than the cap exactly as it is", () => {
    const dir = tmp();
    const file = join(dir, "t3.ndjson");
    const body = record(1) + JSON.stringify({ big: "z".repeat(400) }) + "\n";
    writeFileSync(file, body);
    // there is no line boundary inside the window, and emptying the file
    // would throw away the only record it has
    expect(trimToTail(file, 100)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("does nothing for a file that is not there", () => {
    expect(trimToTail(join(tmp(), "missing.ndjson"), 10)).toBe(0);
  });
});

describe("sweepTranscriptLogs", () => {
  it("trims every oversized log in the directory, both generations", () => {
    const dir = tmp();
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(join(dir, "a.ndjson"), body);
    writeFileSync(join(dir, "a.ndjson.1"), body);
    writeFileSync(join(dir, "b.ndjson"), record(1));
    writeFileSync(join(dir, "notes.txt"), body);

    const result = sweepTranscriptLogs(dir, width * 2 + Math.floor(width / 2));
    expect(result).toEqual({ scanned: 3, trimmed: 2, bytesReclaimed: width * 8 * 2, tempRemoved: 0, failed: 0 });
    expect(ns(readFileSync(join(dir, "a.ndjson"), "utf8"))).toEqual([9, 10]);
    expect(ns(readFileSync(join(dir, "a.ndjson.1"), "utf8"))).toEqual([9, 10]);
    expect(readFileSync(join(dir, "b.ndjson"), "utf8")).toBe(record(1));
    // a file that is not a transcript log is not this sweep's business
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(body);
  });

  it("is idempotent across runs", () => {
    const dir = tmp();
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(join(dir, "a.ndjson"), body);

    const cap = width * 3 + Math.floor(width / 2);
    expect(sweepTranscriptLogs(dir, cap).trimmed).toBe(1);
    const once = readFileSync(join(dir, "a.ndjson"), "utf8");
    // a second and third pass find a file already inside the cap: no trim, no
    // rewrite, and — the part the boot sweep depends on — no growth in state
    expect(sweepTranscriptLogs(dir, cap)).toEqual({ scanned: 1, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 });
    expect(sweepTranscriptLogs(dir, cap)).toEqual({ scanned: 1, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 });
    expect(readFileSync(join(dir, "a.ndjson"), "utf8")).toBe(once);
  });

  it("skips a log this process is appending to, because rotation already bounds it", () => {
    const dir = tmp();
    const file = join(dir, "live.ndjson");
    appendBounded(file, record(1), 1024);
    expect(sweepTranscriptLogs(dir, 1)).toEqual({ scanned: 0, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 });
    expect(readFileSync(file, "utf8")).toBe(record(1));
  });

  it("says nothing when there was nothing to do, and leads with what happened when there was", () => {
    expect(describeSweep({ scanned: 4, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 })).toBeNull();
    expect(describeSweep({ scanned: 4, trimmed: 2, bytesReclaimed: 3 * 1024 * 1024, tempRemoved: 0, failed: 0 })).toBe(
      "[transcripts] Trimmed 2 of 4 thread logs to their size cap, reclaiming 3.0 MB.",
    );
    // a sweep that only reaped a killed trim's leftovers must not open by
    // announcing that it trimmed nothing
    expect(describeSweep({ scanned: 4, trimmed: 0, bytesReclaimed: 2048, tempRemoved: 1, failed: 0 })).toBe(
      "[transcripts] Removed 1 stale temp file from an interrupted trim, reclaiming 0.0 MB.",
    );
    expect(describeSweep({ scanned: 4, trimmed: 2, bytesReclaimed: 3 * 1024 * 1024, tempRemoved: 2, failed: 1 })).toBe(
      "[transcripts] Trimmed 2 of 4 thread logs to their size cap, reclaiming 3.0 MB.  Removed 2 stale temp files from an interrupted trim.  1 log could not be trimmed.",
    );
  });

  it("survives a directory that does not exist", () => {
    expect(sweepTranscriptLogs(join(tmp(), "nope"), 10)).toEqual({ scanned: 0, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 });
  });
});

describe("trimToTail on a file much larger than the cap", () => {
  /** A line of exactly 64 bytes, so a cap in bytes is a count of records. */
  const wide = (i: number) => {
    const body = JSON.stringify({ i });
    return body + " ".repeat(63 - body.length) + "\n";
  };

  it("keeps the newest whole lines and reads only the tail it keeps", () => {
    const dir = tmp();
    const file = join(dir, "big.ndjson");
    const count = 65_536;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(wide(i));
    writeFileSync(file, parts.join(""));
    const size = statSync(file).size;
    expect(size).toBe(count * 64);

    // counts the bytes that actually leave the disk, so "seeks to size minus
    // cap, never reads the whole file" is asserted rather than commented
    let bytesRead = 0;
    const cap = 256 * 1024;
    const reclaimed = trimToTail(file, cap, (fd, buffer, offset, length, position) => {
      const read = readSync(fd, buffer, offset, length, position);
      bytesRead += Math.max(0, read);
      return read;
    });

    const kept = lines(readFileSync(file, "utf8"));
    // the window opens on a record boundary, so the first whole record after
    // it is the 4,096th from the end minus that one
    expect(kept).toHaveLength(4095);
    expect(Number(JSON.parse(kept[0]!).i)).toBe(count - 4095);
    expect(Number(JSON.parse(kept.at(-1)!).i)).toBe(count - 1);
    expect(statSync(file).size).toBeLessThanOrEqual(cap);
    expect(reclaimed).toBe(size - 4095 * 64);

    // one chunk to find the line boundary, then the kept tail — nothing like
    // the 4 MB the file holds.  The lower bound is what keeps this honest: a
    // counter that never saw a read would satisfy the upper one trivially.
    expect(bytesRead).toBeGreaterThanOrEqual(4095 * 64);
    expect(bytesRead).toBeLessThanOrEqual(cap + 64 * 1024);
    expect(bytesRead).toBeLessThan(size / 4);
  });
});

describe("stale temp files", () => {
  const tempName = (log: string, pid: number) => `${log}.${pid}.123e4567-e89b-42d3-a456-426614174000.tmp`;

  it("reaps a temp file whose writer is gone, and one too old to be in flight", () => {
    const dir = tmp();
    const dead = join(dir, tempName("t1.ndjson", 2_147_480_000));
    const old = join(dir, tempName("t2.ndjson.1", process.pid));
    const mine = join(dir, tempName("t3.ndjson", process.pid));
    for (const file of [dead, old, mine]) writeFileSync(file, "half a tail\n");
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(old, hoursAgo, hoursAgo);

    const result = sweepTranscriptLogs(dir, 1024);
    expect(result.tempRemoved).toBe(2);
    // what a killed trim was holding is reclaimed disk like any other
    expect(result.bytesReclaimed).toBe(Buffer.byteLength("half a tail\n") * 2);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(old)).toBe(false);
    // a live writer's fresh temp file is a trim in flight, not litter
    expect(existsSync(mine)).toBe(true);
    // and a temp file is never counted as a log to trim
    expect(result.scanned).toBe(0);
  });

  it("leaves a file that only looks like one alone", () => {
    const dir = tmp();
    const decoy = join(dir, "notes.tmp");
    const unowned = join(dir, "t1.ndjson.tmp");
    // a pid wider than any system assigns is not a pid this sweep wrote
    const absurd = join(dir, tempName("t2.ndjson", 123_456_789_012_345));
    for (const file of [decoy, unowned, absurd]) writeFileSync(file, "keep me\n");
    expect(sweepTranscriptLogs(dir, 1024).tempRemoved).toBe(0);
    for (const file of [decoy, unowned, absurd]) expect(existsSync(file)).toBe(true);
  });

  it("reaps a temp file whose pid is a number no process can hold", () => {
    const dir = tmp();
    // ten digits, so the name matches, but past int32 — `process.kill` answers
    // this with an argument complaint rather than ESRCH
    const beyond = join(dir, tempName("t1.ndjson", 9_999_999_999));
    writeFileSync(beyond, "half a tail\n");
    expect(() => sweepTranscriptLogs(dir, 1024)).not.toThrow();
    expect(existsSync(beyond)).toBe(false);
  });

  it("trims logs and reaps temps in the same pass", () => {
    const dir = tmp();
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(join(dir, "a.ndjson"), body);
    writeFileSync(join(dir, tempName("a.ndjson", 2_147_480_000)), "orphan\n");

    const result = sweepTranscriptLogs(dir, width * 3 + Math.floor(width / 2));
    expect(result.trimmed).toBe(1);
    expect(result.tempRemoved).toBe(1);
    expect(readdirSync(dir)).toEqual(["a.ndjson"]);
  });
});

describe("removeTranscriptLogs", () => {
  it("removes both generations and any temp file, for every thread it is given", () => {
    const dir = tmp();
    for (const name of [
      "t1.ndjson",
      "t1.ndjson.1",
      `t1.ndjson.${process.pid}.123e4567-e89b-42d3-a456-426614174000.tmp`,
      "t2.ndjson",
      "keep.ndjson",
      "keep.ndjson.1",
    ]) writeFileSync(join(dir, name), "x\n");

    expect(removeTranscriptLogs(dir, ["t1", "t2"])).toBe(4);
    expect(readdirSync(dir).sort()).toEqual(["keep.ndjson", "keep.ndjson.1"]);
  });

  it("does not mind a thread with nothing on disk, or a directory that is gone", () => {
    const dir = tmp();
    expect(removeTranscriptLogs(dir, ["never-written"])).toBe(0);
    expect(removeTranscriptLogs(join(dir, "nope"), ["t1"])).toBe(0);
  });

  it("forgets the cached size, so a thread id that comes back starts from disk", () => {
    const dir = tmp();
    const file = join(dir, "t1.ndjson");
    const width = Buffer.byteLength(record(1));
    appendBounded(file, record(1), width * 2);
    appendBounded(file, record(2), width * 2);
    removeTranscriptLogs(dir, ["t1"]);

    // with a stale counter still at two records, this append would rotate an
    // empty file instead of starting one
    appendBounded(file, record(3), width * 2);
    expect(existsSync(rotatedPath(file))).toBe(false);
    expect(ns(readFileSync(file, "utf8"))).toEqual([3]);
  });
});

describe("caps and paths", () => {
  it("names both generations of a thread's log", () => {
    expect(transcriptLogPaths("/data/native", "t-1")).toEqual([join("/data/native", "t-1.ndjson"), join("/data/native", "t-1.ndjson.1")]);
  });

  it("caps the chattier native tee higher than the normalized event stream", () => {
    expect(NATIVE_LOG_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(EVENTS_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(EVENTS_LOG_MAX_BYTES).toBeLessThan(NATIVE_LOG_MAX_BYTES);
  });
});

describe("sweepOrphanedTranscripts", () => {
  const OLD = Date.now() - ORPHAN_MAX_AGE_MS - 24 * 60 * 60 * 1000; // 8 days ago
  const RECENT = Date.now();

  function age(file: string, at: number) {
    const d = new Date(at);
    utimesSync(file, d, d);
  }

  it("removes an orphaned thread's logs, both directories and both generations, once old enough", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const files = [
      join(eventsDir, "orphan.ndjson"),
      join(eventsDir, "orphan.ndjson.1"),
      join(nativeDir, "orphan.ndjson"),
      join(nativeDir, "orphan.ndjson.1"),
    ];
    for (const file of files) {
      writeFileSync(file, "x".repeat(10));
      age(file, OLD);
    }

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set());
    expect(result).toEqual({ ids: 1, files: 4, bytesReclaimed: 40, dryRun: false });
    for (const file of files) expect(existsSync(file)).toBe(false);
  });

  it("folds a stray trim temp file into its thread's byte and file count", () => {
    // removeTranscriptLogs already deletes a thread's leftover *.tmp files
    // alongside its logs; this pins that the count and bytes this function
    // reports agree with that, rather than under-reporting whenever an
    // interrupted trim left one behind (Sentry finding on PR #599).
    const eventsDir = tmp();
    const nativeDir = tmp();
    const log = join(nativeDir, "orphan.ndjson");
    const temp = join(nativeDir, `orphan.ndjson.${process.pid}.123e4567-e89b-42d3-a456-426614174000.tmp`);
    writeFileSync(log, "x".repeat(10));
    writeFileSync(temp, "y".repeat(7));
    age(log, OLD);
    age(temp, OLD);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set());
    expect(result).toEqual({ ids: 1, files: 2, bytesReclaimed: 17, dryRun: false });
    expect(existsSync(log)).toBe(false);
    expect(existsSync(temp)).toBe(false);
  });

  it("dry run previews a stray temp file's bytes too, without touching disk", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const log = join(nativeDir, "preview2.ndjson");
    const temp = join(nativeDir, `preview2.ndjson.${process.pid}.123e4567-e89b-42d3-a456-426614174000.tmp`);
    writeFileSync(log, "a".repeat(3));
    writeFileSync(temp, "b".repeat(4));
    age(log, OLD);
    age(temp, OLD);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set(), { dryRun: true });
    expect(result).toEqual({ ids: 1, files: 2, bytesReclaimed: 7, dryRun: true });
    expect(existsSync(log)).toBe(true);
    expect(existsSync(temp)).toBe(true);
  });

  it("never deletes a file for a live id, no matter how old", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "live.ndjson");
    writeFileSync(file, "x");
    age(file, OLD);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set(["live"]));
    expect(result).toEqual({ ids: 0, files: 0, bytesReclaimed: 0, dryRun: false });
    expect(existsSync(file)).toBe(true);
  });

  it("leaves an orphaned thread alone until it is old enough", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "fresh-orphan.ndjson");
    writeFileSync(file, "x");
    age(file, RECENT);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set());
    expect(result).toEqual({ ids: 0, files: 0, bytesReclaimed: 0, dryRun: false });
    expect(existsSync(file)).toBe(true);
  });

  it("a recent write in EITHER directory keeps the whole thread out of the age check", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const oldFile = join(nativeDir, "mixed.ndjson");
    const recentFile = join(eventsDir, "mixed.ndjson");
    writeFileSync(oldFile, "x");
    age(oldFile, OLD);
    writeFileSync(recentFile, "x");
    age(recentFile, RECENT);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set());
    expect(result).toEqual({ ids: 0, files: 0, bytesReclaimed: 0, dryRun: false });
    expect(existsSync(oldFile)).toBe(true);
    expect(existsSync(recentFile)).toBe(true);
  });

  it("dry run reports exactly what a real run would do, without touching disk", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "preview.ndjson");
    writeFileSync(file, "12345");
    age(file, OLD);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set(), { dryRun: true });
    expect(result).toEqual({ ids: 1, files: 1, bytesReclaimed: 5, dryRun: true });
    expect(existsSync(file)).toBe(true);
  });

  it("ignores threads not old enough while removing the ones that are, in the same pass", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const stale = join(eventsDir, "stale.ndjson");
    const fresh = join(eventsDir, "fresh.ndjson");
    writeFileSync(stale, "x");
    age(stale, OLD);
    writeFileSync(fresh, "x");
    age(fresh, RECENT);

    const result = sweepOrphanedTranscripts({ eventsDir, nativeDir }, new Set());
    expect(result.ids).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("survives directories that do not exist", () => {
    const result = sweepOrphanedTranscripts(
      { eventsDir: join(tmp(), "nope-e"), nativeDir: join(tmp(), "nope-n") },
      new Set(),
    );
    expect(result).toEqual({ ids: 0, files: 0, bytesReclaimed: 0, dryRun: false });
  });
});

describe("describeOrphanSweep", () => {
  it("says nothing when nothing was removed", () => {
    expect(describeOrphanSweep({ ids: 0, files: 0, bytesReclaimed: 0, dryRun: false })).toBeNull();
  });

  it("reports what it removed", () => {
    expect(describeOrphanSweep({ ids: 2, files: 4, bytesReclaimed: 1234, dryRun: false })).toBe(
      "[retention] removed 4 transcript logs, 1234 bytes",
    );
  });

  it("reports what a dry run would have removed, using the singular for one file", () => {
    expect(describeOrphanSweep({ ids: 1, files: 1, bytesReclaimed: 10, dryRun: true })).toBe(
      "[retention] would remove 1 transcript log, 10 bytes",
    );
  });
});
