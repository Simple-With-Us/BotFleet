import type { QuotaPlanMetadata } from "../../shared/quota-plan-metadata";
import { formatResetCountdown, isGeminiQuotaModel, type QuotaDisplayLine, type QuotaDisplayModel } from "./quota-display";
import { canonicalQuotaProvider, isSupportedQuotaProvider, normalizeQuotaProviderKey } from "../../server/quota-window-map";

export type UsageMonitorQuotaWindow = {
  id: string;
  provider: string;
  providerKey?: string | null;
  providerLabel?: string | null;
  sourceApp?: string | null;
  source?: string | null;
  via?: string | null;
  label: string;
  remainingPercent?: number | null;
  resetAt?: string | null;
  skip: boolean;
  status?: string | null;
  window?: string | null;
  occurredAt?: string | null;
  modelId?: string | null;
  /** Everything the native handoff publishes beyond a percentage: the plan
   *  the allowance belongs to, what is left of it in dollars, requests or
   *  credits, and the producer's own verdict. */
  planName?: string | null;
  planMetadata?: QuotaPlanMetadata;
  absoluteRemaining?: number | null;
  absoluteLimit?: number | null;
  quotaUnit?: string | null;
  isExhausted?: boolean;
  fileStatus?: string | null;
  fileSkip?: boolean;
  fileSkipReason?: string | null;
};

function normalized(value: string | null | undefined): string {
  return normalizeQuotaProviderKey(value);
}

function providerKey(window: UsageMonitorQuotaWindow): string {
  return canonicalQuotaProvider(window);
}

/** Only providers with a BotFleet engine may appear in its quota section.
 *  The allow-list, the aliases and the exclusions live in
 *  server/quota-window-map.ts so this renderer and the server's own parser
 *  can no longer drift apart over which providers count. */
export function isBotFleetQuotaWindow(window: UsageMonitorQuotaWindow): boolean {
  if (/grok[-_ ]?bot/i.test(`${window.providerKey ?? ""} ${window.provider} ${window.sourceApp ?? ""} ${window.label}`)) return false;
  if (!isSupportedQuotaProvider(window)) return false;
  // A bare OpenAI provider is ambiguous for custom OpenAI-compatible engines.
  // Codex's source identity makes the native subscription window attributable.
  // Tested against the key the row actually reported, so a window that names
  // the product outright ("codex", "chatgpt") stays attributable on its own.
  if (normalized(window.providerKey || window.provider) !== "openai") return true;
  return /codex|chatgpt/i.test(`${window.sourceApp ?? ""} ${window.label}`);
}

/** Unused engines stay hidden even when old spend or local cooldowns exist. */
export function isHiddenQuotaEngine(driverKind: string): boolean {
  const key = driverKind.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/agent$/, "");
  return ["kimi", "moonshot", "geminicli", "githubcopilot", "copilot", "windsurf", "grokbot"].includes(key);
}

/** Legacy Antigravity observations report only the 5-hour pool.  Never turn
 *  monthly prompt credits into a subscription percentage or borrow weekly
 *  readings from a different account/source. */
export function antigravityDisplayWindows(
  windows: UsageMonitorQuotaWindow[],
  models: QuotaDisplayModel[] = [],
  occurredAt?: string,
): UsageMonitorQuotaWindow[] {
  const authoritative = antigravityQuotaWindows(windows);
  if (authoritative.length > 0) return authoritative;
  const legacy = models.filter((model) => !model.isAutocompleteOnly).map((model) => {
    const fraction = model.remainingPercentage;
    const resetAt = model.resetTime && Number.isFinite(Date.parse(model.resetTime)) ? model.resetTime : null;
    const expired = resetAt !== null && Date.parse(resetAt) <= Date.now();
    const percent = expired ? null : model.isExhausted ? 0
      : typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : null;
    return {
      id: `antigravity-local:${model.modelId}`, provider: "google-antigravity", sourceApp: "antigravity-local",
      label: `${isGeminiQuotaModel(model) ? "Gemini Models" : "Third-Party Models"} · 5-hour`,
      window: "5h", remainingPercent: percent, resetAt, skip: false, occurredAt,
    };
  });
  return antigravityQuotaWindows(legacy.length > 0 ? legacy : [{
    id: "antigravity-unreported", provider: "google-antigravity", label: "Gemini Models · 5-hour",
    window: "5h", remainingPercent: null, resetAt: null, skip: false,
  }]);
}

type AntigravityPool = "gemini" | "third-party";
type AntigravityPeriod = "5h" | "weekly";

function poolFor(window: UsageMonitorQuotaWindow): AntigravityPool | null {
  const identity = `${window.label} ${window.providerLabel ?? ""}`.toLowerCase();
  if (identity.includes("gemini")) return "gemini";
  if (/third[ -]?party|claude|gpt|openai|anthropic/.test(identity)) return "third-party";
  return null;
}

function periodFor(window: UsageMonitorQuotaWindow): AntigravityPeriod | null {
  const token = normalized(window.window).replace(/-/g, "");
  if (["weekly", "week", "1w", "7d", "168h", "10080m"].includes(token)) return "weekly";
  if (["5h", "5hr", "5hours", "300m"].includes(token)) return "5h";
  const label = window.label.toLowerCase();
  if (label.includes("weekly")) return "weekly";
  if (label.includes("5-hour") || label.includes("5 hour")) return "5h";
  return null;
}

function finitePercent(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function periodLabel(period: AntigravityPeriod): string {
  return period === "5h" ? "5-hour" : "Weekly";
}

function observedAt(window: UsageMonitorQuotaWindow): number | null {
  if (!window.occurredAt) return null;
  const parsed = Date.parse(window.occurredAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMoreRecent(candidate: UsageMonitorQuotaWindow, prior: UsageMonitorQuotaWindow): boolean {
  const candidateAt = observedAt(candidate);
  const priorAt = observedAt(prior);
  if (candidateAt != null || priorAt != null) {
    if (candidateAt == null) return false;
    if (priorAt == null) return true;
    if (candidateAt !== priorAt) return candidateAt > priorAt;
  }
  return (finitePercent(candidate.remainingPercent) ?? 101) < (finitePercent(prior.remainingPercent) ?? 101);
}

/**
 * Selects the four shared Antigravity pools from Usage Monitor.  A partial
 * response remains four explicit rows with unknown values; no cap is inferred.
 */
export function antigravityQuotaWindows(
  windows: UsageMonitorQuotaWindow[],
): UsageMonitorQuotaWindow[] {
  const candidates = windows.filter((window) => providerKey(window) === "google-antigravity");
  if (candidates.length === 0) return [];

  const selected = new Map<string, UsageMonitorQuotaWindow>();
  for (const window of candidates) {
    const pool = poolFor(window);
    const period = periodFor(window);
    if (!pool || !period) continue;
    const key = `${pool}:${period}`;
    const prior = selected.get(key);
    if (!prior || isMoreRecent(window, prior)) {
      selected.set(key, window);
    }
  }

  const result: UsageMonitorQuotaWindow[] = [];
  for (const pool of ["gemini", "third-party"] as const) {
    for (const period of ["5h", "weekly"] as const) {
      const selectedWindow = selected.get(`${pool}:${period}`);
      result.push(selectedWindow ? {
        ...selectedWindow,
        remainingPercent: finitePercent(selectedWindow.remainingPercent),
        label: `${pool === "gemini" ? "Gemini Models" : "Third-Party Models"} · ${periodLabel(period)}`,
        window: period,
      } : {
        id: `antigravity:${pool}:${period}`,
        provider: "google-antigravity",
        providerKey: "google-antigravity",
        providerLabel: "Antigravity",
        sourceApp: "usage-monitor",
        label: `${pool === "gemini" ? "Gemini Models" : "Third-Party Models"} · ${periodLabel(period)}`,
        remainingPercent: null,
        resetAt: null,
        skip: false,
        status: "unknown",
        window: period,
      });
    }
  }
  return result;
}

/** One quota grid cell's exhaustion verdict, in a single place so the cell
 *  can never redden under an engine chip that says the engine is available.
 *
 *  It reads the producer's own verdict (`isExhausted` / `fileSkip`) beside
 *  the percentage the chip reads, and the server's parser
 *  (server/local-usage-monitor.ts) clears all three together once a window's
 *  reset has passed — so a stale verdict cannot reach any of the three paths
 *  that have to agree: this cell, `headlinesExhausted` above it, and
 *  `applyLocalPayload`'s routing behind it. */
export function isQuotaCellExhausted(window: UsageMonitorQuotaWindow): boolean {
  return window.skip || window.isExhausted === true || window.fileSkip === true || finitePercent(window.remainingPercent) === 0;
}

/** The narrower verdict the Antigravity pools use: those rows come from the
 *  Antigravity poller rather than the handoff and carry no producer verdict
 *  of their own. */
function isExhausted(window: UsageMonitorQuotaWindow): boolean {
  return window.skip || finitePercent(window.remainingPercent) === 0;
}

function windowsForPool(
  windows: UsageMonitorQuotaWindow[],
  pool: AntigravityPool,
): UsageMonitorQuotaWindow[] {
  return antigravityQuotaWindows(windows).filter((window) => poolFor(window) === pool);
}

/** A pool is blocked when any of its reported periods is exhausted. */
export function antigravityPoolBlocked(
  windows: UsageMonitorQuotaWindow[],
  pool: AntigravityPool,
): boolean {
  return windowsForPool(windows, pool).some(isExhausted);
}

/** Both independent Antigravity pools must be blocked before the engine is capped. */
export function antigravityQuotaCapped(windows: UsageMonitorQuotaWindow[]): boolean {
  return antigravityPoolBlocked(windows, "gemini") && antigravityPoolBlocked(windows, "third-party");
}

/** MiniMax video/Hailuo limits remain available as secondary details. */
export function isMiniMaxVideoQuotaWindow(window: {
  provider: string;
  providerKey?: string | null;
  providerLabel?: string | null;
  label: string;
  modelId?: string | null;
}): boolean {
  const key = normalized(window.providerKey || window.provider);
  return key === "minimax" && /\bvideo\b|hailuo/i.test(`${window.label} ${window.providerLabel ?? ""} ${window.modelId ?? ""}`);
}

export function antigravityQuotaLines(windows: UsageMonitorQuotaWindow[]): QuotaDisplayLine[] {
  return antigravityQuotaWindows(windows).map((window) => ({
    label: window.label,
    value: finitePercent(window.remainingPercent) == null ? "not reported" : `${Math.round(window.remainingPercent!)}%`,
    exhausted: window.skip || finitePercent(window.remainingPercent) === 0,
    group: window.label.startsWith("Gemini") ? "gemini" : "external",
  }));
}

export function antigravityQuotaHeadlines(windows: UsageMonitorQuotaWindow[]): string[] {
  return antigravityQuotaWindows(windows).map((window) => {
    const percent = finitePercent(window.remainingPercent);
    const value = percent == null ? "not reported" : `${Math.round(percent)}% available`;
    const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
    const countdown = Number.isFinite(reset) ? formatResetCountdown(reset) : null;
    return countdown ? `${window.label} ${value} · resets in ${countdown}` : `${window.label} ${value}`;
  });
}
