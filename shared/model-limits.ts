/** The most fallback models a bot may be given.
 *
 *  Owner decision (2026-09-30): three.  Every surface that draws, adds or
 *  stores a fallback reads this one number — the desktop Models page, the
 *  per-bot settings panel, the Apply to All Bots block, the harness routes,
 *  and the iOS profile (`AgentProfileView.maximumFallbacks` mirrors it).
 *
 *  The cap used to be typed as a bare `2` in three places that did not agree:
 *  the Models page drew two slots, the per-bot panel drew every stored entry,
 *  and the harness enforced nothing.  A bot that reached three fallbacks
 *  through the API therefore looked like two bots' worth of chain on one screen
 *  and three on the other, and the third entry — which still ran — could not
 *  be seen or removed from the page the owner actually uses. */
export const MAX_MODEL_FALLBACKS = 3;

/** How many fallback places a surface should draw for a bot that stores
 *  `stored` of them.
 *
 *  Never fewer than the cap, and never fewer than what is stored, so an entry
 *  that predates the cap (or arrived through the API) is always shown and can
 *  always be removed instead of silently riding along. */
export function fallbackSlotCount(stored: number): number {
  return Math.max(MAX_MODEL_FALLBACKS, stored);
}

/** Whether a surface may offer to add one more fallback to a chain of
 *  `stored` entries.  A chain that is already over the cap offers nothing. */
export function canAddFallback(stored: number): boolean {
  return stored < MAX_MODEL_FALLBACKS;
}

/** Whether a write that leaves `next` fallbacks is allowed on a bot whose
 *  stored chain has `current` of them.
 *
 *  Growth past the cap is refused; everything else is not.  A bot whose chain
 *  is already over the cap (written before the cap existed, or by hand) keeps
 *  working: changing only its primary re-sends the whole chain unchanged, and
 *  refusing that would make the bot impossible to edit.  Shrinking or
 *  reordering such a chain is allowed too.  With no stored chain (a new bot,
 *  a task-level selection) the cap is absolute. */
export function fallbackCountAllowed(next: number, current: number = 0): boolean {
  return next <= Math.max(MAX_MODEL_FALLBACKS, current);
}
