import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadLocalMiniMaxConfig } from "./drivers/minimax.ts";
import { quotaCooldowns, type QuotaCooldownRegistry } from "./model-fallback.ts";

// Reads the user's MiniMax account balance / Token Plan quota and serves it
// to the Settings → Usage UI. A peer of deepseek-balance.ts, same cache and
// timeout shape, deliberately never injected into any engine's process
// environment — this only ever reads the same key the MiniMax driver already
// resolved, it never adds a new credential surface.
//
// MiniMax's PUBLIC docs (platform.minimax.io/docs — api-reference/api-overview,
// faq/about-account, faq/about-apis, guides/pricing-paygo, token-plan/intro;
// checked 2026-09-13) document no balance/quota API at all: every number
// there — cash balance, voucher balance, credits, Token Plan usage — lives
// only in the web dashboard (platform.minimax.io/user-center/payment/balance).
//
// MiniMax's own OFFICIAL `mmx-cli` npm package (published by npm user
// `minimax-ai`, the same account whose `mmx quota show` this driver's
// sign-in copy already tells users to run) proves two real endpoints exist —
// just never documented — by shipping a `quota show` command backed by them.
// Recovered by reading the published bundle (mmx-cli@1.0.25, dist/sdk.mjs):
//
//   - Pay-as-you-go SECRET keys (start with "sk-api-"):
//       GET {base}/account/query_balance
//       -> { available_amount, cash_balance, voucher_balance, credit_balance,
//            owed_amount, balance_alert_switch, balance_alert_threshold,
//            base_resp }  (all amount fields are decimal strings, USD)
//   - Token Plan / subscription keys (anything else, incl. OAuth tokens):
//       GET {base}/v1/token_plan/remains
//       -> { model_remains: [{ model_name, current_interval_remaining_percent,
//            current_weekly_remaining_percent, end_time, weekly_end_time,
//            current_interval_status, current_weekly_status, … }] }
//
// Both take `Authorization: Bearer <key>` and report success via
// `base_resp.status_code === 0` (nonzero is an error, message in
// `status_msg`). `{base}` is the bare region host (https://api.minimax.io, or
// https://api.minimaxi.com for "cn") — NOT the /v1-suffixed apiUrl the
// minimax.ts driver builds for chat completions.
//
// Live-verified 2026-09-13 by the coordinating agent running `mmx quota
// show` against a real Token Plan account on this Mac (no secrets involved —
// only the response SHAPE was recorded).  The `/v1/token_plan/remains` shape
// is now pinned, not inferred:
//   - `model_remains[]` has one row per product, `model_name` distinguishing
//     them ("general" is the chat/text quota this file surfaces as the
//     headline; other rows — "video" observed — are kept in `models` for
//     display but never blended into the top-line numbers, since they are
//     unrelated quota pools).
//   - `current_interval_remaining_percent` / `current_weekly_remaining_percent`
//     are always integers 0..100 (observed 100 and 94) — never a fraction.
//   - `start_time` / `end_time` / `weekly_start_time` / `weekly_end_time` are
//     always epoch MILLISECONDS (observed ~1.79e12-scale values, and
//     `end_time - start_time` is exactly 18,000,000 ms = 5 hours;
//     `weekly_end_time - weekly_start_time` is exactly 7 days).
//     `remains_time` / `weekly_remains_time` are milliseconds REMAINING
//     (a duration, not an absolute time) — used only as a fallback when the
//     absolute `_time` field is missing.
//   - `current_interval_status` / `current_weekly_status` are integers; only
//     `1` ("active") is confirmed. Any other value (or absence) is genuinely
//     unknown and is never read as "capped" — that comes from the percent
//     fields alone.
//   - `current_interval_total_count` / `current_interval_usage_count` (and
//     the weekly pair) are raw counts (0 for "general", small integers for
//     "video") with no confirmed relationship to the percent fields — never
//     used to derive a percentage.
//
// Undocumented still means unstable elsewhere (which endpoint answers for a
// given key, whether a field disappears), so parsing stays defensive and any
// failure degrades to an "unavailable" snapshot with `error` set — it never
// throws into the /api/quotas response, the same contract deepseek-balance.ts
// makes.

export type MiniMaxBalanceSource = "account-balance" | "token-plan" | "unavailable";
export type MiniMaxBalanceStatus = "ok" | "near_cap" | "capped" | "unknown";

/** "active" is the only status value confirmed live; everything else
 *  (including a field that's absent) is "unknown" rather than a guess. */
export type MiniMaxWindowStatus = "active" | "unknown";

export type MiniMaxModelQuota = {
  /** 0–100 integer. The 5-hour ("interval") window, when reported for this
   *  model. */
  remainingPercent: number | null;
  /** 0–100 integer. The weekly window, when reported. Null (not undefined)
   *  when the model only has an interval window — matches
   *  antigravity-quota.ts's contract so the two can share a renderer. */
  secondaryRemainingPercent: number | null;
  /** "5hr/Week" when both windows are known, "5hr" when only the interval
   *  is — same vocabulary antigravity-quota.ts uses. */
  windowsLabel: string | undefined;
  /** Epoch ms of the sooner of the two window resets — feeds
   *  registry.ts's per-model dual-window merge, mirroring
   *  antigravity-quota.ts's single resetsAt-per-model shape. */
  resetsAt: number | null;
  /** The 5-hour window's own reset, kept separate from the combined
   *  `resetsAt` above so a caller that specifically means "when does the
   *  recurring 5h window come back" (minimaxQuotaLine) doesn't have to
   *  guess which of the two `resetsAt` actually is. */
  intervalResetsAt: number | null;
  weeklyResetsAt: number | null;
  intervalStatus: MiniMaxWindowStatus;
  weeklyStatus: MiniMaxWindowStatus;
};

export type MiniMaxBalanceSnapshot = {
  /** Which undocumented endpoint answered, or "unavailable" when neither
   *  did (no key, network failure, or an unrecognized response shape). */
  source: MiniMaxBalanceSource;
  /** Whether MiniMax reported a real cap/balance figure at all — false only
   *  when the account has no discoverable ceiling ("unavailable"). */
  capExists: boolean;
  status: MiniMaxBalanceStatus;
  /** USD remaining, pay-as-you-go accounts only. */
  balanceUsd: number | null;
  /** 0–100 integer, the "general" (chat) model's 5-hour window. Token Plan
   *  accounts only — other model rows ("video", …) are unrelated quota
   *  pools and never blended into this headline figure; see `models`. */
  remainingPercent: number | null;
  /** 0–100 integer, the "general" model's weekly window. */
  secondaryRemainingPercent: number | null;
  windowsLabel: string | undefined;
  /** Per-model breakdown for EVERY row the endpoint reported (chat, video,
   *  …), Token Plan accounts only — kept for display even though only
   *  "general" feeds the headline fields above. Mirrors
   *  antigravity-quota.ts's per-model shape so both can feed the same
   *  registry.ts dual-window merge. */
  models: Record<string, MiniMaxModelQuota> | null;
  /** Epoch ms the "general" model's 5-hour window resets — the actionable,
   *  recurring one minimaxQuotaLine names. */
  resetsAt: number | null;
  /** Epoch ms the "general" model's weekly window resets. */
  weeklyResetsAt: number | null;
  fetchedAt: number;
  /** Set when the key is missing, the request failed, or the response was
   *  not parseable. The UI hides quota detail when this is set, the same
   *  contract deepseek-balance.ts uses. */
  error: string | null;
};

const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;
/** MiniMax's own "balance alert" feature is the user's own chosen low-balance
 *  threshold — reuse it as "near cap" instead of picking an arbitrary
 *  percentage no one asked for. */
const NEAR_CAP_PERCENT = 10;

type CacheEntry = {
  expiresAt: number;
  inflight: Promise<MiniMaxBalanceSnapshot> | null;
  value: MiniMaxBalanceSnapshot;
};

/** One slot per (key, url) pair, not one shared slot — a single module-level
 *  slot meant two MiniMax instances would fight over it: instance B's fetch
 *  would overwrite instance A's cache entry, so A's next 30s poll missed
 *  the cache too, and neither instance was ever actually served from
 *  cache. Keyed by a HASH of (key, url), never the raw key itself, so the
 *  API key never sits in memory as a plain-text map key. */
const cacheByHash = new Map<string, CacheEntry>();

function cacheKeyFor(key: string, url: string): string {
  // JSON.stringify a tuple rather than concatenating with a separator
  // character: any fixed separator risks a collision between (key + url)
  // pairs that differ only in where the boundary falls, and JSON already
  // escapes both strings unambiguously.
  return createHash("sha256").update(JSON.stringify([key, url])).digest("hex");
}

function emptySnapshot(now: number, error: string | null): MiniMaxBalanceSnapshot {
  return {
    source: "unavailable",
    capExists: false,
    status: "unknown",
    balanceUsd: null,
    remainingPercent: null,
    secondaryRemainingPercent: null,
    windowsLabel: undefined,
    models: null,
    resetsAt: null,
    weeklyResetsAt: null,
    fetchedAt: now,
    error,
  };
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Live-verified 2026-09-13: current_interval_remaining_percent and
 *  current_weekly_remaining_percent are always integers 0..100 (observed
 *  100 and 94) — never a 0–1 fraction. Clamped defensively in case a future
 *  response goes out of range; never rescaled. */
function parsePercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** MiniMax's own client (mmx-cli's sdk.mjs) scales the weekly percent by
 *  `weekly_boost_permille / 1000` and clamps at 200, not 100 — a "boosted"
 *  weekly allowance (a promo, a plan upgrade mid-week, …) can legitimately
 *  read above 100%. No boost field (or a non-positive one) is a 1.0x
 *  factor, matching the un-boosted case exactly. There is no interval-side
 *  equivalent field, so the 5-hour figure stays on the plain parsePercent
 *  above. */
function parseWeeklyPercent(raw: unknown, boostPermille: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const boost = typeof boostPermille === "number" && Number.isFinite(boostPermille) && boostPermille > 0
    ? boostPermille
    : 1000;
  return Math.min(200, Math.max(0, Math.round(raw * (boost / 1000))));
}

/** Live-verified 2026-09-13: start_time/end_time/weekly_start_time/
 *  weekly_end_time are always epoch MILLISECONDS (observed ~1.79e12-scale
 *  values) — never seconds. No unit-guessing: just validate and pass
 *  through. */
function parseEpochMs(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/** `remains_time` / `weekly_remains_time` are milliseconds REMAINING (a
 *  duration), used only when the absolute `_time` field is missing. */
function parseResetMs(absoluteMs: unknown, remainingMs: unknown, now: number): number | null {
  const absolute = parseEpochMs(absoluteMs);
  if (absolute != null) return absolute;
  if (typeof remainingMs === "number" && Number.isFinite(remainingMs) && remainingMs > 0) {
    return now + remainingMs;
  }
  return null;
}

/** Live-verified 2026-09-13: `1` ("active") is the only confirmed status
 *  value. Anything else — including a value never seen — is genuinely
 *  unknown, not a capped signal; "capped" comes only from the percent
 *  fields via statusFromPercent. */
function parseWindowStatus(raw: unknown): MiniMaxWindowStatus {
  return raw === 1 ? "active" : "unknown";
}

function normalizeBase(url: string | undefined): string {
  let href = (url ?? "").trim();
  if (!href) return "https://api.minimax.io";
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  href = href.replace(/\/+$/, "");
  // minimax.ts's own apiUrl (config.url / local.url) is always /v1-suffixed
  // for chat completions; both balance endpoints hang off the bare host.
  return href.replace(/\/v1$/i, "");
}

/** Matches mmx-cli's own selectUsageEndpoint: a pay-as-you-go SECRET key
 *  reads the wallet; anything else (a Token Plan / subscription key, or an
 *  OAuth-issued token) reads the Token Plan quota. */
function isSecretApiKey(key: string): boolean {
  return key.trim().startsWith("sk-api-");
}

function statusFromPercent(percent: number | null): MiniMaxBalanceStatus {
  if (percent == null) return "unknown";
  if (percent <= 0) return "capped";
  if (percent <= NEAR_CAP_PERCENT) return "near_cap";
  return "ok";
}

function parseAccountBalanceResponse(body: Record<string, unknown>, now: number): MiniMaxBalanceSnapshot {
  const balance = parseAmount(body.available_amount);
  const alertOn = body.balance_alert_switch === true;
  const threshold = parseAmount(body.balance_alert_threshold);
  let status: MiniMaxBalanceStatus = "unknown";
  if (balance != null) {
    status = balance <= 0 ? "capped" : alertOn && threshold != null && balance <= threshold ? "near_cap" : "ok";
  }
  return {
    source: "account-balance",
    capExists: balance != null,
    status,
    balanceUsd: balance,
    remainingPercent: null,
    secondaryRemainingPercent: null,
    windowsLabel: undefined,
    models: null,
    resetsAt: null,
    weeklyResetsAt: null,
    fetchedAt: now,
    error: null,
  };
}

/** `model_remains[]` has one row per product ("general" is chat, "video" is
 *  video generation, …) — genuinely separate quota pools, not alternate
 *  readings of the same one. The headline fields only ever come from
 *  "general"; every row (including "general") still lands in `models` so a
 *  future UI can show "video" quota too. */
const CHAT_MODEL_NAME = "general";

function parseModelRow(raw: unknown, now: number): { name: string; quota: MiniMaxModelQuota } | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const modelName = typeof row.model_name === "string" && row.model_name ? row.model_name : null;
  if (!modelName) return null;
  const interval = parsePercent(row.current_interval_remaining_percent);
  const weekly = parseWeeklyPercent(row.current_weekly_remaining_percent, row.weekly_boost_permille);
  const intervalResetsAt = parseResetMs(row.end_time, row.remains_time, now);
  const weeklyResetsAt = parseResetMs(row.weekly_end_time, row.weekly_remains_time, now);
  const resetsAt = intervalResetsAt != null && weeklyResetsAt != null
    ? Math.min(intervalResetsAt, weeklyResetsAt)
    : intervalResetsAt ?? weeklyResetsAt;
  return {
    name: modelName,
    quota: {
      remainingPercent: interval,
      secondaryRemainingPercent: weekly,
      windowsLabel: weekly != null ? "5hr/Week" : interval != null ? "5hr" : undefined,
      resetsAt,
      intervalResetsAt,
      weeklyResetsAt,
      // current_interval_total_count / current_interval_usage_count (and the
      // weekly pair) are raw counts with no confirmed relationship to the
      // percent fields — deliberately not read here; never derive a percent
      // from a count.
      intervalStatus: parseWindowStatus(row.current_interval_status),
      weeklyStatus: parseWindowStatus(row.current_weekly_status),
    },
  };
}

function parseTokenPlanResponse(body: Record<string, unknown>, now: number): MiniMaxBalanceSnapshot {
  const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
  if (rows.length === 0) {
    return { ...emptySnapshot(now, null), source: "token-plan" };
  }
  const models: Record<string, MiniMaxModelQuota> = {};
  let chatModel: MiniMaxModelQuota | null = null;
  for (const raw of rows) {
    const parsed = parseModelRow(raw, now);
    if (!parsed) continue;
    models[parsed.name] = parsed.quota;
    if (parsed.name === CHAT_MODEL_NAME) chatModel = parsed.quota;
  }
  if (!chatModel) {
    // No "general" row: MiniMax changed its own schema, or this account has
    // no chat quota. Every other row (video, …) still lands in `models` for
    // display — there is just no headline to report.
    return {
      source: "token-plan",
      capExists: Object.keys(models).length > 0,
      status: "unknown",
      balanceUsd: null,
      remainingPercent: null,
      secondaryRemainingPercent: null,
      windowsLabel: undefined,
      models,
      resetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: now,
      error: null,
    };
  }
  const mostRestrictive = chatModel.remainingPercent != null && chatModel.secondaryRemainingPercent != null
    ? Math.min(chatModel.remainingPercent, chatModel.secondaryRemainingPercent)
    : chatModel.remainingPercent ?? chatModel.secondaryRemainingPercent;
  return {
    source: "token-plan",
    capExists: true,
    status: statusFromPercent(mostRestrictive),
    balanceUsd: null,
    remainingPercent: chatModel.remainingPercent,
    secondaryRemainingPercent: chatModel.secondaryRemainingPercent,
    windowsLabel: chatModel.windowsLabel,
    models,
    resetsAt: chatModel.intervalResetsAt,
    weeklyResetsAt: chatModel.weeklyResetsAt,
    fetchedAt: now,
    error: null,
  };
}

async function fetchOnce(key: string, url: string | undefined, signal: AbortSignal): Promise<MiniMaxBalanceSnapshot> {
  const now = Date.now();
  const trimmedKey = key.trim();
  if (!trimmedKey) return emptySnapshot(now, "no key configured");
  const base = normalizeBase(url);
  const endpoint = isSecretApiKey(trimmedKey) ? `${base}/account/query_balance` : `${base}/v1/token_plan/remains`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${trimmedKey}`, accept: "application/json" },
      signal,
    });
    if (!response.ok) return emptySnapshot(now, `HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object") return emptySnapshot(now, "malformed response");
    const record = body as Record<string, unknown>;
    const baseResp = record.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
    if (typeof baseResp?.status_code === "number" && baseResp.status_code !== 0) {
      const message = typeof baseResp.status_msg === "string" && baseResp.status_msg
        ? baseResp.status_msg
        : `MiniMax error ${baseResp.status_code}`;
      return emptySnapshot(now, message);
    }
    if ("available_amount" in record) return parseAccountBalanceResponse(record, now);
    if ("model_remains" in record) return parseTokenPlanResponse(record, now);
    return emptySnapshot(now, "unrecognized response shape");
  } catch (err) {
    return emptySnapshot(now, err instanceof Error ? err.message : String(err));
  }
}

/** Returns the cached snapshot when the same (key, url) is requested within
 *  the TTL; otherwise fetches fresh and shares the in-flight promise across
 *  concurrent callers for that SAME (key, url) — identical contract to
 *  getDeepSeekBalance, so a Settings panel that mounts twice in 5 minutes
 *  does not double-ping MiniMax, and each MiniMax instance's per-describe
 *  call rides its own cache slot independently of every other instance's. */
export async function getMiniMaxBalance(key: string | undefined, url: string | undefined): Promise<MiniMaxBalanceSnapshot> {
  const safeKey = (key ?? "").trim();
  const safeUrl = (url ?? "").trim();
  const now = Date.now();
  const hash = cacheKeyFor(safeKey, safeUrl);
  const existing = cacheByHash.get(hash);
  if (existing) {
    if (existing.expiresAt > now && existing.inflight === null) return existing.value;
    if (existing.inflight) return existing.inflight;
  }
  const inflight = (async () => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, FETCH_TIMEOUT_MS);
    let value: MiniMaxBalanceSnapshot;
    try {
      value = await fetchOnce(safeKey, safeUrl, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) value = { ...value, error: "timeout" };
    // Look the slot up fresh by hash rather than closing over the object
    // created below — a concurrent call for a DIFFERENT (key, url) never
    // touches this hash's slot, so this always updates the right one.
    const current = cacheByHash.get(hash);
    if (current) {
      current.inflight = null;
      current.expiresAt = Date.now() + CACHE_TTL_MS;
      current.value = value;
    }
    return value;
  })();
  cacheByHash.set(hash, { expiresAt: now + CACHE_TTL_MS, inflight, value: emptySnapshot(0, safeKey ? null : "no key configured") });
  return inflight;
}

export function invalidateMiniMaxBalance(): void {
  cacheByHash.clear();
}

/** Instance id the registry/botfleet wiring uses for the reserved
 *  MiniMax entry (mirrors `RESERVED_INSTANCE_ID` in drivers/minimax.ts
 *  but kept as a local literal to avoid a cross-module dependency on
 *  the driver module — both files agree because `instanceConfigs()` in
 *  server/config.ts's `DEFAULT_FLEET` declares it under this name). */
const MINIMAX_INSTANCE_ID = "minimax";

/** Marker the registry uses to attribute a broadcast cooldown to this
 *  module. Reuses the convention `antigravity-quota.ts`'s source string
 *  established, so a caller asking "which publishers are still claiming
 *  this cap?" sees a uniform shape across both engines. */
const MINIMAX_ACCOUNT_SOURCE = "minimax-account-balance";

/** True iff the snapshot says the SHARED account (wallet empty, or
 *  every quota pool below 1%) cannot place a chat call. Per
 *  server/harness/registry.ts's own `walletExhausted` verdict:
 *  a pay-as-you-go account that returns `status: "capped"` with no
 *  `general` pool is a wallet that cannot pay for any catalog turn;
 *  a Token Plan whose `general` row reads 0% on both windows is the
 *  chat quota that runs every chat call. Either verdict means the
 *  whole instance is dark. */
function isAccountLevelCap(snapshot: MiniMaxBalanceSnapshot): boolean {
  if (snapshot.status !== "capped") return false;
  if (snapshot.source === "account-balance") return true;
  // Token Plan: only the "general" pool governs chat calls; an
  // exhausted "video" pool must not mislabel chat models (see
  // server/harness/registry.ts). Cap on `general` means the whole
  // instance is dark; cap on anything else is a no-op here.
  const general = snapshot.models?.general;
  if (!general) return false;
  const interval = general.remainingPercent;
  const weekly = general.secondaryRemainingPercent;
  const intervalCap = interval != null && interval <= 0;
  const weeklyCap = weekly != null && weekly <= 0;
  return intervalCap || weeklyCap;
}

/** Broadcast a MiniMax account-level cap to every bot that reaches for
 *  the instance, so an exhausted wallet on bot A is not re-paged by bot
 *  B five seconds later. Mirrors `applyAntigravityUsageToRegistry`'s
 *  contract (server/antigravity-quota.ts): the registry's `get()` falls
 *  back to `*:instance:model` after the per-bot row, so a single
 *  wildcard write covers every caller without a per-bot record.
 *
 *  Returns the model rows still flagged as capped for callers that
 *  want to publish them on `ProviderSnapshot.quota.models`. Never
 *  throws: a registry write failure is logged and swallowed, since
 *  reading balance must not regress to a hard error.
 *
 *  Clears prior `minimax-account-balance` rows first so a recovered
 *  balance (status flipped back to `ok`/`near_cap`) lifts the cap
 *  immediately, instead of waiting out the registry's TTL. */
export function applyMiniMaxBalanceToRegistry(
  snapshot: MiniMaxBalanceSnapshot,
  registry: QuotaCooldownRegistry = quotaCooldowns,
): { capped: boolean } {
  const previouslyCappedModels = registry.list()
    .filter((cd) => cd.instanceId === MINIMAX_INSTANCE_ID && cd.source === MINIMAX_ACCOUNT_SOURCE)
    .map((cd) => cd.model);
  // Drop the prior broadcast (any model — see wildcard branch below) so
  // a recovered balance releases the cap without waiting on TTL.
  for (const model of previouslyCappedModels) {
    registry.clearWhere((cd) =>
      cd.instanceId === MINIMAX_INSTANCE_ID
      && cd.source === MINIMAX_ACCOUNT_SOURCE
      && cd.model === model,
    );
  }
  if (!isAccountLevelCap(snapshot)) return { capped: false };
  const resetsAt = pickResetsAt(snapshot);
  registry.recordInstanceCap(MINIMAX_INSTANCE_ID, "*", {
    resetsAt,
    error: snapshot.source === "account-balance"
      ? "MiniMax account balance exhausted"
      : "MiniMax Token Plan exhausted",
    source: MINIMAX_ACCOUNT_SOURCE,
  });
  return { capped: true };
}

function pickResetsAt(snapshot: MiniMaxBalanceSnapshot): number | null {
  if (snapshot.source === "account-balance") return null;
  const general = snapshot.models?.general;
  if (!general) return null;
  const interval = general.intervalResetsAt ?? general.resetsAt ?? null;
  const weekly = general.weeklyResetsAt ?? null;
  if (interval != null && weekly != null) return Math.min(interval, weekly);
  if (interval != null) return interval;
  if (weekly != null) return weekly;
  return null;
}

type LocalMiniMaxConfig = ReturnType<typeof loadLocalMiniMaxConfig>;

type LocalConfigCacheEntry = {
  mtimeMs: number | null;
  expiresAt: number;
  value: LocalMiniMaxConfig;
};

let localConfigCache: LocalConfigCacheEntry | null = null;

function statMmxConfig(): { mtimeMs: number } | null {
  try {
    return statSync(join(homedir(), ".mmx", "config.json"));
  } catch {
    return null;
  }
}

/** loadLocalMiniMaxConfig() (server/drivers/minimax.ts) does a synchronous
 *  readFileSync + JSON.parse every call — cheap once, but registry.ts's
 *  describe() (per instance, per poll) and /api/quotas both called it on
 *  every request. Cached for the same 5-minute TTL as the balance itself,
 *  keyed on the config file's own mtime so an `mmx auth login` mid-window
 *  is picked up immediately rather than waiting out the TTL — a stat()
 *  call replaces the read+parse on every cache hit, far cheaper than
 *  either the old unconditional read or a naive time-only cache that would
 *  miss an edit for up to 5 minutes. */
export function getCachedLocalMiniMaxConfig(opts: {
  now?: number;
  stat?: () => { mtimeMs: number } | null;
  load?: () => LocalMiniMaxConfig;
} = {}): LocalMiniMaxConfig {
  const now = opts.now ?? Date.now();
  const stat = opts.stat ?? statMmxConfig;
  const load = opts.load ?? loadLocalMiniMaxConfig;
  const mtimeMs = stat()?.mtimeMs ?? null;
  if (localConfigCache && localConfigCache.mtimeMs === mtimeMs && localConfigCache.expiresAt > now) {
    return localConfigCache.value;
  }
  const value = load();
  localConfigCache = { mtimeMs, expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

export function invalidateLocalMiniMaxConfigCache(): void {
  localConfigCache = null;
}
