// Live Grok remaining-percent from the local Grok CLI.
//
// As of 2026-09-23 the `grok` CLI does not expose a quota subcommand:
// `grok --help` lists `usage <SESSION_ID> <TURN>` which prints per-session
// token usage (NOT a remaining-percent window), plus the unrelated `du`
// "disk-usage" alias.  There is no `grok quota`, no `grok usage status`,
// and no xAI-published JSON schema for remaining-percent windows.  This
// module therefore returns a snapshot with NO `remainingPercent` fields
// and a structured `availability: "no-source"` — the Settings UI renders
// the card with an honest "no quota source available yet" line instead
// of inventing numbers.
//
// When xAI ships a quota endpoint we will replace this with the real
// reader; the wiring (registry, poller, /api/quotas, UsageMonitorQuotaGrid,
// ModelPicker) is already in place, so the swap is a single-file change.
// See the audit doc at docs/audits/2026-09-23-botfleet-settings-revamp.md
// for the reasoning and the trade-off.

import { quotaCooldowns, type QuotaCooldownRegistry } from "./model-fallback.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_INSTANCE_ID = "grok";
export const GROK_USAGE_SOURCE = "grok-cli";
export const GROK_NO_SOURCE_REASON =
  "The `grok` CLI does not expose a quota subcommand as of 2026-09-23." +
  "\u00A0 " +
  "`grok usage <session_id> <turn>` reports per-turn token usage only, not a remaining-percent window." +
  "\u00A0 " +
  "Until xAI ships an API for remaining quota, this card renders no quota numbers.";

export interface GrokUsageModel {
  label: string;
  modelId: string;
  /** Always null today — the CLI does not publish remaining-percent. */
  remainingPercentage: number | null;
  /** True when a model has reported a rate-limit; `false` otherwise. */
  isExhausted: boolean;
  /** ISO-8601 reset time when reported, otherwise undefined. */
  resetTime?: string;
  /** Relative countdown in ms when reported. */
  timeUntilResetMs?: number;
}

export interface GrokUsageSnapshot {
  timestamp: string;
  /** Always "no-source" today — the CLI doesn't have a quota endpoint. */
  method: "no-source" | "cli-quota" | "http-api";
  /** Why no quota data is available.  Empty when `method` is not "no-source". */
  noSourceReason?: string;
  /** Empty today.  Reserved for the future when a quota endpoint ships. */
  models: GrokUsageModel[];
  /** Subscription tier the user is on, when reported by the harness. */
  subscription?: { tierLabel: string; costPerMonth: number | null };
}

/** Where the local Grok CLI is.  Same path-discovery shape as the
 *  Antigravity sibling — `findAntigravityUsageBin` — so a future CLI
 *  swap can replace both without a search rewrite. */
export function findGrokBin(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".grok", "bin", "grok"),
    join(home, ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "grok";
}

/** Returns an empty snapshot with `method: "no-source"` and a populated
 *  `noSourceReason` so the Settings UI knows to render the honest
 *  "no quota source available yet" state.  Stable across calls — the
 *  same `timestamp` every read is fine because there is nothing to
 *  refresh. */
export function buildNoSourceSnapshot(now = Date.now()): GrokUsageSnapshot {
  return {
    timestamp: new Date(now).toISOString(),
    method: "no-source",
    noSourceReason: GROK_NO_SOURCE_REASON,
    models: [],
  };
}

let lastSnapshot: GrokUsageSnapshot | null = null;

export function lastGrokQuotaSnapshot(): GrokUsageSnapshot | null {
  return lastSnapshot;
}

export function setLastGrokQuotaSnapshot(snapshot: GrokUsageSnapshot | null): void {
  lastSnapshot = snapshot;
}

/** Apply a snapshot to the cooldown registry.  Today this is a no-op
 *  because the snapshot has no models — the function exists so the wire
 *  shape matches `applyAntigravityUsageToRegistry` and a future quota
 *  endpoint slots in without touching callers. */
export function applyGrokUsageToRegistry(
  _snapshot: GrokUsageSnapshot,
  _registry: QuotaCooldownRegistry = quotaCooldowns,
  _now = Date.now(),
): { capped: string[]; cleared: string[] } {
  // No-op: the current CLI does not report a remaining-percent window.
  return { capped: [], cleared: [] };
}

export interface GrokModelQuota {
  capped: boolean;
  remainingPercent?: number | null;
  secondaryRemainingPercent?: number | null;
  resetsAt?: number | null;
  error?: string;
  windowsLabel?: string;
  /** True when the source is the "no-source" stub.  The UI uses this to
   *  surface a "not yet available" line instead of an empty grid. */
  noSource?: boolean;
  noSourceReason?: string;
}

export function quotaModelsFromSnapshot(
  snapshot: GrokUsageSnapshot | null,
): Record<string, GrokModelQuota> {
  const models: Record<string, GrokModelQuota> = {};
  if (!snapshot) return models;
  if (snapshot.method === "no-source") {
    return {
      "*": {
        capped: false,
        remainingPercent: null,
        windowsLabel: "n/a",
        noSource: true,
        noSourceReason: snapshot.noSourceReason ?? GROK_NO_SOURCE_REASON,
      },
    };
  }
  for (const model of snapshot.models) {
    models[model.modelId] = {
      capped: model.isExhausted,
      remainingPercent: model.remainingPercentage,
      resetsAt: model.resetTime ? Date.parse(model.resetTime) : undefined,
      ...(model.isExhausted
        ? { error: `${model.label} quota exhausted (grok)` }
        : {}),
    };
  }
  return models;
}

export interface GrokQuotaExec {
  /** Resolve the current snapshot.  Default impl returns the no-source
   *  stub every call.  Future quota-endpoint readers override this. */
  snapshot(): Promise<GrokUsageSnapshot>;
}

export const defaultGrokQuotaExec: GrokQuotaExec = {
  async snapshot() {
    return buildNoSourceSnapshot();
  },
};

export interface GrokQuotaPoller {
  start: () => void;
  stop: () => void;
  tick: () => Promise<GrokUsageSnapshot | null>;
  lastSnapshot: () => GrokUsageSnapshot | null;
}

export function createGrokQuotaPoller(opts: {
  exec?: GrokQuotaExec;
  /** Optional clock for tests; `Date.now` when omitted.  Reserved for a
   *  future quota reader that needs to date-stamp its snapshot. */
  now?: () => number;
  log?: (message: string) => void;
} = {}): GrokQuotaPoller {
  const exec = opts.exec ?? defaultGrokQuotaExec;
  // Captured for the snapshot writer when a future quota reader needs
  // a stable clock.  ESLint flags this as unused until that reader
  // lands — the underscore prefix keeps the strict-no-unused-locals
  // gate honest.
  const _now = opts.now ?? Date.now;
  void _now;
  const log = opts.log ?? ((message: string) => console.log(`[grok-quota] ${message}`));
  let snapshot: GrokUsageSnapshot | null = null;
  let ticking = false;
  let noSourceLogged = false;
  let started = false;

  const tick = async (): Promise<GrokUsageSnapshot | null> => {
    if (ticking) return snapshot;
    ticking = true;
    try {
      const parsed = await exec.snapshot();
      snapshot = parsed;
      lastSnapshot = parsed;
      if (parsed.method === "no-source" && !noSourceLogged) {
        log(`no quota source available yet (${GROK_NO_SOURCE_REASON.slice(0, 80)}…)`);
        noSourceLogged = true;
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`poll failed: ${message}`);
      return snapshot;
    } finally {
      ticking = false;
    }
  };

  return {
    // HS14: the CLI has no quota subcommand, so `exec.snapshot()` returns
    // the SAME documented no-source stub every time (or, for a caller that
    // injects a real reader, whatever THAT reader currently reports at
    // start time) — a recurring timer bought nothing but a tick every 5
    // minutes forever.  Compute it once; a future real quota reader that
    // needs to actually refresh over time can reintroduce a timer then,
    // when there is a live value for it to refresh.
    start() {
      if (started) return;
      started = true;
      void tick();
    },
    stop() {
      started = false;
    },
    tick,
    lastSnapshot: () => snapshot,
  };
}

const defaultPoller = createGrokQuotaPoller();

export function startGrokQuotaPoller(): void {
  defaultPoller.start();
}

export function stopGrokQuotaPoller(): void {
  defaultPoller.stop();
}