export type RoutineOutcomeCode =
  | "completed" | "cancelled" | "capability_denied" | "auth_required"
  | "quota_exhausted" | "timeout" | "runtime_restart" | "runtime_reconfigured" | "bot_stopped"
  | "bot_missing" | "thread_missing" | "dispatch_failed" | "engine_unavailable" | "resume_failed"
  | "budget_exhausted" | "execution_failed" | "missed_offline" | "combined_unverified";

export type RoutineFailurePhase = "schedule" | "dispatch" | "execution" | "approval" | "lifecycle";

/** Stop reasons that mean the ENGINE could not start, not that this run's work
 *  went wrong.  Only meaningful alongside the `setup` flag on the runtime
 *  error — a plain `spawn_error` from a mid-flight crash is a different fact
 *  and stays `dispatch_failed`. */
const SETUP_REASONS: Record<string, RoutineOutcomeCode> = {
  spawn_error: "engine_unavailable",
  setup_required: "engine_unavailable",
};

const REASONS: Record<string, RoutineOutcomeCode> = {
  interrupted: "cancelled", cancelled: "cancelled", canceled: "cancelled",
  auth_required: "auth_required", permission_denied: "capability_denied",
  capability_denied: "capability_denied", tool_denied: "capability_denied",
  quota_exhausted: "quota_exhausted", rate_limit: "quota_exhausted",
  prompt_timeout: "timeout", prompt_stall: "timeout", turn_timeout: "timeout", permission_timeout: "timeout", timeout: "timeout",
  resume_failed: "resume_failed", spawn_error: "dispatch_failed",
  // A turn that spent its tool-round ceiling did real work and stopped on a
  // budget line, which is a different fact from a crash: the work is partial
  // and resumable, the engine is fine, and the fix is a bigger `maxToolRounds`
  // rather than a retry.  Filing it as `execution_failed` made a configured
  // ceiling indistinguishable from a broken driver in receipts and digests.
  tool_round_limit: "budget_exhausted",
  "BotFleet restarted while this routine was running": "runtime_restart",
  "The bot stopped before this run finished": "bot_stopped",
  "The assigned Bot no longer exists": "bot_missing",
  "Could not find this bot's conversation": "thread_missing",
  "Could not create a task for this run": "thread_missing",
};

/** Only fixed driver reasons and harness messages become diagnostic codes.
 * Arbitrary upstream text stays in the existing error field, never in labels.
 *
 *  `setup` is consulted FIRST, for the reasons it can explain.  The old order
 *  looked `setup` up last, so an ENOENT spawn — the single most common
 *  doomed-engine failure, and the one that kept a recurring trigger
 *  re-dispatching into a CLI that was not installed — was recorded as a plain
 *  `dispatch_failed`, indistinguishable from a transient dispatch throw.  The
 *  receipt then said the wrong thing and nothing downstream could tell a dead
 *  engine from a busy one. */
export function routineFailureCode(reason?: string | null, setup = false, denied = false): RoutineOutcomeCode {
  if (setup && reason && Object.hasOwn(SETUP_REASONS, reason)) return SETUP_REASONS[reason];
  return (reason && Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined)
    ?? (denied ? "capability_denied" : setup ? "auth_required" : "execution_failed");
}

export function routineFailurePhase(code: RoutineOutcomeCode): RoutineFailurePhase {
  if (["runtime_restart", "runtime_reconfigured", "bot_stopped", "cancelled"].includes(code)) return "lifecycle";
  if (["bot_missing", "thread_missing", "dispatch_failed", "auth_required", "engine_unavailable", "resume_failed"].includes(code)) return "dispatch";
  if (code === "capability_denied") return "approval";
  if (code === "missed_offline") return "schedule";
  return "execution";
}

export const ROUTINE_OUTCOME_LABELS: Record<RoutineOutcomeCode, string> = {
  completed: "Completed", cancelled: "Cancelled", capability_denied: "Capability denied",
  auth_required: "Sign-in required", quota_exhausted: "Quota exhausted", timeout: "Timed out",
  runtime_restart: "Interrupted by restart", runtime_reconfigured: "Interrupted by settings change", bot_stopped: "Bot stopped", bot_missing: "Bot unavailable",
  thread_missing: "Conversation unavailable", dispatch_failed: "Could not start", engine_unavailable: "Engine unavailable",
  resume_failed: "Could not resume",
  budget_exhausted: "Round budget reached",
  execution_failed: "Execution failed", missed_offline: "Missed while offline", combined_unverified: "Combined; outcome unavailable",
};

export interface RoutineOutcomeRecord {
  routineId: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  outcomeCode?: RoutineOutcomeCode;
  coalescedInto?: string;
  error?: string;
  output?: string;
}

/** Statuses that left a task unfinished without anyone choosing to: the run
 *  settled without delivering the work it promised.  `cancelled` is a
 *  deliberate outcome and `completed` is the point, so neither is an
 *  unanswered failure.  Shared because the server decides what acknowledging
 *  clears and the client decides what the badge counts — two lists would
 *  drift into a badge the owner cannot dismiss. */
export const ROUTINE_ATTENTION_STATUSES = ["failed", "missed"] as const;

export function routineOutcomeCode(run: RoutineOutcomeRecord): RoutineOutcomeCode | undefined {
  if (run.outcomeCode) return run.outcomeCode;
  // Older releases settled combined receipts at dispatch, without retaining
  // the owning run ID.  Do not invent an execution result for that history.
  if (run.status === "completed" && run.finishedAt === run.startedAt && run.output?.startsWith("Handled together with ")) return "combined_unverified";
  if (run.status === "completed") return "completed";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "missed") return "missed_offline";
  if (run.status === "failed") return routineFailureCode(run.error);
  return undefined;
}

/** Summaries count executions once.  Combined receipts, cancellations, and
 * expected denials remain visible outside the completion-rate denominator. */
export function routineOutcomeSummary(runs: RoutineOutcomeRecord[], now: number, windowMs = 7 * 86_400_000) {
  const summary = { completed: 0, failed: 0, cancelled: 0, denied: 0, missed: 0, pending: 0, combined: 0,
    lastSuccessAt: null as number | null, lastFailureAt: null as number | null, successRate: null as number | null };
  for (const run of runs) {
    const code = routineOutcomeCode(run);
    const terminal = ["completed", "failed", "cancelled", "missed"].includes(run.status);
    const at = terminal ? run.finishedAt ?? run.createdAt : run.createdAt;
    if (!Number.isFinite(at) || at > now) continue;
    if (!run.coalescedInto && code !== "combined_unverified") {
      if (code === "completed") summary.lastSuccessAt = Math.max(summary.lastSuccessAt ?? -Infinity, at);
      else if (run.status === "failed" && code !== "capability_denied" && code !== "cancelled") summary.lastFailureAt = Math.max(summary.lastFailureAt ?? -Infinity, at);
    }
    if (at < now - windowMs) continue;
    if (run.coalescedInto || code === "combined_unverified") summary.combined++;
    else if (code === "completed") summary.completed++;
    else if (code === "cancelled") summary.cancelled++;
    else if (code === "capability_denied") summary.denied++;
    else if (code === "missed_offline") summary.missed++;
    else if (run.status === "failed") summary.failed++;
    else summary.pending++;
  }
  const finished = summary.completed + summary.failed;
  summary.successRate = finished ? summary.completed / finished : null;
  return summary;
}
