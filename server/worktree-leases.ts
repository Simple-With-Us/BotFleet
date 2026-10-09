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
  /** Delete the worktree's Git branch after removal.  Commits that only that
   *  branch points at are lost with it, so this runs only together with
   *  `confirmBranchDeletion`. */
  removeBranch?: boolean;
  /** The caller has decided that losing the branch's unmerged commits is fine.
   *  Without it `removeBranch` is refused before anything is touched. */
  confirmBranchDeletion?: boolean;
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

/** The directory one bot+thread pair works in, a single segment under the repo
 *  hash.
 *
 *  Joining the two sanitized ids with a hyphen cannot be read back: the
 *  sanitizer keeps `-`, so bot `bot-1` on thread `thread-1` and bot
 *  `bot-1-thread` on thread `1` both spelled `bot-1-thread-1`.  Their lease
 *  keys differ, so both were admitted, and the second `acquire` removed and
 *  re-created the first turn's live working tree.  The tail here is a digest
 *  of the RAW pair, framed as JSON so no choice of ids can move a boundary,
 *  and it is a fixed length so the name cannot be split two ways. */
function worktreeDirName(botId: string, threadId: string): string {
  const pair = createHash("sha256")
    .update(JSON.stringify([botId, threadId]))
    .digest("hex")
    .slice(0, 16);
  return `${sanitizeRefSegment(botId)}-${pair}`;
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
  /** Worktree directories this manager has leased and not yet released.  The
   *  directory name is a digest, so a directory cannot be mapped back to a
   *  lease key; the path itself is what the prune pass compares. */
  private readonly activePaths = new Set<string>();

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
   * Creates an isolated worktree directory under
   * `baseDir/<repoHash>/<botId>-<pairDigest>` (see `worktreeDirName`) checked out
   * to branch `botfleet/<botId>/<threadId>`, protected by an exact turn occupancy
   * claim.
   *
   * The branch is reset with `-B` on every acquire and survives `release` unless
   * the caller deletes it (`removeBranch` with `confirmBranchDeletion`), so work
   * a turn left only on that branch stays reachable until the next acquire for
   * the same bot and thread resets it.
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

    const worktreePath = join(this.baseDir, repoHash, worktreeDirName(botId, threadId));

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

      this.activePaths.add(worktreePath);
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
        // Refuse a branch deletion nobody confirmed BEFORE the worktree goes:
        // the old order threw after the removal, so the caller was told "no"
        // about a branch while its working tree was already destroyed.
        if (options.removeBranch && !options.confirmBranchDeletion) {
          throw new Error("Branch deletion requires explicit owner confirmation");
        }
        if (options.removeBranch && options.keepWorktree) {
          throw new Error("Cannot delete a branch while keeping its worktree checked out");
        }
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
          const deleted = await this.runGit(
            ["branch", "-D", leaseInfo.branch],
            leaseInfo.repoRoot,
          );
          if (deleted.code !== 0) {
            throw new Error(
              `Failed to delete branch ${leaseInfo.branch}: ${deleted.stderr.trim() || deleted.stdout.trim()}`,
            );
          }
        }
      });
    } finally {
      this.activePaths.delete(leaseInfo.worktreePath);
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

            // A directory a live lease is using is never stale, whatever its
            // mtime says.  Compared by path: the name is a digest of the
            // bot+thread pair and cannot be turned back into a lease key.
            if (this.activePaths.has(entryPath)) continue;

            // Reclaiming the rest needs the owning repository, which the
            // repo-hash directory cannot give back, so a stale directory is
            // left for the next acquire of the same bot and thread to remove.
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
