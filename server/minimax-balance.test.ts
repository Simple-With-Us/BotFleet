// Unit tests for the MiniMax balance/quota fetcher. We don't want to hit the
// real (undocumented) API in tests, so global fetch is stubbed before the
// module loads — same shape as deepseek-balance.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<FetchResponse>>();

function mockResponse(ok: boolean, status: number, body: unknown): FetchResponse {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  // Reset the module-level cache between tests so different (key, url) pairs
  // don't leak across cases.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadModule() {
  return await import("./minimax-balance.ts");
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000; // 18,000,000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000

// The coordinator's own example magnitude ("observed 1789275600000 style").
const INTERVAL_END = 1_789_275_600_000;
const INTERVAL_START = INTERVAL_END - FIVE_HOURS_MS;
const WEEKLY_END = 1_789_360_800_000;
const WEEKLY_START = WEEKLY_END - SEVEN_DAYS_MS;

/** Live-verified 2026-09-13 via `mmx quota show` against a real Token Plan
 *  account (no secrets involved — only the response shape was recorded).
 *  Two model rows: "general" (the chat quota, zero counts, 100%/94%
 *  remaining) and "video" (a separate quota pool, non-zero counts, 85%/88%
 *  remaining) — proves the two are parsed independently and never blended
 *  into one number. */
const TOKEN_PLAN_FIXTURE = {
  model_remains: [
    {
      model_name: "general",
      start_time: INTERVAL_START,
      end_time: INTERVAL_END,
      remains_time: 3_600_000,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_interval_remaining_percent: 100,
      current_interval_status: 1,
      weekly_start_time: WEEKLY_START,
      weekly_end_time: WEEKLY_END,
      weekly_remains_time: 259_200_000,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      current_weekly_remaining_percent: 94,
      current_weekly_status: 1,
    },
    {
      model_name: "video",
      start_time: INTERVAL_START,
      end_time: INTERVAL_END,
      remains_time: 3_600_000,
      current_interval_total_count: 20,
      current_interval_usage_count: 3,
      current_interval_remaining_percent: 85,
      current_interval_status: 1,
      weekly_start_time: WEEKLY_START,
      weekly_end_time: WEEKLY_END,
      weekly_remains_time: 259_200_000,
      current_weekly_total_count: 100,
      current_weekly_usage_count: 12,
      current_weekly_remaining_percent: 88,
      current_weekly_status: 1,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

describe("getMiniMaxBalance", () => {
  it("returns a 'no key configured' snapshot when the key is empty", async () => {
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("", "https://api.minimax.io");
    expect(result.error).toBe("no key configured");
    expect(result.source).toBe("unavailable");
    expect(result.capExists).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a pay-as-you-go secret key to /account/query_balance", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        available_amount: "12.34",
        cash_balance: "10.00",
        voucher_balance: "2.34",
        credit_balance: "0.00",
        owed_amount: "0.00",
        balance_alert_switch: false,
        balance_alert_threshold: "5.00",
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-test123", "https://api.minimax.io/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimax.io/account/query_balance");
    expect(result.source).toBe("account-balance");
    expect(result.capExists).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.balanceUsd).toBeCloseTo(12.34);
    expect(result.error).toBeNull();
  });

  it("routes a Token Plan / subscription key to /v1/token_plan/remains and reads 'general' for the headline", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(result.source).toBe("token-plan");
    expect(result.capExists).toBe(true);
    expect(result.status).toBe("ok");
    // The headline is "general"'s own figures (100%/94%), not blended with
    // "video"'s (85%/88%) — they are unrelated quota pools.
    expect(result.remainingPercent).toBe(100);
    expect(result.secondaryRemainingPercent).toBe(94);
    expect(result.windowsLabel).toBe("5hr/Week");
    // Epoch fields are milliseconds, passed through verbatim — no unit
    // rescaling. "general"'s own 5-hour window resets at end_time exactly.
    expect(result.resetsAt).toBe(INTERVAL_END);
    expect(result.weeklyResetsAt).toBe(WEEKLY_END);
    // Every row lands in `models`, including "video", for display — it is
    // just never used for the headline.
    expect(result.models?.general).toMatchObject({ remainingPercent: 100, secondaryRemainingPercent: 94 });
    expect(result.models?.video).toMatchObject({ remainingPercent: 85, secondaryRemainingPercent: 88 });
    expect(result.error).toBeNull();
  });

  it("maps current_interval_status/current_weekly_status: 1 is active, anything else is unknown (never capped)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.models?.general?.intervalStatus).toBe("active");
    expect(result.models?.general?.weeklyStatus).toBe("active");

    // Same (key, url) pair as above — bust the 5-minute cache so this
    // second fetch actually reaches the mock instead of serving the first
    // response back.
    mod.invalidateMiniMaxBalance();
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ ...TOKEN_PLAN_FIXTURE.model_remains[0], current_interval_status: 3, current_weekly_status: undefined }],
        base_resp: { status_code: 0 },
      }),
    );
    const unknownResult = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(unknownResult.models?.general?.intervalStatus).toBe("unknown");
    expect(unknownResult.models?.general?.weeklyStatus).toBe("unknown");
    // An unrecognized status must never be read as "capped" on its own —
    // that comes only from the percent fields (still 100 here).
    expect(unknownResult.status).toBe("ok");
  });

  it("ignores usage/total counts entirely — never derives a percent from them", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    // "general" has zero counts and 100% remaining; "video" has non-zero
    // counts (3/20 used) and only 85% remaining — if percent were ever
    // derived from counts, "general" would show 100% (0/0) and this
    // assertion would still pass by coincidence, so the real proof is that
    // neither model's exposed shape carries a count field at all.
    expect(result.models?.general).not.toHaveProperty("current_interval_usage_count");
    expect(result.models?.video?.remainingPercent).toBe(85);
  });

  it("falls back to remains_time (a duration) when the absolute end_time is missing", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          {
            model_name: "general",
            remains_time: 7_200_000,
            current_interval_remaining_percent: 100,
            weekly_remains_time: 259_200_000,
            current_weekly_remaining_percent: 94,
          },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.resetsAt).toBe(now + 7_200_000);
    expect(result.weeklyResetsAt).toBe(now + 259_200_000);
    vi.useRealTimers();
  });

  it("reports 'capped' status once general's most restrictive window hits zero, unaffected by a capped 'video' row", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 50 },
          { model_name: "video", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("capped");
    expect(result.remainingPercent).toBe(0);
  });

  it("does not go capped when only an unrelated 'video' row is exhausted", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 62, current_weekly_remaining_percent: 40 },
          { model_name: "video", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("ok");
    expect(result.remainingPercent).toBe(62);
    expect(result.models?.video?.remainingPercent).toBe(0);
  });

  it("goes capped when the WEEKLY window hits zero even while the 5-hour interval still has quota", async () => {
    // The weekly cap binds regardless of which window still has room: a
    // fresh 5-hour interval does not mean the account can place a call
    // when the weekly allowance underneath it is exhausted.
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 0 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("capped");
    expect(result.remainingPercent).toBe(100);
    expect(result.secondaryRemainingPercent).toBe(0);
  });

  it("has no headline when there is no 'general' row, but still keeps the other rows for display", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "video", current_interval_remaining_percent: 85 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("unknown");
    expect(result.remainingPercent).toBeNull();
    expect(result.capExists).toBe(true);
    expect(result.models?.video?.remainingPercent).toBe(85);
  });

  it("clamps an out-of-range percent defensively without rescaling it", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 142 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.remainingPercent).toBe(100);
  });

  it("reads a bare 1 as 1%, not as a 0-1 fraction rescaled to 100%", async () => {
    // The boundary an inferred-unit heuristic gets exactly backwards: a
    // `*_remaining_percent` field of 1 means the account is nearly out, and
    // rescaling it to 100% hid the near-cap state precisely when it
    // mattered most. Live-verified integers 0..100, never fractions.
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 1, current_weekly_remaining_percent: 1 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.remainingPercent).toBe(1);
    expect(result.secondaryRemainingPercent).toBe(1);
    expect(result.status).toBe("near_cap");
  });

  it("scales the weekly percent by weekly_boost_permille (a 1500 boost = 1.5x) — matching mmx-cli's own client", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{
          model_name: "general",
          current_interval_remaining_percent: 100,
          current_weekly_remaining_percent: 94,
          weekly_boost_permille: 1500,
        }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    // 94 * (1500 / 1000) = 141 — a legitimately boosted allowance above 100%.
    expect(result.secondaryRemainingPercent).toBe(141);
    expect(result.remainingPercent).toBe(100);
  });

  it("clamps a boosted weekly percent at 200, never higher", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{
          model_name: "general",
          current_weekly_remaining_percent: 90,
          weekly_boost_permille: 2500,
        }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    // 90 * 2.5 = 225, clamped to 200.
    expect(result.secondaryRemainingPercent).toBe(200);
  });

  it("treats a missing or non-positive weekly_boost_permille as a 1.0x factor (no boost)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_weekly_remaining_percent: 94 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.secondaryRemainingPercent).toBe(94);
  });

  it("uses the balance alert threshold as the near-cap signal", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        available_amount: "4.00",
        balance_alert_switch: true,
        balance_alert_threshold: "5.00",
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-test", "https://api.minimax.io");
    expect(result.status).toBe("near_cap");
  });

  it("returns an error snapshot on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(false, 401, null));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-bad", "https://api.minimax.io");
    expect(result.error).toBe("HTTP 401");
    expect(result.source).toBe("unavailable");
  });

  it("surfaces the MiniMax base_resp error message when status_code is non-zero", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, { base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-bad", "https://api.minimax.io");
    expect(result.error).toBe("invalid api key");
    expect(result.source).toBe("unavailable");
  });

  it("falls back to 'unknown' on an unrecognized response shape", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { unrelated: true }));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io");
    expect(result.error).toBe("unrecognized response shape");
    expect(result.source).toBe("unavailable");
  });

  it("strips a /v1 suffix off the configured URL before building the endpoint", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { model_remains: [], base_resp: { status_code: 0 } }));
    const mod = await loadModule();
    await mod.getMiniMaxBalance("subscription-token", "https://api.minimaxi.com/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains");
  });

  it("times out a hanging fetch instead of blocking /api/quotas forever", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<FetchResponse>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const mod = await loadModule();
      const pending = mod.getMiniMaxBalance("sk-api-test", "https://api.minimax.io");
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;
      expect(result.error).toBe("timeout");
      expect(result.source).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches two instances' (key, url) pairs independently instead of one fighting over a shared slot", async () => {
    // Regression: a single module-level cache slot meant instance B's fetch
    // overwrote instance A's entry, so A's next poll missed the cache too —
    // neither instance was ever actually served from cache.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const percent = url.includes("minimaxi.com") ? 10 : 90;
      return mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: percent }],
        base_resp: { status_code: 0 },
      });
    });
    const mod = await loadModule();
    const [a1, b1] = await Promise.all([
      mod.getMiniMaxBalance("key-a", "https://api.minimax.io/v1"),
      mod.getMiniMaxBalance("key-b", "https://api.minimaxi.com/v1"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a1.remainingPercent).toBe(90);
    expect(b1.remainingPercent).toBe(10);
    fetchMock.mockClear();
    // Second round, still within the 5-minute TTL: both instances are
    // served from their OWN cache slot — zero further fetches, and each
    // still reports its own account's number.
    const [a2, b2] = await Promise.all([
      mod.getMiniMaxBalance("key-a", "https://api.minimax.io/v1"),
      mod.getMiniMaxBalance("key-b", "https://api.minimaxi.com/v1"),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a2).toEqual(a1);
    expect(b2).toEqual(b1);
  });

  it("shares one in-flight request across concurrent callers for the SAME (key, url)", async () => {
    let resolveFetch!: (value: FetchResponse) => void;
    const pending = new Promise<FetchResponse>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);
    const mod = await loadModule();
    const p1 = mod.getMiniMaxBalance("key-a", "https://api.minimax.io/v1");
    const p2 = mod.getMiniMaxBalance("key-a", "https://api.minimax.io/v1");
    resolveFetch(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 50 }],
        base_resp: { status_code: 0 },
      }),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r1.remainingPercent).toBe(50);
  });
});

describe("getCachedLocalMiniMaxConfig", () => {
  it("serves the cached value when the file's mtime and the TTL both still hold", async () => {
    const mod = await loadModule();
    const load = vi.fn(() => ({ apiKey: "k1", url: "https://api.minimax.io/v1", defaultModel: "" }));
    const stat = vi.fn(() => ({ mtimeMs: 1000 }));
    const now = Date.now();
    const first = mod.getCachedLocalMiniMaxConfig({ now, stat, load });
    const second = mod.getCachedLocalMiniMaxConfig({ now: now + 1000, stat, load });
    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(2); // stat is cheap; called every time to detect a change
  });

  it("reloads when the file's mtime changes, even within the TTL", async () => {
    const mod = await loadModule();
    let mtimeMs = 1000;
    const load = vi.fn(() => ({ apiKey: `k-${mtimeMs}`, url: "https://api.minimax.io/v1", defaultModel: "" }));
    const stat = () => ({ mtimeMs });
    const now = Date.now();
    const first = mod.getCachedLocalMiniMaxConfig({ now, stat, load });
    mtimeMs = 2000;
    const second = mod.getCachedLocalMiniMaxConfig({ now: now + 1000, stat, load });
    expect(first.apiKey).toBe("k-1000");
    expect(second.apiKey).toBe("k-2000");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads once the TTL lapses, even with the same mtime", async () => {
    const mod = await loadModule();
    const load = vi.fn(() => ({ apiKey: "k1", url: "https://api.minimax.io/v1", defaultModel: "" }));
    const stat = () => ({ mtimeMs: 1000 });
    const now = Date.now();
    mod.getCachedLocalMiniMaxConfig({ now, stat, load });
    mod.getCachedLocalMiniMaxConfig({ now: now + 5 * 60_000 + 1, stat, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("treats a missing config file (stat returns null) as its own stable cache key", async () => {
    const mod = await loadModule();
    const load = vi.fn(() => ({ apiKey: "", url: "https://api.minimax.io/v1", defaultModel: "" }));
    const stat = () => null;
    const now = Date.now();
    mod.getCachedLocalMiniMaxConfig({ now, stat, load });
    mod.getCachedLocalMiniMaxConfig({ now: now + 1000, stat, load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidateLocalMiniMaxConfigCache forces the next call to reload", async () => {
    const mod = await loadModule();
    const load = vi.fn(() => ({ apiKey: "k1", url: "https://api.minimax.io/v1", defaultModel: "" }));
    const stat = () => ({ mtimeMs: 1000 });
    mod.getCachedLocalMiniMaxConfig({ stat, load });
    mod.invalidateLocalMiniMaxConfigCache();
    mod.getCachedLocalMiniMaxConfig({ stat, load });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("applyMiniMaxBalanceToRegistry", () => {
  // Local fresh-reset epoch, derived from now() instead of hardcoded, so CI
  // run-anywhere keeps the cooldown non-expired (matches the convention
  // antigravity-quota.test.ts established).
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const intervalEnd = Date.now() + FIVE_HOURS_MS;
  const weeklyEnd = Date.now() + FIVE_HOURS_MS + SEVEN_DAYS_MS;

  function accountBalanceSnapshot(balanceUsd: number): Awaited<ReturnType<typeof loadModule>> extends infer M ? M extends { getMiniMaxBalance: (...args: any) => Promise<infer S> } ? S : never : never {
    // We don't actually call the network — applyMiniMaxBalanceToRegistry
    // accepts any MiniMaxBalanceSnapshot. Build one with the same shape the
    // production parseAccountBalanceResponse yields.
    return {
      source: "account-balance" as const,
      capExists: balanceUsd != null,
      status: balanceUsd <= 0 ? "capped" as const : "ok" as const,
      balanceUsd,
      remainingPercent: null,
      secondaryRemainingPercent: null,
      windowsLabel: undefined,
      models: null,
      resetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: Date.now(),
      error: null,
    } as any;
  }

  function tokenPlanSnapshot(generalInterval: number, generalWeekly: number): any {
    return {
      source: "token-plan" as const,
      capExists: true,
      status: (generalInterval <= 0 || generalWeekly <= 0) ? "capped" as const : "ok" as const,
      balanceUsd: null,
      remainingPercent: generalInterval,
      secondaryRemainingPercent: generalWeekly,
      windowsLabel: "5hr/Week",
      models: {
        general: {
          remainingPercent: generalInterval,
          secondaryRemainingPercent: generalWeekly,
          windowsLabel: "5hr/Week",
          resetsAt: Math.min(intervalEnd, weeklyEnd),
          intervalResetsAt: intervalEnd,
          weeklyResetsAt: weeklyEnd,
          intervalStatus: "active" as const,
          weeklyStatus: "active" as const,
        },
        // An unrelated, healthy pool ("video") — must not trigger a
        // cap when "general" is fine.
        video: {
          remainingPercent: 100,
          secondaryRemainingPercent: 100,
          windowsLabel: "5hr/Week",
          resetsAt: intervalEnd,
          intervalResetsAt: intervalEnd,
          weeklyResetsAt: weeklyEnd,
          intervalStatus: "active" as const,
          weeklyStatus: "active" as const,
        },
      },
      resetsAt: intervalEnd,
      weeklyResetsAt: weeklyEnd,
      fetchedAt: Date.now(),
      error: null,
    };
  }

  it("broadcasts a pay-as-you-go wallet cap to every bot reusing the instance", async () => {
    const mod = await loadModule();
    const { QuotaCooldownRegistry } = await import("./model-fallback.ts");
    const registry = new QuotaCooldownRegistry();
    const snapshot = accountBalanceSnapshot(0);
    const applied = mod.applyMiniMaxBalanceToRegistry(snapshot as any, registry);
    expect(applied.capped).toBe(true);
    // ANY bot asking for the instance should see the wildcard cap —
    // this is what stops bot B from re-paging the dead wallet that
    // bot A just hit with 402 (board 555c5227).
    const seenByBotB = registry.get("bot-b", "minimax", "MiniMax-M3");
    expect(seenByBotB).toMatchObject({
      botId: "*",
      instanceId: "minimax",
      model: "*",
      error: "MiniMax account balance exhausted",
      source: "minimax-account-balance",
    });
    // The account has no known reset time (recovery is a top-up, not a
    // window); the registry falls back to a 15-min default TTL until
    // the next describe() observes `status: "ok"` and clears it.
    expect(seenByBotB?.resetsAt).toEqual(expect.any(Number));
  });

  it("broadcasts a Token Plan cap when general pool runs out on either window", async () => {
    const mod = await loadModule();
    const { QuotaCooldownRegistry } = await import("./model-fallback.ts");
    const registry = new QuotaCooldownRegistry();
    // Weekly window at 0% must trigger even though 5-hour stays fresh.
    const snapshot = tokenPlanSnapshot(100, 0);
    const applied = mod.applyMiniMaxBalanceToRegistry(snapshot, registry);
    expect(applied.capped).toBe(true);
    expect(registry.get("any-bot", "minimax", "MiniMax-M3")).toMatchObject({
      botId: "*",
      source: "minimax-account-balance",
      error: "MiniMax Token Plan exhausted",
      resetsAt: intervalEnd,
    });
  });

  it("does NOT broadcast when only an unrelated pool (video) is exhausted", async () => {
    const mod = await loadModule();
    const { QuotaCooldownRegistry } = await import("./model-fallback.ts");
    const registry = new QuotaCooldownRegistry();
    const snapshot = {
      source: "token-plan" as const,
      capExists: true,
      status: "ok" as const, // the snapshot's overall status stays ok —
                             // only a non-general pool is gone.
      balanceUsd: null,
      remainingPercent: 100,
      secondaryRemainingPercent: 100,
      windowsLabel: "5hr/Week",
      models: {
        general: { remainingPercent: 100, secondaryRemainingPercent: 100,
                   windowsLabel: "5hr/Week", resetsAt: intervalEnd,
                   intervalResetsAt: intervalEnd, weeklyResetsAt: weeklyEnd,
                   intervalStatus: "active" as const, weeklyStatus: "active" as const },
        video: { remainingPercent: 0, secondaryRemainingPercent: 0,
                 windowsLabel: "5hr/Week", resetsAt: intervalEnd,
                 intervalResetsAt: intervalEnd, weeklyResetsAt: weeklyEnd,
                 intervalStatus: "active" as const, weeklyStatus: "active" as const },
      },
      resetsAt: intervalEnd,
      weeklyResetsAt: weeklyEnd,
      fetchedAt: Date.now(),
      error: null,
    };
    const applied = mod.applyMiniMaxBalanceToRegistry(snapshot, registry);
    expect(applied.capped).toBe(false);
    expect(registry.get("any-bot", "minimax", "MiniMax-M3")).toBeUndefined();
  });

  it("clears a previously broadcast cap once the balance recovers", async () => {
    const mod = await loadModule();
    const { QuotaCooldownRegistry } = await import("./model-fallback.ts");
    const registry = new QuotaCooldownRegistry();
    const capped = accountBalanceSnapshot(0);
    mod.applyMiniMaxBalanceToRegistry(capped as any, registry);
    expect(registry.get("any-bot", "minimax", "MiniMax-M3")).toBeDefined();
    const recovered = accountBalanceSnapshot(12.34);
    const applied = mod.applyMiniMaxBalanceToRegistry(recovered as any, registry);
    expect(applied.capped).toBe(false);
    expect(registry.get("any-bot", "minimax", "MiniMax-M3")).toBeUndefined();
  });

  it("does not touch cooldowns on a different instance", async () => {
    const mod = await loadModule();
    const { QuotaCooldownRegistry } = await import("./model-fallback.ts");
    const registry = new QuotaCooldownRegistry();
    registry.record({ botId: "grok-bot", instanceId: "grok", model: "grok-4",
                      resetsAt: Date.now() + 60_000, error: "session limit",
                      recordedAt: Date.now() });
    mod.applyMiniMaxBalanceToRegistry(accountBalanceSnapshot(0) as any, registry);
    expect(registry.get("grok-bot", "grok", "grok-4")).toBeDefined();
  });
});
