// HTTP-lane `bash` runs every command in a process group of its own and stops
// the whole group (jobs P0).  These tests start REAL process trees — a shell
// with background `sleep` children that write their pids to a file — because
// the bug was exactly that a stopped shell left its children running.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TurnToolRuntime } from "../contracts.ts";
import type { AgentToolCallContext } from "./agents.ts";
import { createComputerTools } from "./computer.ts";
import { commandLabel, groupAlive, killGroup, TurnProcessGroups } from "./process-group.ts";

const identity: AgentToolCallContext = { botId: "bot-1", threadId: "thread-1", commsDepth: 0 };

const runtime = (signal: AbortSignal = new AbortController().signal): TurnToolRuntime => ({
  signal,
  requestApproval: async () => "allowed-once",
});

/** Whether a pid still names a live process (a zombie counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

async function until(predicate: () => boolean, timeoutMs = 8_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const pidsIn = (path: string): number[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
    : [];

describe.skipIf(process.platform === "win32")("bash process groups (real process trees)", () => {
  let scratch: string;
  let groups: TurnProcessGroups;
  const started: number[] = [];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "bf-pgroup-test-"));
    groups = new TurnProcessGroups(300);
  });

  afterEach(async () => {
    // never leave a sleeper behind, whatever the test did
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await groups.reap();
    rmSync(scratch, { recursive: true, force: true });
  });

  const tools = (over: { bashTimeoutMs?: number } = {}) =>
    createComputerTools({ cwd: scratch, processGroups: groups, groupKillGraceMs: 300, ...over });

  it("stops every process a timed-out command started, not just the shell", async () => {
    const pids = join(scratch, "pids");
    const result = await tools({ bashTimeoutMs: 600 }).bash(
      { id: "c1", name: "bash", arguments: { command: `sleep 30 & echo $! > ${pids}; sleep 30 & echo $! >> ${pids}; wait` } },
      identity,
      runtime(),
    );
    expect(result).toMatchObject({ kind: "error", detail: "timeout" });
    expect(result.content).toContain("every process it started");
    const children = pidsIn(pids);
    started.push(...children);
    expect(children).toHaveLength(2);
    await until(() => children.every((pid) => !alive(pid)), 8_000, "the shell's children to be stopped");
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const pids = join(scratch, "pids");
    const result = await tools({ bashTimeoutMs: 600 }).bash(
      { id: "c2", name: "bash", arguments: { command: `trap '' TERM; sleep 30 & echo $! > ${pids}; wait` } },
      identity,
      runtime(),
    );
    expect(result).toMatchObject({ kind: "error", detail: "timeout" });
    const children = pidsIn(pids);
    started.push(...children);
    expect(children).toHaveLength(1);
    await until(() => !alive(children[0]), 8_000, "the TERM-ignoring child to be killed");
  });

  it("stops the whole group when the turn is interrupted", async () => {
    const pids = join(scratch, "pids");
    const abort = new AbortController();
    const pending = tools().bash(
      { id: "c3", name: "bash", arguments: { command: `sleep 30 & echo $! > ${pids}; wait` } },
      identity,
      runtime(abort.signal),
    );
    await until(() => pidsIn(pids).length === 1, 8_000, "the child to start");
    const [child] = pidsIn(pids);
    started.push(child);
    abort.abort();
    expect(await pending).toMatchObject({ kind: "error", detail: "stopped" });
    await until(() => !alive(child), 8_000, "the interrupted child to be stopped");
  });

  it("answers as soon as the shell exits, and the turn's settle stops what it left running", async () => {
    const pids = join(scratch, "pids");
    const startedAt = Date.now();
    // the child inherits the shell's stdout, so the pipe stays open after the shell is gone
    const command = `sleep 30 & echo $! > ${pids}; echo started`;
    const result = await tools().bash({ id: "c4", name: "bash", arguments: { command } }, identity, runtime());
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.kind).toBe("result");
    expect(result.content).toContain("started");
    expect(result.content).toContain("will be stopped when this turn ends");
    const [child] = pidsIn(pids);
    started.push(child);
    expect(alive(child)).toBe(true);
    expect(groups.size).toBe(1);

    // the lost-job detector, as the tool host runs it at turn settle
    expect(await groups.reap()).toEqual([commandLabel(command)]);
    await until(() => !alive(child), 8_000, "the lost job to be stopped");
    expect(groups.size).toBe(0);
  });

  it("also catches a background process that let go of the shell's pipes", async () => {
    const pids = join(scratch, "pids");
    const result = await tools().bash(
      { id: "c5", name: "bash", arguments: { command: `sleep 30 > /dev/null 2>&1 & echo $! > ${pids}` } },
      identity,
      runtime(),
    );
    expect(result.kind).toBe("result");
    expect(result.content).toContain("still running");
    const [child] = pidsIn(pids);
    started.push(child);
    await groups.reap();
    await until(() => !alive(child), 8_000, "the detached child to be stopped");
  });

  it("forgets a command whose processes all exited, and reaps nothing", async () => {
    const result = await tools().bash({ id: "c6", name: "bash", arguments: { command: "echo done" } }, identity, runtime());
    expect(result).toEqual({ kind: "result", content: "done" });
    expect(groups.size).toBe(0);
    expect(await groups.reap()).toEqual([]);
  });

  it("keeps an exit code and the output printed before it", async () => {
    const result = await tools().bash(
      { id: "c7", name: "bash", arguments: { command: "echo partial; echo oops >&2; exit 3" } },
      identity,
      runtime(),
    );
    expect(result).toMatchObject({ kind: "error", detail: "exit 3" });
    expect(result.content).toContain("partial");
    expect(result.content).toContain("STDERR:\noops");
    expect(result.content).toContain("Process exited with code 3");
  });

  it("killGroup and groupAlive address the group, not a single pid", async () => {
    const pids = join(scratch, "pids");
    const pending = tools({ bashTimeoutMs: 30_000 }).bash(
      { id: "c8", name: "bash", arguments: { command: `sleep 30 & echo $! > ${pids}; echo $$ >> ${pids}; wait` } },
      identity,
      runtime(),
    );
    await until(() => pidsIn(pids).length === 2, 8_000, "the shell and its child to start");
    const [child, shell] = pidsIn(pids);
    started.push(child, shell);
    expect(groupAlive(shell)).toBe(true);
    await killGroup(shell, 300);
    await until(() => !alive(child) && !alive(shell), 8_000, "the group to be gone");
    expect(groupAlive(shell)).toBe(false);
    // the shell died of the group's SIGTERM: a signal, not an exit code
    expect((await pending).kind).toBe("error");
  });
});

describe("commandLabel", () => {
  it("masks secrets and keeps one short line", () => {
    const label = commandLabel(`curl -H "Authorization: Bearer sk-ant-api03-${"x".repeat(40)}"\n  https://example.com`);
    expect(label).not.toContain("x".repeat(40));
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(80);
  });
});
