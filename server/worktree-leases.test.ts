import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { ExactTurnLeases } from "./turn-safety.ts";
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
  const repoDir = createTempDir("bf-wt-repo-");
  runGit(repoDir, "init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\nInitial content\n");
  runGit(repoDir, "add", "README.md");
  runGit(repoDir, "commit", "-m", "Initial commit");
  return repoDir;
}

describe("WorktreeLeaseManager", () => {
  let baseDir: string;
  let exactTurnLeases: ExactTurnLeases;
  let manager: WorktreeLeaseManager;
  let repoDir: string;

  beforeEach(() => {
    baseDir = createTempDir("bf-wt-base-");
    exactTurnLeases = new ExactTurnLeases();
    manager = new WorktreeLeaseManager({ baseDir, exactTurnLeases });
    repoDir = initGitRepo();
  });

  it("detects Git repositories and resolves their real root", async () => {
    expect(await manager.isGitRepo(repoDir)).toBe(true);

    const subDir = join(repoDir, "src", "sub");
    mkdirSync(subDir, { recursive: true });
    expect(await manager.isGitRepo(subDir)).toBe(true);

    const resolved = await manager.resolveRepoRoot(subDir);
    expect(resolved).toBe(repoDir);

    const nonGitDir = createTempDir("bf-wt-nongit-");
    expect(await manager.isGitRepo(nonGitDir)).toBe(false);
    await expect(manager.resolveRepoRoot(nonGitDir)).rejects.toThrow(
      /not inside a Git repository/i,
    );
  });

  it("acquires an isolated worktree on a unique branch with HEAD commit", async () => {
    const lease = await manager.acquire(repoDir, "bot-1", "thread-1", 101);

    expect(lease).toBeDefined();
    expect(lease.repoRoot).toBe(repoDir);
    expect(lease.branch).toBe("botfleet/bot-1/thread-1");
    expect(lease.targetKey).toMatch(/^worktree:[a-f0-9]+:bot-1:thread-1$/);
    expect(existsSync(lease.worktreePath)).toBe(true);
    expect(existsSync(join(lease.worktreePath, "README.md"))).toBe(true);

    // Verify git branch in worktree
    const currentBranch = runGit(lease.worktreePath, "symbolic-ref", "--short", "HEAD").trim();
    expect(currentBranch).toBe("botfleet/bot-1/thread-1");

    // Verify exactTurnLease was registered
    expect(exactTurnLeases.hasTarget(lease.targetKey)).toBe(true);
    expect(exactTurnLeases.hasBot("bot-1")).toBe(true);
    expect(manager.activeLeaseCount).toBe(1);

    // Clean up
    await manager.release(lease);
    expect(existsSync(lease.worktreePath)).toBe(false);
    expect(exactTurnLeases.hasTarget(lease.targetKey)).toBe(false);
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("prevents conflicting concurrent claims on the same target key", async () => {
    const first = await manager.acquire(repoDir, "bot-a", "thread-1", 1);
    expect(first).toBeDefined();

    // A second claim with a DIFFERENT bot attempting to hold the same occupancy key is refused
    // Let's verify via exactTurnLeases
    const collisionAttempt = exactTurnLeases.claim("bot-b", "thread-1", 2, first.targetKey);
    expect(collisionAttempt).toBeNull();

    await manager.release(first);
  });

  it("allows two concurrent bots to work on the same repository with distinct worktree leases", async () => {
    const leaseA = await manager.acquire(repoDir, "bot-alpha", "thread-a", 10);
    const leaseB = await manager.acquire(repoDir, "bot-beta", "thread-b", 20);

    expect(leaseA.worktreePath).not.toBe(leaseB.worktreePath);
    expect(leaseA.branch).not.toBe(leaseB.branch);
    expect(existsSync(leaseA.worktreePath)).toBe(true);
    expect(existsSync(leaseB.worktreePath)).toBe(true);
    expect(manager.activeLeaseCount).toBe(2);

    // Bot A writes a change and commits in its isolated worktree
    writeFileSync(join(leaseA.worktreePath, "alpha.txt"), "bot alpha work");
    runGit(leaseA.worktreePath, "add", "alpha.txt");
    runGit(leaseA.worktreePath, "commit", "-m", "Alpha commit");

    // Bot B writes a different change in its isolated worktree without collision
    writeFileSync(join(leaseB.worktreePath, "beta.txt"), "bot beta work");
    runGit(leaseB.worktreePath, "add", "beta.txt");
    runGit(leaseB.worktreePath, "commit", "-m", "Beta commit");

    // Main repo index is untouched
    expect(existsSync(join(repoDir, "alpha.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "beta.txt"))).toBe(false);

    // Release both cleanly
    await manager.release(leaseA);
    await manager.release(leaseB);
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("supports keepWorktree option to retain the working tree directory", async () => {
    const lease = await manager.acquire(repoDir, "bot-keep", "thread-keep", 30);
    expect(existsSync(lease.worktreePath)).toBe(true);

    await manager.release(lease, { keepWorktree: true });
    // Directory should still exist on disk
    expect(existsSync(lease.worktreePath)).toBe(true);
    // But turn lease is freed
    expect(exactTurnLeases.hasTarget(lease.targetKey)).toBe(false);
    expect(manager.activeLeaseCount).toBe(0);
  });

  it("recovers cleanly from leftover or crashed worktree paths", async () => {
    // Acquire a lease and simulate a crash leaving the directory on disk
    const lease = await manager.acquire(repoDir, "bot-crash", "thread-crash", 40);
    const stalePath = lease.worktreePath;
    expect(existsSync(stalePath)).toBe(true);

    // Free the lease in memory without calling git worktree remove
    exactTurnLeases.clearBot("bot-crash");

    // Now re-acquire for the same bot and thread: should clean up stale path and succeed
    const recovered = await manager.acquire(repoDir, "bot-crash", "thread-crash", 41);
    expect(recovered).toBeDefined();
    expect(recovered.worktreePath).toBe(stalePath);
    expect(existsSync(recovered.worktreePath)).toBe(true);

    await manager.release(recovered);
  });

  it("stops automatic deletion of stale worktrees without confirmed workflow", async () => {
    const lease = await manager.acquire(repoDir, "bot-stale", "thread-stale", 50);
    const worktreePath = lease.worktreePath;

    // Release with keepWorktree so the directory remains on disk
    await manager.release(lease, { keepWorktree: true });
    expect(existsSync(worktreePath)).toBe(true);

    // Prune with maxAgeMs = 0 skips automatic deletion
    const result = await manager.pruneStaleWorktrees(0);
    expect(result.pruned).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("refuses unconfirmed branch deletion during release, before the worktree is touched", async () => {
    const lease = await manager.acquire(repoDir, "bot-del", "thread-del", 60);
    writeFileSync(join(lease.worktreePath, "unsaved.txt"), "still here");

    await expect(manager.release(lease, { removeBranch: true })).rejects.toThrow(
      "Branch deletion requires explicit owner confirmation",
    );

    // The refusal used to land AFTER the removal, so the caller was told no
    // about the branch while the working tree was already gone.
    expect(existsSync(join(lease.worktreePath, "unsaved.txt"))).toBe(true);
    expect(runGit(repoDir, "branch", "--list", lease.branch).trim()).not.toBe("");

    await manager.release(lease);
  });

  it("deletes the branch when the caller confirms, so botfleet/* branches do not pile up", async () => {
    const lease = await manager.acquire(repoDir, "bot-del", "thread-del", 61);
    expect(runGit(repoDir, "branch", "--list", lease.branch).trim()).not.toBe("");

    await manager.release(lease, { removeBranch: true, confirmBranchDeletion: true });

    expect(existsSync(lease.worktreePath)).toBe(false);
    expect(runGit(repoDir, "branch", "--list", lease.branch).trim()).toBe("");
    expect(exactTurnLeases.hasTarget(lease.targetKey)).toBe(false);
  });

  it("refuses to delete a branch while keeping its worktree checked out", async () => {
    const lease = await manager.acquire(repoDir, "bot-del", "thread-keep", 62);

    await expect(
      manager.release(lease, { keepWorktree: true, removeBranch: true, confirmBranchDeletion: true }),
    ).rejects.toThrow(/while keeping its worktree/);
    expect(existsSync(lease.worktreePath)).toBe(true);

    await manager.release(lease);
  });

  it("gives bot and thread pairs that join to the same text separate worktrees", async () => {
    // Both pairs spelled `<base>/<repoHash>/bot-1-thread-1`.  Their lease keys
    // differ, so the lease engine admitted both, and the second acquire then
    // removed and re-created the first turn's live working tree.
    const first = await manager.acquire(repoDir, "bot-1", "thread-1", 70);
    writeFileSync(join(first.worktreePath, "first.txt"), "first turn's work");

    const second = await manager.acquire(repoDir, "bot-1-thread", "1", 71);

    expect(second.worktreePath).not.toBe(first.worktreePath);
    expect(readFileSync(join(first.worktreePath, "first.txt"), "utf8")).toBe("first turn's work");
    expect(existsSync(second.worktreePath)).toBe(true);

    await manager.release(first);
    await manager.release(second);
  });

  it("names a worktree from the raw ids, not their sanitized spelling", async () => {
    // `a/b` and `a_b` sanitize to the same segment.
    const slash = await manager.acquire(repoDir, "bot", "a/b", 80);
    const underscore = await manager.acquire(repoDir, "bot-2", "a_b", 81);
    const sameBotOtherThread = await manager.acquire(repoDir, "bot-3", "a/b", 82);
    const sameBotSanitized = await manager.acquire(repoDir, "bot-3b", "a_b", 83);

    const paths = new Set([slash, underscore, sameBotOtherThread, sameBotSanitized].map((l) => l.worktreePath));
    expect(paths.size).toBe(4);

    for (const lease of [slash, underscore, sameBotOtherThread, sameBotSanitized]) await manager.release(lease);
  });
});
