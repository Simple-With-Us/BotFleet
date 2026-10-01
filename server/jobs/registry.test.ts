// The background job registry (jobs P1).  Real short processes where the
// behaviour is the process's (exit files, logs, kills, restart), a fake
// spawn where it is bookkeeping (caps, records, notices), and an injected
// clock for awake-time deadlines.  Every test works in its own temp folder.
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  host: { swap: number | null; disk: number | null; spend: boolean };
  settings: { value: JobsSettings };
}

const made: Harness[] = [];
const strays: ChildProcess[] = [];

function harness(overrides: Partial<JobRegistryDeps> = {}, dir?: string): Harness {
  const root = dir ?? mkdtempSync(join(tmpdir(), "omb-jobs-registry-"));
  const frames: JobsFrame[] = [];
  const finished: Harness["finished"] = [];
  const clock = { now: 1_700_000_000_000 };
  const host = { swap: 50 as number | null, disk: 100 * 1024 ** 3 as number | null, spend: false };
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
    graceMs: 300,
    frameDebounceMs: 5,
    listProcesses: async () => [],
    ...overrides,
  });
  const h = { registry, dir: root, frames, finished, clock, host, settings };
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

describe("caps", () => {
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

  it("refuses on Windows with a clear message", () => {
    const h = harness({ platform: "win32", spawn: fakeSpawn().spawnFn });
    const refused = start(h, "echo hi");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("not available on Windows");
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

describe("admission", () => {
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
    const pid = await until(() => {
      const raw = readFileSync(join(h.dir, "jobs", "jobs.json"), "utf8");
      return (JSON.parse(raw) as Array<{ id: string; pid: number | null }>).find((r) => r.id === started.job.id)?.pid ?? null;
    });
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
    const started = start(h, "head -c 3000 /dev/zero | tr '\\0' a; printf END; sleep 30");
    if (!started.ok) throw new Error(started.error);
    const log = join(h.dir, "jobs", `${started.job.id}.log`);
    await until(() => existsSync(log) && statSync(log).size >= 3003);
    h.registry.tick();
    expect(statSync(log).size).toBeLessThanOrEqual(1000);
    const chunk = h.registry.readForModel(started.job.id, 16_384)!;
    expect(chunk.dropped).toBe(2503);
    expect(chunk.text.endsWith("END")).toBe(true);
    expect(chunk.text.length).toBe(500);
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
    const record = (JSON.parse(readFileSync(join(h.dir, "jobs", "jobs.json"), "utf8")) as Array<{ id: string; pid: number }>).find(
      (r) => r.id === started.job.id,
    )!;
    await until(() => {
      try {
        process.kill(-record.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe("records", () => {
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
    const stored = JSON.parse(readFileSync(join(h.dir, "jobs", "jobs.json"), "utf8")) as Array<{ id: string; logPath?: string }>;
    expect(stored).toHaveLength(3);
    // paths are derived from the id, never persisted; nor is the command
    expect(JSON.stringify(stored)).not.toContain("logPath");
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

describe("awake-time deadlines", () => {
  it("credits at most two ticks across a sleep, then times the job out on awake time", async () => {
    const { spawnFn } = fakeSpawn();
    const h = harness({ spawn: spawnFn, tickMs: 5_000 });
    h.settings.value = { ...h.settings.value, defaultMinutes: 1 };
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    // the Mac slept for ten hours
    h.clock.now += 10 * 3600_000;
    h.registry.tick();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    // five more awake seconds at a time: 10 s credited so far, 50 to go
    for (let i = 0; i < 9; i++) {
      h.clock.now += 5_000;
      h.registry.tick();
    }
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    h.clock.now += 5_000;
    h.registry.tick();
    await until(() => h.registry.get(started.job.id)?.status === "killed");
    expect(h.registry.get(started.job.id)?.killedBy).toBe("timeout");
  });

  it("stops a job whose bot lost its grant, on the next tick", async () => {
    const { spawnFn } = fakeSpawn();
    let reason: string | null = null;
    const h = harness({ spawn: spawnFn, stopReason: () => reason });
    const started = start(h, "sleep 9999");
    if (!started.ok) throw new Error(started.error);
    h.registry.tick();
    expect(h.registry.get(started.job.id)?.status).toBe("running");
    reason = "the bot no longer has This Computer";
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
    const records = JSON.parse(readFileSync(join(first.dir, "jobs", "jobs.json"), "utf8")) as Array<Record<string, unknown>>;
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
    const pid = (JSON.parse(readFileSync(join(h.dir, "jobs", "jobs.json"), "utf8")) as Array<{ id: string; pid: number }>).find(
      (r) => r.id === started.job.id,
    )!.pid;
    h.registry.shutdownSync();
    await until(() => !alive(pid));
    const stored = (JSON.parse(readFileSync(join(h.dir, "jobs", "jobs.json"), "utf8")) as Array<{ id: string; status: string; notice: string }>).find(
      (r) => r.id === started.job.id,
    )!;
    expect(stored).toMatchObject({ status: "lost", notice: "pending" });
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
