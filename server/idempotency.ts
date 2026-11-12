// A small TTL cache that lets a POST route answer a client retry with the
// outcome of the first attempt instead of doing the work twice.
//
// MCP clients and phones time out and retry.  A bot instruction that ran
// twice is duplicate work — two PRs, two cleanups — so the first attempt's
// promise is remembered under the caller's key: a retry that lands while
// the first is still in flight awaits the same promise, and one that lands
// after it settled gets the settled reply back.  Rejected attempts are
// forgotten at once so a caller can retry a real failure.

export interface IdempotentRun<T> {
  /** True when the reply came from an earlier attempt under the same key. */
  replayed: boolean;
  result: Promise<T>;
}

export interface IdempotencyCacheOptions {
  /** How long a settled reply stays answerable.  Default ten minutes. */
  ttlMs?: number;
  /** Upper bound on remembered keys; the oldest go first.  Default 1,000. */
  maxEntries?: number;
  now?: () => number;
}

export class IdempotencyCache<T> {
  private readonly entries = new Map<string, { at: number; result: Promise<T>; settled: boolean }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  /** Run `attempt` once per key.  A second call with the same live key
   * returns the first call's promise and marks the run as replayed. */
  run(key: string, attempt: () => Promise<T>): IdempotentRun<T> {
    this.pruneExpired();
    const existing = this.entries.get(key);
    if (existing) return { replayed: true, result: existing.result };
    this.evictForInsertion();
    const result = attempt();
    const entry = { at: this.now(), result, settled: false };
    this.entries.set(key, entry);
    void result.then(
      () => {
        if (this.entries.get(key) === entry) entry.settled = true;
      },
      () => {
        // A failed attempt is not an outcome worth replaying — let a retry on
        // the same task run, and reject a stale-task retry as an unknown key.
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return { replayed: false, result };
  }

  /** Return an earlier fulfilled attempt without starting new work.  Route guards use
   * this when mutable routing state changed after the original request: a
   * committed key may replay its outcome, while unknown, in-flight, and
   * rejected keys must be rejected rather than dispatched into the new task. */
  replay(key: string): IdempotentRun<T> | undefined {
    this.pruneExpired();
    const existing = this.entries.get(key);
    return existing?.settled ? { replayed: true, result: existing.result } : undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
  }

  private evictForInsertion(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
