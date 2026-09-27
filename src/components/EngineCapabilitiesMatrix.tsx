// Capability matrix for the Settings → Engines panel.  Renders a 2-axis
// grid: rows are capabilities (Files, Terminal, …), columns are engines,
// cells hold the capability state (✓ / ✗ / limited / pro only / —).
//
// One row per capability, one column per engine — there is no engine
// duplication, so the layout stays scannable on a 1440×900 viewport.
// Hover a cell to surface the engine's "Why This Engine?" prose for the
// relevant capability (or the engine's overall prose when the registry
// does not yet differentiate per capability).
//
// Sits under the cloud/local tabs and ahead of the per-engine detail
// rows.  Uses the same Tailwind tokens the rest of the settings panel
// uses — `border-hairline/40`, `bg-inset/30`, `text-ink-secondary`, and
// the accent palette the panel already has for "Available" chips.
//
// Source-of-truth: this matrix reads the `ENGINE_CAPABILITIES` registry
// (`src/lib/engine-capabilities.tsx`), NOT the live driver contract.  A
// future lane could query each instance's `snapshot.adapter.capabilities`
// for live data and override the registry value when they disagree —
// for now the registry is the canonical view and is updated when a
// driver adds/removes a capability (`server/drivers/claude.ts:1250-1262`,
// `server/drivers/codex.ts:714-723`, etc.).  Codex flagged the gap; the
// registry already documents it.
import * as React from "react";
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellLabel,
  type CapabilityKey,
  type EngineCapabilityEntry,
} from "@/lib/engine-capabilities";
import { PricingModeChip } from "./EngineCallout";
import { EngineCalloutBody } from "@/lib/engine-capabilities";

const CELL_TEXT_TONE: Record<string, string> = {
  yes: "text-emerald-700 dark:text-emerald-300 bg-emerald-500/10",
  no: "text-ink-secondary bg-inset/40",
  limited: "text-amber-700 dark:text-amber-300 bg-amber-500/10",
  "yes-pro-only": "text-violet-700 dark:text-violet-300 bg-violet-500/10",
};

export function EngineCapabilitiesMatrix(): React.ReactElement {
  // Resolve the engine list up front so a future filter (disabled engines,
  // engines the user has not installed) can replace this constant without
  // touching the renderer.
  const engines = ENGINE_DISPLAY_ORDER
    .map((id) => ENGINE_CAPABILITIES[id])
    .filter((entry): entry is EngineCapabilityEntry => Boolean(entry));

  // Hover state lives locally — a global store would force every other
  // panel cell to re-render on every mouse move, which is the wrong shape
  // for a hover tooltip.
  const [hover, setHover] = React.useState<{ engineId: string; key: CapabilityKey } | null>(null);
  const hoveredEntry = hover ? ENGINE_CAPABILITIES[hover.engineId] : null;
  const hoveredCapability = hover?.key;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-hairline/40 bg-raised/30 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[14px] font-medium text-ink">Engine Capabilities</h3>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {"What every installed engine can do.\u00A0 Hover a cell for the engine's reasoning — the same prose the per-row \"Why This Engine?\" callout shows, kept in one place so the two never drift apart."}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[160px] border-b border-hairline/40 bg-raised/40 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                Capability
              </th>
              {engines.map((entry) => (
                <th
                  key={entry.id}
                  className="min-w-[120px] border-b border-hairline/40 bg-raised/40 px-2.5 py-2 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`flex shrink-0 items-center justify-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${entry.capabilityBadgeColor}`}
                    >
                      {entry.displayName}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <PricingModeChip entry={entry} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_KEYS.map((key) => (
              <tr key={key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-hairline/20 bg-raised/20 px-3 py-2 text-left text-[12px] font-normal text-ink"
                >
                  {CAPABILITY_LABELS[key]}
                </th>
                {engines.map((entry) => {
                  const state = entry.capabilities[key];
                  const tone = CELL_TEXT_TONE[state ?? ""] ?? CELL_TEXT_TONE.no;
                  return (
                    <td
                      key={entry.id}
                      onMouseEnter={() => setHover({ engineId: entry.id, key })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ engineId: entry.id, key })}
                      onBlur={() => setHover(null)}
                      tabIndex={0}
                      className={`cursor-default border-b border-hairline/20 px-2.5 py-2 text-center align-middle text-[12px] tabular-nums ${tone}`}
                      title={`${entry.displayName} · ${CAPABILITY_LABELS[key]} · ${capabilityCellLabel(state)}`}
                    >
                      {capabilityCellLabel(state)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hoveredEntry && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-ink">
            <span
              className={`flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${hoveredEntry.capabilityBadgeColor}`}
            >
              {hoveredEntry.displayName}
            </span>
            <span className="text-ink-secondary">·</span>
            <span className="text-ink-secondary">{hoveredCapability ? CAPABILITY_LABELS[hoveredCapability] : "Overview"}</span>
          </div>
          <EngineCalloutBody entry={hoveredEntry} className="border-0 bg-transparent p-0" />
        </div>
      )}

      <div className="text-[11.5px] leading-relaxed text-ink-secondary">
        Capability verdicts reflect the engine's driver on the current build — for example,
        "connected apps" is only "yes" for engines whose driver actually exposes the MCP
        channel.  Pricing labels follow the same registry the per-engine rows use, so a
        <em> Subscription · $99/mo</em> chip on Grok here matches the headline on the Grok row
        above.
      </div>
    </div>
  );
}
