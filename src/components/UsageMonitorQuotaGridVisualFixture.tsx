// Test harness for tests/e2e/usage-monitor-quota-grid.visual.spec.ts.
//
// Mounts UsageMonitorQuotaGrid with fixed quota windows (plan metadata,
// absolute limits, reset times) so the spec can pin Settings → Usage quota
// cells without a harness or live network.  `state` picks populated, empty,
// near-limit, or exhausted; `theme=dark` uses Midnight, otherwise Studio.
import { useEffect } from "react";

import { UsageMonitorQuotaGrid } from "./UsageMonitorQuotaGrid";
import { applySkin } from "@/lib/skins";
import type { UsageMonitorQuotaWindow } from "@/lib/usage-monitor-quota";

const params = new URLSearchParams(window.location.search);
const DARK = params.get("theme") === "dark";
const STATE = params.get("state") ?? "populated";

/** Frozen in the spec via page.clock — must stay in sync with the visual spec. */
export const USAGE_GRID_FIXTURE_RESET_AT = "2026-10-10T19:00:00.000Z";

const POPULATED: UsageMonitorQuotaWindow[] = [
  {
    id: "codex-weekly",
    provider: "openai",
    providerKey: "openai",
    label: "Codex · Weekly",
    window: "1w",
    skip: false,
    remainingPercent: 62,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
    absoluteRemaining: 248,
    absoluteLimit: 400,
    quotaUnit: "USD",
    planName: "ultra",
    planMetadata: {
      detectedPlanName: "ChatGPT Ultra",
      userPlanName: "Ultra",
      userSubtitle: "Primary workspace",
      userCostUsd: "200.00",
      userRenewalDateText: "Nov 1, 2026",
      showCostAndRenewal: true,
      hasMismatch: false,
    },
  },
  {
    id: "gemini-5h",
    provider: "google-antigravity",
    providerKey: "google-antigravity",
    label: "Gemini Models · 5-hour",
    window: "5h",
    skip: false,
    remainingPercent: 88,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
    absoluteRemaining: 44,
    absoluteLimit: 50,
    quotaUnit: "requests",
  },
];

const NEAR_LIMIT: UsageMonitorQuotaWindow[] = [
  {
    id: "claude-5h",
    provider: "anthropic",
    providerKey: "anthropic",
    label: "Claude · 5-hour",
    window: "5h",
    skip: false,
    remainingPercent: 15,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
    absoluteRemaining: 3,
    absoluteLimit: 20,
    quotaUnit: "USD",
    planMetadata: {
      detectedPlanName: "Max",
      userPlanName: "Max",
      showCostAndRenewal: false,
      hasMismatch: false,
    },
  },
  {
    id: "claude-weekly",
    provider: "anthropic",
    providerKey: "anthropic",
    label: "Claude · Weekly",
    window: "weekly",
    skip: false,
    remainingPercent: 18,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
  },
];

const EXHAUSTED: UsageMonitorQuotaWindow[] = [
  {
    id: "codex-weekly-spent",
    provider: "openai",
    providerKey: "openai",
    label: "Codex · Weekly",
    window: "1w",
    skip: true,
    remainingPercent: 0,
    isExhausted: true,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
    planName: "ultra",
    absoluteRemaining: 0,
    absoluteLimit: 400,
    quotaUnit: "USD",
    planMetadata: {
      detectedPlanName: "ChatGPT Ultra",
      userPlanName: "Ultra",
      showCostAndRenewal: true,
      hasMismatch: false,
    },
  },
  {
    id: "gemini-5h-spent",
    provider: "google-antigravity",
    providerKey: "google-antigravity",
    label: "Gemini Models · 5-hour",
    window: "5h",
    skip: false,
    remainingPercent: 0,
    isExhausted: true,
    resetAt: USAGE_GRID_FIXTURE_RESET_AT,
  },
];

function windowsForState(): UsageMonitorQuotaWindow[] | null {
  switch (STATE) {
    case "populated":
      return POPULATED;
    case "near-limit":
      return NEAR_LIMIT;
    case "exhausted":
      return EXHAUSTED;
    case "empty":
      return null;
    default:
      return POPULATED;
  }
}

function EmptyPlaceholder() {
  return (
    <div
      className="ml-9 mt-1.5 rounded-lg border border-dashed border-hairline/40 px-2.5 py-3 text-[11px] text-ink-secondary"
      data-testid="usage-grid-empty-placeholder"
    >
      No quota windows reported for this engine.
    </div>
  );
}

export default function UsageMonitorQuotaGridVisualFixture() {
  const windows = windowsForState();

  useEffect(() => {
    applySkin(DARK ? "midnight" : "studio");
  }, []);

  return (
    <div
      data-testid="usage-grid-fixture-root"
      className="w-[480px] bg-app p-6 text-ink"
    >
      <div className="text-[13px] font-medium text-ink" data-testid="usage-grid-engine-title">
        Engine quotas
      </div>
      <div data-testid="usage-grid-panel" className="mt-2">
        {windows && windows.length > 0 ? (
          <UsageMonitorQuotaGrid windows={windows} />
        ) : (
          <EmptyPlaceholder />
        )}
      </div>
    </div>
  );
}
