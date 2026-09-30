// State and request shape for the Apply to All Bots block on the Models page.
//
// Each picker in that block owns one FIXED place: Primary, then Fallback 1,
// Fallback 2 and Fallback 3.  The state used to be four differently named
// variables, with `secondary` sitting under the label "Fallback 1" and
// `fallback1` under "Fallback 2", and the route compacted whatever was filled —
// so a value chosen only for "Fallback 2" landed on every bot's Fallback 1.
// Indexing the slots and sending them by index makes the place a picker is
// drawn in the place it is written.
import type { ModelSelection } from "@/state/store";
import { MAX_MODEL_FALLBACKS } from "../../shared/model-limits";

/** A slot is a real selection to write, or empty: "leave this place alone". */
export type DefaultModelSlot = ModelSelection | null;

/** One empty slot per fallback place. */
export function emptyFallbackSlots(): DefaultModelSlot[] {
  return Array.from({ length: MAX_MODEL_FALLBACKS }, () => null);
}

/** A copy of `slots` with place `index` replaced.  Out-of-range places are
 *  ignored rather than growing the list past the cap. */
export function withSlot(
  slots: readonly DefaultModelSlot[],
  index: number,
  value: DefaultModelSlot,
): DefaultModelSlot[] {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_MODEL_FALLBACKS) return [...slots];
  const next = [...slots];
  next[index] = value;
  return next;
}

/** Whether there is anything to apply. */
export function hasDefaults(primary: DefaultModelSlot, fallbacks: readonly DefaultModelSlot[]): boolean {
  return primary !== null || fallbacks.some((slot) => slot !== null);
}

type WireSlot = { instanceId: string; model: string; latest?: string };

/** A "Latest <Class>" pick keeps its class on the wire, so every bot floats
 *  on the class instead of freezing on today's slug.  A pinned pick
 *  (`latest` null or absent) sends no class. */
const wire = (slot: DefaultModelSlot): WireSlot | null =>
  slot
    ? {
        instanceId: slot.instanceId,
        model: slot.model,
        ...(typeof slot.latest === "string" && slot.latest ? { latest: slot.latest } : {}),
      }
    : null;

/** The body for POST /api/bots/apply-model-defaults.
 *
 *  `fallbacks` is always exactly MAX_MODEL_FALLBACKS long, with null for an
 *  empty picker, so the server reads position N as "Fallback N+1" without
 *  having to guess which pickers were filled. */
export function applyDefaultsBody(
  primary: DefaultModelSlot,
  fallbacks: readonly DefaultModelSlot[],
): { slots: { primary: WireSlot | null; fallbacks: (WireSlot | null)[] } } {
  return {
    slots: {
      primary: wire(primary),
      fallbacks: Array.from({ length: MAX_MODEL_FALLBACKS }, (_, index) => wire(fallbacks[index] ?? null)),
    },
  };
}
