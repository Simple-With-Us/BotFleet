// Reads the user's DeepSeek account balance and serves it to the Settings →
// Usage UI.  The key is user-level (not per-instance) and is used ONLY here
// — it is never injected into any engine's process environment, so a bot
// can run on Clutch without it.  Cached for five minutes so
// the chip doesn't ping DeepSeek on every page load.

export type DeepSeekBalanceSnapshot = {
  /** USD amount remaining on the account, parsed from the API's
   * `balance_infos[*].total_balance` field for the USD currency. Null when
   * the API did not return a USD entry. */
  balanceUsd: number | null;
  /** When the balance is owed to grants vs. topped-up; surfaced in the
   * tooltip. Null when the API did not return that split. */
  grantedUsd: number | null;
  toppedUpUsd: number | null;
  /** "available" when the API reports the account can spend, "exhausted"
   * when it reports `is_available: false`. "unknown" when the response did
   * not include the field. */
  availability: "available" | "exhausted" | "unknown";
  fetchedAt: number;
  /** Set when the key is missing, the request failed, or the response was
   * not parseable. The UI hides the chip when this is set. */
  error: string | null;
};

const CACHE_TTL_MS = 5 * 60_000;
const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com";
// /api/quotas awaits this snapshot on every poll of the Usage card, so an
// unresponsive api.deepseek.com must not stall cooldowns, windows, and
// Antigravity data along with it. Bounded regardless of what the network does.
const FETCH_TIMEOUT_MS = 4_000;

type CacheEntry = {
  key: string;
  url: string;
  expiresAt: number;
  inflight: Promise<DeepSeekBalanceSnapshot> | null;
  value: DeepSeekBalanceSnapshot;
};

let entry: CacheEntry | null = null;

function parseBalanceNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBase(url: string): string {
  let href = url.trim();
  if (!href) return DEEPSEEK_DEFAULT_URL;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  return href.replace(/\/+$/, "");
}

function pickUsdEntry(body: unknown): {
  total: number | null;
  granted: number | null;
  toppedUp: number | null;
} {
  if (!body || typeof body !== "object") return { total: null, granted: null, toppedUp: null };
  const root = body as { balance_infos?: unknown };
  if (!Array.isArray(root.balance_infos)) return { total: null, granted: null, toppedUp: null };
  for (const raw of root.balance_infos) {
    if (!raw || typeof raw !== "object") continue;
    const info = raw as { currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown };
    if (typeof info.currency === "string" && info.currency.toUpperCase() === "USD") {
      return {
        total: parseBalanceNumber(info.total_balance),
        granted: parseBalanceNumber(info.granted_balance),
        toppedUp: parseBalanceNumber(info.topped_up_balance),
      };
    }
  }
  return { total: null, granted: null, toppedUp: null };
}

function pickAvailability(body: unknown): DeepSeekBalanceSnapshot["availability"] {
  if (!body || typeof body !== "object") return "unknown";
  const root = body as { is_available?: unknown };
  if (typeof root.is_available === "boolean") return root.is_available ? "available" : "exhausted";
  return "unknown";
}

async function fetchOnce(key: string, url: string, signal: AbortSignal): Promise<DeepSeekBalanceSnapshot> {
  const now = Date.now();
  if (!key.trim()) {
    return {
      balanceUsd: null,
      grantedUsd: null,
      toppedUpUsd: null,
      availability: "unknown",
      fetchedAt: now,
      error: "no key configured",
    };
  }
  const base = normalizeBase(url);
  try {
    const response = await fetch(`${base}/user/balance`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      return {
        balanceUsd: null,
        grantedUsd: null,
        toppedUpUsd: null,
        availability: "unknown",
        fetchedAt: now,
        error: `HTTP ${response.status}`,
      };
    }
    const body = (await response.json().catch(() => null)) as unknown;
    const usd = pickUsdEntry(body);
    return {
      balanceUsd: usd.total,
      grantedUsd: usd.granted,
      toppedUpUsd: usd.toppedUp,
      availability: pickAvailability(body),
      fetchedAt: now,
      error: null,
    };
  } catch (err) {
    return {
      balanceUsd: null,
      grantedUsd: null,
      toppedUpUsd: null,
      availability: "unknown",
      fetchedAt: now,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Returns the cached snapshot when the same (key, url) is requested within
 *  the TTL; otherwise fetches fresh and shares the in-flight promise across
 *  concurrent callers (so a Settings panel that mounts twice in 5 minutes
 *  does not double-ping the API). */
export async function getDeepSeekBalance(key: string | undefined, url: string | undefined): Promise<DeepSeekBalanceSnapshot> {
  const safeKey = (key ?? "").trim();
  const safeUrl = (url ?? "").trim();
  const now = Date.now();
  if (entry && entry.key === safeKey && entry.url === safeUrl) {
    if (entry.expiresAt > now && entry.inflight === null) return entry.value;
    if (entry.inflight) return entry.inflight;
  }
  const inflight = (async () => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, FETCH_TIMEOUT_MS);
    let value: DeepSeekBalanceSnapshot;
    try {
      value = await fetchOnce(safeKey, safeUrl, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    // Normalize whatever fetch's abort exception says (it varies by
    // runtime) to one deterministic reason the UI and tests can rely on.
    if (timedOut) value = { ...value, error: "timeout" };
    if (entry && entry.key === safeKey && entry.url === safeUrl) {
      entry.inflight = null;
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      entry.value = value;
    }
    return value;
  })();
  entry = { key: safeKey, url: safeUrl, expiresAt: now + CACHE_TTL_MS, inflight, value: stubFor(safeKey) };
  return inflight;
}

function stubFor(key: string): DeepSeekBalanceSnapshot {
  return {
    balanceUsd: null,
    grantedUsd: null,
    toppedUpUsd: null,
    availability: "unknown",
    fetchedAt: 0,
    error: key ? null : "no key configured",
  };
}

export function invalidateDeepSeekBalance(): void {
  entry = null;
}
