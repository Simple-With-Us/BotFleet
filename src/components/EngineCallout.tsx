// Shared "Why This Engine?" callout.  Replaces the MiniMax-only
// `<MiniMaxCallout>` so every engine row gets the same prose block —
// the panel used to render detail copy only for the MiniMax row, and a
// reader flipping through Claude / Codex / Cursor had to infer the
// differences themselves.  Reads from the capability registry at
// `src/lib/engine-capabilities.tsx` so the prose and the matrix table
// stay in sync.
//
// Compact by default (collapsed to the Title Case label) so ModelPicker
// can keep the model list on screen.  Expand reveals the headline, full
// prose, and pricing.  The capability matrix keeps using
// `<EngineCalloutBody>` directly for the always-expanded hover panel.
//
// Props:
//   - `engineId`  — registry key (e.g. "minimax", "claude", "grok").
//   - `driverKind`— optional runtime driver-kind id.  When the driver
//                   layer reports a name like "grokAgent" the registry
//                   id is "grok"; the helper handles the mapping.
//   - `instanceId`— optional instance id so aria-controls stays unique
//                   when EnginesSettings renders several callouts.
//   - `defaultOpen` — start expanded (default false).
//   - `className` — optional override; default matches the legacy
//                   MiniMax callout's box style.
import * as React from "react";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  engineCapability,
  engineIdFromDriverKind,
  pricingModeLabel,
  type EngineCapabilityEntry,
} from "@/lib/engine-capabilities";
import { cn } from "@/lib/cn";

export interface EngineCalloutProps {
  engineId?: string;
  driverKind?: string;
  instanceId?: string;
  defaultOpen?: boolean;
  className?: string;
}

export function EngineCallout(props: EngineCalloutProps): React.ReactElement | null {
  const id = props.engineId ?? engineIdFromDriverKind(props.driverKind);
  if (!id) return null;
  const entry = engineCapability(id);
  return (
    <EngineCalloutDisclosure
      entry={entry}
      instanceId={props.instanceId ?? id}
      defaultOpen={props.defaultOpen ?? false}
      className={props.className}
    />
  );
}

function EngineCalloutDisclosure(props: {
  entry: EngineCapabilityEntry;
  instanceId: string;
  defaultOpen: boolean;
  className?: string;
}): React.ReactElement {
  const { entry, instanceId, defaultOpen, className } = props;
  const [open, setOpen] = useState(defaultOpen);
  const reactId = useId();
  // Prefer the instance id so EnginesSettings rows never collide; fall
  // back to React's useId when somehow blank.
  const detailId = `engine-callout-detail-${instanceId || reactId}`;

  return (
    <div
      className={
        className ??
        "mt-2 rounded-xl border border-hairline/30 bg-inset/30 px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary"
      }
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // Only point at the detail region while it is rendered; a collapsed
        // callout has no element with this id.
        aria-controls={open ? detailId : undefined}
        className="flex w-full items-center gap-1.5 rounded text-left text-ink hover:text-ink"
      >
        <span className="min-w-0 flex-1 truncate">
          <strong>Why This Engine?</strong>
        </span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <div id={detailId} className="mt-1.5 max-h-40 overflow-y-auto">
          <p className="mb-1.5 text-ink">{entry.whyThisEngine.headline}</p>
          {entry.whyThisEngine.prose.map((line, index) => (
            <p key={index} className="mb-1 last:mb-0">
              {line}
            </p>
          ))}
          <p className="mt-1.5 text-[11px] text-ink-secondary/80">
            Pricing: {pricingModeLabel(entry.pricing)}.
          </p>
        </div>
      )}
    </div>
  );
}

/** Header chip used by `<EngineCapabilitiesMatrix>` — exposes the same
 *  pricing-mode label the callout uses, so the two stay in sync. */
export function PricingModeChip(props: { entry: EngineCapabilityEntry }): React.ReactElement {
  const { entry } = props;
  return (
    <span
      className="rounded-full bg-inset/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
      title={entry.pricing.kind === "subscription+api"
        ? `${entry.pricing.subscription.tierLabel}${typeof entry.pricing.subscription.costPerMonth === "number" ? ` · $${entry.pricing.subscription.costPerMonth.toFixed(2)}/mo` : ""}; API ${entry.pricing.api.inputPer1k}/1k in`
        : undefined}
    >
      {pricingModeLabel(entry.pricing)}
    </span>
  );
}
