// ACP `initialize` deadline.
//
// `initialize` is the first RPC after a cold spawn, so its latency is the
// CLI's whole boot: module loading, plugin activation, config reads.  That
// is CPU work, and this Mac routinely runs with a load average many times
// its core count while the fleet builds and tests.  A fixed 60 s wall clock
// was sized for Grok (p50 0.7 s) and cut off DeepSeek Harness boots that
// were still making progress — `dsh --profile acp` spends about 3.5 s of CPU
// loading ~200 Cordis plugins, which stretched to 24-52 s of wall time at a
// load average of ~400-500 on 10 cores, and 89% of BotFleet's failed-turn
// spans over 14 days were this one "initialize timed out".
//
// The deadline is therefore (engine base) x (host load factor), capped:
//   - the engine base is 60 s unless a support declares a heavier boot;
//   - the load factor is the 1-minute load average per core, clamped to
//     [1, MAX_INIT_LOAD_FACTOR], so an idle or normally busy host keeps the
//     base and only a saturated host stretches it;
//   - an operator's per-instance `initTimeoutMs` is taken exactly as given.
// A truly wedged child still dies, just no sooner than a slow healthy boot
// would have answered.
import { availableParallelism, loadavg } from "node:os";

export const DEFAULT_INIT_TIMEOUT_MS = 60_000;
export const MIN_INIT_TIMEOUT_MS = 1_000;
/** Ceiling for both a scaled deadline and an operator override.  A boot emits
 *  no events while it waits, so this stays well under the harness stall
 *  watchdog (20 min of silence), which would otherwise end the turn first. */
export const MAX_INIT_TIMEOUT_MS = 5 * 60_000;
/** Load stretches the base at most this many times. */
export const MAX_INIT_LOAD_FACTOR = 3;
/** An initialize slower than this is logged so the tail stays visible after
 *  the deadline stops failing turns. */
export const SLOW_INIT_LOG_MS = 30_000;

export interface HostLoad {
  /** 1-minute load average. */
  load1: number;
  /** Logical cores available to this process. */
  cores: number;
}

export interface InitDeadline {
  timeoutMs: number;
  /** Load average per core at spawn time, when it could be read. */
  loadPerCore: number | null;
  /** True when an operator pinned the value in the instance config. */
  pinned: boolean;
}

/** Current host load, or null where the platform reports none (Windows
 *  answers zeros, which would read as an idle host anyway). */
export function readHostLoad(): HostLoad | null {
  try {
    const [load1 = Number.NaN] = loadavg();
    const cores = availableParallelism();
    if (!Number.isFinite(load1) || load1 < 0) return null;
    if (!Number.isFinite(cores) || cores <= 0) return null;
    return { load1, cores };
  } catch {
    return null;
  }
}

/** Load average per core, or null without a reading. */
export function loadPerCore(load: HostLoad | null | undefined): number | null {
  if (!load) return null;
  const ratio = load.load1 / load.cores;
  return Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
}

/** 1 on an idle or normally busy host; up to MAX_INIT_LOAD_FACTOR when the
 *  run queue is several times the core count. */
export function initLoadFactor(load: HostLoad | null | undefined): number {
  const ratio = loadPerCore(load);
  if (ratio === null || ratio <= 1) return 1;
  return Math.min(MAX_INIT_LOAD_FACTOR, ratio);
}

/** A valid per-instance `initTimeoutMs`, or undefined for anything else —
 *  the same bounded-integer rule `promptTimeoutMs` uses. */
export function decodeInitTimeoutMs(raw: unknown): number | undefined {
  return typeof raw === "number" &&
    Number.isFinite(raw) &&
    Number.isInteger(raw) &&
    raw >= MIN_INIT_TIMEOUT_MS &&
    raw <= MAX_INIT_TIMEOUT_MS
    ? raw
    : undefined;
}

export function resolveInitDeadline(options: {
  /** Per-instance override from the decoded config. */
  configured?: number;
  /** The engine's own base, from its AcpSupport. */
  engineBaseMs?: number;
  load?: HostLoad | null;
}): InitDeadline {
  const perCore = loadPerCore(options.load);
  if (options.configured !== undefined) {
    return { timeoutMs: options.configured, loadPerCore: perCore, pinned: true };
  }
  const engineBase = options.engineBaseMs ?? Number.NaN;
  const base = Number.isFinite(engineBase) && engineBase > 0 ? engineBase : DEFAULT_INIT_TIMEOUT_MS;
  const scaled = Math.round(base * initLoadFactor(options.load));
  return {
    timeoutMs: Math.max(MIN_INIT_TIMEOUT_MS, Math.min(MAX_INIT_TIMEOUT_MS, scaled)),
    loadPerCore: perCore,
    pinned: false,
  };
}

/** "after 180 s (host load 4.2 per core)" — the tail of the timeout message.
 *  Durations and a load figure only; nothing from the turn itself. */
export function describeInitDeadline(deadline: InitDeadline): string {
  const seconds = Math.max(1, Math.round(deadline.timeoutMs / 1000));
  const notes: string[] = [];
  if (deadline.pinned) notes.push("instance setting");
  if (deadline.loadPerCore !== null) notes.push(`host load ${deadline.loadPerCore.toFixed(1)} per core`);
  return notes.length ? `after ${seconds} s (${notes.join(", ")})` : `after ${seconds} s`;
}

/** The log line for an initialize that answered, but slowly. */
export function describeSlowInit(elapsedMs: number, deadline: InitDeadline): string {
  const load = deadline.loadPerCore === null ? "" : `, host load ${deadline.loadPerCore.toFixed(1)} per core`;
  const elapsed = Math.round(elapsedMs / 1000);
  const budget = Math.max(1, Math.round(deadline.timeoutMs / 1000));
  return `initialize answered after ${elapsed} s (deadline ${budget} s${load})`;
}
