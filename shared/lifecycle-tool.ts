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

const NAMES_FAILURE = /\b(?:\d+\s+)?(?:errors?|failed|failures?)\b/;

function namesFailure(detail: string | undefined, title?: string): boolean {
  const titleBody = (title ?? "").replace(TITLE_STATUS_SUFFIX, "");
  return NAMES_FAILURE.test(`${titleBody}\n${detail ?? ""}`.toLowerCase());
}

/** Same shape as provider-route-activity and repeat-detector title guards. */
export function isLifecycleToolTitle(title: string | undefined): boolean {
  return Boolean(title?.trim() && LIFECYCLE_TOOL_TITLE.test(title));
}

/** Whether lifecycle output or a terminal title says the step finished. */
export function lifecycleTextSaysCompleted(detail: string | undefined, title?: string): boolean {
  const lower = (detail ?? "").trim().toLowerCase();
  // "completed with errors" is not done, even under a completed title.
  if (namesFailure(detail, title)) return false;
  if (title && TITLE_TERMINAL_SUCCESS.test(title.trim())) return true;
  if (!lower) return false;
  if (!/\b(?:main run )?(?:completed|finished)\b/.test(lower)) return false;
  if (/\b(?:not|never|unable to|couldn't|could not)\b.{0,48}\b(?:completed|finished)\b/.test(lower)) return false;
  if (/\b(?:did not|didn't)\s+(?:complete|finish)\b/.test(lower)) return false;
  return true;
}

/** Treat a failed lifecycle status as success when its text says it completed.
 *  Text that names errors or failures stays failed, including when the
 *  provider already reported the step completed. */
export function reconcileLifecycleToolOk(reportedOk: boolean, title: string | undefined, detail?: string): boolean {
  if (!isLifecycleToolTitle(title)) return reportedOk;
  if (namesFailure(detail, title)) return false;
  return lifecycleTextSaysCompleted(detail, title) ? true : reportedOk;
}
