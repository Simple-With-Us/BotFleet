export interface LocalVmLeaseRecord {
  threadId: string;
  botId: string;
  expiresAt: number;
}

/** A short, renewable ownership fence for one Local VM desktop.
 * Runtime events keep an active turn's lease alive; a dead provider cannot
 * pin the VM forever. All methods are synchronous so lifecycle routes and
 * turn dispatch can claim their side of the race before either awaits. */
export class LocalVmLease {
  private record: LocalVmLeaseRecord | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Local VM lease TTL must be positive");
    this.ttlMs = ttlMs;
  }

  current(isBotBusy: (botId: string) => boolean, now = Date.now()): LocalVmLeaseRecord | null {
    if (this.record && (this.record.expiresAt <= now || !isBotBusy(this.record.botId))) this.record = null;
    return this.record ? { ...this.record } : null;
  }

  /** Take or renew the fence.  Ownership is a TURN — a thread and the bot
   * running on it — not a conversation.  A 1:1 thread has exactly one bot, so
   * that lane is unchanged; a room thread is shared by every member, and
   * comparing the thread alone would have let a second member walk into the
   * container a first member is already clicking inside, then overwrite the
   * record's `botId` so the first member's unwind released it mid-turn. */
  claim(
    threadId: string,
    botId: string,
    isBotBusy: (ownerBotId: string) => boolean,
    now = Date.now(),
  ): boolean {
    const current = this.current(isBotBusy, now);
    if (current && (current.threadId !== threadId || current.botId !== botId)) return false;
    this.record = { threadId, botId, expiresAt: now + this.ttlMs };
    return true;
  }

  touch(threadId: string, now = Date.now()): void {
    if (this.record && this.record.expiresAt <= now) {
      this.record = null;
      return;
    }
    if (this.record?.threadId === threadId) this.record.expiresAt = now + this.ttlMs;
  }

  /** Give the fence back.  With a bot id the match is exact, for the same
   * reason `claim` compares both: on a shared room thread one member must not
   * be able to release another member's live claim. */
  release(threadId: string, botId?: string): void {
    if (this.record?.threadId !== threadId) return;
    if (botId !== undefined && this.record.botId !== botId) return;
    this.record = null;
  }
}

/** Independent lease lanes keyed by an already-validated Local VM target.
 * Shared mode uses one key; per-bot mode uses one digest-derived key per bot,
 * so separate desktops never block each other while each desktop remains a
 * strict singleton. */
export class LocalVmLeasePool {
  private readonly leases = new Map<string, LocalVmLease>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Local VM lease TTL must be positive");
    this.ttlMs = ttlMs;
  }

  forTarget(targetKey: string): LocalVmLease {
    let lease = this.leases.get(targetKey);
    if (!lease) {
      lease = new LocalVmLease(this.ttlMs);
      this.leases.set(targetKey, lease);
    }
    return lease;
  }
}
