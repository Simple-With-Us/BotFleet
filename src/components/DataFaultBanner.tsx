// A bar across the top of the app when saved data could not be used: a bots,
// rooms, routines or settings file that was unreadable and has been set aside
// (never deleted), or one BotFleet could only partly read.  Silent when there
// is nothing to say, including when the server is an older build with no
// notices to give.  The words live in src/lib/data-faults.ts.
import { useState } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { dataFaultsAreUrgent, dataFaultsKey, dataFaultText, useDataFaults } from "@/lib/data-faults";

const GAP = "  ";

export function DataFaultBanner() {
  const faults = useDataFaults();
  // Dismissal holds for this set of notices only: a new or changed one brings the bar back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = dataFaultsKey(faults);
  if (faults.length === 0 || dismissed === key) return null;
  const urgent = dataFaultsAreUrgent(faults);
  return (
    <div
      role="alert"
      data-testid="data-fault-banner"
      className={cn(
        "flex items-start justify-between gap-3 border-b px-4 py-2 text-[13px] text-ink",
        urgent ? "border-danger/30 bg-danger/10" : "border-warning/30 bg-warning/10",
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {faults.map((fault) => {
          const { lead, body } = dataFaultText(fault);
          return (
            <p key={fault.file} className="break-words">
              <span className="font-medium">{lead}</span>
              {GAP}
              <span>{body}</span>
            </p>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Dismiss Saved Data Notice"
        onClick={() => setDismissed(key)}
        className="shrink-0 rounded-md p-0.5 hover:bg-raised"
      >
        <X size={14} />
      </button>
    </div>
  );
}
