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
 *  fleet's fallback reviewer.  Never any other engine. */
export type ReviewerRole = "own" | "fallback";

/** What a reviewer is sent (server/auto-review.ts `buildReviewPrompt`).
 *  Structured so no reviewer can glue the halves back into one string:
 *  `system` is the brief, sent in the system role, and `data` is the action
 *  under review, delimited, sent as the user turn. */
export interface ReviewPrompt {
  system: string;
  data: string;
}

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

// ── how many reviews a turn may spend ──────────────────────────────────
/** The default cap on reviewer calls per turn (`autoReview.maxReviewsPerTurn`
 *  in config, the `BOTFLEET_AUTO_REVIEW_MAX_PER_TURN` knob).  A reviewer call
 *  is one question to one reviewer, so a step the engine's own reviewer could
 *  not answer and the fallback then did counts twice.  Past the cap On fails
 *  closed (the turn stops, or the ask waits for a person) and Watch stops
 *  recording for the rest of the turn. */
export const DEFAULT_MAX_REVIEWS_PER_TURN = 50;
export const MIN_MAX_REVIEWS_PER_TURN = 1;
export const MAX_MAX_REVIEWS_PER_TURN = 500;

// ── who reviews ─────────────────────────────────────────────────────────
// One ordering and one health rule, used by the server when it asks and by
// the Bot Profile when it says who will be asked, so the two never drift.

/** The stored fallback-reviewer setting, read.  Absent or empty means
 *  Automatic (the best available engine), `none` means the owner turned the
 *  fallback off, and anything else is the instance id the owner picked. */
export type FallbackReviewerSetting =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "chosen"; instanceId: string };

export const FALLBACK_REVIEWER_NONE = "none";

export function fallbackReviewerSetting(stored: string | null | undefined): FallbackReviewerSetting {
  const value = stored?.trim();
  if (!value) return { kind: "auto" };
  if (value === FALLBACK_REVIEWER_NONE) return { kind: "none" };
  return { kind: "chosen", instanceId: value };
}

/** Engines whose isolated review is one more call to the very endpoint the
 *  bot's own turns use (the HTTP lanes).  Reviewing the bot's own action
 *  there is close to a model judging itself, so a different fallback
 *  reviewer, when there is one, is asked first. */
const SAME_ENDPOINT_REVIEW_DRIVERS: ReadonlySet<string> = new Set(["openai-compat", "minimax", "grok"]);

export function reviewSharesEngine(driverKind: string | undefined): boolean {
  return driverKind !== undefined && SAME_ENDPOINT_REVIEW_DRIVERS.has(driverKind);
}

/** How the automatic fallback reviewer is chosen, best first: Claude's
 *  review is a separate tool-free process on a small model, then the API
 *  lanes.  An engine not listed here can still be picked, after these. */
export const AUTO_REVIEWER_PREFERENCE: readonly string[] = ["claudeAgent", "openai-compat", "grok", "minimax"];

/** `unknown` is an engine nobody has probed yet, or whose probe is still
 *  answering.  It stays eligible, behind a healthy one, so a restart never
 *  leaves On with no reviewer at all for the seconds before the first probe. */
export type ReviewerHealth = "healthy" | "unknown" | "unhealthy";

export function reviewerHealth(snapshot: { state?: string; transient?: boolean } | null | undefined): ReviewerHealth {
  if (!snapshot) return "unknown";
  if (snapshot.state === "available" && snapshot.transient !== true) return "healthy";
  if (snapshot.transient === true) return "unknown";
  return "unhealthy";
}

export interface AutoReviewerCandidate {
  instanceId: string;
  driverKind: string;
  /** Switched on, and able to run an isolated review (`reviewPermission`). */
  canReview: boolean;
  health: ReviewerHealth;
}

/** The fallback reviewer Automatic picks, or null when no engine can review.
 *  Never an unhealthy engine; a healthy one before one not yet probed; then
 *  the preference above; then the order the engines are listed in. */
export function pickAutoReviewer(candidates: readonly AutoReviewerCandidate[]): string | null {
  const rank = (driverKind: string) => {
    const at = AUTO_REVIEWER_PREFERENCE.indexOf(driverKind);
    return at === -1 ? AUTO_REVIEWER_PREFERENCE.length : at;
  };
  const eligible = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.canReview && candidate.health !== "unhealthy");
  eligible.sort(
    (a, b) =>
      Number(b.candidate.health === "healthy") - Number(a.candidate.health === "healthy") ||
      rank(a.candidate.driverKind) - rank(b.candidate.driverKind) ||
      a.index - b.index,
  );
  return eligible[0]?.candidate.instanceId ?? null;
}

/** The order reviewers are asked in, by instance id: the engine that raised
 *  the request when it can review on its own, then the fallback reviewer.
 *  An HTTP lane's own review goes second when a different fallback exists,
 *  so a model is not the first judge of its own action.  The same engine is
 *  never listed twice. */
export function reviewerOrder(args: {
  engine: { instanceId: string; driverKind: string; canReview: boolean } | null | undefined;
  fallback: { instanceId: string; canReview: boolean } | null | undefined;
}): Array<{ instanceId: string; role: ReviewerRole }> {
  const own = args.engine?.canReview ? { instanceId: args.engine.instanceId, role: "own" as const } : null;
  const fallback =
    args.fallback?.canReview && args.fallback.instanceId !== args.engine?.instanceId
      ? { instanceId: args.fallback.instanceId, role: "fallback" as const }
      : null;
  if (own && fallback && reviewSharesEngine(args.engine?.driverKind)) return [fallback, own];
  return [own, fallback].filter((entry): entry is { instanceId: string; role: ReviewerRole } => entry !== null);
}
