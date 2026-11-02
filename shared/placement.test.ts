import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_JOBS_SETTINGS, JobRegistry } from "../server/jobs/registry.ts";
import { loadHostId } from "../server/host-id.ts";
import { isJobActive, jobExitChip, type JobsFrame } from "./jobs.ts";
import { PLACEMENT_WIRE_VERSION, type PlacementIdentity } from "./placement.ts";

it("uses the same placement wire version as native enrollment independently of the product version", () => {
  const shared = JSON.parse(readFileSync(new URL("../ios/Tests/CompanionCoreTests/Fixtures/placement-wire-version.json", import.meta.url), "utf8")) as { placementWireVersion: string };
  const identity: PlacementIdentity = {
    hostId: "server:11111111-1111-4111-8111-111111111111", controllerId: "server:11111111-1111-4111-8111-111111111111",
    epoch: 0, platform: "linux", capabilities: ["shell"], version: PLACEMENT_WIRE_VERSION,
  };
  expect(identity.version).toBe(shared.placementWireVersion);
  expect(identity.version).toBe("1");
  expect(identity.version).not.toBe("0.1.0");
});

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

it("preserves a hostless queue owned by this controller rather than adopting a nonexistent local process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-hostless-queue-"));
  const controllerHostId = loadHostId(dir, "darwin");
  const queued = { ...fixture.jobs[1]!, controllerHostId, epoch: 0 };
  mkdirSync(join(dir, "jobs"));
  writeFileSync(join(dir, "jobs", "jobs.json"), JSON.stringify([{ ...queued,
    pid: null, spawnedAt: queued.startedAt, leaderExited: false, modelCursor: 0, ownerCursor: 0, droppedBytes: 0, awakeMs: 0, announced: false,
  }]));
  // An exit file is not authority to settle a job that was never dispatched.
  writeFileSync(join(dir, "jobs", `${queued.id}.exit`), "0\n");
  let spawns = 0;
  let notices = 0;
  const registry = new JobRegistry({ dir: join(dir, "jobs"), dataDir: dir, settings: () => DEFAULT_JOBS_SETTINGS,
    spendBlocked: () => false, broadcast: () => undefined, platform: "darwin", now: () => 10_000,
    probe: { swapUsedPercent: () => 0, freeDiskBytes: () => 10 ** 12 },
    spawn: () => { spawns++; return { ok: false, error: "unexpected spawn" }; }, onFinished: () => { notices++; },
  });
  try {
    expect(await registry.adopt()).toEqual({ settled: 0, lost: 0 });
    registry.tick();
    registry.checkLogs();
    expect(await registry.quiesce()).toBe(0);
    registry.shutdownSync();
    expect((await registry.kill(queued.id, "owner")).ok).toBe(false);
    expect(registry.get(queued.id)).toEqual(queued);
    expect(registry.frameJobs(queued.threadId)).toEqual([queued]);
    expect(spawns).toBe(0);
    expect(notices).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "jobs", "jobs.json"), "utf8"))[0].status).toBe("queued");
  } finally { registry.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
