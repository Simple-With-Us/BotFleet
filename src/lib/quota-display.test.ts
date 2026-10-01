import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  absoluteQuotaLabel,
  antigravityGroupSummary,
  antigravityQuotaLines,
  formatDualQuotaBadge,
  formatResetCountdown,
  headlinesExhausted,
  headlinesNearCap,
  isEngineUnconfigured,
  localQuotaStatusLine,
  minimaxQuotaLine,
  NEAR_CAP_PERCENT,
  providerIssueLine,
  quotaLinesSummary,
  quotaProducerLabel,
  remainingPercentLabel,
  windowHeadlines,
  windowsLabelFromHeadlines,
} from "./quota-display";
import { driverKindsForWindow, isPlanLevelSkip, modelsToSkip } from "../../server/quota-window-map";

// Countdown fixtures compare exact minute labels.  Keep construction and
// formatting on the same clock instead of racing a minute boundary.
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(1_788_912_000_000); });
afterEach(() => { vi.restoreAllMocks(); });

describe("antigravity quota lines", () => {
  const models = [
    { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.3, isExhausted: false },
    { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
    { label: "Gemini 3 Flash", modelId: "gemini-3-flash", isExhausted: false },
    { label: "Tab", modelId: "gemini-tab", remainingPercentage: 0.9, isExhausted: false, isAutocompleteOnly: true },
  ];

  it("emits only Gemini and Third-Party, not per-model rows", () => {
    const lines = antigravityQuotaLines(models);
    expect(lines.map((line) => `${line.label}: ${line.value}`)).toEqual([
      "Gemini: exhausted",
      "Third-Party: 30%",
    ]);
  });

  it("joins the two buckets for hover, not a per-model slice", () => {
    expect(quotaLinesSummary(antigravityQuotaLines(models))).toBe("Gemini: exhausted · Third-Party: 30%");
  });

  it("treats N/A remaining as exhausted", () => {
    expect(remainingPercentLabel({ label: "Gemini", modelId: "gemini-x", isExhausted: false })).toBe("exhausted");
  });
});

describe("Cursor monthly windows", () => {
  const monthly = {
    provider: "cursor",
    sourceApp: "cursor-cli",
    label: "Cursor Pro monthly",
    modelId: null,
    modelType: null,
    window: "monthly",
    skip: true,
    skipReason: "0% remaining",
  };

  it("maps onto cursorAgent and skips the whole engine", () => {
    expect(driverKindsForWindow(monthly)).toEqual(["cursorAgent"]);
    expect(isPlanLevelSkip(monthly)).toBe(true);
    expect(
      modelsToSkip(monthly, {
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: { options: [{ id: "auto" }, { id: "composer-2.5" }] },
      }),
    ).toEqual(["*"]);
  });

  it("does not treat a 5-hour remainder as a plan skip", () => {
    expect(
      isPlanLevelSkip({
        ...monthly,
        window: "5h",
        skip: true,
        skipReason: "session limit",
        label: "Cursor 5h",
      }),
    ).toBe(false);
  });
});

describe("Codex windows", () => {
  it("maps onto the shipped fleet's codex driver kind, not just codexAgent", () => {
    // The default fleet's Codex instance rides driver kind "codex"
    // (server/drivers/codex.ts's DRIVER_KIND) — "codexAgent" matches nothing
    // instanceConfigs() ever produces, so a Codex/OpenAI Usage Monitor window
    // was unreachable by windowsForDriver() for the one instance most likely
    // to want it.
    const codexWindow = {
      provider: "openai",
      sourceApp: "codex-cli",
      label: "Codex 5h",
      modelId: null,
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(codexWindow)).toContain("codex");
  });

  it("does not attribute an openai-compat custom-engine window to Codex", () => {
    // "openai-compat" is server/telemetry.ts's AMBIGUOUS_ENGINE fallback
    // provider token for a custom engine — it contains "openai" as a literal
    // substring, so without an explicit exclusion a skipped monthly window
    // on an unrelated custom engine would wildcard-cap the real Codex
    // instance, and an ordinary window would render under the wrong row.
    const customEngineWindow = {
      provider: "openai-compat",
      sourceApp: null,
      label: "Custom Engine",
      modelId: null,
      modelType: null,
      window: "monthly",
      skip: true,
      skipReason: "0% remaining",
    };
    expect(driverKindsForWindow(customEngineWindow)).toEqual([]);
  });

  it("does not attribute a bare openai-provider window to Codex without a codex/chatgpt product signal", () => {
    // Usage Monitor's own classification can report provider "openai" (not
    // "openai-compat") for a custom engine whose configured model merely
    // LOOKS like a real OpenAI model — e.g. "gpt-4o" proxied through
    // OpenRouter, Azure, or a self-hosted gateway — with nothing else in
    // the window distinguishing it from genuine Codex/ChatGPT usage. The
    // vendor/model family alone ("openai", "gpt") is not proof it came
    // from the one app BotFleet actually ships as "codex"; only the
    // product name ("codex"/"chatgpt") is.
    const gptShapedCustomEngineWindow = {
      provider: "openai",
      sourceApp: null,
      label: "GPT-4o usage",
      modelId: "gpt-4o",
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(gptShapedCustomEngineWindow)).toEqual([]);
  });

  it("still attributes a genuine ChatGPT-labelled window even when the provider token is bare openai", () => {
    const chatgptWindow = {
      provider: "openai",
      sourceApp: "ChatGPT desktop",
      label: "ChatGPT Plus 5h",
      modelId: null,
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(chatgptWindow)).toContain("codex");
  });
});

describe("Kimi windows", () => {
  it("maps a moonshot-provider window onto the shipped fleet's kimiAgent driver kind", () => {
    // inferProviderAndService (server/telemetry.ts) reports Kimi/Moonshot
    // windows under provider "moonshot"; the raw Usage Monitor windows table
    // this PR removed was the only place a Kimi window stayed visible
    // without this mapping.
    const kimiWindow = {
      provider: "moonshot",
      sourceApp: "kimi-cli",
      label: "Kimi 5h",
      modelId: null,
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(kimiWindow)).toEqual(["kimiAgent"]);
  });
});

describe("isEngineUnconfigured", () => {
  it("hides a driver whose CLI was never installed", () => {
    expect(isEngineUnconfigured("`codex` CLI not found")).toBe(true);
  });

  it("hides a driver with no API key or token ever entered", () => {
    expect(isEngineUnconfigured("no xAI API key — add {\"xai\":{\"key\":\"xai-…\"}} to ~/.botfleet/config.json or set XAI_API_KEY")).toBe(true);
    expect(isEngineUnconfigured("no Box token — add {\"box\":{\"token\":\"…\"}} to ~/.botfleet/config.json")).toBe(true);
    expect(isEngineUnconfigured("no API key — set OPENAI_COMPAT_API_KEY or add it to the instance config")).toBe(true);
  });

  it("hides an engine explicitly disabled in settings", () => {
    expect(isEngineUnconfigured("Disabled in settings")).toBe(true);
  });

  it("keeps a configured engine that is merely failing right now", () => {
    // A Box token IS set but the API call failed — this engine is
    // configured and the user relies on it, so its row must stay visible
    // with the real failure reason, not vanish as if never set up.
    expect(isEngineUnconfigured("box API unreachable: fetch failed")).toBe(false);
    expect(isEngineUnconfigured("Codex CLI is out of date (needs 0.151.0+). Run `npm install -g @openai/codex`")).toBe(false);
  });

  it("treats no reason as not-unconfigured", () => {
    expect(isEngineUnconfigured(undefined)).toBe(false);
    expect(isEngineUnconfigured(null)).toBe(false);
  });

  it("never calls an engine unconfigured when its probe just did not answer in time", () => {
    // A slow probe is not a missing CLI: the row stays while it is re-checked.
    expect(isEngineUnconfigured({ reason: "Claude did not answer in time", transient: true })).toBe(false);
    // Even a stale "not found" wording carried on a transient snapshot.
    expect(isEngineUnconfigured({ reason: "`cursor-agent` CLI not found", transient: true })).toBe(false);
    // A definitive snapshot still reads by its reason.
    expect(isEngineUnconfigured({ reason: "`cursor-agent` CLI not found" })).toBe(true);
  });
});

describe("antigravity group summary", () => {
  it("collapses third-party models into one summary and keeps Gemini separate", () => {
    const groups = antigravityGroupSummary([
      { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.3, isExhausted: false },
      { label: "GPT-OSS 120B", modelId: "gpt-oss-120b-medium", remainingPercentage: 0.2, isExhausted: false },
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
      { label: "Gemini 3 Flash", modelId: "gemini-3-flash", remainingPercentage: 0.8, isExhausted: false },
    ]);
    // Exhausted models are excluded from the average — including an empty
    // slot would dilute the read of the models the user can still send to.
    expect(groups).toEqual([
      { group: "gemini", label: "Gemini", remainingPercent: 80, exhausted: false },
      { group: "external", label: "Third-Party", remainingPercent: 20, exhausted: false },
    ]);
  });

  it("does not show 0% when the group still has a usable model", () => {
    const groups = antigravityGroupSummary([
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0, isExhausted: false },
      { label: "Gemini 3 Flash", modelId: "gemini-3-flash", remainingPercentage: 0.4, isExhausted: false },
    ]);
    expect(groups).toEqual([
      { group: "gemini", label: "Gemini", remainingPercent: 40, exhausted: false },
    ]);
  });

  it("marks the whole group exhausted when every model is", () => {
    const groups = antigravityGroupSummary([
      { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", isExhausted: true },
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
    ]);
    expect(groups.every((group) => group.exhausted)).toBe(true);
    expect(groups.find((group) => group.group === "external")?.remainingPercent).toBe(0);
  });

  it("ignores autocomplete-only entries", () => {
    const groups = antigravityGroupSummary([
      { label: "Tab", modelId: "gemini-tab", remainingPercentage: 0.9, isExhausted: false, isAutocompleteOnly: true },
    ]);
    expect(groups).toEqual([]);
  });

  it("surfaces rolling 5h window countdown and monthly pool reset in headline", () => {
    const now = Date.now();
    const resetTime = new Date(now + (3 * 3600 + 21 * 60 + 5) * 1000).toISOString();
    const groups = antigravityGroupSummary(
      [
        { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0.9, isExhausted: false, resetTime },
        { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.46, isExhausted: false, resetTime },
      ],
      { remainingPercentage: 0.46 },
    );
    expect(groups[0].headline).toBe("Gemini: 90% available (5h window, resets in 3h 21m)");
    expect(groups[1].headline).toBe("Third-Party: 46% available (5h window, resets in 3h 21m)");
  });

  it("ties the reset countdown to the model that supplied the displayed percentage, not the earliest reset in the group", () => {
    // The displayed percentage is the MOST RESTRICTIVE reading (10%), not an
    // average — so the reset next to it must be THAT model's reset (4h), not
    // an unrelated 90%-remaining model's earlier 1h reset. Showing "10%
    // available … resets in 1h" would promise replenishment that will not
    // happen then.
    // The fixed clock keeps the reset-owner assertion independent of elapsed time.
    const now = Date.now();
    const tenPercentResetsIn4h = new Date(now + (4 * 3600 + 5 * 60) * 1000).toISOString();
    const ninetyPercentResetsIn1h = new Date(now + (1 * 3600 + 5 * 60) * 1000).toISOString();
    const groups = antigravityGroupSummary([
      { label: "GPT-OSS 120B", modelId: "gpt-oss-120b-medium", remainingPercentage: 0.1, isExhausted: false, resetTime: tenPercentResetsIn4h },
      { label: "Grok 4", modelId: "grok-4", remainingPercentage: 0.9, isExhausted: false, resetTime: ninetyPercentResetsIn1h },
    ]);
    const thirdParty = groups.find((group) => group.group === "external")!;
    expect(thirdParty.remainingPercent).toBe(10);
    expect(thirdParty.resetAtMs).toBe(Date.parse(tenPercentResetsIn4h));
    expect(thirdParty.headline).toBe("Third-Party: 10% available (5h window, resets in 4h 5m)");
  });
});

describe("windowHeadlines + formatResetCountdown", () => {
  it("picks the most restrictive window per bucket and orders weekly → monthly → 5h", () => {
    const headlines = windowHeadlines([
      { label: "Cursor Pro weekly", window: "weekly", remainingPercent: 80, resetAt: futureIso(4, 12), skip: false },
      { label: "Cursor Hobby weekly", window: "weekly", remainingPercent: 5, resetAt: futureIso(1, 2), skip: false },
      { label: "Cursor Pro monthly", window: "monthly", remainingPercent: 100, resetAt: futureIso(12, 0), skip: false },
      { label: "Cursor 5h", window: "5h", remainingPercent: 50, resetAt: futureIso(0, 2, 14), skip: false },
    ]);
    expect(headlines.map((h) => h.bucket)).toEqual(["weekly", "monthly", "5h"]);
    // The most restrictive (lowest remaining) wins the weekly slot.
    expect(headlines[0].remainingPercent).toBe(5);
    expect(headlines[0].display).toBe("Weekly");
  });

  it("treats an explicitly-skipped window as fully exhausted (zero remaining)", () => {
    const headlines = windowHeadlines([
      { label: "Cursor Pro monthly", window: "monthly", remainingPercent: 100, resetAt: futureIso(12, 0), skip: true, skipReason: "0% remaining" } as any,
    ]);
    expect(headlines[0].exhausted).toBe(true);
    expect(headlines[0].remainingPercent).toBe(0);
  });

  it("formats reset countdowns: 4d 12h, 12h 14m, 14m, resetting now", () => {
    const now = Date.now();
    expect(formatResetCountdown(now + (4 * 86_400 + 12 * 3600) * 1000, now)).toBe("4d 12h");
    expect(formatResetCountdown(now + (12 * 3600 + 14 * 60) * 1000, now)).toBe("12h 14m");
    expect(formatResetCountdown(now + 14 * 60 * 1000, now)).toBe("14m");
    expect(formatResetCountdown(now - 1, now)).toBe("resetting now");
    expect(formatResetCountdown(null)).toBeNull();
  });
});

describe("formatDualQuotaBadge", () => {
  it("formats dual percentage when both primary and secondary exist", () => {
    expect(formatDualQuotaBadge(75, 100)).toBe("(75% / 100%)");
    expect(formatDualQuotaBadge(92.24, 1.4)).toBe("(92% / 1%)");
  });

  it("formats single percentage with windows label or left suffix", () => {
    expect(formatDualQuotaBadge(75, null, { windowsLabel: "5hr/Week" })).toBe("(75% for 5h / w)");
    expect(formatDualQuotaBadge(75, null)).toBe("75% left");
    expect(formatDualQuotaBadge(null, 50)).toBe("(50%)");
    expect(formatDualQuotaBadge(null, null)).toBeNull();
  });
});

describe("windowsLabelFromHeadlines", () => {
  it("returns the combined '5hr/Week' badge when both buckets are present", () => {
    const headlines = windowHeadlines([
      { label: "Token Plan", window: "5-hour", remainingPercent: 100, skip: false },
      { label: "Token Plan", window: "Weekly", remainingPercent: 100, skip: false },
    ]);
    expect(windowsLabelFromHeadlines(headlines)).toBe("5hr/Week");
  });

  it("returns the bare '5hr' badge when only the 5h bucket is present", () => {
    const headlines = windowHeadlines([{ label: "Token Plan", window: "5h", remainingPercent: 100, skip: false }]);
    expect(windowsLabelFromHeadlines(headlines)).toBe("5hr");
  });

  it("returns 'Week' when only the weekly bucket is present", () => {
    const headlines = windowHeadlines([{ label: "Token Plan", window: "weekly", remainingPercent: 100, skip: false }]);
    expect(windowsLabelFromHeadlines(headlines)).toBe("Week");
  });

  it("returns 'Month' for a monthly-only engine", () => {
    const headlines = windowHeadlines([{ label: "Cursor monthly", window: "monthly", remainingPercent: 100, skip: false }]);
    expect(windowsLabelFromHeadlines(headlines)).toBe("Month");
  });

  it("returns undefined for an empty window list", () => {
    expect(windowsLabelFromHeadlines([])).toBeUndefined();
  });
});

describe("minimaxQuotaLine", () => {
  const base = {
    source: "unavailable" as const,
    status: "unknown" as const,
    balanceUsd: null,
    remainingPercent: null,
    secondaryRemainingPercent: null,
    resetsAt: null,
    weeklyResetsAt: null,
  };

  it("returns null when the source is unavailable", () => {
    expect(minimaxQuotaLine(base)).toBeNull();
  });

  it("formats a pay-as-you-go balance line", () => {
    expect(minimaxQuotaLine({ ...base, source: "account-balance", status: "ok", balanceUsd: 12.34 })).toBe("$12.34 remaining");
  });

  it("flags a near-cap balance without claiming it's exhausted", () => {
    expect(minimaxQuotaLine({ ...base, source: "account-balance", status: "near_cap", balanceUsd: 4 })).toBe("$4.00 remaining · near cap");
  });

  it("reports a capped balance as exhausted (a wallet balance has no reset time)", () => {
    const line = minimaxQuotaLine({ ...base, source: "account-balance", status: "capped", balanceUsd: 0 });
    expect(line).toBe("at usage cap — balance exhausted");
  });

  it("returns null for a pay-as-you-go response with no balance figure at all", () => {
    expect(minimaxQuotaLine({ ...base, source: "account-balance", status: "unknown", balanceUsd: null })).toBeNull();
  });

  it("formats the live-verified Token Plan sentence: weekly first, then the 5h window, then a clock-time reset", () => {
    const resetsAt = Date.now() + 3_600_000;
    const line = minimaxQuotaLine({
      ...base,
      source: "token-plan",
      status: "ok",
      remainingPercent: 100,
      secondaryRemainingPercent: 94,
      resetsAt,
    });
    const expectedTime = new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(line).toBe(`94% left this week, 100% left in the current 5 h window, resets at ${expectedTime}`);
  });

  it("formats a Token Plan line with only the 5h window known, and no reset clause when the reset is unknown", () => {
    const line = minimaxQuotaLine({ ...base, source: "token-plan", status: "ok", remainingPercent: 62 });
    expect(line).toBe("62% left in the current 5 h window");
  });

  it("formats a Token Plan line with only the weekly window known", () => {
    const line = minimaxQuotaLine({ ...base, source: "token-plan", status: "ok", secondaryRemainingPercent: 40 });
    expect(line).toBe("40% left this week");
  });

  it("returns null for a Token Plan response with zero usable model rows", () => {
    expect(minimaxQuotaLine({ ...base, source: "token-plan", status: "unknown" })).toBeNull();
  });

  it("says 'of a boosted allowance' when the weekly figure is above 100%", () => {
    const line = minimaxQuotaLine({ ...base, source: "token-plan", status: "ok", secondaryRemainingPercent: 141 });
    expect(line).toBe("141% left this week of a boosted allowance");
  });

  it("does not say 'boosted' for an ordinary weekly figure at or below 100%", () => {
    const line = minimaxQuotaLine({ ...base, source: "token-plan", status: "ok", secondaryRemainingPercent: 100 });
    expect(line).toBe("100% left this week");
  });

  it("says 'resets soon' instead of a stale clock time once the reset has already passed", () => {
    const now = Date.now();
    const line = minimaxQuotaLine(
      { ...base, source: "token-plan", status: "ok", remainingPercent: 100, resetsAt: now - 60_000 },
      now,
    );
    expect(line).toBe("100% left in the current 5 h window, resets soon");
  });

  it("names the WEEKLY reset when the week is the window that has run out", () => {
    // The 5-hour window refilling in twenty minutes is not what the owner
    // is waiting on when the weekly allowance underneath it is at zero —
    // quoting the 5-hour reset there reads as "back shortly" while the
    // account actually cannot place a call for days.
    const now = Date.now();
    const weeklyResetsAt = now + (3 * 86_400_000);
    const line = minimaxQuotaLine(
      { ...base, source: "token-plan", status: "capped", remainingPercent: 100, secondaryRemainingPercent: 0, resetsAt: now + 1_200_000, weeklyResetsAt },
      now,
    );
    // A countdown, not a clock time: the weekly reset is three days out,
    // and "resets at 3:00 PM" would read as this afternoon.
    expect(line).toBe("0% left this week, 100% left in the current 5 h window, resets in 3d");
  });

  it("keeps naming the 5-hour reset while the weekly window still has room", () => {
    const now = Date.now();
    const resetsAt = now + 1_200_000;
    const line = minimaxQuotaLine(
      { ...base, source: "token-plan", status: "ok", remainingPercent: 4, secondaryRemainingPercent: 80, resetsAt, weeklyResetsAt: now + (3 * 86_400_000) },
      now,
    );
    const expectedTime = new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(line).toBe(`80% left this week, 4% left in the current 5 h window, resets at ${expectedTime}`);
  });

  it("still shows a clock time for a reset that has not passed yet", () => {
    const now = Date.now();
    const resetsAt = now + 3_600_000;
    const line = minimaxQuotaLine(
      { ...base, source: "token-plan", status: "ok", remainingPercent: 100, resetsAt },
      now,
    );
    const expectedTime = new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(line).toBe(`100% left in the current 5 h window, resets at ${expectedTime}`);
  });
});

function futureIso(days: number, hours: number, extraMinutes = 0): string {
  return new Date(Date.now() + ((days * 86_400) + (hours * 3600) + (extraMinutes * 60)) * 1000).toISOString();
}

describe("engine chip terms", () => {
  it("caps the chip on the same exhausted window the grid reddens, with skip false", () => {
    // The local parser keeps `skip` false by design, so this is exactly the
    // Codex row that used to sit under a green "Available" chip.
    const headlines = windowHeadlines([
      { label: "Codex weekly", window: "1w", remainingPercent: 0, resetAt: futureIso(2, 0), skip: false },
    ]);
    expect(headlinesExhausted(headlines)).toBe(true);
    expect(headlinesNearCap(headlines)).toBe(false);
  });

  it("warns near the cap at the shared threshold and stays quiet above it", () => {
    expect(NEAR_CAP_PERCENT).toBe(20);
    const near = windowHeadlines([
      { label: "Claude weekly", window: "1w", remainingPercent: 8, resetAt: futureIso(1, 0), skip: false },
    ]);
    expect(headlinesNearCap(near)).toBe(true);
    expect(headlinesExhausted(near)).toBe(false);
    const healthy = windowHeadlines([
      { label: "Claude weekly", window: "1w", remainingPercent: 92, resetAt: futureIso(1, 0), skip: false },
    ]);
    expect(headlinesNearCap(healthy)).toBe(false);
  });
});

describe("absolute allowances and handoff health", () => {
  it("renders money, counts and a plan the way the collector measured them", () => {
    expect(absoluteQuotaLabel({ absoluteRemaining: 0, absoluteLimit: 400, quotaUnit: "USD", planName: "ultra" }))
      .toBe("$0 of $400 on Ultra");
    expect(absoluteQuotaLabel({ absoluteRemaining: 12, absoluteLimit: 300, quotaUnit: "requests" }))
      .toBe("12 of 300 requests");
    expect(absoluteQuotaLabel({ planName: "ultra" })).toBe("Ultra plan");
    expect(absoluteQuotaLabel({ absoluteRemaining: 12, absoluteLimit: null, quotaUnit: "credits" })).toBeNull();
    expect(absoluteQuotaLabel({})).toBeNull();
  });

  it("says why the grid is empty instead of rendering nothing", () => {
    expect(localQuotaStatusLine({ state: "fresh", generatedAt: new Date().toISOString() })).toBeNull();
    expect(localQuotaStatusLine(null)).toBeNull();
    expect(localQuotaStatusLine({ state: "missing" })).toBe(
      "CodeCaps is not running, so no local subscription quota is available",
    );
    const written = Date.now() - 1_800_000;
    expect(localQuotaStatusLine({ state: "stale", generatedAt: new Date(written).toISOString(), producer: "codecaps" }))
      .toBe(`CodeCaps has not written quota since ${new Date(written).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    expect(localQuotaStatusLine({ state: "unreadable" })).toBe("CodeCaps's quota file could not be read");
  });

  it("maps the legacy agent-bar producer to the new CodeCaps label", () => {
    // CodeCaps renamed on the wire from "agent-bar" to "codecaps" on
    // 2026-09-20.  An older build still writing "agent-bar" must render
    // under the new brand, not the old one — that's the whole point of the
    // back-compat alias in `quotaProducerLabel`.
    expect(quotaProducerLabel("agent-bar")).toBe("CodeCaps");
    expect(quotaProducerLabel("codecaps")).toBe("CodeCaps");
    expect(quotaProducerLabel("usage-monitor")).toBe("Usage Monitor");
    expect(quotaProducerLabel(undefined)).toBe("CodeCaps");
    expect(quotaProducerLabel(null)).toBe("CodeCaps");
    expect(quotaProducerLabel("  AGENT-BAR  ")).toBe("CodeCaps");
  });

  it("attributes a provider's read failure to the app that measured it", () => {
    expect(providerIssueLine("Claude", "Sign in again to refresh quota", "codecaps"))
      .toBe("Claude: Sign in again to refresh quota (from CodeCaps)");
    expect(providerIssueLine("Claude", "  ", "codecaps")).toBeNull();
    expect(providerIssueLine("Claude", undefined)).toBeNull();
    const long = providerIssueLine("Cursor", "x".repeat(400));
    expect(long?.length).toBeLessThanOrEqual("Cursor: ".length + 160 + " (from CodeCaps)".length);
    // The reason is the producer's text and stays text: angle brackets are
    // carried through verbatim rather than stripped or escaped here, because
    // the row renders this as a JSX text child and never as markup.  Escaping
    // it in the string would show the entity to the reader instead.
    expect(providerIssueLine("Claude", '<b>read failed</b>', "codecaps"))
      .toBe("Claude: <b>read failed</b> (from CodeCaps)");
    // Wrapped prose folds onto the one line the row has room for.
    expect(providerIssueLine("Claude", "Sign in again.\nOpen CodeCaps to retry.", "codecaps"))
      .toBe("Claude: Sign in again. Open CodeCaps to retry. (from CodeCaps)");
    // Back-compat: an older CodeCaps build still writing "agent-bar" still
    // resolves to the same rendered string.
    expect(providerIssueLine("Claude", "Sign in again to refresh quota", "agent-bar"))
      .toBe("Claude: Sign in again to refresh quota (from CodeCaps)");
  });
});
