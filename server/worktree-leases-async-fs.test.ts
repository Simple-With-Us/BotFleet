import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExactTurnLeases } from "./turn-safety.ts";
import { WorktreeLeaseManager } from "./worktree-leases.ts";

// The lease queue is one async chain per repository.  A synchronous mkdirSync
// or rmSync inside it runs on the main thread, so removing a worktree full of
// build output stalls every other bot, not just the next lease.  While `guard.on`
// is set, those two calls throw, so a lease task that reaches for them fails here.
// The wrappers are installed on the CommonJS object and published to the ESM
// bindings the lease module imports, so no module mock is needed.
const guard = { on: false };
const realMkdirSync = fs.mkdirSync;
const realRmSync = fs.rmSync;

beforeAll(() => {
  // SAFETY: the wrapper forwards every argument to the real function, so it has
  // the same overloads; TypeScript cannot see that through a rest parameter.
  fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
    if (guard.on) throw new Error("mkdirSync ran inside the lease queue");
    return realMkdirSync(...args);
  }) as typeof fs.mkdirSync;
  // SAFETY: same forwarding wrapper as above, for rmSync.
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
    if (guard.on) throw new Error("rmSync ran inside the lease queue");
    return realRmSync(...args);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
});

const scratchDirs: string[] = [];

afterAll(async () => {
  fs.mkdirSync = realMkdirSync;
  fs.rmSync = realRmSync;
  syncBuiltinESMExports();
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function scratch(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_SYSTEM: nullDevice,
      GIT_AUTHOR_NAME: "BotFleet Test",
      GIT_AUTHOR_EMAIL: "test@botfleet.app",
      GIT_COMMITTER_NAME: "BotFleet Test",
      GIT_COMMITTER_EMAIL: "test@botfleet.app",
    },
  });
}

async function withGuard<T>(task: () => Promise<T>): Promise<T> {
  guard.on = true;
  try {
    return await task();
  } finally {
    guard.on = false;
  }
}

describe("worktree lease queue", () => {
  it("acquires, clears a leftover directory and releases without a synchronous fs call", async () => {
    const repo = await scratch("bf-wt-async-repo-");
    git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "# Test Repo\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "Initial commit");

    const manager = new WorktreeLeaseManager({
      baseDir: await scratch("bf-wt-async-base-"),
      exactTurnLeases: new ExactTurnLeases(),
    });

    const first = await withGuard(() => manager.acquire(repo, "bot-a", "thread-a", 1));
    expect((await stat(join(first.worktreePath, "README.md"))).isFile()).toBe(true);
    await withGuard(() => manager.release(first));
    await expect(stat(first.worktreePath)).rejects.toThrow();

    // A plain directory left where the worktree goes (a crashed turn's leftovers, which git
    // does not know about) has to be cleared by the queue, without a synchronous rm.
    await mkdir(first.worktreePath, { recursive: true });
    await writeFile(join(first.worktreePath, "junk.txt"), "leftover");
    const second = await withGuard(() => manager.acquire(repo, "bot-a", "thread-a", 2));
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(await readFile(join(second.worktreePath, "README.md"), "utf8")).toContain("Test Repo");
    await expect(stat(join(second.worktreePath, "junk.txt"))).rejects.toThrow();
    await withGuard(() => manager.release(second));
  }, 60_000);
});
