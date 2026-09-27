/**
 * Doomed-dispatch breaker: stop re-sending work to an engine that cannot
 * start.
 *
 * A recurring trigger fires on a timer whether or not anything can come of
 * it.  When a bot's engine is dead in a way that is permanent for now — the
 * CLI is not installed, is not executable, or needs an interactive login —
 * every tick produced another `spawn_error` run: same failure, same bot, same
 * engine, dozens of times an hour.  Measured over three days on one Mac, 216
 * of 2,001 runs (11%) were `spawn_error` and another 105 were `rpc_error`, so
 * 86% of all failures were the process never coming up rather than the model
 * doing the work badly.  The run is not the problem and retrying it on a timer
 * does not fix the problem.
 *
 * This registry is a half-open breaker over a `(bot, engine)` pair:
 *
 *  - N consecutive SETUP-class failures open it.  One failure can be a race
 *    during an install or a login; N in a row on the same pair is a fact about
 *    the engine.  A non-setup failure never opens it — a provider blip, a
 *    wall-clock timeout and a missing binary want different reactions, and
 *    only the last one is worth refusing to retry.
 *  - While open, the dispatcher declines to start and the run stays QUEUED
 *    rather than being failed, so it still lands once the engine comes back.
 *  - A success for the pair clears it.
 *  - After the TTL the breaker goes half-open: the next dispatch is allowed
 *    through, and because the consecutive-failure count survives expiry, a
 *    single further failure re-opens it immediately instead of needing another
 *    three.  A dead engine therefore costs a few dispatches per TTL rather
 *    than one per tick, and recovers by itself after a `pnpm install` or a
 *    fresh login — no restart, no manual reset.
 *
 * A pair's count is forgotten only after a day of silence
 * (`DOOMED_MEMORY_MS`): the TTL governs how long the breaker refuses, not
 * how long it remembers, and a success clears immediately.  Anything
 * shorter would delete the half-open state the next time the status
 * endpoint listed the registry.
 *
 * The TTL is the only reset mechanism on purpose.  Keying the reset on an
 * "engine snapshot changed" fingerprint, as the hardening plan proposed, needs
 * a synchronous handle on the describe snapshot that the dispatch path does
 * not have; a time-based half-open gets the same self-healing property from a
 * value the scheduler already owns, and never leaves a bot blocked by a
 * fingerprint that failed to refresh.
 *
 * Mirrors `QuotaCooldownRegistry` in `model-fallback.ts` deliberately — the
 * same key shape, the same lazy expiry on read, the same
 * `enablePersist(path, write?)` seam, the same write override for tests, the
 * same "a corrupt file is an empty registry" rule — so there is one
 * persistence idiom in this codebase rather than two.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** Consecutive setup-class failures on one `(bot, engine)` pair before the
 *  breaker opens.  Three, not one: a single ENOENT can land mid-install or
 *  mid-login, and refusing to retry that would strand a routine until the TTL
 *  expired for no reason. */
export const DOOMED_FAILURE_THRESHOLD = 3;

/** How long a pair stays refused before one probe is let through.  Matches the
 *  quota cooldown TTL so both kinds of "stop sending this there" read the same
 *  on a dashboard. */
export const DOOMED_TTL_MS = 15 * 60_000;

/** How long a quiet pair's count is remembered.  The TTL governs how long an
 *  open breaker REFUSES; the consecutive-failure count has to outlive it or
 *  the half-open probe would need three failures to re-open instead of one.
 *  A day of silence is what finally forgets a pair - long past any realistic
 *  probe, short enough that a deleted bot does not linger in the map. */
export const DOOMED_MEMORY_MS = 24 * 60 * 60_000;

export interface DoomedEntry {
  botId: string;
  instanceId: string;
  consecutiveFailures: number;
  /** When the breaker last opened.  The half-open clock runs from here, so it
   *  is re-stamped on every failure past the threshold — otherwise a pair
   *  failing steadily would expire once and then re-open on a single later
   *  failure, which is the opposite of what a steady failure rate should buy. */
  openedAt: number;
  lastFailureAt: number;
  lastError?: string;
}

const key = (botId: string, instanceId: string) => `${botId}:${instanceId}`;

export class DoomedDispatchRegistry {
  private readonly entries = new Map<string, DoomedEntry>();
  private persistPath: string | null = null;
  private persistImpl: ((path: string, json: string) => void) | null = null;

  enablePersist(path: string, write?: (path: string, json: string) => void): void {
    this.persistPath = path;
    this.persistImpl = write ?? null;
    this.load();
  }

  private persist(): void {
    if (!this.persistPath) return;
    const body = JSON.stringify({ version: 1, doomed: [...this.entries.values()] });
    if (this.persistImpl) {
      this.persistImpl(this.persistPath, body);
      return;
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileAtomic(this.persistPath, body);
    } catch {
      /* a failed persist must not break a turn */
    }
  }

  /** Whether an entry is currently refusing dispatches.
   *
   *  The threshold is checked here as well as at record time on purpose: below
   *  it an entry is just a counter, and `openedAt` is stamped from the first
   *  failure so the TTL clock is measured from when the trouble started rather
   *  than from when it became serious.  Reading it the other way round — a
   *  fresh entry inside its own TTL — made ONE failed spawn refuse the pair,
   *  which is the opposite of what a threshold is for. */
  private isEntryOpen(entry: DoomedEntry, now: number): boolean {
    if (entry.consecutiveFailures < DOOMED_FAILURE_THRESHOLD) return false;
    return now - entry.openedAt < DOOMED_TTL_MS;
  }

  /** Drop pairs quiet long enough to forget, so a long-lived process does
   *  not accumulate one entry per (bot, engine) pair it ever tried.  An
   *  expired breaker is NOT dropped: its count is what lets the half-open
   *  probe re-open on a single failure, and a `list` from the status
   *  endpoint must not be what destroys it.  Only called on a cold read and
   *  on `list`, never on the hot dispatch path. */
  private sweep(now: number): boolean {
    let removed = false;
    for (const [k, entry] of this.entries) {
      if (now - (entry.lastFailureAt ?? entry.openedAt) >= DOOMED_MEMORY_MS) {
        this.entries.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        version?: number;
        doomed?: DoomedEntry[];
      };
      if (!Array.isArray(parsed.doomed)) return;
      const now = Date.now();
      let removed = false;
      for (const entry of parsed.doomed) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.botId !== "string" ||
          typeof entry.instanceId !== "string" ||
          typeof entry.consecutiveFailures !== "number" ||
          typeof entry.openedAt !== "number"
        ) {
          removed = true;
          continue;
        }
        // A restart must not cost the count either: only a pair quiet past
        // the memory window is forgotten - an expired breaker is kept, so
        // the half-open probe still re-opens on a single failure.
        const rememberedAt = typeof entry.lastFailureAt === "number" ? entry.lastFailureAt : entry.openedAt;
        if (now - rememberedAt >= DOOMED_MEMORY_MS) {
          removed = true;
          continue;
        }
        this.entries.set(key(entry.botId, entry.instanceId), entry);
      }
      if (removed) this.persist();
    } catch {
      /* corrupt file = empty registry */
    }
  }

  /** Count a SETUP-class failure and open the breaker once the threshold is
   *  crossed.  Non-setup failures are the caller's business and must not reach
   *  this: they are the model's problem, not the engine's. */
  recordFailure(botId: string, instanceId: string, error?: string, now = Date.now()): DoomedEntry | null {
    if (!botId || !instanceId) return null;
    const k = key(botId, instanceId);
    const prior = this.entries.get(k);
    const consecutiveFailures = (prior ? prior.consecutiveFailures : 0) + 1;
    const wasOpen = prior ? this.isEntryOpen(prior, now) : false;
    const entry: DoomedEntry = {
      botId,
      instanceId,
      consecutiveFailures,
      // Re-stamp on every failure past the threshold, so a pair that keeps
      // failing keeps its breaker closed instead of lapsing into a probe every
      // TTL forever.
      openedAt: consecutiveFailures >= DOOMED_FAILURE_THRESHOLD || wasOpen ? now : (prior?.openedAt ?? now),
      lastFailureAt: now,
      lastError: error,
    };
    this.entries.set(k, entry);
    this.persist();
    return consecutiveFailures >= DOOMED_FAILURE_THRESHOLD ? entry : null;
  }

  /** Any turn from this pair that got as far as a result clears the breaker. */
  recordSuccess(botId: string, instanceId: string): void {
    if (!botId || !instanceId) return;
    if (this.entries.delete(key(botId, instanceId))) this.persist();
  }

  /** Whether the dispatcher should decline this pair right now.  Expired
   *  entries are left in place on purpose: the count has to survive into the
   *  probe, or a pair that fails again would need three more tries to re-open
   *  instead of one. */
  isOpen(botId: string, instanceId: string, now = Date.now()): boolean {
    if (!botId || !instanceId) return false;
    const entry = this.entries.get(key(botId, instanceId));
    if (!entry) return false;
    return this.isEntryOpen(entry, now);
  }

  /** What the entry says, for a receipt or a diagnostic — including the
   *  half-open state where the breaker is not refusing but a recent failure is
   *  still on record. */
  peek(botId: string, instanceId: string): DoomedEntry | null {
    return this.entries.get(key(botId, instanceId)) ?? null;
  }

  list(now = Date.now()): DoomedEntry[] {
    if (this.sweep(now)) this.persist();
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }
}

/** The process-wide breaker.  A module singleton for the same reason
 *  `quotaCooldowns` is one: the dispatcher and the runtime-event bus have to
 *  be talking about the same set of refused pairs, and threading a second
 *  instance through both call sites would be a way to have them disagree. */
export const doomedDispatches = new DoomedDispatchRegistry();

export function enableDoomedDispatchPersist(path: string): void {
  doomedDispatches.enablePersist(path);
}
