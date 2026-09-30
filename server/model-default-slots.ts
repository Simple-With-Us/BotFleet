// Fixed-position fallback writes for POST /api/bots/apply-model-defaults.
//
// The route applies a handful of model choices to every bot at once.  Each
// fallback choice belongs to a FIXED place in the chain: position 0 is a bot's
// Fallback 1, position 1 its Fallback 2, position 2 its Fallback 3.  The route
// used to collect whichever slots were filled and push() them in order, which
// turned "Fallback 2 only" into "overwrite every bot's Fallback 1" and made it
// impossible to clear an entry.  Keeping the writes positional is what lets an
// empty picker mean "leave that place alone" without shifting anything.
import type { ModelSelection } from "./contracts.ts";
import { MAX_MODEL_FALLBACKS } from "../shared/model-limits.ts";

/** What one fallback place should do on every bot.
 *   keep  — leave whatever the bot has there (the empty picker).
 *   clear — remove the entry at that place (an explicit, deliberate wipe).
 *   set   — write this selection there. */
export type FallbackSlot =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; selection: ModelSelection };

export const KEEP_FALLBACK_SLOT: FallbackSlot = { kind: "keep" };

/** Whether any place in `slots` would change a bot's chain. */
export function touchesFallbacks(slots: readonly FallbackSlot[]): boolean {
  return slots.some((slot) => slot.kind !== "keep");
}

/** Apply fixed-position slots to one bot's existing fallback chain.
 *
 *  - A `set` at a place the bot already has overwrites that place in place.
 *  - A `set` past the end of the bot's chain is appended.  A chain cannot hold
 *    a hole — the validator rejects empty entries — and padding the bot with a
 *    copy of its primary so the place exists would invent a fallback nobody
 *    chose.  So a bot with one fallback that is told "Fallback 3" ends up with
 *    two, the new one last, which is also exactly where the per-bot "Add
 *    Fallback" control would have put it.
 *  - A `clear` removes the entry at that place; the entries after it move up,
 *    as they do when the per-bot Remove control is used.  Clearing a place the
 *    bot does not have is a no-op.
 *  - Places are read against the bot's chain AS IT WAS, so a request that sets
 *    Fallback 1 and clears Fallback 2 touches those two entries and nothing
 *    else, whatever order the slots are processed in.
 *
 *  Never grows a chain past max(MAX_MODEL_FALLBACKS, what the bot already had):
 *  it can only address places 0..MAX_MODEL_FALLBACKS-1. */
export function applyFallbackSlots(
  existing: readonly ModelSelection[],
  slots: readonly FallbackSlot[],
): ModelSelection[] {
  // `null` marks a cleared place so later places keep their original index.
  const next: (ModelSelection | null)[] = [...existing];
  const places = Math.min(slots.length, MAX_MODEL_FALLBACKS);
  for (let index = 0; index < places; index++) {
    const slot = slots[index]!;
    if (slot.kind === "keep") continue;
    if (slot.kind === "clear") {
      if (index < next.length) next[index] = null;
      continue;
    }
    if (index < next.length) next[index] = { ...slot.selection };
    else next.push({ ...slot.selection });
  }
  return next.filter((entry): entry is ModelSelection => entry !== null);
}
