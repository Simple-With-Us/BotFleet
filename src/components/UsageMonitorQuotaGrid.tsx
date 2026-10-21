import { quotaPlanMetadataLines } from "../../shared/quota-plan-metadata";
import { isQuotaCellExhausted, type UsageMonitorQuotaWindow } from "@/lib/usage-monitor-quota";
import { absoluteQuotaLabel, formatResetCountdown } from "@/lib/quota-display";

function percentLabel(window: UsageMonitorQuotaWindow): string {
  const percent = window.remainingPercent;
  if (percent == null || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return "not reported";
  }
  return `${Math.round(percent)}% remaining`;
}

function resetLabel(resetAt: string | null | undefined): string {
  if (!resetAt) return "reset unknown";
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return "reset unknown";
  if (parsed <= Date.now()) return "awaiting refresh";
  return `Resets in ${formatResetCountdown(parsed)}`;
}

function resetHover(resetAt: string | undefined): string | undefined {
  if (!resetAt) return undefined;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return undefined;
  // Viewer timezone, labeled — never pin America/Chicago.
  return new Date(parsed).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function UsageMonitorQuotaGrid({ windows }: { windows: UsageMonitorQuotaWindow[] }) {
  if (windows.length === 0) return null;
  const rows = windows;

  return (
    <div className="ml-9 mt-1.5 grid grid-cols-2 gap-2" aria-label="Usage Monitor quota windows">
      {rows.map((window) => {
        // One shared verdict, never an expression of its own: the chip above
        // this grid and the routing behind it have to agree with the cell.
        const exhausted = isQuotaCellExhausted(window);
        const resetAt = window.resetAt ?? undefined;
        // "$0 of $400 on Ultra" / "12 of 300 requests": the figures the
        // collector already measured, which used to be rounded away into
        // the percentage above and then dropped.
        const absolute = absoluteQuotaLabel(window);
        return (
          <div
            key={`${window.providerKey ?? window.provider}:${window.window}:${window.label}`}
            className="rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2"
          >
            <div className="truncate text-[11px] font-medium text-ink" title={window.label}>
              {window.label}
            </div>
            <div className={`mt-0.5 text-[12px] tabular-nums ${exhausted ? "text-amber-700 dark:text-amber-300" : "text-ink-secondary"}`}>
              {percentLabel(window)}
            </div>
            {absolute && (
              <div className="truncate text-[10.5px] text-ink-secondary" title={absolute}>
                {absolute}
              </div>
            )}
            {quotaPlanMetadataLines(window.planMetadata).map((line, index) => (
              <div key={index} className="truncate text-[10.5px] text-ink-secondary" title={line}>
                {line}
              </div>
            ))}
            <div
              className="truncate text-[10.5px] text-ink-secondary"
              title={resetHover(resetAt)}
            >
              {resetLabel(resetAt)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
