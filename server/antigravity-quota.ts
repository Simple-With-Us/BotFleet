// Live Antigravity remaining-percent from the `antigravity-usage` CLI
// (`antigravity-usage quota --json`).  BotFleet used to learn a cap only
// after a turn burned a quota chip.  Usage Monitor's `agy -p /usage`
// collector is group-level and hours stale.  This CLI talks to Google Cloud
// Code (or the local language server) and returns per-model remaining,
// isExhausted, and resetTime — the signal we actually route on.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import { stripWorkspaceCredentialEnv } from "./config.ts";
import { antigravityQuotaCatalogId } from "./antigravity-models.ts";
import { FailureLogDedup } from "./log-dedup.ts";
import {
  quotaCooldowns,
  type QuotaCooldownRegistry,
} from "./model-fallback.ts";

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_INSTANCE_ID = "antigravity";
export const ANTIGRAVITY_USAGE_SOURCE = "antigravity-usage";

export interface AntigravityUsageModel {
  label: string;
  modelId: string;
  /** 0–1 fraction when Google reports it.  Gemini rows are often omitted. */
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime?: string;
  timeUntilResetMs?: number;
  isAutocompleteOnly?: boolean;
}

export interface AntigravityUsageSnapshot {
  timestamp: string;
  method?: string;
  models: AntigravityUsageModel[];
  promptCredits?: {
    available?: number;
    monthly?: number;
    usedPercentage?: number;
    remainingPercentage?: number;
  };
}

export type AntigravityQuotaExec = (args: string[], refresh: boolean) => Promise<string>;

const CLI_TIMEOUT_MS = 20_000;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function findAntigravityUsageBin(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const explicit = env.ANTIGRAVITY_USAGE_BIN?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(home, ".local", "bin", "antigravity-usage"),
    join(home, ".npm-global", "bin", "antigravity-usage"),
    "/opt/homebrew/bin/antigravity-usage",
    "/usr/local/bin/antigravity-usage",
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "antigravity-usage";
}

export function parseAntigravityUsageJson(raw: unknown): AntigravityUsageSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new Error("antigravity-usage output was not a JSON object");
  }
  const root = raw as Record<string, unknown>;
  const rows = Array.isArray(root.models) ? root.models : null;
  if (!rows) {
    throw new Error("antigravity-usage JSON is missing models[]");
  }

  const models: AntigravityUsageModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const modelId = firstString(entry.modelId, entry.id);
    if (!modelId) continue;
    const remaining = firstFiniteNumber(entry.remainingPercentage);
    models.push({
      label: firstString(entry.label, entry.name) ?? modelId,
      modelId,
      ...(remaining != null ? { remainingPercentage: remaining } : {}),
      isExhausted: entry.isExhausted === true,
      resetTime: firstString(entry.resetTime, entry.reset_time, entry.resetsAt),
      timeUntilResetMs: firstFiniteNumber(entry.timeUntilResetMs),
      isAutocompleteOnly: entry.isAutocompleteOnly === true,
    });
  }
  if (models.length === 0) {
    throw new Error("antigravity-usage JSON contained zero model rows");
  }
  const promptCredits = root.promptCredits && typeof root.promptCredits === "object"
    ? {
        available: firstFiniteNumber((root.promptCredits as Record<string, unknown>).available),
        monthly: firstFiniteNumber((root.promptCredits as Record<string, unknown>).monthly),
        usedPercentage: firstFiniteNumber((root.promptCredits as Record<string, unknown>).usedPercentage),
        remainingPercentage: firstFiniteNumber((root.promptCredits as Record<string, unknown>).remainingPercentage),
      }
    : undefined;

  return {
    timestamp: firstString(root.timestamp) ?? new Date().toISOString(),
    method: firstString(root.method),
    models,
    ...(promptCredits ? { promptCredits } : {}),
  };
}

/** Skip autocomplete-only rows.  Remaining 0, isExhausted, or N/A
 *  (missing remainingPercentage — owner 2026-09-04: N/A means none remains)
 *  is a hit. */
export function isAntigravityModelCapped(model: AntigravityUsageModel): boolean {
  if (model.isAutocompleteOnly) return false;
  if (model.isExhausted) return true;
  if (typeof model.remainingPercentage !== "number") return true;
  return model.remainingPercentage <= 0;
}

export function remainingPercentDisplay(model: AntigravityUsageModel): number | null {
  if (typeof model.remainingPercentage !== "number") return 0;
  return Math.round(model.remainingPercentage * 10_000) / 100;
}

export function resetAtMs(model: AntigravityUsageModel, now = Date.now()): number | null {
  if (model.resetTime) {
    const parsed = Date.parse(model.resetTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof model.timeUntilResetMs === "number" && model.timeUntilResetMs > 0) {
    return now + model.timeUntilResetMs;
  }
  return null;
}

/** Retain original diagnostic keys and add known catalog aliases for routing.
 * Unknown labels remain unmapped; they must not disable an unrelated model. */
function routingRows(snapshot: AntigravityUsageSnapshot, now: number): AntigravityUsageModel[] {
  const rows = new Map<string, AntigravityUsageModel>();
  for (const reported of snapshot.models) {
    if (reported.isAutocompleteOnly) continue;
    // Relative countdowns belong to the sample time, not each later picker read.
    const sampleAt = Date.parse(snapshot.timestamp);
    const relativeReset = (Number.isFinite(sampleAt) ? sampleAt : now) + (reported.timeUntilResetMs ?? 0);
    const model = (!reported.resetTime || !Number.isFinite(Date.parse(reported.resetTime))) &&
      (reported.timeUntilResetMs ?? 0) > 0 && Number.isFinite(relativeReset) && Math.abs(relativeReset) <= 8.64e15
      ? { ...reported, resetTime: new Date(relativeReset).toISOString() } : reported;
    const catalogId = antigravityQuotaCatalogId(model);
    for (const modelId of new Set([model.modelId, ...(catalogId ? [catalogId] : [])])) {
      const prior = rows.get(modelId);
      // Duplicate alias reports use the most restrictive observed reading.
      const capped = isAntigravityModelCapped(model);
      const priorCapped = prior && isAntigravityModelCapped(prior);
      if (!prior || (capped && !priorCapped) || (capped && priorCapped &&
          (resetAtMs(model, now) ?? Infinity) > (resetAtMs(prior, now) ?? Infinity)) ||
          (!capped && !priorCapped && (model.remainingPercentage ?? 0) < (prior.remainingPercentage ?? 0))) {
        rows.set(modelId, { ...model, modelId });
      }
    }
  }
  return [...rows.values()];
}

function activeQuotaCap(model: AntigravityUsageModel, now: number): boolean {
  const reset = resetAtMs(model, now);
  return isAntigravityModelCapped(model) && !(reset !== null && reset <= now);
}

export function applyAntigravityUsageToRegistry(
  snapshot: AntigravityUsageSnapshot,
  registry: QuotaCooldownRegistry = quotaCooldowns,
  now = Date.now(),
): { capped: string[]; cleared: string[] } {
  const turnModels = routingRows(snapshot, now);
  const cappedIds = new Set(
    turnModels.filter((model) => activeQuotaCap(model, now)).map((model) => model.modelId),
  );
  const knownIds = new Set(turnModels.map((model) => model.modelId));

  const cleared: string[] = [];
  registry.clearWhere((cd) => {
    if (cd.instanceId !== ANTIGRAVITY_INSTANCE_ID) return false;
    if (cappedIds.has(cd.model)) return false;
    if (knownIds.has(cd.model) || cd.model === "*") {
      cleared.push(cd.model);
      return true;
    }
    return false;
  });

  const capped: string[] = [];
  for (const model of turnModels) {
    if (!activeQuotaCap(model, now)) continue;
    const remaining = remainingPercentDisplay(model);
    const remainingText = remaining === 0 ? "exhausted" : `${remaining}% remaining`;
    registry.recordInstanceCap(ANTIGRAVITY_INSTANCE_ID, model.modelId, {
      resetsAt: resetAtMs(model, now),
      error: `${model.label} quota ${remainingText} (antigravity-usage)`,
      source: ANTIGRAVITY_USAGE_SOURCE,
    });
    capped.push(model.modelId);
  }
  return { capped, cleared };
}

export interface AntigravityModelQuota {
  capped: boolean;
  remainingPercent?: number | null;
  secondaryRemainingPercent?: number | null;
  resetsAt?: number | null;
  error?: string;
  windowsLabel?: string;
}

export function quotaModelsFromSnapshot(
  snapshot: AntigravityUsageSnapshot | null,
  now = Date.now(),
): Record<string, AntigravityModelQuota> {
  const models: Record<string, AntigravityModelQuota> = {};
  if (!snapshot) return models;
  const promptCredits = snapshot.promptCredits;
  let secondaryPercent: number | null = null;
  if (typeof promptCredits?.remainingPercentage === "number" && Number.isFinite(promptCredits.remainingPercentage)) {
    const raw = promptCredits.remainingPercentage;
    const pct = raw <= 1 && raw > 0 ? raw * 100 : raw;
    secondaryPercent = Math.round(pct * 100) / 100;
  }
  for (const model of routingRows(snapshot, now)) {
    const reset = resetAtMs(model, now);
    const isGemini = /gemini/i.test(`${model.label} ${model.modelId}`);
    models[model.modelId] = {
      capped: activeQuotaCap(model, now),
      remainingPercent: reset !== null && reset <= now ? null : remainingPercentDisplay(model),
      ...(isGemini && secondaryPercent != null ? { secondaryRemainingPercent: secondaryPercent } : {}),
      windowsLabel: isGemini && secondaryPercent != null ? "5hr/Week" : "5hr",
      resetsAt: resetAtMs(model, now),
      ...(activeQuotaCap(model, now)
        ? { error: `${model.label} quota exhausted (antigravity-usage)` }
        : {}),
    };
  }
  return models;
}

let lastSnapshot: AntigravityUsageSnapshot | null = null;

export function lastAntigravityQuotaSnapshot(): AntigravityUsageSnapshot | null {
  return lastSnapshot;
}

export function setLastAntigravityQuotaSnapshot(snapshot: AntigravityUsageSnapshot | null): void {
  lastSnapshot = snapshot;
}

export async function defaultAntigravityUsageExec(args: string[], refresh: boolean): Promise<string> {
  const bin = findAntigravityUsageBin();
  const cliArgs = ["quota", "--json", ...args, ...(refresh ? ["--refresh"] : [])];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), NO_COLOR: "1" };
  stripWorkspaceCredentialEnv(env);
  delete env.FORCE_COLOR;
  const { stdout } = await execFileAsync(bin ?? "antigravity-usage", cliArgs, {
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    env,
  });
  return stdout;
}

export interface AntigravityQuotaPoller {
  start: () => void;
  stop: () => void;
  tick: (refresh?: boolean) => Promise<AntigravityUsageSnapshot | null>;
  lastSnapshot: () => AntigravityUsageSnapshot | null;
}

/** Ceiling for the consecutive-failure backoff below: 30 minutes. */
const MAX_BACKOFF_MS = 30 * 60_000;

export function createAntigravityQuotaPoller(opts: {
  registry?: QuotaCooldownRegistry;
  exec?: AntigravityQuotaExec;
  intervalMs?: number;
  refreshEveryMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Gate the CLI spawn itself, not just the timer: the poller stays
   * armed (a cheap timer, no process spawn) but skips every tick while
   * this returns false, so a fleet with no Antigravity instance spawns
   * `antigravity-usage` zero times a day instead of 1,440 (OP3, HS13),
   * and a poller already running keeps polling once one is added without
   * needing a restart to re-arm.  Default `() => true` preserves the
   * always-on behavior for every existing caller and test. */
  isConfigured?: () => boolean;
} = {}): AntigravityQuotaPoller {
  const registry = opts.registry ?? quotaCooldowns;
  const exec = opts.exec ?? defaultAntigravityUsageExec;
  const intervalMs = opts.intervalMs ?? 60_000;
  const refreshEveryMs = opts.refreshEveryMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const isConfigured = opts.isConfigured ?? (() => true);
  const log = opts.log ?? ((message: string) => console.log(`[antigravity-quota] ${message}`));
  // HS23: 350 `[antigravity-quota]` lines in two days, almost all repeats
  // of the same failure.  Collapse those the same way telemetry.ts does.
  const failureLog = new FailureLogDedup({
    summaryIntervalMs: 30 * 60_000,
    log,
    formatSummary: (count, since, last) => `${count} poll(s) failed since ${since} (last: ${last})`,
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRefreshAt = 0;
  let snapshot: AntigravityUsageSnapshot | null = null;
  let ticking = false;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  // "Unexpected end of JSON input" (10 of 350 lines in the field) usually
  // means the CLI was caught mid-write, not that it is actually down — one
  // immediate retry next tick is cheaper than waiting out a full backoff
  // step, and it does not itself count toward the backoff ladder.
  let truncatedRetried = false;

  const backoffForFailure = (count: number): number =>
    Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.max(0, count - 1));

  const tick = async (forceRefresh = false): Promise<AntigravityUsageSnapshot | null> => {
    if (ticking) return snapshot;
    if (!isConfigured()) {
      // Nothing to poll.  Drop any backoff/failure state so the tick right
      // after an instance is (re)configured starts clean instead of
      // honoring a delay left over from a previous, unrelated run.
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      truncatedRetried = false;
      failureLog.reset();
      return snapshot;
    }
    if (!forceRefresh && nextAttemptAt > now()) return snapshot;
    ticking = true;
    try {
      const elapsed = now() - lastRefreshAt;
      const refresh = forceRefresh || lastRefreshAt === 0 || elapsed >= refreshEveryMs;
      const stdout = await exec([], refresh);
      const parsed = parseAntigravityUsageJson(JSON.parse(stdout));
      snapshot = parsed;
      lastSnapshot = parsed;
      lastRefreshAt = now();
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      truncatedRetried = false;
      failureLog.reset();
      const applied = applyAntigravityUsageToRegistry(parsed, registry, now());
      if (applied.capped.length || applied.cleared.length) {
        log(
          `applied ${parsed.models.length} model(s); capped=${applied.capped.length} cleared=${applied.cleared.length}`,
        );
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /ENOENT|not found|not installed/i.test(message);
      const truncated = !missing && /Unexpected end of JSON input/i.test(message);
      const kind = missing ? "missing" : truncated ? "truncated-json" : "other";
      const detail = missing ? "antigravity-usage CLI not on PATH; leaving existing cooldowns alone" : `poll failed: ${message}`;

      if (truncated && !truncatedRetried) {
        // One free immediate retry per INCIDENT, not per occurrence — do
        // not reset this below, or a persistently truncated response would
        // alternate immediate-retry/backoff-step forever and never
        // actually escalate past the first backoff rung.  Only a success
        // or a configuration change (both reset it above) starts a new
        // incident.
        truncatedRetried = true;
        nextAttemptAt = 0;
        failureLog.report(kind, detail);
        return snapshot;
      }
      consecutiveFailures += 1;
      nextAttemptAt = now() + backoffForFailure(consecutiveFailures);
      failureLog.report(kind, detail);
      return snapshot;
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick(true);
      timer = setInterval(() => void tick(false), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    lastSnapshot: () => snapshot,
  };
}

let configuredCheck: (() => boolean) | null = null;

/** Installed by the harness at boot, before `startAntigravityQuotaPoller()`
 * — the module-level default poller below is constructed once at import
 * time, long before `cfg`/the provider registry exist, so it cannot close
 * over them directly the way `createAntigravityQuotaPoller`'s own option
 * does.  This indirection is what lets `server/index.ts` wire a live
 * "is Antigravity configured" query in after the fact, mirroring how
 * `telemetry.configure()` and `infisical.configure()` install a live
 * settings getter post-construction. */
export function configureAntigravityQuotaPoller(isConfigured: (() => boolean) | null): void {
  configuredCheck = isConfigured;
}

const defaultPoller = createAntigravityQuotaPoller({
  isConfigured: () => configuredCheck?.() ?? true,
});

export function startAntigravityQuotaPoller(): void {
  defaultPoller.start();
}

export function stopAntigravityQuotaPoller(): void {
  defaultPoller.stop();
}
