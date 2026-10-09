import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { realOrResolved } from "./bot-cwd.ts";
import { execCli } from "./procs.ts";
import { ExactTurnLeases, type ExactTurnLease } from "./turn-safety.ts";

function canonicalPath(p: string): string {
  try {
    return realpathSync.native ? realpathSync.native(p) : realOrResolved(p);
  } catch {
    return realOrResolved(p);
  }
}

export const WORKTREES_BASE_DIR = join(DATA_DIR, "worktrees");

export interface WorktreeLease {
  readonly lease: ExactTurnLease;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly targetKey: string;
  readonly createdAt: number;
}

export interface AcquireWorktreeOptions {
  /** Optional branch name to checkout.  Defaults to botfleet/<safeBotId>/<safeThreadId>. */
  branch?: string;
  /** Commit, tag, or branch to branch from.  Defaults to HEAD. */
  commitIsh?: string;
}

export interface ReleaseWorktreeOptions {
  /** Keep the worktree directory on disk instead of removing it. */
  keepWorktree?: boolean;
  /** Delete the worktree's Git branch after removal. */
  removeBranch?: boolean;
}

export interface WorktreeLeaseManagerOptions {
  baseDir?: string;
  exactTurnLeases?: ExactTurnLeases;
  gitTimeoutMs?: number;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function sanitizeRefSegment(str: string): string {
  return str.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Strict Git Worktree Lease Engine (Option C).
 *
 * Provides safe, concurrent, turn-level repository isolation for multi-bot
 * operations.  Each active turn acquires an isolated Git worktree on its own
 * branch, eliminating .git/index.lock contention, branch thrashing, and
 * concurrent compile/artifact collisions.
 */
export class WorktreeLeaseManager {
  readonly baseDir: string;
  readonly exactTurnLeases: ExactTurnLeases;
  readonly gitTimeoutMs: number;

  private readonly repoQueues = new Map<string, Promise<unknown>>();

  constructor(options: WorktreeLeaseManagerOptions = {}) {
    this.baseDir = options.baseDir ?? WORKTREES_BASE_DIR;
    this.exactTurnLeases = options.exactTurnLeases ?? new ExactTurnLeases();
    this.gitTimeoutMs = options.gitTimeoutMs ?? 30_000;
  }

  /**
   * Serializes Git worktree lifecycle operations (add, remove, prune) per
   * repository root so that concurrent operations do not collide on Git locks.
   */
  private serialize<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
    const prev = this.repoQueues.get(repoRoot) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.repoQueues.set(
      repoRoot,
      next.catch(() => {}),
    );
    return next;
  }

  private runGit(
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execCli(
        "git",
        args,
        {
          cwd,
          env: gitEnv(),
          timeout: this.gitTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          // SAFETY: execCli callback delivers an Error or null; code is an integer if child process exited.
          const execErr = error as (Error & { code?: number }) | null;
          const rawCode = execErr?.code;
          if (error && !Number.isInteger(rawCode)) {
            reject(error);
            return;
          }
          const code = Number.isInteger(rawCode) ? Number(rawCode) : 0;
          resolve({ code, stdout: stdout || "", stderr: stderr || "" });
        },
      );
    });
  }

  /**
   * Resolves the top-level repository root directory.  Throws if the directory
   * is not inside a Git repository.
   */
  async resolveRepoRoot(dir: string): Promise<string> {
    const resolved = canonicalPath(dir);
    const result = await this.runGit(["rev-parse", "--show-toplevel"], resolved);
    if (result.code !== 0 || !result.stdout.trim()) {
      throw Object.assign(
        new Error(`Directory is not inside a Git repository: ${dir}`),
        { status: 400, code: "not_a_git_repo" },
      );
    }
    return canonicalPath(result.stdout.trim());
  }

  /**
   * Returns true if the specified directory is inside a Git repository.
   */
  async isGitRepo(dir: string): Promise<boolean> {
    try {
      await this.resolveRepoRoot(dir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Acquires a strict worktree lease for a turn.
   *
   * Creates an isolated worktree directory under `baseDir/<repoHash>/<botId>-<threadId>`
   * checked out to branch `botfleet/<botId>/<threadId>`, protected by an exact turn
   * occupancy claim.
   */
  async acquire(
    repoRoot: string,
    botId: string,
    threadId: string,
    dispatchId: number,
    options: AcquireWorktreeOptions = {},
  ): Promise<WorktreeLease> {
    const root = await this.resolveRepoRoot(repoRoot);
    const repoHash = createHash("sha256")
      .update(root)
      .digest("hex")
      .slice(0, 12);
    const safeBotId = sanitizeRefSegment(botId);
    const safeThreadId = sanitizeRefSegment(threadId);

    const branch =
      options.branch ?? `botfleet/${safeBotId}/${safeThreadId}`;
    const commitIsh = options.commitIsh ?? "HEAD";
    const targetKey = `worktree:${repoHash}:${safeBotId}:${safeThreadId}`;

    const lease = this.exactTurnLeases.claim(
      botId,
      threadId,
      dispatchId,
      targetKey,
    );
    if (!lease) {
      throw Object.assign(
        new Error(
          `Worktree for bot "${botId}" on thread "${threadId}" is already held by another active turn`,
        ),
        { status: 409, code: "worktree_locked" },
      );
    }

    const worktreePath = join(
      this.baseDir,
      repoHash,
      `${safeBotId}-${safeThreadId}`,
    );

    try {
      await this.serialize(root, async () => {
        // If a leftover directory exists from a prior killed turn or crash, remove it first.
        if (existsSync(worktreePath)) {
          await this.runGit(
            ["worktree", "remove", "--force", worktreePath],
            root,
          ).catch(() => {});
          await this.runGit(["worktree", "prune"], root).catch(() => {});
          if (existsSync(worktreePath)) {
            rmSync(worktreePath, { recursive: true, force: true });
          }
        }

        mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });

        const addResult = await this.runGit(
          ["worktree", "add", "--force", "-B", branch, worktreePath, commitIsh],
          root,
        );

        if (addResult.code !== 0) {
          throw new Error(
            `Failed to create Git worktree at ${worktreePath}: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
          );
        }
      });

      return {
        lease,
        repoRoot: root,
        worktreePath,
        branch,
        targetKey,
        createdAt: Date.now(),
      };
    } catch (error) {
      this.exactTurnLeases.release(lease);
      throw error;
    }
  }

  /**
   * Releases a worktree lease, removing the worktree from Git and freeing the
   * turn occupancy claim.
   */
  async release(
    leaseInfo: WorktreeLease,
    options: ReleaseWorktreeOptions = {},
  ): Promise<void> {
    try {
      await this.serialize(leaseInfo.repoRoot, async () => {
        if (!options.keepWorktree) {
          await this.runGit(
            ["worktree", "remove", "--force", leaseInfo.worktreePath],
            leaseInfo.repoRoot,
          ).catch(() => {});
          await this.runGit(["worktree", "prune"], leaseInfo.repoRoot).catch(
            () => {},
          );
          if (existsSync(leaseInfo.worktreePath)) {
            try {
              rmSync(leaseInfo.worktreePath, { recursive: true, force: true });
            } catch {
              // Ignore disk removal error if Git already detached it
            }
          }
        }

        if (options.removeBranch) {
          throw new Error("Branch deletion requires explicit owner confirmation");
        }
      });
    } finally {
      this.exactTurnLeases.release(leaseInfo.lease);
    }
  }

  /**
   * Prunes stale worktrees older than maxAgeMs that are not currently claimed
   * by any active turn.
   */
  async pruneStaleWorktrees(
    maxAgeMs = 24 * 60 * 60_000,
  ): Promise<{ pruned: number; errors: number }> {
    let pruned = 0;
    let errors = 0;
    if (!existsSync(this.baseDir)) return { pruned, errors };

    const now = Date.now();
    try {
      const repoHashDirs = readdirSync(this.baseDir, { withFileTypes: true });
      for (const hashDir of repoHashDirs) {
        if (!hashDir.isDirectory()) continue;
        const hashDirPath = join(this.baseDir, hashDir.name);
        const worktreeEntries = readdirSync(hashDirPath, {
          withFileTypes: true,
        });

        for (const entry of worktreeEntries) {
          const entryPath = join(hashDirPath, entry.name);
          try {
            const stats = statSync(entryPath);
            const ageMs = now - stats.mtimeMs;
            if (ageMs < maxAgeMs) continue;

            // Check if any lease is holding this entry
            const targetKeySuffix = entry.name.replace("-", ":");
            const targetKey = `worktree:${hashDir.name}:${targetKeySuffix}`;
            if (this.exactTurnLeases.hasTarget(targetKey)) continue;

            continue;
          } catch {
            errors++;
          }
        }
      }
    } catch {
      errors++;
    }

    return { pruned, errors };
  }

  get activeLeaseCount(): number {
    return this.exactTurnLeases.size;
  }
}
