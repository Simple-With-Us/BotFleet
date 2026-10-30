import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_JOBS_SETTINGS, JobRegistry } from "../server/jobs/registry.ts";
import { isJobActive, jobExitChip, type JobsFrame } from "./jobs.ts";

// Swift JobsTests decodes these exact bytes through StreamFrame as well.
const fixture = JSON.parse(readFileSync(new URL("../ios/Tests/CompanionCoreTests/Fixtures/jobs-placement.json", import.meta.url), "utf8")) as JobsFrame;

it("retains legacy and placed jobs through the persisted schema, snapshot and SSE frame", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-placement-contract-"));
  let spawns = 0;
  mkdirSync(join(dir, "jobs"));
  writeFileSync(join(dir, "jobs", "jobs.json"), JSON.stringify(fixture.jobs.map((job) => ({
    ...job, pid: null, spawnedAt: job.startedAt, leaderExited: false, modelCursor: 0, ownerCursor: 0, droppedBytes: 0, awakeMs: 0, announced: false,
  }))));
  const registry = new JobRegistry({
    dir: join(dir, "jobs"), dataDir: dir, settings: () => DEFAULT_JOBS_SETTINGS, spendBlocked: () => false, broadcast: () => undefined,
    now: () => 10_000, platform: "darwin", probe: { swapUsedPercent: () => 0, freeDiskBytes: () => 10 ** 12 },
    spawn: () => { spawns++; return { ok: false, error: "unexpected spawn" }; },
  });
  try {
    for (const job of fixture.jobs) expect(registry.get(job.id)).toEqual(job);
    expect(registry.frameJobs(fixture.threadId).map((job) => job.id).sort()).toEqual(fixture.jobs.map((job) => job.id).sort());
    expect(await registry.adopt()).toEqual({ settled: 0, lost: 0 });
    registry.tick();
    expect(await registry.quiesce()).toBe(0);
    registry.shutdownSync();
    for (const job of fixture.jobs) expect(registry.get(job.id)).toEqual(job);
    for (const job of fixture.jobs.filter(isJobActive)) {
      expect((await registry.kill(job.id, "owner")).ok).toBe(false);
      expect(registry.get(job.id)).toEqual(job);
    }
    expect(spawns).toBe(0);
    const stored = JSON.parse(readFileSync(join(dir, "jobs", "jobs.json"), "utf8"));
    expect(stored.find((job: { id: string }) => job.id === fixture.jobs[4]!.id).epoch).toBe(0);
  } finally { registry.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the placement states active and labels them without implying completion", () => {
  expect(fixture.jobs.map(isJobActive)).toEqual([false, true, true, true, false]);
  expect(fixture.jobs.map(jobExitChip)).toEqual(["Exited 0", "Queued", "Dispatching", "Worker unreachable", "Exited 0"]);
});
