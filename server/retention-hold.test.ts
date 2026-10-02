// The sweeps that delete "orphaned" data treat every bot and room missing from
// the roster as deleted, and remove its workspace (14 days), transcripts (7
// days) and message rows once it is old enough.  While the real roster sits in
// a set-aside file, an empty roster is not evidence of anything, and those
// sweeps would turn a recoverable incident into permanent loss.  They are held
// for as long as a set-aside bots.json or groups.json is waiting in the data
// folder, which is read from disk on every run so a restart does not forget.
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupHoldReason } from "./data-faults.ts";
import { ORPHAN_MAX_AGE_MS, startOrphanTranscriptSweeps } from "./transcript-retention.ts";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-retention-hold-"));
  dirs.push(dir);
  return dir;
};

describe("the orphan transcript sweep while the roster is on hold", () => {
  let eventsDir: string;
  let nativeDir: string;
  let log: string;

  beforeEach(() => {
    eventsDir = tmp();
    nativeDir = tmp();
    log = join(eventsDir, "orphan.ndjson");
    writeFileSync(log, "x".repeat(10));
    const old = new Date(Date.now() - ORPHAN_MAX_AGE_MS - 24 * 60 * 60 * 1000);
    utimesSync(log, old, old);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("removes an old orphan when nothing holds the sweep", () => {
    const lines: string[] = [];
    const stop = startOrphanTranscriptSweeps({ eventsDir, nativeDir }, () => [], (line) => lines.push(line), {
      initialDelayMs: 10,
      hold: () => null,
    });
    vi.advanceTimersByTime(20);
    stop();
    expect(existsSync(log)).toBe(false);
    expect(lines.join("\n")).toContain("removed 1 transcript log");
  });

  it("leaves it alone and says why while the sweep is held", () => {
    const lines: string[] = [];
    const stop = startOrphanTranscriptSweeps({ eventsDir, nativeDir }, () => [], (line) => lines.push(line), {
      initialDelayMs: 10,
      hold: () => "bots.json.corrupt-1790000000000 is waiting to be restored or removed",
    });
    vi.advanceTimersByTime(20);
    stop();
    expect(existsSync(log)).toBe(true);
    expect(lines).toEqual([
      "[retention] orphan transcript sweep skipped: bots.json.corrupt-1790000000000 is waiting to be restored or removed.",
    ]);
  });

  it("asks again on every run, so lifting the hold lets the next daily run proceed", () => {
    let held: string | null = "waiting";
    const stop = startOrphanTranscriptSweeps({ eventsDir, nativeDir }, () => [], () => {}, {
      initialDelayMs: 10,
      hold: () => held,
    });
    vi.advanceTimersByTime(20);
    expect(existsSync(log)).toBe(true);
    held = null;
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 20);
    stop();
    expect(existsSync(log)).toBe(false);
  });

  it("is driven by a set-aside file on disk, not by anything in memory", () => {
    const dataDir = tmp();
    expect(cleanupHoldReason(dataDir)).toBeNull();
    writeFileSync(join(dataDir, "bots.json.corrupt-1790000000000"), "x");
    const stop = startOrphanTranscriptSweeps({ eventsDir, nativeDir }, () => [], () => {}, {
      initialDelayMs: 10,
      hold: () => cleanupHoldReason(dataDir),
    });
    vi.advanceTimersByTime(20);
    stop();
    expect(existsSync(log)).toBe(true);
  });
});
