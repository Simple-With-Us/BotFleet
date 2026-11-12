// Muse lifecycle tools (hooks, reminder children, workflows, subagents) can
// report ACP `failed` while their output text says the work finished. Normalize
// once here so every surface that reads `tool.ok` agrees.

const LIFECYCLE_TOOL_TITLE = /^\s*(?:hookRun|reminderChild|workflow|subagent)(?=[\s:_-]|$)/i;

const TITLE_TERMINAL_SUCCESS = /:\s*(?:completed|finished)\s*$/i;

// A trailing status token is the provider's state, not a claim that the work
// failed.  "reminderChild: failed" can still be a completed child.  Prose such
// as "completed with errors" is a claim, whether it sits in the title or the
// output.
const TITLE_STATUS_SUFFIX = /:\s*(?:inprogress|in_progress|pending|completed|finished|failed|cancelled|canceled|rejected|live state unknown)\s*$/i;

const FAILURE_WORD = /\b(?:errors?|failed|failures?)\b/g;

// A count of zero, or "no" / "without" / "zero" immediately before the word,
// is a clean run.  "10 errors" stays a failure because the 0 is not its own token.
const NEGATED_BEFORE = /(?:^|[^a-z0-9])(?:without|zero|no|0)\s+$/;

function lifecycleProse(detail: string | undefined, title?: string): string {
  const titleBody = (title ?? "").replace(TITLE_STATUS_SUFFIX, "");
  return `${titleBody}\n${detail ?? ""}`.toLowerCase();
}

/** Unnegated failure words force a miss.  A negated one ("0 errors", "no failures") is a clean finish. */
function scanFailureWords(text: string) {
  let bare = false;
  let clean = false;
  for (const match of text.matchAll(FAILURE_WORD)) {
    const before = text.slice(0, match.index ?? 0);
    if (NEGATED_BEFORE.test(before)) clean = true;
    else bare = true;
  }
  return { bare, clean };
}

function namesFailure(detail: string | undefined, title?: string): boolean {
  return scanFailureWords(lifecycleProse(detail, title)).bare;
}

/** Same shape as provider-route-activity and repeat-detector title guards. */
export function isLifecycleToolTitle(title: string | undefined): boolean {
  return Boolean(title?.trim() && LIFECYCLE_TOOL_TITLE.test(title));
}

/** Whether lifecycle output or a terminal title says the step finished. */
export function lifecycleTextSaysCompleted(detail: string | undefined, title?: string): boolean {
  const lower = (detail ?? "").trim().toLowerCase();
  const scan = scanFailureWords(lifecycleProse(detail, title));
  // "completed with errors" is not done.  "completed with no errors" and "0 failures" are.
  if (scan.bare) return false;
  if (title && TITLE_TERMINAL_SUCCESS.test(title.trim())) return true;
  if (/\b(?:not|never|unable to|couldn't|could not)\b.{0,48}\b(?:completed|finished)\b/.test(lower)) return false;
  if (/\b(?:did not|didn't)\s+(?:complete|finish)\b/.test(lower)) return false;
  if (scan.clean) return true;
  if (!lower) return false;
  if (!/\b(?:main run )?(?:completed|finished)\b/.test(lower)) return false;
  return true;
}

/** Treat a failed lifecycle status as success when its text says it completed.
 *  An unnegated error or failure stays failed.  "no errors" and "0 failures" count as done. */
export function reconcileLifecycleToolOk(reportedOk: boolean, title: string | undefined, detail?: string): boolean {
  if (!isLifecycleToolTitle(title)) return reportedOk;
  if (namesFailure(detail, title)) return false;
  return lifecycleTextSaysCompleted(detail, title) ? true : reportedOk;
}
