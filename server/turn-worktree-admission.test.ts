import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { ExactTurnLeases } from "./turn-safety.ts";
import {
  ActiveTurnWorktreeLeases,
  admitTurnWorktree,
  gitWorktreeLeasesEnabled,
} from "./turn-worktree-admission.ts";
import { WorktreeLeaseManager } from "./worktree-leases.ts";

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const dir of scratchDirs) {
    await removeTempDir(dir);
  }
});

function createTempDir(prefix: string): string {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const dir = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw);
  scratchDirs.push(dir);
  return dir;
}

function runGit(cwd: string, ...args: string[]): string {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
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

function initGitRepo(): string {
  const repoDir = createTempDir("bf-tw-admit-repo-");
  runGit(repoDir, "init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  runGit(repoDir, "add", "README.md");
  runGit(repoDir, "commit", "-m", "Initial commit");
  return repoDir;
}

describe("gitWorktreeLeasesEnabled", () => {
  const cfg: AppConfig = { features: { gitWorktreeLeases: true } };

  it("defaults off when neither bot nor workspace enables it", () => {
    expect(gitWorktreeLeasesEnabled({}, {})).toBe(false);
    expect(gitWorktreeLeasesEnabled({ features: {} }, {})).toBe(false);
  });

  it("honours the workspace flag and per-bot overrides", () => {
    expect(gitWorktreeLeasesEnabled(cfg, {})).toBe(true);
    expect(gitWorktreeLeasesEnabled(cfg, { gitWorktreeLeases: true })).toBe(true);
    expect(gitWorktreeLeasesEnabled(cfg, { gitWorktreeLeases: false })).toBe(false);
    expect(gitWorktreeLeasesEnabled({}, { gitWorktreeLeases: true })).toBe(true);
  });
});

describe("admitTurnWorktree", () => {
  let baseDir: string;
  let manager: WorktreeLeaseManager;

  beforeEach(() => {
    baseDir = createTempDir("bf-tw-admit-base-");
    manager = new WorktreeLeaseManager({ baseDir, exactTurnLeases: new ExactTurnLeases() });
  });

  it("keeps the shared cwd when disabled or not a project folder", async () => {
    const repo = initGitRepo();
    expect(await admitTurnWorktree({
      enabled: false,
      manager,
      botId: "b1",
      threadId: "t1",
      dispatchId: 1,
      baseCwd: repo,
    })).toMatchObject({ cwd: repo, isolated: false });

    expect(await admitTurnWorktree({
      enabled: true,
      manager,
      botId: "b1",
      threadId: "t1",
      dispatchId: 2,
      baseCwd: undefined,
    })).toMatchObject({ isolated: false });
  });

  it("isolates a git project folder into a worktree when enabled", async () => {
    const repo = initGitRepo();
    const admitted = await admitTurnWorktree({
      enabled: true,
      manager,
      botId: "b1",
      threadId: "t1",
      dispatchId: 3,
      baseCwd: repo,
    });
    expect(admitted.isolated).toBe(true);
    expect(admitted.cwd).toBe(admitted.lease?.worktreePath);
    expect(admitted.cwd).not.toBe(repo);
    expect(existsSync(admitted.cwd!)).toBe(true);
    if (admitted.lease) await manager.release(admitted.lease);
  });

  it("falls back to the shared cwd when acquire fails", async () => {
    const repo = initGitRepo();
    const broken = new WorktreeLeaseManager({
      baseDir,
      exactTurnLeases: new ExactTurnLeases(),
    });
    vi.spyOn(broken, "acquire").mockRejectedValueOnce(new Error("simulated git failure"));
    const log = vi.fn();
    const admitted = await admitTurnWorktree({
      enabled: true,
      manager: broken,
      botId: "b1",
      threadId: "t1",
      dispatchId: 4,
      baseCwd: repo,
      log,
    });
    expect(admitted).toMatchObject({ cwd: repo, isolated: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("simulated git failure"));
  });
});

describe("ActiveTurnWorktreeLeases", () => {
  let baseDir: string;
  let manager: WorktreeLeaseManager;
  let registry: ActiveTurnWorktreeLeases;
  let repo: string;

  beforeEach(() => {
    baseDir = createTempDir("bf-tw-active-base-");
    manager = new WorktreeLeaseManager({ baseDir, exactTurnLeases: new ExactTurnLeases() });
    registry = new ActiveTurnWorktreeLeases(manager);
    repo = initGitRepo();
  });

  async function holdLease(dispatchId: number) {
    const lease = await manager.acquire(repo, "bot-a", "thread-a", dispatchId);
    registry.register({ threadId: "thread-a", botId: "bot-a", dispatchId }, lease);
    return lease;
  }

  it("releases on complete, cancel, error, timeout, and boot-recovery style clearBot", async () => {
    const paths = [
      { name: "complete", release: () => registry.releaseFor({ threadId: "thread-a", botId: "bot-a", dispatchId: 10 }) },
      { name: "cancel", release: () => registry.releaseFor({ threadId: "thread-a", botId: "bot-a", dispatchId: 11 }) },
      { name: "error", release: () => registry.releaseFor({ threadId: "thread-a", botId: "bot-a", dispatchId: 12 }) },
      { name: "timeout", release: () => registry.releaseFor({ threadId: "thread-a", botId: "bot-a", dispatchId: 13 }) },
      { name: "boot recovery", release: () => registry.clearBot("bot-a") },
    ] as const;

    for (const [index, path] of paths.entries()) {
      const dispatchId = 10 + index;
      const lease = await holdLease(dispatchId);
      expect(registry.has({ threadId: "thread-a", botId: "bot-a", dispatchId })).toBe(true);
      await path.release();
      expect(registry.has({ threadId: "thread-a", botId: "bot-a", dispatchId })).toBe(false);
      expect(existsSync(lease.worktreePath)).toBe(false);
    }
  });
});
