/** Settings → Usage quota row: full per-model / per-window lines for hover and click. */
import { lookupOwn, NEAR_CAP_PERCENT } from "../../server/quota-window-map.ts";

export type QuotaDisplayModel = {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  isAutocompleteOnly?: boolean;
  resetTime?: string;
  timeUntilResetMs?: number;
};

export type QuotaDisplayLine = {
  label: string;
  value: string;
  exhausted: boolean;
  group: "gemini" | "external" | "window";
};

export function isGeminiQuotaModel(model: Pick<QuotaDisplayModel, "label" | "modelId">): boolean {
  return /gemini/i.test(`${model.label} ${model.modelId}`);
}

export function isQuotaModelExhausted(model: QuotaDisplayModel): boolean {
  if (model.isAutocompleteOnly) return false;
  if (model.isExhausted) return true;
  if (typeof model.remainingPercentage !== "number") return true;
  return model.remainingPercentage <= 0;
}

export function remainingPercentLabel(model: QuotaDisplayModel): string {
  if (isQuotaModelExhausted(model)) return "exhausted";
  return `${Math.round((model.remainingPercentage ?? 0) * 100)}%`;
}

/** The two-line Antigravity chip the user actually reads: "Gemini" vs
 *  "Third-Party". Those two buckets each share one remaining-percent
 *  number, so per-model rows are noise. Hover and the expanded panel
 *  use the same two lines (`antigravityQuotaLines`).
 *
 *  Models with no reported remaining percentage are treated as unsampled
 *  (the local antigravity-usage CLI reports N/A until it has seen them).
 *  The group number is the most restrictive reported remaining in that
 *  bucket. The group is exhausted only when every model in it is. */
export type AntigravityGroupSummary = {
  group: "gemini" | "external";
  label: string;
  remainingPercent: number | null;
  exhausted: boolean;
  resetAtMs?: number | null;
  headline?: string;
};

export function antigravityGroupSummary(
  models: QuotaDisplayModel[],
  promptCredits?: { remainingPercentage?: number } | null,
): AntigravityGroupSummary[] {
  const groups: Record<"gemini" | "external", QuotaDisplayModel[]> = { gemini: [], external: [] };
  for (const model of models) {
    if (model.isAutocompleteOnly) continue;
    groups[isGeminiQuotaModel(model) ? "gemini" : "external"].push(model);
  }
  const out: AntigravityGroupSummary[] = [];
  const now = Date.now();
  for (const [group, list] of Object.entries(groups) as Array<["gemini" | "external", QuotaDisplayModel[]]>) {
    if (list.length === 0) continue;
    const reported = list
      .filter((m) => !isQuotaModelExhausted(m))
      .map((m) => m.remainingPercentage)
      .filter((value): value is number => typeof value === "number");
    const exhausted = list.every(isQuotaModelExhausted);
    const remainingPercent = exhausted
      ? 0
      : reported.length > 0
        ? Math.round(Math.min(...reported) * 100)
        : null;

    const resetMsOf = (m: QuotaDisplayModel): number | null => {
      if (m.resetTime) {
        const p = Date.parse(m.resetTime);
        if (Number.isFinite(p)) return p;
      }
      if (typeof m.timeUntilResetMs === "number" && m.timeUntilResetMs > 0) {
        return now + m.timeUntilResetMs;
      }
      return null;
    };

    // The displayed percentage is the most restrictive (lowest) remaining
    // reading in the group, not an average — so the reset countdown next to
    // it must come from the SAME model, not the earliest reset among every
    // model in the group. A model at 10% resetting in 4h alongside one at
    // 90% resetting in 1h must show "resets in 4h", not the unrelated 1h.
    // When every model is exhausted there is no single model behind the 0%,
    // so fall back to the earliest reset among them (whichever comes back
    // first still lifts the group off 0%).
    let earliestResetMs: number | null = null;
    if (exhausted) {
      for (const m of list) {
        const rMs = resetMsOf(m);
        if (rMs) earliestResetMs = earliestResetMs ? Math.min(earliestResetMs, rMs) : rMs;
      }
    } else if (reported.length > 0) {
      const minPercent = Math.min(...reported);
      for (const m of list) {
        if (isQuotaModelExhausted(m)) continue;
        if (m.remainingPercentage !== minPercent) continue;
        const rMs = resetMsOf(m);
        if (rMs) earliestResetMs = earliestResetMs ? Math.min(earliestResetMs, rMs) : rMs;
      }
    }

    const resetCountdown = earliestResetMs ? formatResetCountdown(earliestResetMs) : null;
    const groupName = group === "gemini" ? "Gemini" : "Third-Party";
    const entry: AntigravityGroupSummary = {
      group,
      label: groupName,
      remainingPercent,
      exhausted,
    };
    if (earliestResetMs != null) entry.resetAtMs = earliestResetMs;
    if (earliestResetMs != null || promptCredits?.remainingPercentage != null) {
      const pctStr = exhausted ? "0%" : remainingPercent != null ? `${remainingPercent}% available` : "not reported";
      let headline = `${groupName}: ${pctStr}`;
      if (resetCountdown) {
        headline += ` (5h window, resets in ${resetCountdown})`;
      } else {
        headline += ` (5h window)`;
      }
      entry.headline = headline;
    }

    out.push(entry);
  }
  // Gemini first — the group with the model name in the engine brand.
  out.sort((a, b) => (a.group === "gemini" ? -1 : 1) - (b.group === "gemini" ? -1 : 1));
  return out;
}

export function antigravityQuotaLines(
  models: QuotaDisplayModel[],
  promptCredits?: { remainingPercentage?: number } | null,
): QuotaDisplayLine[] {
  return antigravityGroupSummary(models, promptCredits).map((group) => ({
    label: group.label,
    value: group.exhausted
      ? "exhausted"
      : group.remainingPercent == null
        ? "not reported"
        : `${group.remainingPercent}%`,
    exhausted: group.exhausted,
    group: group.group,
  }));
}

export function quotaLinesSummary(lines: QuotaDisplayLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join(" · ");
}

/** Every driver's `snapshot()` reports `state: "unavailable"` for two very
 *  different situations, distinguishable only by `reason`'s wording:
 *   - never set up: the CLI binary isn't on PATH ("`codex` CLI not found"),
 *     or no credential was ever entered ("no xAI API key — add …", "no Box
 *     token — add …"). Hiding these rows is the Fleet Quotas table's whole
 *     point — a fresh install ships a dozen engines nobody has touched.
 *   - configured but currently broken: a Box token IS set but the API is
 *     unreachable, a CLI is installed but out of date, a login expired. The
 *     user relies on this engine and needs to SEE "Unavailable: <reason>",
 *     not have the row silently vanish as if it never existed.
 *  Match only the first shape's wording, so the second keeps its row. */
export function isEngineUnconfigured(
  reasonOrSnapshot: string | { reason?: string; transient?: boolean } | undefined | null,
): boolean {
  // A probe that gave no answer ("Claude did not answer in time") says
  // nothing about setup: the engine keeps its row while it is re-checked.
  if (reasonOrSnapshot && typeof reasonOrSnapshot === "object" && reasonOrSnapshot.transient) return false;
  const reason = typeof reasonOrSnapshot === "object" ? reasonOrSnapshot?.reason : reasonOrSnapshot;
  if (!reason) return false;
  if (/CLI not found/i.test(reason)) return true;
  if (/^no [\w .-]*\b(?:api key|token)\b/i.test(reason)) return true;
  if (reason === "Disabled in settings") return true;
  return false;
}

export type QuotaWindowDisplay = {
  label: string;
  window?: string | null;
  remainingPercent?: number | null;
  /** ISO timestamp from the upstream poller — when the cap resets. */
  resetAt?: string | null;
  skip: boolean;
};

export function usageWindowLines(windows: QuotaWindowDisplay[]): QuotaDisplayLine[] {
  return windows.map((window) => ({
    label: window.window ? `${window.label} (${window.window})` : window.label,
    value: window.remainingPercent == null ? "not reported" : `${window.remainingPercent}%`,
    exhausted: window.skip,
    group: "window" as const,
  }));
}

/** The user-visible "headline" per engine row: which windows matter for
 *  that engine, what % is left, when each one resets. The cap (chip) state
 *  is computed elsewhere — these are the numbers, not the verdict.
 *
 *  Multiple windows can share a `window` slot (Cursor Pro weekly + Cursor
 *  Hobby weekly); collapse to the most restrictive remaining so the chip
 *  does not look generous when the plan underneath it is spent. Order:
 *  weekly → monthly → 5h → everything else, alphabetic. */
export type WindowHeadline = {
  /** Short, chip-friendly bucket name. */
  bucket: "weekly" | "monthly" | "5h" | string;
  /** Display label: "Weekly", "5h", "Monthly", … */
  display: string;
  remainingPercent: number | null;
  /** epoch ms, or null when the upstream poller did not return a reset. */
  resetAtMs: number | null;
  exhausted: boolean;
  /** Original window that produced this headline (one of the collapsed set). */
  sourceWindow: string | null;
};

const BUCKET_DISPLAY: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  "5h": "5h",
  daily: "Daily",
  hourly: "Hourly",
};

function bucketFor(window: string | null | undefined): string {
  if (!window) return "other";
  const raw = window.toLowerCase();
  if (raw.includes("week")) return "weekly";
  if (raw.includes("month")) return "monthly";
  if (raw === "5h" || raw.includes("5-h") || raw.includes("5 hour") || raw.includes("session")) return "5h";
  if (raw.includes("day")) return "daily";
  if (raw.includes("hour")) return "hourly";
  return raw;
}

function remainingAsNumber(value: number | null | undefined, fallback: number): number {
  // Anti-slop `no-runtime-typeof` wants a parser at the I/O boundary; the
  // boundary is `quotaWindows` coming from the upstream poller, but we
  // always coerce `null`/`undefined` to a sentinel here so the comparator
  // below never has to type-check. The poller contract: number | null.
  if (value == null) return fallback;
  return value;
}

function pickMostRestrictive(group: QuotaWindowDisplay[]): QuotaWindowDisplay {
  // Sort ascending by remaining percent; nulls (no report) sort last so a
  // reported 80% beats an unreported one for "most restrictive".
  return [...group].sort((a, b) => {
    const ap = remainingAsNumber(a.remainingPercent, Number.POSITIVE_INFINITY);
    const bp = remainingAsNumber(b.remainingPercent, Number.POSITIVE_INFINITY);
    if (ap !== bp) return ap - bp;
    // Tie-break: a window that's marked skip (engine refuses to use it) is
    // more restrictive than one that merely reports low %.
    if (a.skip !== b.skip) return a.skip ? -1 : 1;
    return 0;
  })[0];
}

function parseResetAt(resetAt: string | null | undefined): number | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

export function windowHeadlines(windows: QuotaWindowDisplay[]): WindowHeadline[] {
  const grouped = new Map<string, QuotaWindowDisplay[]>();
  for (const window of windows) {
    const bucket = bucketFor(window.window);
    const list = grouped.get(bucket);
    if (list) list.push(window);
    else grouped.set(bucket, [window]);
  }
  const out: WindowHeadline[] = [];
  for (const [bucket, list] of grouped) {
    const pick = pickMostRestrictive(list);
    const remainingPercent = pick.remainingPercent == null ? null : pick.remainingPercent;
    const exhausted = pick.skip || (remainingPercent != null && remainingPercent <= 0);
    out.push({
      bucket,
      // `bucketFor` passes an unrecognised window token through unchanged, so
      // this is indexed with handoff text: a bare read would answer the
      // `Object` function for "constructor" and the `localeCompare` sort below
      // would throw on it.
      display: lookupOwn(BUCKET_DISPLAY, bucket) ?? pick.window ?? bucket,
      remainingPercent: exhausted ? 0 : remainingPercent,
      resetAtMs: parseResetAt(pick.resetAt),
      exhausted,
      sourceWindow: pick.window ?? null,
    });
  }
  const order = (bucket: string): number => {
    if (bucket === "weekly") return 0;
    if (bucket === "monthly") return 1;
    if (bucket === "5h") return 2;
    if (bucket === "daily") return 3;
    if (bucket === "hourly") return 4;
    return 5;
  };
  out.sort((a, b) => order(a.bucket) - order(b.bucket) || a.display.localeCompare(b.display));
  return out;
}

/** "4d 12h" / "12h 14m" / "14m" — coarse on purpose, the chip is the
 *  at-a-glance answer. */
export function formatResetCountdown(resetAtMs: number | null, now = Date.now()): string | null {
  if (resetAtMs == null) return null;
  const diffMs = resetAtMs - now;
  if (diffMs <= 0) return "resetting now";
  const diffSec = Math.floor(diffMs / 1000);
  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

/** How little of a window may be left before the engine chip warns.  One
 *  constant, defined in server/quota-window-map.ts and re-exported here, so
 *  the chip, the grid cell under it and the `near_cap` status the server
 *  derives in server/local-usage-monitor.ts cannot drift apart — and so all
 *  three keep matching the producer, which classifies the same window at the
 *  same 20% before it ever reaches BotFleet.
 *
 *  MiniMax deliberately keeps its own 10% (server/minimax-balance.ts) or the
 *  balance-alert threshold the user set: that is a vendor reading about a
 *  real balance rather than a share BotFleet inferred from a percentage, and
 *  folding it into this constant would silently move MiniMax's alert point. */
export { NEAR_CAP_PERCENT };

/** The chip's own verdict, read off the same headline buckets the grid under
 *  it renders — so a red 0% cell can no longer sit below a green chip. */
export function headlinesExhausted(headlines: WindowHeadline[]): boolean {
  return headlines.some((headline) => headline.exhausted);
}

export function headlinesNearCap(headlines: WindowHeadline[]): boolean {
  return headlines.some(
    (headline) => !headline.exhausted && headline.remainingPercent != null && headline.remainingPercent <= NEAR_CAP_PERCENT,
  );
}

/** What the native handoff publishes beside the percentage. */
export type AbsoluteQuotaView = {
  absoluteRemaining?: number | null;
  absoluteLimit?: number | null;
  quotaUnit?: string | null;
  planName?: string | null;
};

function finiteAmount(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function planTitle(planName: string | null | undefined): string | null {
  const raw = (planName ?? "").trim();
  if (!raw) return null;
  return raw.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function amountLabel(value: number, unit: string): string {
  const figure = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return unit.toUpperCase() === "USD" ? `$${figure}` : figure;
}

/** "$0 of $400 on Ultra", "12 of 300 requests", "Ultra plan" — the numbers
 *  the producer already measured, instead of the bare percentage they were
 *  rounded into. */
export function absoluteQuotaLabel(window: AbsoluteQuotaView): string | null {
  const plan = planTitle(window.planName);
  const remaining = finiteAmount(window.absoluteRemaining);
  const limit = finiteAmount(window.absoluteLimit);
  const unit = (window.quotaUnit ?? "").trim();
  if (remaining == null || limit == null) {
    if (!plan) return null;
    return /\bplans?\b/i.test(plan) ? plan : `${plan} plan`;
  }
  const isMoney = unit.toUpperCase() === "USD";
  const suffix = isMoney || !unit ? "" : ` ${unit}`;
  const amounts = `${amountLabel(remaining, unit)} of ${amountLabel(limit, unit)}${suffix}`;
  return plan ? `${amounts} on ${plan}` : amounts;
}

/** Whether the native app is still writing its handoff, which app that is,
 *  and any provider it could not read — as `/api/quotas` reports it.  Mirrors
 *  server/usage-quota.ts's LocalQuotaView. */
export type LocalQuotaFreshnessView = {
  state?: string | null;
  generatedAt?: string | null;
  ageMs?: number | null;
  producer?: string | null;
  issues?: Record<string, string> | null;
};

/** The app that writes the local handoff.  It names itself in the payload;
 *  the fallback is the menu-bar app that has always written this file, since
 *  the file is the only thing that could say otherwise.
 *
 *  CodeCaps renamed on the wire from `agent-bar` to `codecaps` on 2026-09-20
 *  (PR #22 in Simple-With-Us/codecaps).  Both values resolve to the new
 *  brand in the UI; anything else falls through to "CodeCaps" as the
 *  assumed writer of the local handoff path. */
export function quotaProducerLabel(producer?: string | null): string {
  const value = (producer ?? "").trim().toLowerCase();
  if (value === "usage-monitor") return "Usage Monitor";
  if (value === "codecaps" || value === "agent-bar") return "CodeCaps";
  return "CodeCaps";
}

/** Sentence-case status line for an empty quota grid, or null while the
 *  handoff is live.  An empty grid with no explanation is what let the
 *  native app quit unnoticed. */
export function localQuotaStatusLine(freshness: LocalQuotaFreshnessView | null | undefined): string | null {
  const state = freshness?.state ?? "";
  if (state === "" || state === "fresh") return null;
  const producer = quotaProducerLabel(freshness?.producer);
  if (state === "missing") return `${producer} is not running, so no local subscription quota is available`;
  if (state === "stale") {
    const written = freshness?.generatedAt ? Date.parse(freshness.generatedAt) : Number.NaN;
    // Viewer timezone, the same as the reset hovers in the grid.
    const at = Number.isFinite(written)
      ? new Date(written).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : null;
    return at
      ? `${producer} has not written quota since ${at}`
      : `${producer} has not written quota recently`;
  }
  return `${producer}'s quota file could not be read`;
}

/** "Claude: sign in again to refresh quota (from CodeCaps)" — the reason a
 *  provider reported nothing, attributed to the app that measured it.  The
 *  reason is the producer's own user-safe text: rendered as plain text,
 *  never markup, and capped again here in case it reached this module by
 *  some path other than the server parser. */
export function providerIssueLine(
  engineName: string,
  reason: string | null | undefined,
  producer?: string | null,
): string | null {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 160).trim();
  if (!text) return null;
  return `${engineName}: ${text} (from ${quotaProducerLabel(producer)})`;
}

export type MiniMaxQuotaStatus = "ok" | "near_cap" | "capped" | "unknown";

/** Structural subset of server/minimax-balance.ts's MiniMaxBalanceSnapshot —
 *  redeclared rather than imported so this stays a dependency-free pure
 *  module other UI surfaces can use without pulling in the server client. */
export type MiniMaxQuotaView = {
  source: "account-balance" | "token-plan" | "unavailable";
  status: MiniMaxQuotaStatus;
  balanceUsd: number | null;
  remainingPercent: number | null;
  secondaryRemainingPercent: number | null;
  /** The 5-hour ("interval") window's own reset. */
  resetsAt: number | null;
  /** The weekly window's own reset — kept separate so the line can name
   *  whichever window is actually BINDING (at 0%) rather than always the
   *  5-hour one, e.g. when the weekly allowance is exhausted but the 5-hour
   *  window still has quota left. */
  weeklyResetsAt: number | null;
};

/** One status vocabulary for MiniMax's quota row, whichever of the two
 *  undocumented endpoints answered (server/minimax-balance.ts). Null when
 *  there is nothing worth a line (unavailable source, or a response with no
 *  usable figures) — the caller falls back to its own generic "Active and
 *  ready for turns" line, exactly like deepseek-balance.ts's contract: an
 *  absent/errored figure hides the line, it never fabricates one.
 *
 *  Live-verified 2026-09-13: the Token Plan sentence is "N% left this week,
 *  N% left in the current 5 h window, resets at H:MM" — weekly first, then
 *  the 5-hour figure, then when the 5-hour window (the recurring, actionable
 *  one) comes back, as a clock time rather than a countdown, matching the
 *  "resets at H:MM" convention server/index.ts's own quota line already
 *  uses.  When the WEEKLY window is the binding one instead, the clause
 *  becomes a countdown ("resets in 3d 4h") — that reset can be days away
 *  and a clock time alone would read as later today. `row.resetsAt` here is
 *  specifically the 5-hour window's own reset
 *  (server/minimax-balance.ts keeps it separate from the "soonest of either
 *  window" figure the registry.ts per-model merge uses instead). A weekly
 *  figure above 100% (MiniMax's own boosted-allowance scaling,
 *  server/minimax-balance.ts's parseWeeklyPercent) says so explicitly
 *  rather than reading like a typo. `now` defaults to the real clock and
 *  exists so a test can pin it; when the cached snapshot has outlived its
 *  own window (the 5-minute balance cache can outlive a 5-hour window's
 *  reset), a reset time already in the past reads "resets soon" instead of
 *  a stale clock time. */
export function minimaxQuotaLine(row: MiniMaxQuotaView, now: number = Date.now()): string | null {
  if (row.source === "unavailable") return null;
  if (row.source === "account-balance") {
    if (row.balanceUsd == null) return null;
    const amount = row.balanceUsd <= 0 ? "$0.00 remaining" : `$${row.balanceUsd.toFixed(2)} remaining`;
    if (row.status === "capped") return "at usage cap — balance exhausted";
    if (row.status === "near_cap") return `${amount} · near cap`;
    return amount;
  }
  const parts: string[] = [];
  if (row.secondaryRemainingPercent != null) {
    const boosted = row.secondaryRemainingPercent > 100 ? " of a boosted allowance" : "";
    parts.push(`${Math.round(row.secondaryRemainingPercent)}% left this week${boosted}`);
  }
  if (row.remainingPercent != null) parts.push(`${Math.round(row.remainingPercent)}% left in the current 5 h window`);
  if (parts.length === 0) return null;
  let line = parts.join(", ");
  // Name whichever window is actually BINDING: if the weekly allowance is
  // the one at 0% (even while the 5-hour window still has room), its reset
  // is what the user is actually waiting on — not the 5-hour window's,
  // which would read as "back in 20 minutes" while the account still
  // cannot place a call for days.
  const weeklyBinds = row.secondaryRemainingPercent != null && row.secondaryRemainingPercent <= 0;
  const bindingResetsAt = weeklyBinds ? row.weeklyResetsAt : row.resetsAt;
  if (bindingResetsAt != null) {
    if (bindingResetsAt <= now) line += ", resets soon";
    // A weekly reset can be up to seven days out, and a bare clock time
    // drops the day entirely — "resets at 3:00 PM" on a Thursday-morning
    // block reads as this afternoon.  The countdown this file already
    // exports says "3d 4h", which cannot be mistaken for today.  The
    // 5-hour window keeps the clock time: it is always under five hours
    // away, so the day is never in question there.
    else if (weeklyBinds) line += `, resets in ${formatResetCountdown(bindingResetsAt, now)}`;
    else line += `, resets at ${new Date(bindingResetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return line;
}

/** Generalizes the "5hr" / "5hr/Week" dual-window badge — previously
 *  computed only for Antigravity (antigravity-quota.ts) and, since MiniMax's
 *  Token Plan quota client shipped, MiniMax (server/minimax-balance.ts,
 *  merged in server/harness/registry.ts) — to any engine whose Usage
 *  Monitor headlines include a 5h and/or a weekly bucket: Claude, Codex,
 *  Cursor, Kimi, Grok, DSH and DeepSeek only ever get windows through
 *  quota-window-map.ts's mapping (established fact, not this file's own
 *  data), and had no equivalent combined label at all before this. */
export function windowsLabelFromHeadlines(headlines: WindowHeadline[]): string | undefined {
  const has5h = headlines.some((h) => h.bucket === "5h");
  const hasWeekly = headlines.some((h) => h.bucket === "weekly");
  const hasMonthly = headlines.some((h) => h.bucket === "monthly");
  const hasDaily = headlines.some((h) => h.bucket === "daily");
  const hasHourly = headlines.some((h) => h.bucket === "hourly");

  const primary = has5h ? "5hr" : hasHourly ? "Hour" : hasDaily ? "Day" : undefined;
  const secondary = hasWeekly ? "Week" : hasMonthly ? "Month" : undefined;

  if (primary && secondary) return `${primary}/${secondary}`;
  if (primary) return primary;
  if (secondary) return secondary;
  return undefined;
}

/** Formats dual-window quota percentage for ModelPicker row.
 *  When both primary (5h) and secondary (weekly/monthly) percentages exist: "(XX% / YY% for 5h / w)".
 *  When only primary exists: "(XX% for 5h)" if a windows label exists, or "XX% left" otherwise. */
export function formatDualQuotaBadge(
  remainingPercent?: number | null,
  secondaryRemainingPercent?: number | null,
  options?: { windowsLabel?: string },
): string | null {
  if (remainingPercent == null && secondaryRemainingPercent == null) return null;
  const p1 = remainingPercent != null ? Math.round(remainingPercent) : null;
  const p2 = secondaryRemainingPercent != null ? Math.round(secondaryRemainingPercent) : null;
  
  let suffix = "";
  if (options?.windowsLabel) {
    let w = options.windowsLabel.toLowerCase();
    w = w.replace(/hr/g, "h");
    w = w.replace(/hour/g, "h");
    w = w.replace(/week/g, "w");
    w = w.replace(/month/g, "m");
    w = w.replace(/day/g, "d");
    w = w.replace(/\//g, " / ");
    suffix = ` for ${w}`;
  }

  if (p1 != null && p2 != null) {
    return `(${p1}% / ${p2}%${suffix})`;
  }
  if (p1 != null) {
    return options?.windowsLabel ? `(${p1}%${suffix})` : `${p1}% left`;
  }
  if (p2 != null) {
    return `(${p2}%${suffix})`;
  }
  return null;
}

