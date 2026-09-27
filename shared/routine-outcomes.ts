export type RoutineOutcomeCode =
  | "completed" | "cancelled" | "capability_denied" | "auth_required"
  | "quota_exhausted" | "timeout" | "runtime_restart" | "runtime_reconfigured" | "bot_stopped"
  | "bot_missing" | "thread_missing" | "dispatch_failed" | "resume_failed"
  | "execution_failed" | "missed_offline" | "combined_unverified";

export type RoutineFailurePhase = "schedule" | "dispatch" | "execution" | "approval" | "lifecycle";

const REASONS: Record<string, RoutineOutcomeCode> = {
  interrupted: "cancelled", cancelled: "cancelled", canceled: "cancelled",
  auth_required: "auth_required", permission_denied: "capability_denied",
  capability_denied: "capability_denied", tool_denied: "capability_denied",
  quota_exhausted: "quota_exhausted", rate_limit: "quota_exhausted",
  prompt_timeout: "timeout", prompt_stall: "timeout", turn_timeout: "timeout", permission_timeout: "timeout", timeout: "timeout",
  resume_failed: "resume_failed", spawn_error: "dispatch_failed",
  "BotFleet restarted while this routine was running": "runtime_restart",
  "The bot stopped before this run finished": "bot_stopped",
  "The assigned Bot no longer exists": "bot_missing",
  "Could not find this bot's conversation": "thread_missing",
  "Could not create a task for this run": "thread_missing",
};

/** Only fixed driver reasons and harness messages become diagnostic codes.
 * Arbitrary upstream text stays in the existing error field, never in labels. */
export function routineFailureCode(reason?: string | null, setup = false, denied = false): RoutineOutcomeCode {
  return (reason && Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined)
    ?? (denied ? "capability_denied" : setup ? "auth_required" : "execution_failed");
}

export function routineFailurePhase(code: RoutineOutcomeCode): RoutineFailurePhase {
  if (["runtime_restart", "runtime_reconfigured", "bot_stopped", "cancelled"].includes(code)) return "lifecycle";
  if (["bot_missing", "thread_missing", "dispatch_failed", "auth_required", "resume_failed"].includes(code)) return "dispatch";
  if (code === "capability_denied") return "approval";
  if (code === "missed_offline") return "schedule";
  return "execution";
}

export const ROUTINE_OUTCOME_LABELS: Record<RoutineOutcomeCode, string> = {
  completed: "Completed", cancelled: "Cancelled", capability_denied: "Capability denied",
  auth_required: "Sign-in required", quota_exhausted: "Quota exhausted", timeout: "Timed out",
  runtime_restart: "Interrupted by restart", runtime_reconfigured: "Interrupted by settings change", bot_stopped: "Bot stopped", bot_missing: "Bot unavailable",
  thread_missing: "Conversation unavailable", dispatch_failed: "Could not start", resume_failed: "Could not resume",
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
