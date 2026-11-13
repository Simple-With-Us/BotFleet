// Neutral engine facts shared by Settings → Engines and the capability matrix.
// This component deliberately avoids recommendation or marketing copy.  It
// reports only the access surface, billing mode, and model ids BotFleet knows.
import * as React from "react";

import {
  engineCapability,
  engineAccessLabel,
  engineIdFromDriverKind,
  pricingModeLabel,
  type EngineCapabilityEntry,
} from "@/lib/engine-capabilities";

export interface EngineCalloutProps {
  engineId?: string;
  driverKind?: string;
  models?: readonly string[];
  className?: string;
}

export function EngineCallout(props: EngineCalloutProps): React.ReactElement | null {
  const id = props.engineId ?? engineIdFromDriverKind(props.driverKind);
  if (!id) return null;
  const entry = engineCapability(id);
  const modelIds = props.models?.filter(Boolean) ?? entry.defaultModels.map((model) => model.id);
  const visibleModels = modelIds.slice(0, 6);
  const remaining = modelIds.length - visibleModels.length;

  return (
    <div className={props.className ?? "mt-2 grid gap-1 text-[11.5px] leading-relaxed text-ink-secondary"}>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="text-ink-secondary/70">Access:</span> {engineAccessLabel(entry)}</span>
        <span><span className="text-ink-secondary/70">Billing:</span> {pricingModeLabel(entry.pricing)}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-ink-secondary/70">Models:</span>
        <span className="min-w-0 break-words font-mono text-[11px] text-ink-secondary">
          {visibleModels.length > 0 ? visibleModels.join(", ") : "Discovered from the configured endpoint"}
          {remaining > 0 ? ` +${remaining} more` : ""}
        </span>
      </div>
    </div>
  );
}

/** Access chip used by <EngineCapabilitiesMatrix>.  Access and billing stay
 * separate because an API key can still draw on a subscription. */
export function AccessModeChip(props: { entry: EngineCapabilityEntry }): React.ReactElement {
  const { entry } = props;
  return (
    <span
      className="rounded-full bg-inset/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
      title={entry.pricing.kind === "subscription+api"
        ? `${entry.pricing.subscription.tierLabel}${typeof entry.pricing.subscription.costPerMonth === "number" ? ` · $${entry.pricing.subscription.costPerMonth.toFixed(2)}/mo` : ""}; API ${entry.pricing.api.inputPer1k}/1k in`
        : undefined}
    >
      {engineAccessLabel(entry)}
    </span>
  );
}
