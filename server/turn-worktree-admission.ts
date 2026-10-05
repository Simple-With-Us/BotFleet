import type { AppConfig } from "./config.ts";
import type { BotRecord } from "./store.ts";
import {
  WorktreeLeaseManager,
  type WorktreeLease,
} from "./worktree-leases.ts";

export type TurnWorktreeLeaseKey = {
  threadId: string;
  botId: string;
  dispatchId: number;
};

function leaseKey(key: TurnWorktreeLeaseKey): string {
  return `${key.threadId}:${key.botId}:${key.dispatchId}`;
}

/** Whether this bot should acquire a per-turn Git worktree at admission. */
export function gitWorktreeLeasesEnabled(
  cfg: AppConfig,
  bot: Pick<BotRecord, "gitWorktreeLeases">,
): boolean {
  if (bot.gitWorktreeLeases === false) return false;
  if (bot.gitWorktreeLeases === true) return true;
  return cfg.features?.gitWorktreeLeases === true;
}

export interface AdmitTurnWorktreeInput {
  enabled: boolean;
  manager: WorktreeLeaseManager;
  botId: string;
  threadId: string;
  dispatchId: number;
  /** Working folder before worktree isolation. */
  baseCwd?: string;
  /** BotFleet-owned workspace — never isolated into a worktree. */
  privateWorkspace?: string;
  log?: (line: string) => void;
}

export interface AdmitTurnWorktreeResult {
  cwd?: string;
  lease?: WorktreeLease;
  /** True when a worktree was acquired for this turn. */
  isolated: boolean;
}

/** At turn admission, optionally replace `baseCwd` with an isolated worktree. */
export async function admitTurnWorktree(
  input: AdmitTurnWorktreeInput,
): Promise<AdmitTurnWorktreeResult> {
  const base = input.baseCwd?.trim();
  if (!input.enabled || !base) {
    return { cwd: base || undefined, isolated: false };
  }
  if (input.privateWorkspace && base === input.privateWorkspace) {
    return { cwd: base, isolated: false };
  }
  try {
    const lease = await input.manager.acquire(
      base,
      input.botId,
      input.threadId,
      input.dispatchId,
    );
    return { cwd: lease.worktreePath, lease, isolated: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.log?.(
      `[worktree] turn ${input.threadId} kept shared cwd (${base}): ${reason}`,
    );
    return { cwd: base, isolated: false };
  }
}

interface HeldTurnWorktreeLease extends TurnWorktreeLeaseKey {
  lease: WorktreeLease;
}

/** Active worktree leases keyed by turn dispatch, released on every end path. */
export class ActiveTurnWorktreeLeases {
  private readonly manager: WorktreeLeaseManager;
  private readonly byKey = new Map<string, HeldTurnWorktreeLease>();

  constructor(manager: WorktreeLeaseManager) {
    this.manager = manager;
  }

  register(key: TurnWorktreeLeaseKey, lease: WorktreeLease): void {
    this.byKey.set(leaseKey(key), { ...key, lease });
  }

  has(key: TurnWorktreeLeaseKey): boolean {
    return this.byKey.has(leaseKey(key));
  }

  async releaseFor(key: TurnWorktreeLeaseKey): Promise<void> {
    const held = this.byKey.get(leaseKey(key));
    if (!held) return;
    this.byKey.delete(leaseKey(key));
    await this.manager.release(held.lease).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[worktree] failed to release lease for ${key.threadId} (bot ${key.botId}, dispatch ${key.dispatchId}): ${reason}`,
      );
    });
  }

  async clearBot(botId: string): Promise<void> {
    const pending = [...this.byKey.values()].filter((held) => held.botId === botId);
    for (const held of pending) {
      await this.releaseFor(held);
    }
  }

  get size(): number {
    return this.byKey.size;
  }
}

export const worktreeLeaseManager = new WorktreeLeaseManager();
export const activeTurnWorktreeLeases = new ActiveTurnWorktreeLeases(worktreeLeaseManager);
