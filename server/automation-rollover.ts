// Forever-thread rollover for automation (webhook / resource / routine) tasks.
//
// Problem: a keyed automation task accumulates forever.  Chat-completions
// drivers clip each request (see DEFAULT_REPLAY_CAP in
// drivers/chat-completions/replay-cap.ts — 200 KiB / 60 entries — and
// MAX_REPLAY_BYTES in turn-context.ts — 128 KiB), but ACP/native engines
// still carry the whole session.  Compiler-class seats have burned billions
// of input tokens replaying one home thread (oracle waste report 2026-09-30).
//
// Fix: at admission time for the NEXT wake (never mid-turn), when the keyed
// task is past a size threshold, mint a NEW task that takes the same
// `automationKey`.  The old task keeps its history for receipts; webhooks
// keep routing via the key.  The new task starts with a thin system pointer,
// not the full transcript.
//
// Thresholds sit well ABOVE the per-request replay caps so we do not churn
// every time the HTTP window slides — rollover is for durable-thread bloat,
// not for the request clip.  Override with OMB_AUTOMATION_ROLLOVER_MAX_TURNS
// / OMB_AUTOMATION_ROLLOVER_MAX_MESSAGES when tuning a seat.

/** Snapshot used to decide whether a keyed automation thread should roll. */
export interface AutomationThreadSize {
  /** Settled turns banked on the task (`TaskRecord.usage.turns`). */
  turns: number;
  /** Durable message rows on the thread (SQL count or cached length). */
  messages: number;
}

export interface AutomationRolloverCaps {
  /** Rollover when `usage.turns` reaches this.  Default 300 — 5× the
   * chat-completions entry cap (60), so HTTP clipping already kicked in
   * many times before we mint a fresh task. */
  maxTurns: number;
  /** Rollover when the durable message count reaches this.  Default 600 —
   * 10× the entry cap; catches threads whose turn counter undercounts
   * (tool/activity-heavy cards) while staying well below Compiler-scale
   * multi-thousand message homes. */
  maxMessages: number;
}

const DEFAULT_MAX_TURNS = 300;
const DEFAULT_MAX_MESSAGES = 600;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Live caps: defaults, optionally overridden by env for ops tuning. */
export function automationRolloverCaps(
  env: NodeJS.ProcessEnv = process.env,
): AutomationRolloverCaps {
  return {
    maxTurns: positiveInt(env.OMB_AUTOMATION_ROLLOVER_MAX_TURNS, DEFAULT_MAX_TURNS),
    maxMessages: positiveInt(env.OMB_AUTOMATION_ROLLOVER_MAX_MESSAGES, DEFAULT_MAX_MESSAGES),
  };
}

export const DEFAULT_AUTOMATION_ROLLOVER_CAPS: AutomationRolloverCaps = {
  maxTurns: DEFAULT_MAX_TURNS,
  maxMessages: DEFAULT_MAX_MESSAGES,
};

/** True when either budget is exhausted.  Zero-size threads never roll. */
export function shouldRolloverAutomationThread(
  size: AutomationThreadSize,
  caps: AutomationRolloverCaps = DEFAULT_AUTOMATION_ROLLOVER_CAPS,
): boolean {
  const turns = Math.max(0, size.turns | 0);
  const messages = Math.max(0, size.messages | 0);
  if (turns === 0 && messages === 0) return false;
  return turns >= caps.maxTurns || messages >= caps.maxMessages;
}

/** Thin seed for the replacement task — pointer only, not a history dump. */
export function automationRolloverSeedText(input: {
  previousThreadId: string;
  previousTitle?: string;
  turns?: number;
  messages?: number;
}): string {
  const label = input.previousTitle?.trim() || "previous automation thread";
  const stats: string[] = [];
  if (input.turns && input.turns > 0) stats.push(`${input.turns} turns`);
  if (input.messages && input.messages > 0) stats.push(`${input.messages} messages`);
  const size = stats.length > 0 ? ` (${stats.join(", ")})` : "";
  return [
    `[Automation thread rolled over]`,
    `Earlier work for this webhook/routine lives in “${label}” (${input.previousThreadId})${size}.`,
    `This is a fresh task under the same automation key so context stays thin.`,
    `Do not replay the old transcript; open that thread only if you need a specific receipt.`,
  ].join(" ");
}
