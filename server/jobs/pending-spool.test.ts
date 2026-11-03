import { EventEmitter } from "node:events";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { PendingCommandSpool, PENDING_PAYLOAD_MAX_BYTES, type PendingIdentity } from "./pending-spool.ts";
import { DEFAULT_JOBS_SETTINGS, JobRegistry, resolveJobsSettings, type JobRegistryDeps } from "./registry.ts";
import type { JobSpawnSpec } from "./runner.ts";

const dirs: string[] = [];
const registries: JobRegistry[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bf-pending-spool-"));
  dirs.push(root);
  const dir = join(root, "jobs");
  mkdirSync(dir, { mode: 0o700 });
  const commands: string[] = [];
  const logs: string[] = [];
  let now = 1_700_000_000_000;
  let pressure = true;
  const deps: JobRegistryDeps = {
    dir, dataDir: root, settings: () => ({ ...DEFAULT_JOBS_SETTINGS }),
    spendBlocked: () => false, broadcast: () => undefined,
    probe: { swapUsedPercent: () => 0, freeDiskBytes: () => pressure ? 1 : 100 * 1024 ** 3 },
    now: () => now, awakeNow: () => now, listProcesses: async () => [],
    spawn: (spec) => {
      commands.push(spec.command);
      // SAFETY: the fake executor's child is consumed only through EventEmitter.on for exit/error events.
      return { ok: true, pid: 2_000_000_000 + commands.length, child: new EventEmitter() as ChildProcess };
    },
    platform: "linux", log: (line) => logs.push(line),
  };
  const registry = (overrides: Partial<JobRegistryDeps> = {}) => {
    const value = new JobRegistry({ ...deps, ...overrides });
    registries.push(value);
    return value;
  };
  const start = (value: JobRegistry, command = "printf " + "private-content-".repeat(40), botId = "bot", threadId = "thread") => {
    now += 1000;
    const result = value.start({ command, cwd: root, botId, threadId, onComplete: "wake" });
    if (!result.ok) throw new Error(result.error);
    return result.job;
  };
  const path = (id: string) => join(dir, "pending-commands", `${id}.json`);
  return { root, dir, registry, start, path, commands, logs, clear: () => { pressure = false; }, advance: (ms: number) => { now += ms; } };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

it("loads through the server's actual native strip-only runtime on every platform", () => {
  const moduleUrl = new URL("./pending-spool.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`], { encoding: "utf8", timeout: 5000 });
  expect(child.status, child.stderr || child.error?.message).toBe(0);
});

describe.skipIf(process.platform === "win32")("private pending-command recovery", () => {
  it("recovers pressure waiters in FIFO order and durably claims each before its one spawn", async () => {
    const f = fixture();
    const first = f.registry();
    const a = f.start(first, "command first");
    const b = f.start(first, "command second");
    first.dispose();
    const spawned: string[] = [];
    const second = f.registry({ spawn: (spec: JobSpawnSpec) => {
      const id = spec.env.BOTFLEET_JOB_ID!;
      expect(existsSync(f.path(id))).toBe(false);
      spawned.push(spec.command);
      // SAFETY: the registry uses only the fake child's EventEmitter.on exit/error surface.
      return { ok: true, pid: 2_000_000_001, child: new EventEmitter() as ChildProcess };
    } });
    await second.adopt();
    second.drainQueue();
    expect(spawned).toEqual([]);
    f.clear();
    second.drainQueue();
    second.drainQueue();
    expect(spawned).toEqual(["command first", "command second"]);
    expect(second.get(a.id)?.status).toBe("running");
    expect(second.get(b.id)?.status).toBe("running");
    expect(readdirSync(join(f.dir, "pending-commands"))).toEqual([]);
  });

  it("never replays a crash at the claim/spawn boundary", async () => {
    const f = fixture();
    const first = f.registry({ spawn: () => { throw new Error("simulated process crash after claim"); } });
    const job = f.start(first);
    f.clear();
    expect(() => first.drainQueue()).toThrow("simulated process crash");
    expect(existsSync(f.path(job.id))).toBe(false);
    const second = f.registry();
    const result = await second.adopt();
    second.drainQueue();
    expect(result.lost).toBe(1);
    expect(second.get(job.id)?.status).toBe("lost");
    expect(f.commands).toEqual([]);
  });

  it("preserves FIFO when new work arrives before or after boot recovery", async () => {
    const f = fixture();
    const first = f.registry();
    f.start(first, "old first");
    const second = f.registry();
    f.clear();
    const early = f.start(second, "new before adoption", "b", "b");
    expect(early.status).toBe("queued");
    expect(f.commands).toEqual([]);
    await second.adopt();
    f.start(second, "new after adoption", "c", "c");
    expect(f.commands).toEqual(["old first", "new before adoption", "new after adoption"]);
  });

  it("never replays when the executor started before the running record was saved", async () => {
    const f = fixture();
    const first = f.registry({ spawn: (spec) => {
      f.commands.push(spec.command);
      throw new Error("simulated crash with an uncertain child");
    } });
    const job = f.start(first);
    f.clear();
    expect(() => first.drainQueue()).toThrow("uncertain child");
    const second = f.registry();
    await second.adopt();
    second.drainQueue();
    expect(f.commands).toHaveLength(1);
    expect(second.get(job.id)?.status).toBe("lost");
  });

  it("keeps commands private and supports Stop before and after recovery", async () => {
    const f = fixture();
    const first = f.registry();
    const command = "printf " + "private-content-".repeat(40);
    const a = f.start(first, command);
    expect(statSync(join(f.dir, "pending-commands")).mode & 0o777).toBe(0o700);
    expect(statSync(f.path(a.id)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(f.dir, "jobs.json"), "utf8")).not.toContain(command);
    expect(JSON.stringify(first.list())).not.toContain(command);
    expect(JSON.stringify(first.frameJobs("thread"))).not.toContain("pendingCommand");
    expect(f.logs.join("\n")).not.toContain(command);
    expect((await first.kill(a.id, "owner")).ok).toBe(true);
    expect(existsSync(f.path(a.id))).toBe(false);
    const b = f.start(first);
    const second = f.registry();
    await second.adopt();
    expect((await second.kill(b.id, "owner")).job?.status).toBe("killed");
    expect(existsSync(f.path(b.id))).toBe(false);
    f.clear(); second.drainQueue();
    expect(f.commands).toEqual([]);
  });

  it("expires old payloads at boot and does not wait for a periodic tick to prevent launch", async () => {
    const f = fixture();
    const first = f.registry({ queueWindowMs: 60_000 });
    const a = f.start(first);
    f.advance(61_000);
    const second = f.registry({ queueWindowMs: 60_000 });
    await second.adopt();
    expect(second.get(a.id)?.status).toBe("lost");
    expect(existsSync(f.path(a.id))).toBe(false);
    const b = f.start(second);
    f.advance(61_000); f.clear(); second.drainQueue();
    expect(second.get(b.id)?.status).toBe("lost");
    expect(existsSync(f.path(b.id))).toBe(false);
    expect(f.commands).toEqual([]);
  });

  it("rejects corrupt, identity-swapped and oversized recovery payloads without leaking them", async () => {
    for (const mode of ["malformed", "identity", "oversized", "permissions"] as const) {
      const f = fixture();
      const first = f.registry();
      const a = f.start(first);
      if (mode === "malformed") writeFileSync(f.path(a.id), "private invalid JSON");
      if (mode === "identity") {
        const value = JSON.parse(readFileSync(f.path(a.id), "utf8"));
        value.binding = "0".repeat(64);
        writeFileSync(f.path(a.id), JSON.stringify(value));
      }
      if (mode === "oversized") writeFileSync(f.path(a.id), "x".repeat(PENDING_PAYLOAD_MAX_BYTES + 1));
      if (mode === "permissions") chmodSync(f.path(a.id), 0o644);
      const second = f.registry();
      await second.adopt(); f.clear(); second.drainQueue();
      expect(second.get(a.id)?.status).toBe("lost");
      expect(existsSync(f.path(a.id))).toBe(false);
      expect(f.commands).toEqual([]);
      expect(f.logs.join("\n")).not.toContain("private invalid JSON");
    }
  });

  it("bounds the accepted queue by the existing record cap", () => {
    const f = fixture();
    const registry = f.registry({ recordMax: 2 });
    f.start(registry, "first", "a", "a");
    f.start(registry, "second", "b", "b");
    expect(registry.start({ command: "third", botId: "c", threadId: "c", cwd: f.root, onComplete: "notice" })).toMatchObject({ ok: false, error: expect.stringContaining("queue is full") });
    expect(readdirSync(join(f.dir, "pending-commands"))).toHaveLength(2);
  });
});

describe.skipIf(process.platform === "win32")("pending spool filesystem boundary", () => {
  const identity: PendingIdentity = { id: "job_1234567890", botId: "bot", threadId: "thread", origin: "botfleet", cwd: "/fixture", startedAt: 1, timeoutMs: 60000 };

  it("does not overwrite payloads, follow links, or accept path traversal", () => {
    const f = fixture();
    const spool = new PendingCommandSpool(f.dir, 2);
    spool.put(identity, "first");
    expect(() => spool.put(identity, "second")).toThrow("Private pending command storage");
    expect(spool.read(identity)).toBe("first");
    expect(() => spool.put({ ...identity, id: "../../escape" }, "secret")).toThrow("Private pending command storage");
    const outside = join(f.root, "outside");
    writeFileSync(outside, "untouched", { mode: 0o600 });
    unlinkSync(f.path(identity.id)); symlinkSync(outside, f.path(identity.id));
    expect(spool.claim(identity)).toBeNull();
    spool.reconcile(new Set());
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    linkSync(outside, f.path(identity.id));
    expect(spool.read(identity)).toBeNull();
  });

  it("rejects replaced directories and cleans orphan files and incomplete publications", () => {
    const f = fixture();
    const spool = new PendingCommandSpool(f.dir, 2);
    spool.put(identity, "first");
    writeFileSync(join(f.dir, "pending-commands", ".orphan.tmp"), "private", { mode: 0o600 });
    spool.reconcile(new Set());
    expect(readdirSync(join(f.dir, "pending-commands"))).toEqual([]);
    const path = join(f.dir, "pending-commands");
    renameSync(path, `${path}-old`);
    mkdirSync(path, { mode: 0o700 });
    expect(() => spool.put(identity, "never written")).toThrow("Private pending command storage");
    expect(() => new PendingCommandSpool(f.root, 2)).not.toThrow();
    chmodSync(path, 0o755);
    expect(() => new PendingCommandSpool(f.dir, 2)).toThrow("Private pending command storage");
  });

  it("rejects symlinked spool or jobs directories without touching the target", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(f.dir, "pending-commands"));
    expect(() => new PendingCommandSpool(f.dir, 2)).toThrow("Private pending command storage");
    const linkedJobs = join(f.root, "linked-jobs");
    symlinkSync(f.dir, linkedJobs);
    expect(() => new PendingCommandSpool(linkedJobs, 2)).toThrow("Private pending command storage");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("clamps queue wait independently of execution time", () => {
    expect(resolveJobsSettings(undefined).queueWaitMinutes).toBe(1440);
    expect(resolveJobsSettings({ queueWaitMinutes: 20000, maxMinutes: 5 })).toMatchObject({ queueWaitMinutes: 10080, maxMinutes: 5 });
    expect(resolveJobsSettings({ queueWaitMinutes: 0 }).queueWaitMinutes).toBe(1);
  });
});
