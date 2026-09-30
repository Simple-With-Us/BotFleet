import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  antigravityQuotaHeadlines,
  antigravityDisplayWindows,
  isHiddenQuotaEngine,
  antigravityQuotaCapped,
  antigravityQuotaLines,
  antigravityQuotaWindows,
  isBotFleetQuotaWindow,
  isMiniMaxVideoQuotaWindow,
  isQuotaCellExhausted,
  type UsageMonitorQuotaWindow,
} from "./usage-monitor-quota";
import { headlinesExhausted, windowHeadlines } from "./quota-display";
import { parseLocalQuotaSnapshot } from "../../server/local-usage-monitor";

function window(overrides: Partial<UsageMonitorQuotaWindow>): UsageMonitorQuotaWindow {
  return {
    id: "fixture",
    provider: "google-antigravity",
    providerKey: "google-antigravity",
    sourceApp: "local-mac",
    label: "fixture",
    remainingPercent: 50,
    resetAt: null,
    skip: false,
    window: "5h",
    ...overrides,
  };
}

describe("Usage Monitor BotFleet quota integration", () => {
  it("keeps legacy Antigravity in four windows with unknown weekly quotas", () => {
    const rows = antigravityDisplayWindows([], [
      { label: "Gemini Pro", modelId: "gemini-pro", remainingPercentage: 0.7, isExhausted: false },
      { label: "Claude", modelId: "claude-sonnet", remainingPercentage: 0.2, isExhausted: false },
    ]);
    expect(rows.map((row) => row.remainingPercent)).toEqual([70, null, 20, null]);
    expect(rows.map((row) => row.window)).toEqual(["5h", "weekly", "5h", "weekly"]);
  });

  it("does not fill a partial Usage Monitor account from legacy local models", () => {
    const rows = antigravityDisplayWindows([window({ label: "Gemini Models · Weekly", window: "weekly", remainingPercent: 42 })], [
      { label: "Gemini Pro", modelId: "gemini-pro", remainingPercentage: 0.7, isExhausted: false },
    ]);
    expect(rows.map((row) => row.remainingPercent)).toEqual([null, 42, null, null]);
    expect(antigravityDisplayWindows([]).map((row) => row.remainingPercent)).toEqual([null, null, null, null]);
  });

  it("hides unused engines while retaining Grok CLI and Antigravity", () => {
    for (const driver of ["kimiAgent", "github-copilot", "gemini-cli", "windsurf", "grok-bot"]) expect(isHiddenQuotaEngine(driver)).toBe(true);
    for (const driver of ["grokAgent", "grok", "antigravityAgent", "codex", "claudeAgent"]) expect(isHiddenQuotaEngine(driver)).toBe(false);
  });

  it("renders exactly the two Antigravity pools across 5-hour and weekly windows", () => {
    const rows = antigravityQuotaWindows([
      window({ id: "gemini-week", label: "Gemini Models · Weekly", window: "weekly", remainingPercent: 75 }),
      window({ id: "third-5h", label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 20 }),
      window({ id: "gemini-5h", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80 }),
      window({ id: "third-week", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: null }),
    ]);

    expect(rows.map((row) => `${row.label}:${row.window}`)).toEqual([
      "Gemini Models · 5-hour:5h",
      "Gemini Models · Weekly:weekly",
      "Third-Party Models · 5-hour:5h",
      "Third-Party Models · Weekly:weekly",
    ]);
    expect(antigravityQuotaLines(rows).map((line) => line.value)).toEqual(["80%", "75%", "20%", "not reported"]);
  });

  it("fills an incomplete Antigravity report with explicit unknown rows", () => {
    const rows = antigravityQuotaWindows([
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80 }),
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.label === "Third-Party Models · Weekly")?.remainingPercent).toBeNull();
    expect(rows.find((row) => row.label === "Third-Party Models · Weekly")?.skip).toBe(false);
  });

  it("shows a pool stored under a legacy Claude and GPT label as Third-Party", () => {
    const rows = antigravityQuotaWindows([
      window({ id: "legacy-5h", label: "Claude & GPT · 5-hour", window: "5h", remainingPercent: 35 }),
      window({ id: "legacy-week", label: "Claude and GPT models (weekly)", window: "weekly", remainingPercent: 55 }),
    ]);

    expect(rows.map((row) => `${row.label}:${row.remainingPercent}`)).toEqual([
      "Gemini Models · 5-hour:null",
      "Gemini Models · Weekly:null",
      "Third-Party Models · 5-hour:35",
      "Third-Party Models · Weekly:55",
    ]);
    expect(rows.map((row) => row.label).join(" ")).not.toMatch(/claude|gpt/i);
  });

  it("prefers the newest observation before applying the conservative percentage tie-break", () => {
    const old = "2026-09-13T08:00:00.000Z";
    const fresh = "2026-09-13T09:00:00.000Z";
    const rows = antigravityQuotaWindows([
      window({ id: "old", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 10, occurredAt: old }),
      window({ id: "fresh", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80, occurredAt: fresh }),
      window({ id: "tie-high", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 80, occurredAt: fresh }),
      window({ id: "tie-low", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 20, occurredAt: fresh }),
    ]);

    expect(rows[0].id).toBe("fresh");
    expect(rows[3].id).toBe("tie-low");
  });

  it("caps Antigravity only when both shared pools have an exhausted period", () => {
    const onePool = [
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 0 }),
      window({ label: "Gemini Models · Weekly", window: "weekly", remainingPercent: 80 }),
      window({ label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 40 }),
      window({ label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 60 }),
    ];
    expect(antigravityQuotaCapped(onePool)).toBe(false);
    expect(antigravityQuotaCapped([
      ...onePool,
      window({ id: "third-exhausted", label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 0 }),
    ])).toBe(true);
  });

  it("uses the selected window reset in the headline without changing pool identity", () => {
    const resetAt = new Date(Date.now() + 3_660_000).toISOString();
    const lines = antigravityQuotaHeadlines([
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80, resetAt }),
      window({ label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 20 }),
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Gemini Models · 5-hour 80% available");
    expect(lines[0]).toContain("resets in 1h");
  });

  it("keeps BotFleet Grok support while excluding non-BotFleet providers", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "xai", providerKey: "xai", label: "Grok 5h" }))).toBe(true);
    for (const provider of ["gemini-cli", "windsurf", "github-copilot", "copilot", "kimi", "moonshot"]) {
      expect(isBotFleetQuotaWindow(window({ provider, providerKey: provider, label: provider }))).toBe(false);
    }
  });

  it("recognizes legacy subscriptions without borrowing Antigravity's Claude models", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "claude-code", providerKey: undefined }))).toBe(true);
    expect(antigravityQuotaWindows([window({ provider: "anthropic", providerKey: undefined, via: "antigravity", label: "Third-Party Models · Weekly", window: "weekly" })])).toHaveLength(4);
    expect(isBotFleetQuotaWindow(window({ provider: "Grok Bot", providerKey: "xai" }))).toBe(false);
    expect(isBotFleetQuotaWindow(window({ provider: "xai", providerKey: undefined, sourceApp: "cursor", label: "Grok Bot weekly" }))).toBe(false);
  });

  it("requires a Codex source identity for a bare OpenAI provider", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "openai", providerKey: "openai", sourceApp: "codex-cli", label: "Codex 5h" }))).toBe(true);
    expect(isBotFleetQuotaWindow(window({ provider: "openai", providerKey: "openai", sourceApp: "openrouter", label: "GPT 5h" }))).toBe(false);
  });

  it("deemphasizes MiniMax video and Hailuo windows", () => {
    expect(isMiniMaxVideoQuotaWindow({ provider: "minimax", label: "Hailuo Video" })).toBe(true);
    expect(isMiniMaxVideoQuotaWindow({ provider: "minimax", label: "M3" })).toBe(false);
    expect(isMiniMaxVideoQuotaWindow({ provider: "xai", label: "Hailuo Video" })).toBe(false);
  });
});

describe("a quota window whose reset has already passed", () => {
  // Three paths read this row: the engine chip (headlinesExhausted), the grid
  // cell under it (isQuotaCellExhausted) and the routing behind it
  // (server/usage-quota.ts's applyLocalPayload, pinned in
  // server/usage-quota.test.ts).  The parser blanks a percentage whose reset
  // has passed but used to leave `isExhausted` and `fileSkip` set, and the
  // grid was the only one of the three reading those — so for up to one
  // producer write cycle after every reset boundary the cell sat amber under
  // a chip saying "Available", with nothing diverted.
  //
  // Driven through the REAL parser: what it produces is the whole point.
  const clock = Date.parse("2026-09-13T08:00:00Z");
  const handoff = (resetAt: string) => ({
    format: "usage-monitor-local-quotas",
    version: 1,
    generatedAt: new Date(clock).toISOString(),
    windows: [{
      id: "codex:weekly", provider: "openai", providerKey: "openai", label: "Codex weekly",
      occurredAt: new Date(clock).toISOString(), window: "1w", resetAt,
      remainingPercent: 0, status: "exhausted", skip: true, skipReason: "0% remaining", isExhausted: true,
    }],
  });

  it("reads as available in both the grid cell and the chip", () => {
    const [elapsed] = parseLocalQuotaSnapshot(handoff("2026-09-13T07:59:59Z"), clock);
    expect(elapsed.remainingPercent).toBeNull();
    expect(isQuotaCellExhausted(elapsed)).toBe(false);
    expect(headlinesExhausted(windowHeadlines([elapsed]))).toBe(false);
  });

  it("still reads as exhausted in both while the window is live", () => {
    const [live] = parseLocalQuotaSnapshot(handoff("2026-09-13T08:00:01Z"), clock);
    expect(isQuotaCellExhausted(live)).toBe(true);
    expect(headlinesExhausted(windowHeadlines([live]))).toBe(true);
  });

  it("is the grid cell's only exhaustion test", () => {
    // Naming the predicate is worth nothing unless the cell actually reads
    // it: an exhaustion expression written inline in the component is how the
    // three paths drifted apart in the first place.
    const grid = readFileSync(new URL("../components/UsageMonitorQuotaGrid.tsx", import.meta.url), "utf8");
    expect(grid).toContain("isQuotaCellExhausted(window)");
    expect(grid).not.toMatch(/const exhausted =[^;]*window\.(isExhausted|fileSkip|remainingPercent)/);
  });
});
