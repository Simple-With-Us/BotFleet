// Test harness for tests/e2e/usage-monitor-quota-grid.visual.spec.ts.
//
// Mounts the real UsageMonitorQuotaGrid for an empty engine row and one
// populated window so visual baselines track production markup, not a dashed
// harness-only placeholder.
import { UsageMonitorQuotaGrid } from "./UsageMonitorQuotaGrid";
import { quotaGridPlaceholderLine } from "@/lib/quota-display";

const populatedWindow = {
  id: "claude-weekly",
  provider: "anthropic",
  providerKey: "anthropic",
  label: "Weekly",
  skip: false,
  window: "1w",
  resetAt: "2026-10-10T20:00:00.000Z",
  remainingPercent: 72,
  status: "available",
  planName: "Pro",
};

export default function UsageMonitorQuotaGridVisualFixture() {
  return (
    <div data-testid="usage-monitor-quota-grid-fixture" className="flex w-[520px] flex-col gap-6 bg-app p-4 text-ink">
      <section data-testid="quota-grid-empty" aria-label="Empty usage grid">
        <UsageMonitorQuotaGrid
          windows={[]}
          emptyLine={quotaGridPlaceholderLine("empty", "Claude")}
        />
      </section>
      <section data-testid="quota-grid-populated" aria-label="Populated usage grid">
        <UsageMonitorQuotaGrid windows={[populatedWindow]} />
      </section>
    </div>
  );
}
