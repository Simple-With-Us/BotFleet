// Engine-native helpers (jobs P3, docs/plans/2026-10-01-background-jobs-and-
// subagents-decision.md).
//
// A helper is an engine's own subagent, shown as a card in place of the
// Task, Agent, spawn_agent or invoke_subagent row.  BotFleet does not run
// a second helper runtime: Claude and Codex stamp the call that started
// the helper (typed), and a named engine is recognised by the tool name
// alone.  The header pill counts a helper only while it runs.

export type HelperFidelity = "typed" | "named";

export type HelperStatus = "running" | "completed" | "failed";

/** What a `subagent.updated` frame carries, and what the transcript stores
 * on the row that started the helper.  No process ids and no output. */
export interface SubagentSnapshot {
  /** The tool call that started the helper.  The same id its steps name. */
  id: string;
  threadId: string;
  parentItemId: string;
  /** 1 for a helper the bot started.  A helper's own helper is 2. */
  depth: number;
  fidelity: HelperFidelity;
  /** The short name a reader sees: the description when the engine gave
   * one, otherwise the tool name. */
  label: string;
  /** The latest step, one clipped line. */
  lastActivity?: string;
  toolCount: number;
  /** Tokens the helper's own calls reported.  Absent until one does. */
  tokens?: number;
  startedAt: number;
  endedAt: number | null;
  status: HelperStatus;
}

/** The part of a snapshot the transcript row keeps.  The thread id is the
 * message's own. */
export type HelperTranscript = Omit<SubagentSnapshot, "id" | "threadId" | "parentItemId">;

export const HELPER_UPDATE_MIN_MS = 1000;

const LABEL_LIMIT = 80;
const ACTIVITY_LIMIT = 120;

/** Tool names that start a helper, after case and separators are folded.
 * `task_list` does not match `task`. */
const HELPER_TOOLS: Readonly<Record<string, HelperFidelity>> = {
  task: "typed",
  agent: "typed",
  spawnagent: "typed",
  invokesubagent: "named",
  spawnsubagent: "named",
};

export function normalizeToolName(name: string | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The fidelity of a tool that starts a helper, or null when it does not. */
export function helperToolFidelity(name: string | undefined): HelperFidelity | null {
  return HELPER_TOOLS[normalizeToolName(name)] ?? null;
}

export function isHelperToolName(name: string | undefined): boolean {
  return helperToolFidelity(name) !== null;
}

export function clipHelperText(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

export function helperLabel(name: string, target?: string): string {
  const label = target?.trim() || name.trim() || "Helper";
  return clipHelperText(label, LABEL_LIMIT);
}

export function helperActivityLine(title?: string, target?: string): string | undefined {
  const name = title?.trim();
  const what = target?.trim();
  const line = [name, what && what !== name ? what : undefined].filter(Boolean).join(" · ");
  return line ? clipHelperText(line, ACTIVITY_LIMIT) : undefined;
}

/** A snapshot safe to store and send.  `redact` runs on the label and the
 * activity line.  An activity line that redacts to nothing is dropped, so
 * the copy that was already on the snapshot cannot ride along. */
export function helperSnapshotForWire(
  snapshot: SubagentSnapshot,
  redact: (text: string) => string,
): SubagentSnapshot {
  const label = redact(snapshot.label);
  const activity = snapshot.lastActivity ? redact(snapshot.lastActivity) : undefined;
  const next: SubagentSnapshot = { ...snapshot, label };
  if (activity) next.lastActivity = activity;
  else delete next.lastActivity;
  return next;
}

export function helperTranscript(snapshot: SubagentSnapshot): HelperTranscript {
  return {
    fidelity: snapshot.fidelity,
    depth: snapshot.depth,
    label: snapshot.label,
    ...(snapshot.lastActivity ? { lastActivity: snapshot.lastActivity } : {}),
    toolCount: snapshot.toolCount,
    ...(snapshot.tokens !== undefined ? { tokens: snapshot.tokens } : {}),
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
  };
}

export interface HelperRow {
  kind?: string;
  at?: number;
  helper?: HelperTranscript;
  tool?: {
    name?: string;
    ok?: boolean;
    target?: string;
    durationMs?: number;
    parentItemId?: string;
  };
}

/** A row the chat draws as a helper card: the call that started one, not
 * one of its steps. */
export function isHelperRow(row: HelperRow): boolean {
  if (row.kind !== undefined && row.kind !== "activity") return false;
  if (row.helper) return true;
  if (row.tool?.parentItemId && !isHelperToolName(row.tool.name)) return false;
  return isHelperToolName(row.tool?.name);
}

/** Helpers the header counts: still running.  A step inside a helper is
 * not itself a helper, so it is not counted. */
export function runningHelperCount(rows: readonly HelperRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (!isHelperRow(row)) continue;
    if (row.helper) {
      if (row.helper.status === "running") count += 1;
      continue;
    }
    if (row.tool?.ok === undefined) count += 1;
  }
  return count;
}

export interface HelperCardModel {
  label: string;
  status: HelperStatus;
  fidelity: HelperFidelity;
  depth: number;
  lastActivity?: string;
  toolCount: number;
  tokens?: number;
  startedAt: number;
  endedAt: number | null;
}

/** The card for one transcript row.  A row the harness has not patched yet
 * still draws, from the tool name and whatever the row already knows. */
export function helperCardModel(row: HelperRow, now: number): HelperCardModel | null {
  if (!isHelperRow(row)) return null;
  const name = row.tool?.name ?? "Helper";
  const startedAt = row.helper?.startedAt ?? row.at ?? now;
  const status: HelperStatus = row.helper?.status
    ?? (row.tool?.ok === undefined ? "running" : row.tool.ok ? "completed" : "failed");
  const endedAt = row.helper
    ? row.helper.endedAt
    : status === "running"
      ? null
      : startedAt + (row.tool?.durationMs ?? 0);
  return {
    label: row.helper?.label ?? helperLabel(name, row.tool?.target),
    status,
    fidelity: row.helper?.fidelity ?? helperToolFidelity(name) ?? "named",
    depth: row.helper?.depth ?? 1,
    lastActivity: row.helper?.lastActivity,
    toolCount: row.helper?.toolCount ?? 0,
    tokens: row.helper?.tokens,
    startedAt,
    endedAt,
  };
}

/** How long a helper has run: to now while it runs, to its end once it ended. */
export function helperElapsedMs(card: Pick<HelperCardModel, "startedAt" | "endedAt" | "status">, now: number): number {
  const end = card.status === "running" || card.endedAt === null ? now : card.endedAt;
  return Math.max(0, end - card.startedAt);
}

export function formatHelperDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function helperStatusWord(status: HelperStatus): string {
  switch (status) {
    case "running":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default: {
      const never: never = status;
      return never;
    }
  }
}

/** "3 tools · 1,098 tokens · 12s".  A zero tool count stays off the line
 * until the helper has done something. */
export function helperStatsLine(card: HelperCardModel, now: number): string {
  const parts: string[] = [];
  if (card.toolCount > 0) parts.push(`${card.toolCount} ${card.toolCount === 1 ? "tool" : "tools"}`);
  if (card.tokens !== undefined && card.tokens > 0) parts.push(`${card.tokens.toLocaleString("en-US")} tokens`);
  parts.push(formatHelperDuration(helperElapsedMs(card, now)));
  return parts.join(" · ");
}

/** "2 Jobs · 1 Helper".  A zero side is left out. */
export function workPillLabel(jobCount: number, helperCount: number): string {
  const parts: string[] = [];
  if (jobCount > 0) parts.push(`${jobCount} ${jobCount === 1 ? "Job" : "Jobs"}`);
  if (helperCount > 0) parts.push(`${helperCount} ${helperCount === 1 ? "Helper" : "Helpers"}`);
  return parts.join(" · ");
}
