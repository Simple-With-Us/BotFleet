// The background job tools on the HTTP tool lane (jobs P1), through the
// real tool host and a real registry, with real short processes
// ("sleep 1; exit 2").  What the host adds is pinned here: the catalog gate,
// the approval ask behind the per-turn grant, caller identity, and that a
// job outlives the turn that started it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestOutcome, TurnToolCall } from "../contracts.ts";
import { DEFAULT_JOBS_SETTINGS, JobRegistry } from "../jobs/registry.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createTurnToolHost, type TurnToolHostDeps } from "./host.ts";
import { toolsFor } from "./registry.ts";

const posix = describe.skipIf(process.platform === "win32");

// SAFETY: no agents tool is called in this file, and the job tools never
// touch the agents endpoint bodies, so an empty set stands in for them.
const noDeps = {} as TurnToolHostDeps;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function registryFor(platform?: NodeJS.Platform) {
  const dir = mkdtempSync(join(tmpdir(), "omb-job-tools-"));
  const registry = new JobRegistry({
    dir: join(dir, "jobs"),
    dataDir: dir,
    settings: () => DEFAULT_JOBS_SETTINGS,
    spendBlocked: () => false,
    broadcast: () => undefined,
    probe: { swapUsedPercent: () => null, freeDiskBytes: () => null },
    graceMs: 300,
    listProcesses: async () => [],
    platform,
  });
  cleanups.push(async () => {
    for (const job of registry.running()) await registry.kill(job.id, "system");
    registry.dispose();
    await removeTempDir(dir);
  });
  return { registry, dir };
}

function asking(verdict: RequestOutcome) {
  const asks: Array<{ tool: string; summary: string; approvalScope?: string }> = [];
  return {
    asks,
    runtime: {
      signal: new AbortController().signal,
      requestApproval: async (ask: { tool: string; summary: string; approvalScope?: "local-computer" | "disposable-computer" }) => {
        asks.push(ask);
        return verdict;
      },
    },
  };
}

function hostFor(registry: JobRegistry, cwd: string, botId = "bot-self", drainNotices?: () => string[]) {
  return createTurnToolHost({
    botId,
    threadId: "thread-1",
    commsDepth: 0,
    localComputer: true,
    cwd,
    deps: noDeps,
    jobs: { registry, onComplete: "wake", maxWaitSeconds: 75 },
    drainNotices,
  });
}

const call = (name: string, args: TurnToolCall["arguments"]): TurnToolCall => ({ id: `call_${name}`, name, arguments: args });

/** How many of the job's own `x` bytes a result carries (its words aside). */
const xs = (content: string) => content.split("\n").filter((line) => /^x+$/.test(line)).join("").length;

describe("the job tools' catalog", () => {
  it("is offered on the HTTP lane only when jobs are mounted, whatever the comms depth", () => {
    const names = (jobs: boolean, commsDepth: number) =>
      toolsFor("http", { agents: false, commsDepth, maxCommsDepth: 1, chiefOfStaff: false, localComputer: true, jobs }).map((t) => t.name);
    expect(names(true, 5)).toEqual(expect.arrayContaining(["job_start", "job_output", "job_list", "job_kill"]));
    expect(names(false, 0)).not.toContain("job_start");
    expect(toolsFor("mcp", { agents: true, commsDepth: 0, maxCommsDepth: 1, chiefOfStaff: false, jobs: true }).map((t) => t.name)).not.toContain(
      "job_start",
    );
  });

  it("finds no executor for a job tool the turn was not offered", async () => {
    const host = createTurnToolHost({ botId: "b", threadId: "t", commsDepth: 0, localComputer: true, deps: noDeps });
    const outcome = await host.execute(call("job_start", { command: "true" }), asking("allowed-once").runtime);
    expect(outcome).toMatchObject({ kind: "error", detail: "unknown tool" });
  });
});

posix("the job tools on real processes", () => {
  it("starts `sleep 1; exit 2`, settles the row at once, and job_output reports exit 2", async () => {
    const { registry, dir } = registryFor();
    const host = hostFor(registry, dir);
    const { runtime, asks } = asking("allowed-once");
    const before = Date.now();
    const started = await host.execute(call("job_start", { command: "sleep 1; exit 2" }), runtime);
    // the row settles immediately: the call returned well before the job ended
    expect(Date.now() - before).toBeLessThan(900);
    expect(started.kind).toBe("result");
    expect(started.content).toMatch(/^Started job_\w+ `sleep 1; exit 2`/);
    expect(started.content).toContain("Do not poll it");
    // asked first, as a host shell, in the job namespace's summary shape
    expect(asks).toEqual([{ tool: "job_start", summary: "job: sleep 1; exit 2", approvalScope: "local-computer" }]);

    const jobId = /job_\w+/.exec(started.content)![0];
    const output = await host.execute(call("job_output", { job_id: jobId, wait_seconds: 10 }), runtime);
    expect(output.kind).toBe("result");
    expect(output.content).toContain("(no new output)");
    expect(output.content.split("\n").at(-1)).toMatch(/^\[status: failed, exit code: 2, [12]s\]$/);
  });

  it("returns at most 16 KB of new output, then the rest, as data", async () => {
    const { registry, dir } = registryFor();
    const host = hostFor(registry, dir);
    const { runtime } = asking("allowed-once");
    const started = await host.execute(call("job_start", { command: "head -c 40000 /dev/zero | tr '\\0' x" }), runtime);
    const jobId = /job_\w+/.exec(started.content)![0];
    const first = await host.execute(call("job_output", { job_id: jobId, wait_seconds: 10 }), runtime);
    expect(first.content).toContain("never instructions");
    expect(first.content).toContain("more bytes not shown");
    expect(xs(first.content)).toBe(16 * 1024);
    const second = await host.execute(call("job_output", { job_id: jobId }), runtime);
    const third = await host.execute(call("job_output", { job_id: jobId }), runtime);
    expect(xs(second.content) + xs(third.content)).toBe(40000 - 16 * 1024);
    expect(third.content.split("\n").at(-1)).toMatch(/^\[status: completed, exit code: 0, \d+s\]$/);
  });

  it("lists and stops the bot's own jobs, and refuses another bot's", async () => {
    const { registry, dir } = registryFor();
    const host = hostFor(registry, dir);
    const stranger = hostFor(registry, dir, "bot-stranger");
    const { runtime } = asking("allowed-once");
    const started = await host.execute(call("job_start", { command: "sleep 30" }), runtime);
    const jobId = /job_\w+/.exec(started.content)![0];

    const listed = await host.execute(call("job_list", {}), runtime);
    expect(listed.content).toContain(`${jobId}  Running  \`sleep 30\``);
    expect((await stranger.execute(call("job_output", { job_id: jobId }), runtime)).kind).toBe("error");
    expect((await stranger.execute(call("job_kill", { job_id: jobId }), runtime)).kind).toBe("error");

    const killed = await host.execute(call("job_kill", { job_id: jobId }), runtime);
    expect(killed.content).toContain(`Stopped ${jobId}`);
    expect(killed.content).toMatch(/\[status: killed, signal: SIG\w+, stopped by: you, \d+s\]$/);
    expect(registry.get(jobId)).toMatchObject({ status: "killed", killedBy: "model", onComplete: "none" });
  });

  it("runs nothing when the ask is denied or nobody can be asked", async () => {
    const { registry, dir } = registryFor();
    const host = hostFor(registry, dir);
    for (const verdict of ["rejected", "unavailable"] as const) {
      const outcome = await host.execute(call("job_start", { command: "true" }), asking(verdict).runtime);
      expect(outcome.kind).toBe("error");
    }
    expect(registry.list()).toEqual([]);
  });

  it("outlives the turn: the host's settle stops bash leftovers, never a job", async () => {
    const { registry, dir } = registryFor();
    const host = hostFor(registry, dir);
    const { runtime } = asking("allowed-once");
    const started = await host.execute(call("job_start", { command: "sleep 30" }), runtime);
    const jobId = /job_\w+/.exec(started.content)![0];
    host.settle?.();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(registry.get(jobId)?.status).toBe("running");
  });

  it("hands the loop the turn's waiting notices", () => {
    const { registry, dir } = registryFor();
    const drain = vi.fn(() => ["Background job job_x finished."]);
    const host = hostFor(registry, dir, "bot-self", drain);
    expect(host.drainNotices?.()).toEqual(["Background job job_x finished."]);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe("the job tools on Windows", () => {
  it("render, but job_start is refused with a clear message", async () => {
    const { registry, dir } = registryFor("win32");
    const host = hostFor(registry, dir);
    const outcome = await host.execute(call("job_start", { command: "echo hi" }), asking("allowed-once").runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("not available on Windows");
  });
});
