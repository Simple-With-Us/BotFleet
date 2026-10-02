// The background job registry (jobs P1).  Real short processes where the
// behaviour is the process's (exit files, logs, kills, restart), a fake
// spawn where it is bookkeeping (caps, records, notices), and an injected
// clock for awake-time deadlines.  Every test works in its own temp folder.
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JobSnapshot, JobsFrame } from "../../shared/jobs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DEFAULT_JOBS_SETTINGS, JobRegistry, noticeLine, resolveJobsSettings, type JobRegistryDeps, type JobsSettings } from "./registry.ts";
import type { JobSpawnResult, JobSpawnSpec } from "./runner.ts";

const posix = describe.skipIf(process.platform === "win32");

interface Harness {
  registry: JobRegistry;
  dir: string;
  frames: JobsFrame[];
  finished: Array<{ job: JobSnapshot; notice: string | null; how: { row: boolean; boot: boolean } }>;
  clock: { now: number };
  /** The awake clock deadlines run on (it does not advance in a sleep). */
  awake: { now: number };
  host: { swap: number | null; disk: number | null; spend: boolean };
  settings: { value: JobsSettings };
}

const made: Harness[] = [];

/** One record of the registry's own `jobs.json`, as the tests read it back. */
interface StoredRecord {
  id: string;
  pid: number | null;
  status: string;
  notice: string;
  logPath?: string;
  [field: string]: string | number | boolean | null | undefined;
}

function stored(dir: string): StoredRecord[] {
  // SAFETY: the registry under test wrote this file itself, in this test's
  // own temp folder, as a JSON array of job records.
  return JSON.parse(readFileSync(join(dir, "jobs", "jobs.json"), "utf8")) as StoredRecord[];
}
const strays: ChildProcess[] = [];

function harness(overrides: Partial<JobRegistryDeps> = {}, dir?: string): Harness {
  const root = dir ?? mkdtempSync(join(tmpdir(), "omb-jobs-registry-"));
  const frames: JobsFrame[] = [];
  const finished: Harness["finished"] = [];
  const clock = { now: 1_700_000_000_000 };
  const awake = { now: 1_000 };
  const host: Harness["host"] = { swap: 50, disk: 100 * 1024 ** 3, spend: false };
  const settings = { value: { ...DEFAULT_JOBS_SETTINGS } };
  const registry = new JobRegistry({
    dir: join(root, "jobs"),
    dataDir: root,
    settings: () => settings.value,
    spendBlocked: () => host.spend,
    broadcast: (frame) => frames.push(frame),
    onFinished: (job, notice, how) => finished.push({ job, notice, how }),
    probe: { swapUsedPercent: () => host.swap, freeDiskBytes: () => host.disk },
    now: () => clock.now,
    awakeNow: () => awake.now,
    graceMs: 300,
    frameDebounceMs: 5,
    listProcesses: async () => [],
    // The suites that use a fake spawn are about bookkeeping, not about the
    // host they run on: a registry on Windows refuses every start, so they
    // would all fail there.  The Windows refusal has its own rows, which
    // pass `platform: "win32"` themselves.
    platform: "darwin",
    ...overrides,
  });
  const h = { registry, dir: root, frames, finished, clock, awake, host, settings };
  made.push(h);
  return h;
}

afterEach(async () => {
  for (const h of made.splice(0)) {
    for (const job of h.registry.running()) await h.registry.kill(job.id, "system");
    h.registry.dispose();
    await removeTempDir(h.dir);
  }
  for (const child of strays.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

/** A spawn that starts nothing: a child the test ends by emitting `exit`,
 *  on a pid no process can hold. */
function fakeSpawn() {
  const children: Array<{ spec: JobSpawnSpec; child: EventEmitter & { pid: number } }> = [];
  let pid = 2_000_000_000;
  const spawnFn = (spec: JobSpawnSpec): JobSpawnResult => {
    const child = Object.assign(new EventEmitter(), { pid: pid++ });
    children.push({ spec, child });
    // SAFETY: the registry reads only `on("exit" | "error")` off the child,
    // which an EventEmitter provides; nothing else of ChildProcess is used.
    return { ok: true, child: child as unknown as ChildProcess, pid: child.pid };
  };
  return { spawnFn, children };
}

const start = (h: Harness, command: string, threadId = "thread-a", botId = "bot-a", extra: { timeoutMinutes?: number } = {}) =>
  h.registry.start({ botId, threadId, command, cwd: h.dir, onComplete: "wake", ...extra });

async function until<T>(read: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("settings", () => {
  it("defaults to on, wake on, 60 minutes, at most 240", () => {
    expect(resolveJobsSettings(undefined)).toMatchObject({ enabled: true, wake: true, defaultMinutes: 60, maxMinutes: 240 });
  });
  it("lets the owner raise the ceiling, never past 6 hours", () => {
    expect(resolveJobsSettings({ maxMinutes: 300 }).maxMinutes).toBe(300);
    expect(resolveJobsSettings({ maxMinutes: 9999 }).maxMinutes).toBe(360);
    expect(resolveJobsSettings({ maxMinutes: 30, defaultMinutes: 90 }).defaultMinutes).toBe(30);
  });
  it("does not trip the default swap gate at the 90-94% this Mac sits at", () => {
    expect(resolveJobsSettings(undefined).admission.maxSwapPercent).toBeGreaterThan(95);
  });
});

// Windows refuses every job (no process groups to stop), so every block that
// starts one runs on POSIX hosts only; the refusal has its own block below.
describe("on Windows", () => {
  it("refuses with a clear message", () => {
    const h = harness({ platform: "win32", spawn: fakeSpawn().spawnFn });
    const refused = start(h, "echo hi");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("not available on Windows");
  });
});

posix("caps", () => {
  it("refuses past 3 per thread, 4 per bot and 8 per host", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    for (let i = 0; i < 3; i++) expect(start(h, `sleep ${i}`).ok).toBe(true);
    const fourthHere = start(h, "sleep 9");
    expect(fourthHere.ok).toBe(false);
    if (!fourthHere.ok) expect(fourthHere.error).toContain("already has 3 jobs running");
    expect(start(h, "sleep 9", "thread-b").ok).toBe(true);
    const fifthForBot = start(h, "sleep 9", "thread-c");
    expect(fifthForBot.ok).toBe(false);
    if (!fifthForBot.ok) expect(fifthForBot.error).toContain("4 jobs running");
    for (let i = 0; i < 4; i++) expect(start(h, "sleep 9", `thread-x${i}`, `bot-${i}`).ok).toBe(true);
    const ninth = start(h, "sleep 9", "thread-z", "bot-z");
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.error).toContain("8 background jobs");
  });

  it("refuses when jobs are switched off", () => {
    const h = harness({ spawn: fakeSpawn().spawnFn });
    h.settings.value = { ...h.settings.value, enabled: false };
    expect(start(h, "echo hi").ok).toBe(false);
  });

  it("clamps a run limit past the ceiling and says so", () => {
    const h = harness({ spawn: fakeSpawn().spawnFn });
    const started = start(h, "sleep 1", "t", "b", { timeoutMinutes: 999 });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.job.timeoutMs).toBe(240 * 60_000);
      expect(started.note).toContain("240 minutes");
    }
  });
});

posix("admission", () => {
  it("refuses on high swap, low disk, or a tripped spend ceiling — and never on load", () => {
    const h = harness({ spawn: fakeSpawn().spawnFn });
    h.host.swap = 99;
    const swap = start(h, "true");
    expect(swap.ok).toBe(false);
    if (!swap.ok) expect(swap.error).toContain("short on memory");
    h.host.swap = 94;
    expect(start(h, "true", "t2").ok).toBe(true);
    h.host.swap = null;
    h.host.disk = 100 * 1024 * 1024;
    const disk = start(h, "true", "t3");
    expect(disk.ok).toBe(false);
    if (!disk.ok) expect(disk.error).toContain("short on disk space");
    h.host.disk = null;
    h.host.spend = true;
    const spend = start(h, "true", "t4");
    expect(spend.ok).toBe(false);
    if (!spend.ok) expect(spend.error).toContain("spend ceiling");
  });
});

posix("running real processes", () => {
  it("writes the exit code atomically, logs to a 0600 file, and settles failed", async () => {
    const h = harness();
    const started = start(h, "printf 'hello from a job'; exit 2");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const ended = await until(() => h.finished.find((entry) => entry.job.id === started.job.id));
    expect(ended.job.status).toBe("failed");
    expect(ended.job.exitCode).toBe(2);
    expect(ended.how).toEqual({ row: true, boot: false });
    expect(ended.notice).toContain("failed: exit code 2");
    const jobsDir = join(h.dir, "jobs");
    expect(readFileSync(join(jobsDir, `${started.job.id}.exit`), "utf8").trim()).toBe("2");
    expect(readdirSync(jobsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const logMode = statSync(join(jobsDir, `${started.job.id}.log`)).mode & 0o777;
    expect(logMode).toBe(0o600);
    expect(h.registry.readForModel(started.job.id, 16_384)?.text).toBe("hello from a job");
    // the model's cursor moved: the second read is new output only
    expect(h.registry.readForModel(started.job.id, 16_384)?.text).toBe("");
    // the owner reads from its own position
    expect(h.registry.readForOwner(started.job.id, { limit: 1024 })?.text).toBe("hello from a job");
  });

  it("settles completed on exit 0 and runs with only the model shell environment", async () => {
    const h = harness();
    // a harness variable a job must never see
    process.env.OMB_HARNESS_ONLY_PROBE = "harness";
    let started: ReturnType<typeof start>;
    try {
      started = start(h, "printf '%s|%s' \"$BOTFLEET_JOB_ID\" \"${OMB_HARNESS_ONLY_PROBE:-unset}\"");
    } finally {
      delete process.env.OMB_HARNESS_ONLY_PROBE;
    }
    if (!started.ok) throw new Error(started.error);
    const ended = await until(() => h.finished.find((entry) => entry.job.id === started.job.id));
    expect(ended.job.status).toBe("completed");
    expect(h.registry.readForModel(started.job.id, 1024)?.text).toBe(`${started.job.id}|unset`);
  });

  it("stops the whole group on kill, and a model kill sends no notice", async () => {
    const h = harness();
    const started = start(h, "sleep 30 & sleep 30; wait");
    if (!started.ok) throw new Error(started.error);
    const pid = await until(() => stored(h.dir).find((r) => r.id === started.job.id)?.pid ?? null);
    expect(alive(pid)).toBe(true);
    const killed = await h.registry.kill(started.job.id, "model");
    expect(killed.job?.status).toBe("killed");
    expect(killed.job?.killedBy).toBe("model");
    expect(killed.job?.onComplete).toBe("none");
    expect(alive(pid)).toBe(false);
    const ended = h.finished.find((entry) => entry.job.id === started.job.id);
    expect(ended?.notice).toBeNull();
  });

  it("an owner Stop tells the bot without waking it; a timeout wakes it", async () => {
    const h = harness();
    const owner = start(h, "sleep 30");
    if (!owner.ok) throw new Error(owner.error);
    await h.registry.kill(owner.job.id, "owner");
    const ownerEnd = h.finished.find((entry) => entry.job.id === owner.job.id)!;
    expect(ownerEnd.job.onComplete).toBe("notice");
    expect(ownerEnd.notice).toContain("stopped by the owner");

    const timed = start(h, "sleep 30");
    if (!timed.ok) throw new Error(timed.error);
    await h.registry.kill(timed.job.id, "timeout", "it ran past its 60-minute limit");
    const timedEnd = h.finished.find((entry) => entry.job.id === timed.job.id)!;
    expect(timedEnd.job.onComplete).toBe("wake");
    expect(timedEnd.notice).toContain("ran past its 60-minute limit");
  });

  it("cuts a log past its cap back to the newest half, and tells the next reader", async () => {
    const h = harness({ logMaxBytes: 1000 });
    // 300 lines of "aaaaaaaaa", then END: 3004 bytes
    const started = start(h, "yes aaaaaaaaa | head -c 3000; printf 'END\\n'; sleep 30");
    if (!started.ok) throw new Error(started.error);
    const log = join(h.dir, "jobs", `${started.job.id}.log`);
    await until(() => existsSync(log) && statSync(log).size >= 3004);
    h.registry.tick();
    expect(statSync(log).size).toBeLessThanOrEqual(1000);
    const chunk = h.registry.readForModel(started.job.id, 16_384)!;
    expect(chunk.dropped).toBe(2504);
    expect(chunk.text.endsWith("END\n")).toBe(true);
    // the cut landed mid-line; the reader starts at the next whole line
    expect(chunk.text.startsWith("aaaaaaaaa\n")).toBe(true);
    expect(chunk.text.split("\n").slice(0, -2).every((line) => line === "aaaaaaaaa")).toBe(true);
  });

  it("returns at most the asked bytes, never splitting a character, and counts what is left", async () => {
    const h = harness();
    const started = start(h, "printf 'aé%.0s' $(seq 1 8000)");
    if (!started.ok) throw new Error(started.error);
    await until(() => h.finished.some((entry) => entry.job.id === started.job.id));
    const first = h.registry.readForModel(started.job.id, 16_384)!;
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(16_384);
    expect(first.text).not.toContain("�");
    expect(first.remaining).toBeGreaterThan(0);
    const second = h.registry.readForModel(started.job.id, 16_384)!;
    expect(first.text.length + second.text.length).toBe(16_000);
    expect(second.remaining).toBe(0);
  });

  it("stops what a finished command left running in its group", async () => {
    const h = harness();
    const started = start(h, "sleep 30 & echo started");
    if (!started.ok) throw new Error(started.error);
    const ended = await until(() => h.finished.find((entry) => entry.job.id === started.job.id));
    expect(ended.job.status).toBe("completed");
    const leader = stored(h.dir).find((r) => r.id === started.job.id)!.pid!;
    await until(() => {
      try {
        process.kill(-leader, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

posix("records", () => {
  it("keeps at most the record cap, dropping the oldest finished with their files, never a running job", async () => {
    const { spawnFn, children } = fakeSpawn();
    const h = harness({ spawn: spawnFn, recordMax: 3 });
    const running = start(h, "sleep 1", "keep");
    if (!running.ok) throw new Error(running.error);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.clock.now += 1000;
      const started = start(h, `job ${i}`, `t${i}`, `b${i}`);
      if (!started.ok) throw new Error(started.error);
      ids.push(started.job.id);
      writeFileSync(join(h.dir, "jobs", `${started.job.id}.log`), "x");
      children.at(-1)!.child.emit("exit", 0, null);
    }
    const kept = h.registry.list().map((job) => job.id);
    expect(kept).toHaveLength(3);
    expect(kept).toContain(running.job.id);
    expect(kept).not.toContain(ids[0]);
    expect(existsSync(join(h.dir, "jobs", `${ids[0]}.log`))).toBe(false);
    const onDisk = stored(h.dir);
    expect(onDisk).toHaveLength(3);
    // paths are derived from the id, never persisted; nor is the command
    expect(JSON.stringify(onDisk)).not.toContain("logPath");
  });

  it("drops the oldest finished logs once they pass the disk budget, and any finished job after a week", () => {
    const { spawnFn, children } = fakeSpawn();
    const h = harness({ spawn: spawnFn, logMaxBytes: 100, finishedLogBudgetBytes: 250 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      h.clock.now += 1000;
      const started = start(h, `job ${i}`, `t${i}`, `b${i}`);
      if (!started.ok) throw new Error(started.error);
      ids.push(started.job.id);
      writeFileSync(logOf(h, started.job.id), "x".repeat(100));
      children.at(-1)!.child.emit("exit", 0, null);
    }
    // 400 bytes of finished logs against a 250 byte budget: the two oldest go
    expect(h.registry.list().map((job) => job.id).sort()).toEqual([ids[2]!, ids[3]!].sort());
    expect(existsSync(logOf(h, ids[0]!))).toBe(false);
    expect(existsSync(logOf(h, ids[2]!))).toBe(true);
    // a week on, the once-a-minute check drops the rest
    h.clock.now += 7 * 24 * 3_600_000 + 1;
    h.awake.now += 60_000;
    h.registry.tick();
    expect(h.registry.list()).toEqual([]);
    expect(stored(h.dir)).toEqual([]);
    expect(existsSync(logOf(h, ids[3]!))).toBe(false);
  });

  it("broadcasts one debounced full-set frame per thread, never with output", async () => {
    const { spawnFn, children } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printf secret");
    if (!started.ok) throw new Error(started.error);
    children[0]!.child.emit("exit", 0, null);
    await until(() => h.frames.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ kind: "jobs", threadId: "thread-a" });
    expect(h.frames[0]!.jobs[0]!.status).toBe("completed");
    expect(Object.keys(h.frames[0]!.jobs[0]!)).not.toContain("output");
  });
});

posix("awake-time deadlines", () => {
  it("credits nothing for a sleep, then times the job out on awake time", async () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, tickMs: 5_000 });
    h.settings.value = { ...h.settings.value, defaultMinutes: 1 };
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    // the Mac slept for ten hours: the wall clock moved, the awake one did not
    h.clock.now += 10 * 3600_000;
    h.registry.tick();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    // five awake seconds at a time: 55 s credited, 5 to go
    for (let i = 0; i < 11; i++) {
      h.awake.now += 5_000;
      h.registry.tick();
    }
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    h.awake.now += 5_000;
    h.registry.tick();
    await until(() => h.registry.get(started.job.id)?.status === "killed");
    expect(h.registry.get(started.job.id)?.killedBy).toBe("timeout");
  });

  it("credits every awake second when a loaded Mac's ticks come late", async () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, tickMs: 5_000 });
    h.settings.value = { ...h.settings.value, defaultMinutes: 1 };
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    // the 5 s tick fired 30 s late, twice: a minute of awake time
    h.awake.now += 30_000;
    h.registry.tick();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    h.awake.now += 30_000;
    h.registry.tick();
    await until(() => h.registry.get(started.job.id)?.status === "killed");
  });

  it("caps one tick's credit, should the awake clock ever count a sleep", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, tickMs: 5_000 });
    h.settings.value = { ...h.settings.value, defaultMinutes: 2 };
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    h.awake.now += 10 * 3600_000;
    h.registry.tick();
    // a minute credited, not ten hours
    expect(h.registry.get(started.job.id)?.status).toBe("running");
  });

  it("stops a job whose bot lost its grant, on the next tick", async () => {
    const { spawnFn } = fakeSpawn();
    let reason: { reason: string; forget: boolean } | null = null;
    const h = harness({ spawn: spawnFn, stopReason: () => reason });
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    h.registry.tick();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    reason = { reason: "the bot no longer has This Computer", forget: false };
    h.registry.tick();
    await until(() => h.registry.get(started.job.id)?.status === "killed");
    expect(h.registry.get(started.job.id)).toMatchObject({ killedBy: "system", reason: "the bot no longer has This Computer" });
  });
});

posix("restart", () => {
  it("settles from an exit file, marks a vanished job lost, kills a matching leader, and wakes nobody", async () => {
    // the real clock: a leader is recognised by its real start time
    const first = harness({ now: Date.now });
    const live = start(first, "sleep 30");
    if (!live.ok) throw new Error(live.error);
    const records = stored(first.dir);
    const liveRecord = records.find((r) => r.id === live.job.id)!;
    const leader = Number(liveRecord.pid);
    // Forge two more jobs the "earlier run" left: one whose exit file says 3,
    // one with no exit file and no process.
    const settledId = "job_01JZZZZZZZZZZZZZZZZZZZZZZA";
    const vanishedId = "job_01JZZZZZZZZZZZZZZZZZZZZZZB";
    const base = { ...liveRecord, pid: 2_000_000_123, leaderExited: false, notice: "none", onComplete: "wake" };
    writeFileSync(
      join(first.dir, "jobs", "jobs.json"),
      JSON.stringify([liveRecord, { ...base, id: settledId }, { ...base, id: vanishedId }]),
    );
    writeFileSync(join(first.dir, "jobs", `${settledId}.exit`), "3\n");
    // the first harness "crashed": nothing of it settles anything again
    first.registry.dispose();
    made.splice(made.indexOf(first), 1);

    const second = harness({ now: Date.now }, first.dir);
    const result = await second.registry.adopt();
    expect(result).toEqual({ settled: 1, lost: 2 });
    expect(second.registry.get(settledId)).toMatchObject({ status: "failed", exitCode: 3, onComplete: "notice" });
    expect(second.registry.get(vanishedId)).toMatchObject({ status: "lost" });
    expect(second.registry.get(live.job.id)).toMatchObject({ status: "lost" });
    await until(() => !alive(leader));
    expect(second.finished.every((entry) => entry.how.boot)).toBe(true);
    expect(second.finished.every((entry) => entry.job.onComplete !== "wake")).toBe(true);
  });

  it("never signals a leaderless group by its number; the sweep stops only processes carrying the job's id", async () => {
    // A group whose leader exited while a child lives on — after a reboot,
    // exactly what someone else's leftover `cmd &` looks like.
    const leader = spawn("/bin/sh", ["-c", "sleep 30 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    strays.push(leader);
    let out = "";
    leader.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => leader.on("exit", resolve));
    const child = Number(out.trim());
    const pgid = leader.pid!;
    expect(alive(child)).toBe(true);

    const first = harness();
    const base = {
      botId: "bot-a",
      threadId: "thread-a",
      origin: "botfleet",
      kind: "shell",
      label: "earlier",
      cwd: first.dir,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: 1,
      endedAt: null,
      timeoutMs: 60_000,
      onComplete: "wake",
      notice: "none",
      pid: pgid,
      spawnedAt: Date.now(),
      leaderExited: false,
      modelCursor: 0,
      ownerCursor: 0,
      droppedBytes: 0,
      awakeMs: 0,
      announced: false,
    };
    const notOurs = "job_01JZZZZZZZZZZZZZZZZZZZZZZD";
    writeFileSync(join(first.dir, "jobs", "jobs.json"), JSON.stringify([{ ...base, id: notOurs }]));
    first.registry.dispose();
    made.splice(made.indexOf(first), 1);
    // nothing in the process table carries this job's id: a stranger's group
    const second = harness({ now: Date.now, listProcesses: async () => [] }, first.dir);
    expect(await second.registry.adopt()).toEqual({ settled: 0, lost: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(alive(child)).toBe(true);

    // the same group, this time carrying the job's id: ours, and stopped
    const ours = "job_01JZZZZZZZZZZZZZZZZZZZZZZE";
    writeFileSync(join(first.dir, "jobs", "jobs.json"), JSON.stringify([{ ...base, id: ours }]));
    second.registry.dispose();
    const third = harness({ now: Date.now, listProcesses: async () => [{ pid: child, pgid, jobId: ours }] }, first.dir);
    expect(await third.registry.adopt()).toEqual({ settled: 0, lost: 1 });
    await until(() => !alive(child));
  });

  it("quiesce stops every running job and marks it lost", async () => {
    const h = harness();
    const a = start(h, "sleep 30");
    const b = start(h, "sleep 30", "thread-b");
    if (!a.ok || !b.ok) throw new Error("did not start");
    expect(await h.registry.quiesce()).toBe(2);
    expect(h.registry.get(a.job.id)?.status).toBe("lost");
    expect(h.registry.get(b.job.id)?.status).toBe("lost");
  });

  it("shutdownSync SIGKILLs every group and writes them lost for the next boot", async () => {
    const h = harness();
    const started = start(h, "sleep 30");
    if (!started.ok) throw new Error(started.error);
    const pid = stored(h.dir).find((r) => r.id === started.job.id)!.pid!;
    h.registry.shutdownSync();
    await until(() => !alive(pid));
    expect(stored(h.dir).find((r) => r.id === started.job.id)).toMatchObject({ status: "lost", notice: "pending" });
  });
});

posix("the sweep", () => {
  it("stops a stray carrying the id of a finished job of ours, and nothing else", async () => {
    const { spawnFn, children } = fakeSpawn();
    const stray = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const bystander = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    strays.push(stray, bystander);
    let listed: Array<{ pid: number; pgid: number; jobId: string }> = [];
    const h = harness({ spawn: spawnFn, listProcesses: async () => listed });
    const done = start(h, "done");
    const running = start(h, "running", "thread-b");
    if (!done.ok || !running.ok) throw new Error("did not start");
    children[0]!.child.emit("exit", 0, null);
    listed = [
      { pid: stray.pid!, pgid: stray.pid!, jobId: done.job.id },
      { pid: bystander.pid!, pgid: bystander.pid!, jobId: running.job.id },
      { pid: bystander.pid!, pgid: bystander.pid!, jobId: "job_01JNOTOURSNOTOURSNOTOURS0" },
    ];
    expect(await h.registry.sweep()).toBe(1);
    await until(() => !alive(stray.pid!));
    expect(alive(bystander.pid!)).toBe(true);
  });
});

posix("the sweep's costs", () => {
  it("lists no process while no job of ours ended lately, and again once one does", async () => {
    const { spawnFn, children } = fakeSpawn();
    let listings = 0;
    const h = harness({
      spawn: spawnFn,
      listProcesses: async () => {
        listings += 1;
        return [];
      },
    });
    expect(await h.registry.sweep()).toBe(0);
    const started = start(h, "build");
    if (!started.ok) throw new Error(started.error);
    // a running job is not over: nothing of it can be a stray yet
    expect(await h.registry.sweep()).toBe(0);
    expect(listings).toBe(0);
    children[0]!.child.emit("exit", 0, null);
    await h.registry.sweep();
    expect(listings).toBe(1);
    // a day and more later it has had every sweep it needed
    h.clock.now += 25 * 3_600_000;
    await h.registry.sweep();
    expect(listings).toBe(1);
  });

  it("goes quiet again once the jobs it remembered are a week old", async () => {
    const { spawnFn, children } = fakeSpawn();
    let listings = 0;
    const h = harness({
      spawn: spawnFn,
      listProcesses: async () => {
        listings += 1;
        return [];
      },
    });
    const started = start(h, "build");
    if (!started.ok) throw new Error(started.error);
    children[0]!.child.emit("exit", 0, null);
    // a week and a day on, the once-a-minute check drops the record; nothing of
    // it is worth a listing of every process's environment
    h.clock.now += 8 * 24 * 3_600_000;
    h.awake.now += 60_000;
    h.registry.tick();
    expect(h.registry.get(started.job.id)).toBeNull();
    await h.registry.sweep();
    expect(listings).toBe(0);
  });

  it("still stops the strays of a job the record cap dropped", async () => {
    const { spawnFn, children } = fakeSpawn();
    const stray = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    strays.push(stray);
    let listed: Array<{ pid: number; pgid: number; jobId: string }> = [];
    const h = harness({ spawn: spawnFn, recordMax: 1, listProcesses: async () => listed });
    const first = start(h, "first", "thread-1");
    if (!first.ok) throw new Error(first.error);
    children[0]!.child.emit("exit", 0, null);
    h.clock.now += 1000;
    const second = start(h, "second", "thread-2");
    if (!second.ok) throw new Error(second.error);
    children[1]!.child.emit("exit", 0, null);
    expect(h.registry.get(first.job.id)).toBeNull();
    listed = [{ pid: stray.pid!, pgid: stray.pid!, jobId: first.job.id }];
    expect(await h.registry.sweep()).toBe(1);
    await until(() => !alive(stray.pid!));
  });
});

/** The log a fake-spawned job "printed": the test writes it directly. */
const logOf = (h: Harness, id: string) => join(h.dir, "jobs", `${id}.log`);

describe("reads never split a secret", () => {
  const token = `sk-proj-${"A1b2C3d4E5".repeat(4)}`;

  it("ends a full read at a line, so a token across the 16 KB boundary is redacted whole", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printer");
    if (!started.ok) throw new Error(started.error);
    // filler lines up to just before 16384, then a line whose token straddles it
    const filler = `${`${"f".repeat(99)}\n`.repeat(163)}${"f".repeat(59)}\n`; // 16360 bytes
    expect(Buffer.byteLength(`${filler}key: `)).toBeLessThan(16_384);
    expect(Buffer.byteLength(`${filler}key: ${token}`)).toBeGreaterThan(16_384);
    writeFileSync(logOf(h, started.job.id), `${filler}key: ${token}\nafter\n`);
    const first = h.registry.readForModel(started.job.id, 16_384)!;
    const second = h.registry.readForModel(started.job.id, 16_384)!;
    expect(first.text).toBe(filler);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.text + second.text).not.toContain(token.slice(0, 20));
    expect(second.text).not.toContain(token.slice(-20));
    expect(second.text).toContain("after\n");
  });

  it("ends a full read with no line break at a byte no token holds", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printer");
    if (!started.ok) throw new Error(started.error);
    // one 16 KB+ line: words, with the token across the boundary
    const words = "word ".repeat(3276); // 16380 bytes
    writeFileSync(logOf(h, started.job.id), `${words}${token} tail`);
    const first = h.registry.readForModel(started.job.id, 16_384)!;
    expect(first.text).toBe(words);
  });

  it("holds a private key back until its END marker fits in one read", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printer");
    if (!started.ok) throw new Error(started.error);
    const filler = `${"f".repeat(99)}\n`.repeat(160); // 16000 bytes
    const body = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2)}\n`.repeat(20);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
    writeFileSync(logOf(h, started.job.id), `${filler}${pem}done\n`);
    const first = h.registry.readForModel(started.job.id, 16_384)!;
    const second = h.registry.readForModel(started.job.id, 16_384)!;
    expect(first.text).toBe(filler);
    expect(second.text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(second.text).toContain("done\n");
  });

  // A private key a job prints in more than one write, with the bot reading
  // in between: no read may carry a line of its body, whatever the window.
  describe("a private key printed in more than one write", () => {
    const bodyLine = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    // Assembled, so no private-key header sits in the source for the secret
    // scanner (gitleaks' `private-key` rule) to take for a real key.
    const keyKind = "PRIVATE KEY";
    const keyHead = `-----BEGIN ${keyKind}-----\n`;
    const keyBody = (lines: number) => `${bodyLine}\n`.repeat(lines);
    const keyTail = `-----END ${keyKind}-----\n`;

    it("holds a key that opens the log until its END marker is printed", () => {
      const { spawnFn } = fakeSpawn();
      const h = harness({ spawn: spawnFn });
      const started = start(h, "printer");
      if (!started.ok) throw new Error(started.error);
      const log = logOf(h, started.job.id);
      writeFileSync(log, `${keyHead}${keyBody(5)}`);
      const first = h.registry.readForModel(started.job.id, 16_384)!;
      expect(first.text).toBe("");
      expect(first.held).toBeGreaterThan(0);
      appendFileSync(log, `${keyBody(5)}${keyTail}done\n`);
      const second = h.registry.readForModel(started.job.id, 16_384)!;
      expect(second.text).not.toContain(bodyLine);
      expect(second.text).toContain("-----END PRIVATE KEY-----");
      expect(second.text).toContain("done\n");
    });

    it("never shows the body of a key that follows other output", () => {
      const { spawnFn } = fakeSpawn();
      const h = harness({ spawn: spawnFn });
      const started = start(h, "printer");
      if (!started.ok) throw new Error(started.error);
      const log = logOf(h, started.job.id);
      writeFileSync(log, `building\n${keyHead}${keyBody(5)}`);
      const reads = [h.registry.readForModel(started.job.id, 16_384)!];
      expect(reads[0]!.text).toBe("building\n");
      reads.push(h.registry.readForModel(started.job.id, 16_384)!);
      appendFileSync(log, `${keyBody(5)}${keyTail}done\n`);
      reads.push(h.registry.readForModel(started.job.id, 16_384)!);
      expect(reads.map((read) => read.text).join("")).not.toContain(bodyLine);
      expect(reads[2]!.text).toContain("done\n");
    });

    it("masks the rest of a key longer than a read window, read by read", () => {
      const { spawnFn } = fakeSpawn();
      const h = harness({ spawn: spawnFn });
      const started = start(h, "printer");
      if (!started.ok) throw new Error(started.error);
      writeFileSync(logOf(h, started.job.id), `${keyHead}${keyBody(20)}${keyTail}done\n`);
      const texts: string[] = [];
      for (let i = 0; i < 80; i += 1) {
        const read = h.registry.readForModel(started.job.id, 200)!;
        texts.push(read.text);
        if (read.remaining === 0 && read.held === 0) break;
      }
      const all = texts.join("");
      expect(all).not.toContain(bodyLine.slice(0, 24));
      expect(all).toContain("done\n");
    });

    it("masks a view that starts inside a key, which the owner's offset can do", () => {
      const { spawnFn, children } = fakeSpawn();
      const h = harness({ spawn: spawnFn });
      const started = start(h, "printer");
      if (!started.ok) throw new Error(started.error);
      writeFileSync(logOf(h, started.job.id), `${keyHead}${keyBody(20)}${keyTail}done\n`);
      children[0]!.child.emit("exit", 0, null);
      const inside = Buffer.byteLength(keyHead) + 3 * (bodyLine.length + 1);
      const view = h.registry.readForOwner(started.job.id, { since: inside, limit: 1_000 })!;
      expect(view.text).not.toContain(bodyLine.slice(0, 24));
      const rest = h.registry.readForOwner(started.job.id, { since: inside, limit: 16_384 })!;
      expect(rest.text).toContain("-----END PRIVATE KEY-----");
      expect(rest.text).toContain("done\n");
    });
  });

  it("holds the line a running job is still printing, and says nothing is waiting", () => {
    const { spawnFn, children } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printer");
    if (!started.ok) throw new Error(started.error);
    writeFileSync(logOf(h, started.job.id), "line one\nhalf a li");
    const first = h.registry.readForModel(started.job.id, 16_384)!;
    expect(first).toMatchObject({ text: "line one\n", remaining: 0, held: 9 });
    // the job ended: nothing more will follow, so the rest goes as it is
    children[0]!.child.emit("exit", 0, null);
    const second = h.registry.readForModel(started.job.id, 16_384)!;
    expect(second).toMatchObject({ text: "half a li", remaining: 0, held: 0 });
  });

  it("starts the owner's newest-bytes view at a whole line", () => {
    const { spawnFn, children } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    const started = start(h, "printer");
    if (!started.ok) throw new Error(started.error);
    writeFileSync(logOf(h, started.job.id), `secret-line ${token}\nsecond line\nthird line\n`);
    children[0]!.child.emit("exit", 0, null);
    const view = h.registry.readForOwner(started.job.id, { limit: 40 })!;
    expect(view.text).toBe("second line\nthird line\n");
  });
});

posix("the log watch", () => {
  it("stops a job that prints faster than the flood limit, and holds its log to the cap", async () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, logMaxBytes: 1000, floodBytesPerSecond: 100_000 });
    const started = start(h, "yes");
    if (!started.ok) throw new Error(started.error);
    h.registry.checkLogs(); // the baseline
    writeFileSync(logOf(h, started.job.id), `${"y\n".repeat(150_000)}`); // 300 KB in one second
    h.awake.now += 1_000;
    h.registry.checkLogs();
    expect(statSync(logOf(h, started.job.id)).size).toBeLessThanOrEqual(1000);
    await until(() => h.registry.get(started.job.id)?.status === "killed");
    expect(h.registry.get(started.job.id)).toMatchObject({ killedBy: "limit", onComplete: "wake" });
    expect(h.registry.get(started.job.id)?.reason).toContain("MiB of output a second");
  });

  it("leaves a chatty but ordinary job alone", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, logMaxBytes: 1000, floodBytesPerSecond: 100_000 });
    const started = start(h, "build");
    if (!started.ok) throw new Error(started.error);
    h.registry.checkLogs();
    writeFileSync(logOf(h, started.job.id), "x\n".repeat(25_000)); // 50 KB over a second
    h.awake.now += 1_000;
    h.registry.checkLogs();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    expect(h.registry.readForModel(started.job.id, 16_384)!.dropped).toBeGreaterThan(0);
  });
});

posix("before boot finishes", () => {
  it("loads the earlier run's records at once, so a job started before adopt() is saved beside them and never settled by it", async () => {
    const first = harness();
    const forged = {
      id: "job_01JZZZZZZZZZZZZZZZZZZZZZZC",
      botId: "bot-a",
      threadId: "thread-a",
      origin: "botfleet",
      kind: "shell",
      label: "earlier",
      cwd: first.dir,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: 1,
      endedAt: null,
      timeoutMs: 60_000,
      onComplete: "wake",
      notice: "none",
      pid: 2_000_000_321,
      spawnedAt: 1,
      leaderExited: false,
      modelCursor: 0,
      ownerCursor: 0,
      droppedBytes: 0,
      awakeMs: 0,
      announced: false,
    };
    writeFileSync(join(first.dir, "jobs", "jobs.json"), JSON.stringify([forged]));
    first.registry.dispose();
    made.splice(made.indexOf(first), 1);

    const { spawnFn } = fakeSpawn();
    const second = harness({ spawn: spawnFn }, first.dir);
    // a routine's turn starts a job while boot is still settling
    const early = start(second, "early", "thread-b");
    if (!early.ok) throw new Error(early.error);
    expect(stored(second.dir).map((record) => record.id).sort()).toEqual([early.job.id, forged.id].sort());
    expect(await second.registry.adopt()).toEqual({ settled: 0, lost: 1 });
    expect(second.registry.get(forged.id)?.status).toBe("lost");
    expect(second.registry.get(early.job.id)?.status).toBe("running");
  });
});

describe("refusing before the ask", () => {
  it("names every refusal that does not depend on the command", () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn });
    expect(h.registry.refusal({ botId: "bot-a", threadId: "thread-a" })).toBeNull();
    for (let i = 0; i < 3; i++) start(h, `job ${i}`);
    expect(h.registry.refusal({ botId: "bot-a", threadId: "thread-a" })).toContain("3 jobs running");
    h.host.disk = 1024;
    expect(h.registry.refusal({ botId: "bot-b", threadId: "thread-b" })).toContain("short on disk space");
    expect(harness({ platform: "win32" }).registry.refusal({ botId: "bot-a", threadId: "thread-a" })).toContain("not available on Windows");
  });
});

posix("a deleted conversation's jobs", () => {
  it("are stopped, then forgotten with their logs; a stray of theirs is still swept", async () => {
    const { spawnFn, children } = fakeSpawn();
    const stray = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    strays.push(stray);
    let listed: Array<{ pid: number; pgid: number; jobId: string }> = [];
    const h = harness({ spawn: spawnFn, listProcesses: async () => listed });
    const done = start(h, "done", "thread-gone");
    const running = start(h, "running", "thread-gone");
    const kept = start(h, "kept", "thread-kept");
    if (!done.ok || !running.ok || !kept.ok) throw new Error("did not start");
    children[0]!.child.emit("exit", 0, null);
    writeFileSync(logOf(h, done.job.id), "private output\n");
    expect(await h.registry.killWhere((job) => job.threadId === "thread-gone", "its conversation was deleted", { forget: true })).toBe(1);
    expect(h.registry.get(done.job.id)).toBeNull();
    expect(h.registry.get(running.job.id)).toBeNull();
    expect(existsSync(logOf(h, done.job.id))).toBe(false);
    expect(h.registry.get(kept.job.id)?.status).toBe("running");
    expect(stored(h.dir).map((record) => record.id)).toEqual([kept.job.id]);
    listed = [{ pid: stray.pid!, pgid: stray.pid!, jobId: done.job.id }];
    expect(await h.registry.sweep()).toBe(1);
    await until(() => !alive(stray.pid!));
  });

  it("finished ones are forgotten within a minute when a route deleted the thread without stopping them", () => {
    const { spawnFn, children } = fakeSpawn();
    let gone = false;
    const h = harness({ spawn: spawnFn, stopReason: () => (gone ? { reason: "its conversation was deleted", forget: true } : null) });
    const done = start(h, "done");
    if (!done.ok) throw new Error(done.error);
    children[0]!.child.emit("exit", 0, null);
    h.registry.tick();
    expect(h.registry.get(done.job.id)).not.toBeNull();
    gone = true;
    // finished records are checked once a minute, not every tick
    h.registry.tick();
    expect(h.registry.get(done.job.id)).not.toBeNull();
    h.awake.now += 60_000;
    h.registry.tick();
    expect(h.registry.get(done.job.id)).toBeNull();
  });
});

describe("notices", () => {
  it("says how a job ended, in one line, without its output", () => {
    const base: JobSnapshot = {
      id: "job_01JABCDEFGHJKMNPQRSTVWXYZ0",
      botId: "b",
      threadId: "t",
      origin: "botfleet",
      kind: "shell",
      label: "pnpm test",
      cwd: "/tmp",
      status: "failed",
      exitCode: 1,
      signal: null,
      startedAt: 0,
      endedAt: 252_000,
      timeoutMs: 3_600_000,
      onComplete: "wake",
      notice: "pending",
    };
    expect(noticeLine(base)).toBe(
      "Background job job_01JABCDEFGHJKMNPQRSTVWXYZ0 `pnpm test` failed: exit code 1 after 4m 12s.  Read its output with job_output.",
    );
    expect(noticeLine({ ...base, status: "lost", exitCode: null, reason: "BotFleet restarted" })).toContain("was lost");
  });
});
