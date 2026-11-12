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

/** The result of applying slots to one bot's chain: the new chain, or the
 *  reason this bot cannot take the request and must be left exactly as it was.
 *  `reason` is operator-facing and reads after a bot's name in parentheses. */
export type FallbackSlotResult =
  | { ok: true; fallbacks: ModelSelection[] }
  | { ok: false; reason: string };

/** Whether any place in `slots` would change a bot's chain. */
export function touchesFallbacks(slots: readonly FallbackSlot[]): boolean {
  return slots.some((slot) => slot.kind !== "keep");
}

/** Apply fixed-position slots to one bot's existing fallback chain.
 *
 *  The rule is one sentence: a `set` lands at its own place, or the bot is
 *  refused.  It is never slid to a neighbouring place.
 *
 *  - A `set` at a place the bot already has overwrites that place in place.
 *  - A `set` at the first place past the end of the chain extends it by one.
 *    That is still its own position: a bot with one fallback told "Fallback 2"
 *    gets a Fallback 2.
 *  - A `set` whose place has an empty place before it would leave a hole.  A
 *    chain cannot hold one — the validator rejects empty entries — and the
 *    only ways to close it are to slide the entry down to the wrong place or
 *    to pad the bot with a copy of its primary nobody chose.  Both make
 *    "Fallback 3" land somewhere other than Fallback 3, so neither is done:
 *    the bot is REFUSED, left exactly as it was, and the reason names the
 *    empty place so the operator can fill it.  The route reports it in the
 *    same `skipped` list a busy bot goes in.  A request that sets places 1, 2
 *    and 3 together is never refused, because each place is filled in turn.
 *  - A `clear` removes the entry at that place; the entries after it move up,
 *    as they do when the per-bot Remove control is used.  Clearing a place the
 *    bot does not have is a no-op.  A cleared place counts as empty for any
 *    `set` after it, for the same reason a short chain does: that entry would
 *    move up into the cleared place.
 *  - Places are read against the bot's chain AS IT WAS, so a request that sets
 *    Fallback 1 and clears Fallback 2 touches those two entries and nothing
 *    else, whatever order the slots are processed in.
 *
 *  Never grows a chain past max(MAX_MODEL_FALLBACKS, what the bot already had):
 *  it can only address places 0..MAX_MODEL_FALLBACKS-1. */
export function applyFallbackSlots(
  existing: readonly ModelSelection[],
  slots: readonly FallbackSlot[],
): FallbackSlotResult {
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
    for (let before = 0; before < index; before++) {
      if (next[before] == null) {
        return {
          ok: false,
          reason: `Fallback ${before + 1} is empty, so Fallback ${index + 1} cannot be set`,
        };
      }
    }
    if (index < next.length) next[index] = { ...slot.selection };
    else next.push({ ...slot.selection });
  }
  return { ok: true, fallbacks: next.filter((entry): entry is ModelSelection => entry !== null) };
}
