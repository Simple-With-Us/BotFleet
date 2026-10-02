// What job wake turns cost (jobs P1, decision doc Risks: "Tokens per wake are
// tracked from P1"), and the job-notice channel's cleanup for a deleted bot.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { drainJobNotices, dropJobNoticesForBot, pendingJobNotices, queueJobNotice } from "../steer-queue.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { JobWakeUsage } from "./wake-usage.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("wake usage", () => {
  it("totals every wake, overall and per bot, and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wake-usage-"));
    dirs.push(dir);
    const usage = new JobWakeUsage(dir, () => 1_700_000_000_000);
    usage.record({ botId: "bot-a", inputTokens: 1200, outputTokens: 80, cachedInputTokens: 0, costUsd: 0.012 });
    usage.record({ botId: "bot-a", inputTokens: 900, outputTokens: 40, cachedInputTokens: 800, costUsd: null });
    usage.record({ botId: "bot-b", inputTokens: 100, outputTokens: 10 });
    const totals = usage.snapshot();
    expect(totals).toMatchObject({ wakes: 3, inputTokens: 2200, outputTokens: 130, cachedInputTokens: 800, pricedWakes: 1, since: 1_700_000_000_000 });
    expect(totals.costUsd).toBeCloseTo(0.012);
    expect(totals.byBot["bot-a"]).toMatchObject({ wakes: 2, inputTokens: 2100, pricedWakes: 1 });
    expect(totals.byBot["bot-b"]).toMatchObject({ wakes: 1, outputTokens: 10 });
    // 0600 (Windows has no such mode bits), and read back by the next run
    if (process.platform !== "win32") expect(statSync(join(dir, "wake-usage.json")).mode & 0o777).toBe(0o600);
    expect(new JobWakeUsage(dir).snapshot()).toEqual(totals);
    // totals only: nothing a turn said is ever kept
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "wake-usage.json"), "utf8"))).sort()).toEqual(
      ["byBot", "cachedInputTokens", "costUsd", "inputTokens", "outputTokens", "pricedWakes", "since", "wakes"],
    );
  });
});

describe("wake usage of a deleted bot", () => {
  it("loses its row, keeps what its wakes cost in the totals, and persists that", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wake-usage-"));
    dirs.push(dir);
    const usage = new JobWakeUsage(dir, () => 1_700_000_000_000);
    usage.record({ botId: "bot-gone", inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    usage.record({ botId: "bot-kept", inputTokens: 200, outputTokens: 20 });
    usage.retainBots((botId) => botId === "bot-kept");
    const totals = usage.snapshot();
    expect(Object.keys(totals.byBot)).toEqual(["bot-kept"]);
    expect(totals).toMatchObject({ wakes: 2, inputTokens: 300, pricedWakes: 1, costUsd: 0.5 });
    expect(new JobWakeUsage(dir).snapshot()).toEqual(totals);
  });
});

describe("job notices of a deleted bot", () => {
  it("are dropped from every thread, a room's included, and nobody else's are", () => {
    queueJobNotice("room-1", { jobId: "job_a", botId: "bot-gone", text: "a", wake: false });
    queueJobNotice("room-1", { jobId: "job_b", botId: "bot-kept", text: "b", wake: false });
    queueJobNotice("thread-2", { jobId: "job_c", botId: "bot-gone", text: "c", wake: true });
    dropJobNoticesForBot("bot-gone");
    expect(pendingJobNotices("room-1").map((item) => item.jobId)).toEqual(["job_b"]);
    expect(pendingJobNotices("thread-2")).toEqual([]);
    drainJobNotices("room-1");
  });
});
