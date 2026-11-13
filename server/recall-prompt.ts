// The shared-memory sentences a bot is given when its driver actually
// mounted the recall proxy.
//
// Twelve drivers mount `recall_search`, `recall_contribute` and
// `recall_stats`, and until now not one word of the assembled system prompt
// mentioned them — every other integration gets a sentence there (composio
// inline, the computer through its own prompt, peers through the
// coordination prompt).  A tool a model is never pointed at is one it calls
// by accident, if at all.
//
// The gate is the mounted integration, never the config: `cfg.qdrant` says
// the operator configured a corpus, not that THIS engine can reach it.  A
// bot on pi, MiniMax or Grok would otherwise be told about tools its driver
// cannot mount, which is the harness's own rule against describing a
// capability that is not there.  PR #465 added a second mount path for
// HTTP-lane drivers (MiniMax, OpenAI-compat, Grok HTTP) — the same recall
// tools, in-process — and `recall` here is the matching gate flag the
// dispatch sets whenever the HTTP-lane mount is active, so the prompt keeps
// firing for that lane.

/** The mounted integrations of one turn.  Structural on purpose: both the
 * 1:1 and the room assembly sites pass their own turn-input integrations
 * object plus the dispatch's HTTP-lane recall flag, and the function fires
 * when EITHER mount path is active. */
export interface RecallPromptIntegrations {
  qdrant?: unknown;
  /** Set true when the HTTP-lane in-process recall mount (PR #465) is
   *  active for this turn.  Independent of `qdrant` because the two
   *  mounts never both fire at once — different engines, different gates. */
  recall?: boolean;
}

/**
 * The recall paragraph, or "" when this turn mounted no corpus.
 *
 * Leading space, no trailing punctuation quirks: it concatenates into the
 * same system string as the composio and coordination sentences.
 */
export function recallPromptFor(integrations?: RecallPromptIntegrations | null): string {
  if (!integrations?.qdrant && !integrations?.recall) return "";
  return (
    " You share a memory corpus with the rest of the fleet — lessons, preferences, infrastructure facts, decisions," +
    " and runbooks written by other seats and bots.  Search it with recall_search before you re-derive a lesson," +
    " debug something that smells familiar, or ask a question a past ruling probably answers, and treat a hit as a" +
    " lead to verify rather than a verdict.  When you learn something reusable, save one paragraph with" +
    " recall_contribute under the category lesson, preference, infrastructure, decision, or runbook — never" +
    " secrets, and never a transcript."
  );
}
