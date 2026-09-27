import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSpendCursor,
  parseTurnSpendFromEventLog,
  RollingSpendTracker,
  saveSpendCursor,
  scanRecentSpend,
  SEVEN_DAYS_MS,
  spendCursorPath,
  type SpendCursor,
} from "./rolling-spend.ts";

describe("rolling spend calculation", () => {
  const now = 1_788_912_000_000;

  it("parses turn.completed events with valid cost and respects cutoff", () => {
    const lines = [
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - 1000).toISOString(),
        cost: 0.05,
      }),
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - SEVEN_DAYS_MS - 1000).toISOString(),
        cost: 0.1,
      }),
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - 2000).toISOString(),
        cost: 0,
      }),
      JSON.stringify({
        type: "item.completed",
        cost: 0.2,
      }),
      "not json",
    ].join("\n");

    const parsed = parseTurnSpendFromEventLog(lines, now - SEVEN_DAYS_MS);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      at: now - 1000,
      provider: "dshAgent",
      instanceId: undefined,
      costUsd: 0.05,
      billingMode: undefined,
    });
  });

  it("calculates 5h and 7d rolling spend per engine", () => {
    const tracker = new RollingSpendTracker();
    // Turn within 5 hours
    tracker.recordTurn({
      at: now - 1 * 3600 * 1000,
      provider: "claudeAgent",
      costUsd: 0.5,
    });
    // Turn within 7 days but older than 5 hours (e.g. 24h ago)
    tracker.recordTurn({
      at: now - 24 * 3600 * 1000,
      provider: "claudeAgent",
      costUsd: 1.25,
    });
    // DeepSeek turn within 5 hours
    tracker.recordTurn({
      at: now - 30 * 60 * 1000,
      provider: "deepseek",
      instanceId: "deepseekAgent",
      costUsd: 0.02,
    });

    const spend = tracker.getSpend(now);
    expect(spend.claudeAgent).toEqual({
      spend5hUsd: 0.5,
      spend7dUsd: 1.75,
    });
    // deepseek and deepseekAgent reflect the DeepSeek spend
    expect(spend.deepseek).toEqual({
      spend5hUsd: 0.02,
      spend7dUsd: 0.02,
    });
    expect(spend.deepseekAgent).toEqual({
      spend5hUsd: 0.02,
      spend7dUsd: 0.02,
    });
  });

  it("ignores estimated billing entries from actual spend totals", () => {
    const lines = [
      JSON.stringify({
        type: "turn.completed",
        provider: "claude",
        createdAt: new Date(now - 1000).toISOString(),
        cost: 0.15,
        billingMode: "estimated",
      }),
      JSON.stringify({
        type: "turn.completed",
        provider: "deepseek",
        createdAt: new Date(now - 1000).toISOString(),
        cost: 0.05,
        billingMode: "actual",
      }),
    ].join("\n");

    const parsed = parseTurnSpendFromEventLog(lines, now - SEVEN_DAYS_MS);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].provider).toBe("deepseek");
    expect(parsed[0].costUsd).toBe(0.05);

    const tracker = new RollingSpendTracker();
    tracker.recordTurn({
      at: now - 1000,
      provider: "claude",
      costUsd: 0.2,
      billingMode: "estimated",
    });
    expect(tracker.getSpend(now).claude).toBeUndefined();
  });

  it("aggregates spend from multiple provider aliases without double-counting", () => {
    const tracker = new RollingSpendTracker();
    // deepseek recorded 0.05
    tracker.recordTurn({
      at: now - 1000,
      provider: "deepseek",
      costUsd: 0.05,
    });
    // deepseekAgent recorded 0.03
    tracker.recordTurn({
      at: now - 2000,
      provider: "deepseekAgent",
      costUsd: 0.03,
    });
    // dshAgent recorded 0.10 (independent billing domain)
    tracker.recordTurn({
      at: now - 3000,
      provider: "dshAgent",
      costUsd: 0.10,
    });

    const spend = tracker.getSpend(now);
    expect(spend.deepseekAgent).toEqual({ spend5hUsd: 0.08, spend7dUsd: 0.08 });
    expect(spend.deepseek).toEqual({ spend5hUsd: 0.08, spend7dUsd: 0.08 });
    expect(spend.dshAgent).toEqual({ spend5hUsd: 0.10, spend7dUsd: 0.10 });
  });

  it("preserves precision when aggregating small fractional turns", () => {
    const tracker = new RollingSpendTracker();
    // Record three turns with $0.00004 each
    for (let i = 0; i < 3; i++) {
      tracker.recordTurn({
        at: now - 1000 * (i + 1),
        provider: "minimax",
        costUsd: 0.00004,
      });
    }
    const spend = tracker.getSpend(now);
    // 0.00004 * 3 = 0.00012 -> rounded to 0.0001
    expect(spend.minimax?.spend5hUsd).toBe(0.0001);
    expect(spend.minimax?.spend7dUsd).toBe(0.0001);
  });

  it("prunes turns older than 7 days", () => {
    const tracker = new RollingSpendTracker();
    tracker.recordTurn({
      at: now - SEVEN_DAYS_MS - 5000,
      provider: "minimax",
      costUsd: 0.1,
    });
    const spend = tracker.getSpend(now);
    expect(spend.minimax).toBeUndefined();
  });
});

// Boot used to read every events file inside the 7-day window whole, with
// readFileSync, on the main thread — a multi-second stall on a large history,
// repeated on every one of the 29 boots the owner's Mac saw in two days.  The
// scan streams now and remembers where it stopped; what these tests hold down
// is that remembering never changes a number.
describe("incremental spend scan", () => {
  const now = Date.now();
  let dir: string;
  let eventsDir: string;

  const turn = (over: { id: string; cost: number; agoMs?: number; provider?: string; instanceId?: string }) =>
    JSON.stringify({
      eventId: over.id,
      type: "turn.completed",
      ok: true,
      provider: over.provider ?? "claudeAgent",
      providerInstanceId: over.instanceId,
      threadId: "t-1",
      createdAt: new Date(now - (over.agoMs ?? 60_000)).toISOString(),
      cost: over.cost,
      billingMode: "actual",
    }) + "\n";

  const total = (entries: { costUsd: number }[]) => entries.reduce((sum, entry) => sum + entry.costUsd, 0);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "botfleet-spend-"));
    eventsDir = join(dir, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads only the bytes appended since the cursor, and totals the same as a full read", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "a", cost: 0.1 }) + turn({ id: "b", cost: 0.2 }));

    const first = await scanRecentSpend(eventsDir, { now });
    expect(first.bytesRead).toBeGreaterThan(0);
    expect(total(first.entries)).toBeCloseTo(0.3, 10);

    appendFileSync(log, turn({ id: "c", cost: 0.05 }));
    const incremental = await scanRecentSpend(eventsDir, { now, cursor: first.cursor });
    // Only the new record was read off disk — that is the whole finding.
    expect(incremental.bytesRead).toBe(Buffer.byteLength(turn({ id: "c", cost: 0.05 })));

    const full = await scanRecentSpend(eventsDir, { now });
    expect(total(incremental.entries)).toBeCloseTo(total(full.entries), 10);
    expect(incremental.entries.map((e) => e.eventId).sort()).toEqual(full.entries.map((e) => e.eventId).sort());
  });

  it("reads nothing when nothing was appended", async () => {
    writeFileSync(join(eventsDir, "t-1.ndjson"), turn({ id: "a", cost: 0.1 }));
    const first = await scanRecentSpend(eventsDir, { now });
    const second = await scanRecentSpend(eventsDir, { now, cursor: first.cursor });

    expect(second.bytesRead).toBe(0);
    expect(second.filesRead).toBe(0);
    expect(total(second.entries)).toBeCloseTo(0.1, 10);
  });

  it("follows a rotation to .ndjson.1 without counting the rotated lines twice", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "a", cost: 0.1 }) + turn({ id: "b", cost: 0.2 }));
    const first = await scanRecentSpend(eventsDir, { now });

    // Exactly what appendBounded does at the cap: the live log becomes the one
    // rotated generation (same inode) and a fresh live log starts.
    renameSync(log, `${log}.1`);
    writeFileSync(log, turn({ id: "c", cost: 0.05 }));

    const after = await scanRecentSpend(eventsDir, { now, cursor: first.cursor });
    expect(after.entries.map((e) => e.eventId).sort()).toEqual(["a", "b", "c"]);
    expect(total(after.entries)).toBeCloseTo(0.35, 10);
    // The rotated generation is resumed at the offset it already reached, so
    // only the new live file was read.
    expect(after.bytesRead).toBe(Buffer.byteLength(turn({ id: "c", cost: 0.05 })));
  });

  it("restarts at zero when a file is truncated below the recorded offset", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "a", cost: 0.1 }) + turn({ id: "b", cost: 0.2 }));
    const first = await scanRecentSpend(eventsDir, { now });

    // Same inode, smaller file: the offset now points past the end.
    writeFileSync(log, turn({ id: "c", cost: 0.05 }));
    const after = await scanRecentSpend(eventsDir, { now, cursor: first.cursor });

    expect(after.entries.map((e) => e.eventId)).toContain("c");
    expect(after.bytesRead).toBe(Buffer.byteLength(turn({ id: "c", cost: 0.05 })));
  });

  it("never resumes in the middle of a record when a line is still being appended", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    const complete = turn({ id: "a", cost: 0.1 });
    const partial = turn({ id: "b", cost: 0.2 });
    writeFileSync(log, complete + partial.slice(0, 20));

    const first = await scanRecentSpend(eventsDir, { now });
    expect(first.entries.map((e) => e.eventId)).toEqual(["a"]);

    // The rest of the torn line lands, and the next scan reads it whole.
    writeFileSync(log, complete + partial);
    const second = await scanRecentSpend(eventsDir, { now, cursor: first.cursor });
    expect(second.entries.map((e) => e.eventId).sort()).toEqual(["a", "b"]);
  });

  it("keeps entries that are not on disk any more and drops the ones outside the window", async () => {
    const cursor: SpendCursor = {
      version: 1,
      files: {},
      entries: [
        { at: now - 3_600_000, provider: "claudeAgent", costUsd: 0.4, eventId: "recent" },
        { at: now - SEVEN_DAYS_MS - 1000, provider: "claudeAgent", costUsd: 9.9, eventId: "stale" },
      ],
    };
    const scanned = await scanRecentSpend(eventsDir, { now, cursor });
    expect(scanned.entries.map((e) => e.eventId)).toEqual(["recent"]);
  });

  it("round-trips a cursor through disk and skips the re-read on the next boot", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "a", cost: 0.1 }) + turn({ id: "b", cost: 0.2 }));
    const path = spendCursorPath(eventsDir);
    expect(path).toBe(join(dir, "rolling-spend-cursor.json"));

    const first = await scanRecentSpend(eventsDir, { now });
    saveSpendCursor(path, first.cursor);
    expect(existsSync(path)).toBe(true);

    const reloaded = await loadSpendCursor(path);
    expect(reloaded).not.toBeNull();
    const second = await scanRecentSpend(eventsDir, { now, cursor: reloaded });
    expect(second.bytesRead).toBe(0);
    expect(total(second.entries)).toBeCloseTo(0.3, 10);
  });

  it("falls back to a full read when the cursor is missing or unreadable", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "a", cost: 0.1 }));
    const path = spendCursorPath(eventsDir);
    writeFileSync(path, "{not json");

    expect(await loadSpendCursor(path)).toBeNull();
    const scanned = await scanRecentSpend(eventsDir, { now, cursor: await loadSpendCursor(path) });
    expect(total(scanned.entries)).toBeCloseTo(0.1, 10);
  });

  it("gives a tracker the same spend map cold as it gives one resuming from a cursor", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(
      log,
      turn({ id: "a", cost: 0.1, agoMs: 60_000 }) +
        turn({ id: "b", cost: 0.25, agoMs: 24 * 3600 * 1000, instanceId: "claudeAgent" }) +
        turn({ id: "c", cost: 0.02, agoMs: 30 * 60_000, provider: "deepseek" }),
    );
    const cursorPath = spendCursorPath(eventsDir);

    // Boot one: no cursor, so this is the old full read.
    const cold = new RollingSpendTracker();
    await cold.init(eventsDir, { now, cursorPath });
    const coldSpend = cold.getSpend(now);
    expect(existsSync(cursorPath)).toBe(true);

    // Boot two, with more history appended between them.
    appendFileSync(log, turn({ id: "d", cost: 0.07, agoMs: 10 * 60_000 }));
    const warm = new RollingSpendTracker();
    await warm.init(eventsDir, { now, cursorPath });

    const full = new RollingSpendTracker();
    await full.init(eventsDir, { now, cursorPath: join(dir, "unused-cursor.json") });

    expect(warm.getSpend(now)).toEqual(full.getSpend(now));
    // …and the incremental boot did see the new turn the cold one predates.
    expect(warm.getSpend(now).claudeAgent.spend7dUsd).toBeGreaterThan(coldSpend.claudeAgent.spend7dUsd);
  });

  it("counts a turn once when it was recorded live and then read back out of the log", async () => {
    const log = join(eventsDir, "t-1.ndjson");
    writeFileSync(log, turn({ id: "live-1", cost: 0.5 }));

    const tracker = new RollingSpendTracker();
    // The shape of the race: the live handler banks the turn while the boot
    // scan is still walking the same file.
    tracker.recordTurn({ at: now - 60_000, provider: "claudeAgent", costUsd: 0.5, eventId: "live-1" });
    await tracker.init(eventsDir, { now, cursorPath: spendCursorPath(eventsDir) });

    expect(tracker.getSpend(now).claudeAgent.spend7dUsd).toBeCloseTo(0.5, 10);
  });

  it("does not scan twice when init is called again", async () => {
    writeFileSync(join(eventsDir, "t-1.ndjson"), turn({ id: "a", cost: 0.1 }));
    const tracker = new RollingSpendTracker();
    const cursorPath = spendCursorPath(eventsDir);
    await tracker.init(eventsDir, { now, cursorPath });
    await tracker.init(eventsDir, { now, cursorPath });
    expect(tracker.getSpend(now).claudeAgent.spend7dUsd).toBeCloseTo(0.1, 10);
  });
});
