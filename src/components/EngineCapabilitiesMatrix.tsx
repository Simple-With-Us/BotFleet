// Capability matrix for the Settings → Engines panel.
//
// ORIENTATION.  Rows are engines, columns are capabilities.  The old
// layout was the other way round — one row per capability, one column per
// engine — and with eight engines it needed 160 + (8 × 120) = 1120px inside
// a pane that only offers 1100 − 190 − 40 = 870px.  The first column was
// `sticky left-0`, so roughly 5.9 of 8 engines were ever on screen and the
// rest was a horizontal scroll nobody found.  Transposed, the same twelve
// capabilities are twelve narrow columns over eight short rows, which fits
// with room to spare and lines up with the engine rail rendered right
// below it, so a reader can scan a column and match names.
//
// THE DETAIL STRIP.  Hover used to render its explanation *after* the
// table, at the bottom of the card, roughly 570–600px down a 650px
// viewport — at or past the fold.  It also unmounted on `mouseleave`, so
// scrolling toward it destroyed it.  The strip below is always rendered at
// a fixed `min-height` and *latches*: it takes the last hovered or focused
// cell and keeps showing it.  Hovering a cell must not shift the layout
// under the pointer, and focus has to latch too, or the table is not
// keyboard-navigable in any useful way.
//
// SOURCE OF TRUTH.  This reads the `ENGINE_CAPABILITIES` registry
// (`src/lib/engine-capabilities.tsx`), not the live driver contract.  A
// future lane could query each instance's `snapshot.adapter.capabilities`
// and override the registry when they disagree; for now the registry is
// canonical and moves when a driver adds or removes a capability.  A pair
// nobody has audited is `"unknown"`, which renders as a question mark in
// its own colour — never as a dash wearing the "not available" tone.
//
// Uses the same Tailwind tokens as the rest of the settings panel:
// `border-hairline/40`, `bg-raised/30`, `text-ink-secondary`, `bg-inset/30`,
// and the accent palette.  No background is hardcoded, so the fleet's
// default `system` theme keeps working.
import * as React from "react";

import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_SHORT_LABELS,
  CAPABILITY_STATES,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellGlyph,
  capabilityCellLabel,
  capabilityNoteFor,
  type CapabilityKey,
  type CapabilityState,
  type EngineCapabilityEntry,
} from "@/lib/engine-capabilities";
import { PricingModeChip } from "./EngineCallout";
import { cn } from "@/lib/cn";
import type { InstanceInfo } from "@/state/store";

// ---------------------------------------------------------------------------
// Width budget.  These are the numbers that make "no horizontal scrolling"
// a property of the table rather than a hope, and the shape test imports
// them so a future contributor cannot quietly reintroduce the overflow.
// ---------------------------------------------------------------------------

/** Usable width of the settings content pane, in CSS pixels:
 *  `max-w-[1100px]` on the dialog, minus the 164px section nav, minus the
 *  20px `px-5` gutter on each side of the pane. */
export const MATRIX_CONTENT_BUDGET_PX = 1100 - 164 - 20 * 2;

/** The card's own `p-4` on both sides. */
export const MATRIX_CARD_PADDING_PX = 16 * 2;

/** What is left for the table itself. */
export const MATRIX_TABLE_BUDGET_PX = MATRIX_CONTENT_BUDGET_PX - MATRIX_CARD_PADDING_PX;

/** The sticky engine column. */
export const MATRIX_ROW_HEADER_PX = 188;

/** One capability column.  Wide enough for the two-word column labels at
 *  10.5px once they wrap onto a second line. */
export const MATRIX_CAPABILITY_COL_PX = 54;

// ---------------------------------------------------------------------------
// Per-state presentation.  `unknown` gets its own dashed, low-contrast
// treatment so an unaudited pair is never mistaken for a measured "no".
// ---------------------------------------------------------------------------

const CELL_TONE: Record<CapabilityState, string> = {
  yes: "text-emerald-700 dark:text-emerald-300 bg-emerald-500/10",
  no: "text-ink-secondary/70 bg-inset/30",
  limited: "text-amber-700 dark:text-amber-300 bg-amber-500/10",
  "yes-pro-only": "text-violet-700 dark:text-violet-300 bg-violet-500/10",
  unknown: "text-ink-secondary/50 border border-dashed border-hairline/50 bg-transparent",
};

/** What the matrix can say about an engine on this machine.  Derived only
 *  from fields the runtime actually provides — `snapshot.state`,
 *  `snapshot.authenticated`, and the presence of the instance — so a row
 *  never invents a reason string nobody reported. */
export type EngineAvailability = "ready" | "signed-out" | "cli-missing" | "absent";

const AVAILABILITY_TONE: Record<EngineAvailability, string> = {
  ready: "bg-emerald-500",
  "signed-out": "bg-amber-500",
  "cli-missing": "bg-ink-secondary/50",
  absent: "border border-dashed border-hairline/60 bg-transparent",
};

const AVAILABILITY_LABEL: Record<EngineAvailability, string> = {
  ready: "Ready",
  "signed-out": "Not signed in",
  "cli-missing": "Command-line app not found",
  absent: "Not on this computer",
};

/** Resolve install status from the instances the settings panel already
 *  has.  An engine with no instance is "absent" — that is the whole point:
 *  a newly added engine whose app was never installed used to be missing
 *  from this panel entirely. */
export function engineAvailability(
  entry: EngineCapabilityEntry,
  instances: readonly InstanceInfo[] | undefined,
): EngineAvailability {
  if (!instances) return "absent";
  const match = instances.find((instance) => engineIdFor(instance) === entry.id);
  if (!match) return "absent";
  if (match.snapshot.state !== "available") return "cli-missing";
  if (match.snapshot.authenticated === false) return "signed-out";
  return "ready";
}

function engineIdFor(instance: InstanceInfo): string | null {
  const normalized = instance.driverKind.replace(/Agent$/i, "").toLowerCase();
  if (normalized === "dsh" || normalized === "deepseek") return "deepseek-harness";
  return ENGINE_CAPABILITIES[normalized] ? normalized : null;
}

interface ActiveCell {
  engineId: string;
  key: CapabilityKey;
}

export function EngineCapabilitiesMatrix(props: {
  /** Live instances, so the engine column can say which engines are
   *  actually usable on this computer.  Omit it and every engine reports
   *  as "not on this computer". */
  instances?: readonly InstanceInfo[];
}): React.ReactElement {
  // Resolve the engine list up front so a future filter (engines the user
  // has not installed, engines hidden by preference) can replace this
  // constant without touching the renderer.
  const engines = ENGINE_DISPLAY_ORDER
    .map((id) => ENGINE_CAPABILITIES[id])
    .filter((entry): entry is EngineCapabilityEntry => Boolean(entry));

  // Latched, not hovered.  `setActive` is called on mouse enter and on
  // focus and is *never* cleared by leaving — that is the fix.  A global
  // store would force every other panel cell to re-render on every mouse
  // move, which is the wrong shape for this.
  const [active, setActive] = React.useState<ActiveCell | null>(null);
  const activeEntry = active ? ENGINE_CAPABILITIES[active.engineId] : undefined;
  const activeState = activeEntry && active ? activeEntry.capabilities[active.key] : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-hairline/40 bg-raised/30 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[14px] font-medium text-ink">Engine Capabilities</h3>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          {"What every engine can do, one row per engine.  Hover or focus a cell to read what that capability means; the panel below keeps the text so you can read it without chasing the pointer."}
        </p>
      </div>

      {/* No `overflow-x-auto` on purpose: the declared column budget below is
          asserted against the pane width by the shape test, so this table is
          not allowed to need a horizontal scrollbar. */}
      <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]">
        <colgroup>
          <col style={{ width: `${MATRIX_ROW_HEADER_PX}px` }} />
          {CAPABILITY_KEYS.map((key) => (
            <col key={key} style={{ width: `${MATRIX_CAPABILITY_COL_PX}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              rowSpan={2}
              className="sticky left-0 top-0 z-30 border-b border-r border-hairline/40 bg-raised px-3 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide text-ink-secondary"
            >
              Engine
            </th>
            {CAPABILITY_CATEGORIES.map((category) => (
              <th
                key={category.id}
                scope="colgroup"
                colSpan={category.keys.length}
                className="sticky top-0 z-20 border-b border-hairline/40 bg-raised px-1 py-1 text-center text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary/80"
              >
                {category.label}
              </th>
            ))}
          </tr>
          <tr>
            {CAPABILITY_KEYS.map((key) => (
              <th
                key={key}
                scope="col"
                title={CAPABILITY_LABELS[key]}
                className="sticky top-[22px] z-10 border-b border-hairline/40 bg-raised px-1 py-1.5 text-center align-bottom text-[10.5px] font-medium leading-tight text-ink-secondary"
              >
                {CAPABILITY_SHORT_LABELS[key]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {engines.map((entry) => {
            const availability = engineAvailability(entry, props.instances);
            return (
              <tr key={entry.id}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-hairline/20 bg-raised px-3 py-1.5 text-left font-normal"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      title={AVAILABILITY_LABEL[availability]}
                      className={cn("size-1.5 shrink-0 rounded-full", AVAILABILITY_TONE[availability])}
                    />
                    <span
                      className={cn(
                        "flex shrink-0 items-center justify-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
                        entry.capabilityBadgeColor,
                      )}
                    >
                      {entry.displayName}
                    </span>
                    <span className="ml-auto shrink-0">
                      <PricingModeChip entry={entry} />
                    </span>
                  </span>
                </th>
                {CAPABILITY_KEYS.map((key) => {
                  const state = entry.capabilities[key];
                  const word = capabilityCellLabel(state);
                  const isActive =
                    active?.engineId === entry.id && active.key === key;
                  return (
                    <td
                      key={key}
                      onMouseEnter={() => setActive({ engineId: entry.id, key })}
                      onFocus={() => setActive({ engineId: entry.id, key })}
                      tabIndex={0}
                      title={`${entry.displayName} · ${CAPABILITY_LABELS[key]} · ${word}`}
                      aria-label={`${entry.displayName}, ${CAPABILITY_LABELS[key]}: ${word}`}
                      className={cn(
                        "cursor-default border-b border-hairline/20 p-1 text-center align-middle text-[12px] leading-none tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                        CELL_TONE[state ?? "unknown"],
                        isActive && "ring-2 ring-accent/50",
                      )}
                    >
                      {capabilityCellGlyph(state)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Always mounted, fixed minimum height, and never cleared by the
          pointer leaving.  This is the strip the old matrix rendered below
          the fold and then unmounted out from under the reader. */}
      <div
        aria-live="polite"
        className="flex min-h-[92px] flex-col justify-center gap-1 rounded-xl border border-accent/30 bg-accent/5 p-3"
      >
        {activeEntry && active ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-ink">
              <span
                className={cn(
                  "flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
                  activeEntry.capabilityBadgeColor,
                )}
              >
                {activeEntry.displayName}
              </span>
              <span className="text-ink-secondary">·</span>
              <span>{CAPABILITY_LABELS[active.key]}</span>
              <span className="text-ink-secondary">·</span>
              <span className="font-normal text-ink-secondary">
                {capabilityCellLabel(activeState)}
              </span>
              <span className="text-[11px] font-normal text-ink-secondary/70">
                {AVAILABILITY_LABEL[engineAvailability(activeEntry, props.instances)]}
              </span>
            </div>
            <p className="text-[12px] leading-relaxed text-ink-secondary">
              {capabilityNoteFor(activeEntry, active.key)}
            </p>
          </>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            {"Hover or focus any cell to read what that capability means for that engine.  The text stays here once it appears, so you can read it and look back at the table without losing it."}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-relaxed text-ink-secondary">
        {CAPABILITY_STATES.map((state) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className={cn("rounded px-1 py-0.5 text-[11px] leading-none", CELL_TONE[state])}>
              {capabilityCellGlyph(state)}
            </span>
            {capabilityCellLabel(state)}
          </span>
        ))}
        <span className="basis-full">
          {"A cell marked not audited is a gap in this table, not a claim about the engine.  Connected Apps, for example, is only available where the driver mounts that channel, and driving this Mac is a different capability from reaching a third-party service."}
        </span>
      </div>
    </div>
  );
}
