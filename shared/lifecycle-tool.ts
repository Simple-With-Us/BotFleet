// Muse lifecycle tools (hooks, reminder children, workflows, subagents) can
// report ACP `failed` while their output text says the work finished. Normalize
// once here so every surface that reads `tool.ok` agrees.

const LIFECYCLE_TOOL_TITLE = /^\s*(?:hookRun|reminderChild|workflow|subagent)(?=[\s:_-]|$)/i;

const TITLE_TERMINAL_SUCCESS = /:\s*(?:completed|finished)\s*$/i;

/** Same shape as provider-route-activity and repeat-detector title guards. */
export function isLifecycleToolTitle(title: string | undefined): boolean {
  return Boolean(title?.trim() && LIFECYCLE_TOOL_TITLE.test(title));
}

/** Whether lifecycle output or a terminal title says the step finished. */
export function lifecycleTextSaysCompleted(detail: string | undefined, title?: string): boolean {
  if (title && TITLE_TERMINAL_SUCCESS.test(title.trim())) return true;
  const text = (detail ?? "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!/\b(?:main run )?(?:completed|finished)\b/.test(lower)) return false;
  if (/\b(?:not|never|unable to|couldn't|could not)\b.{0,48}\b(?:completed|finished)\b/.test(lower)) return false;
  if (/\b(?:did not|didn't)\s+(?:complete|finish)\b/.test(lower)) return false;
  if (/\bfailed to\b.{0,48}\b(?:complete|finish)\b/.test(lower)) return false;
  return true;
}

/** Treat a failed lifecycle status as success when its text says it completed. */
export function reconcileLifecycleToolOk(reportedOk: boolean, title: string | undefined, detail?: string): boolean {
  if (reportedOk) return true;
  if (!isLifecycleToolTitle(title)) return reportedOk;
  return lifecycleTextSaysCompleted(detail, title) ? true : reportedOk;
}
