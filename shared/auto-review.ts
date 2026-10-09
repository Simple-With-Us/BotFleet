// The auto-review vocabulary both halves share.
//
// WHY THIS FILE EXISTS.  Auto-review used to be offered only when the engine
// that raised a permission request could also answer a review prompt on its
// own (`reviewPermission`), which only the Claude driver could.  Every other
// engine showed "cannot run an isolated review safely", even though most of
// them already route their approvals through the very same fold.  What an
// engine can actually offer depends on two separate questions, and the server
// and the Bot Profile have to answer them in the same words:
//
//  1. WHERE can BotFleet see this engine's tool calls?  That is the hook.
//  2. WHO reviews them?  The engine itself, or the fallback reviewer the
//     owner picked for the fleet.

/** The stored per-bot setting.  `shadow` is shown as Watch and `enforce` as
 *  On; an unknown stored value reads as `off`. */
export type AutoReviewMode = "off" | "shadow" | "enforce";

/** Where BotFleet can see an engine's tool calls, for auto-review.
 *
 *  - `before`: every action the engine asks about reaches the permission
 *    broker as `request.opened` BEFORE it runs, so the reviewer can hold it.
 *  - `after`: the engine runs its tools without asking (print mode, a remote
 *    box, or a full-auto instance) and reports each step as it starts.  The
 *    reviewer can only watch, and On can only stop the turn afterwards.
 *  - `none`: the engine reports no actions at all, so there is nothing to
 *    review.
 *
 *  An absent hook reads as `none` on the server.  The client treats an engine
 *  it has not heard from yet as unknown, never as `none`. */
export type ReviewHook = "before" | "after" | "none";

export const REVIEW_HOOKS: readonly ReviewHook[] = ["before", "after", "none"];

/** Who answered a review: the engine that raised the request, or the
 *  owner's fallback reviewer.  Never any other engine. */
export type ReviewerRole = "own" | "fallback";

/** The hook a turn actually gets.  A full-auto instance whose driver can run
 *  one turn in its asking mode (`asksWhenHeld`) is held there when review is
 *  On, so its asks reach the reviewer before they run. */
export function effectiveReviewHook(
  native: ReviewHook,
  asksWhenHeld: boolean,
  held: boolean,
): ReviewHook {
  if (native === "after" && asksWhenHeld && held) return "before";
  return native;
}
