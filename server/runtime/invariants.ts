// The invariants checked over stored data
// after every scenario. One message per violation, none when the store is
// consistent. I6 is read from the "started" events (each names the level
// the turn ran with); I9's "owner idle" and I10 live in the host and the
// suite, not in rows, so they are not checked here.
import type { RuntimeStore } from "./store.ts";
import { isTerminal, wakeOwner } from "./tree.ts";
import type { Assignment, AssignmentEvent, InboxItem, Status } from "./types.ts";

const STATUSES: readonly Status[] = ["queued", "running", "needs_input", "waiting", "resume", "completed", "failed", "cancelled"];
const isStatus = (value: string): value is Status => (STATUSES as readonly string[]).includes(value);

/** The status an event leaves the row in, or undefined when it changes
 * none. "settled" and "restart_reconciled" carry the status they lead to
 * as the first token of their detail ("failed: expired — never started"). */
function replayStep(event: AssignmentEvent): Status | undefined {
  switch (event.kind) {
    case "enqueued": return "queued";
    case "started": return "running";
    case "parked": return "needs_input";
    case "answered": return "queued";
    case "continued": return "queued";
    case "waiting": return "waiting";
    case "resume_due": return "resume";
    case "refused": return "failed";
    case "cancelled": return "cancelled";
    case "settled":
    case "restart_reconciled": {
      const token = (event.detail ?? "").split(":")[0]?.trim() ?? "";
      return isStatus(token) ? token : undefined;
    }
    default: return undefined;
  }
}

/** The row's status as its events replay it (I7). */
export function replayStatus(events: readonly AssignmentEvent[]): Status | undefined {
  let status: Status | undefined;
  for (const event of events) status = replayStep(event) ?? status;
  return status;
}

const levelOf = (event: AssignmentEvent): string | undefined => /level (\w+)/.exec(event.detail ?? "")?.[1];

export function checkInvariants(store: RuntimeStore, live: { running: Set<string>; parked: Set<string> }): string[] {
  const problems: string[] = [];
  const rows = store.all();
  const byId = new Map(rows.map(a => [a.id, a]));
  const childrenOf = new Map<string, Assignment[]>();
  for (const a of rows) {
    if (!a.parentId) continue;
    const siblings = childrenOf.get(a.parentId) ?? [];
    siblings.push(a);
    childrenOf.set(a.parentId, siblings);
  }
  for (const a of rows) {
    const events = store.events(a.id);
    const label = `${a.id} (${a.status})`;
    // I1: every non-terminal row has a live owner. A running root is the
    // requesting conversation's own turn, which the host runs, not the
    // runtime, so it has no handle in `live`.
    if (!isTerminal(a)) {
      if (a.status === "running" && a.parentId && !live.running.has(a.id)) problems.push(`I1 ${label}: running without a live turn`);
      if (a.status === "needs_input" && !live.parked.has(a.id)) problems.push(`I1 ${label}: needs_input without a parked question`);
      if (a.status === "waiting" && !(childrenOf.get(a.id) ?? []).some(c => c.reply !== "none")) problems.push(`I1 ${label}: waiting on no child`);
    }
    const reports = events.filter(e => e.kind === "reported").length;
    // A question wakes the requester too; I2 bounds the wakes for the result.
    const wakes = events.filter(e => e.kind === "woken" && e.detail !== "needs_input").length;
    if (isTerminal(a)) {
      if (a.outcome === undefined) problems.push(`I4 ${label}: terminal without an outcome`);
      if (a.finishedAt === undefined) problems.push(`I4 ${label}: terminal without finishedAt`);
      // I2: one report, at most one wake, for every result somebody awaits.
      if (a.reply !== "none") {
        if (reports !== 1 || a.reportedAt === undefined) problems.push(`I2 ${label}: ${reports} reports (reportedAt ${a.reportedAt ?? "unset"})`);
        if (wakes > 1) problems.push(`I2 ${label}: ${wakes} wakes`);
      }
      // I4: a root the runtime ended alone reaches its own conversation.
      if (!a.parentId && a.reportedAt === undefined) problems.push(`I4 root ${label}: ended without a report`);
    } else {
      if (reports > 0) problems.push(`I2 ${label}: reported before settling`);
      if (wakes > 0) problems.push(`I2 ${label}: woken before settling`);
    }
    // I5: expired is never completed; completed is always done.
    if (a.outcome === "expired" && a.status === "completed") problems.push(`I5 ${label}: expired yet completed`);
    if (a.status === "completed" && a.outcome !== "done") problems.push(`I5 ${label}: completed with outcome ${a.outcome ?? "none"}`);
    if (a.status === "failed" && a.outcome === "done") problems.push(`I5 ${label}: failed with outcome done`);
    // I6: every turn ran with the level on the record.
    for (const e of events) {
      if (e.kind !== "started") continue;
      const ran = levelOf(e);
      if (ran !== undefined && ran !== a.level) problems.push(`I6 ${label}: turn ran at ${ran}, record says ${a.level}`);
    }
    // I7: the row is what its events say it is.
    if (events.length === 0) problems.push(`I7 ${label}: no events`);
    else {
      const replayed = replayStatus(events);
      if (replayed !== a.status) problems.push(`I7 ${label}: events replay to ${replayed ?? "nothing"}`);
    }
    // I8: a cut turn runs again at most once: two reruns need a start between.
    let rerunPending = false;
    for (const e of events) {
      if (e.kind === "started") rerunPending = false;
      else if (e.kind === "restart_reconciled" && /rerun/.test(e.detail ?? "")) {
        if (rerunPending) problems.push(`I8 ${label}: rerun reconciled twice without a turn`);
        rerunPending = true;
      }
    }
    if (a.restarts > events.filter(e => e.kind === "restart_reconciled" && /rerun/.test(e.detail ?? "")).length) {
      problems.push(`I8 ${label}: restarts ${a.restarts} exceed reconciled reruns`);
    }
    // Tree shape: a child's root and parent must exist and agree.
    if (a.parentId) {
      const parent = byId.get(a.parentId);
      if (!parent) problems.push(`tree ${label}: parent ${a.parentId} is missing`);
      else if (parent.rootId !== a.rootId) problems.push(`tree ${label}: parent is in another tree`);
      else if (parent.depth + 1 !== a.depth) problems.push(`tree ${label}: depth ${a.depth} under depth ${parent.depth}`);
    } else if (a.rootId !== a.id || a.depth !== 0) problems.push(`tree ${label}: a root must be its own root at depth 0`);
  }
  // I3: no brief dispatched twice under one parent except by rework (the
  // same words as a question or a notice are another request), and no
  // result delivered twice (one inbox item per assignment).
  for (const [parentId, siblings] of childrenOf) {
    const seen = new Map<string, number>();
    for (const c of siblings) {
      const key = JSON.stringify([c.brief, c.mode, c.assignee.botId, c.assignee.destination.threadId, c.assignee.destination.groupId ?? ""]);
      const count = seen.get(key) ?? 0;
      if (count > 0 && !c.rework) problems.push(`I3 ${c.id}: the same brief under ${parentId} without rework`);
      seen.set(key, count + 1);
    }
  }
  // Every lane an item can sit in: each row's requester.
  const items = new Map<string, InboxItem>();
  for (const a of rows) for (const item of store.inbox(wakeOwner(a))) items.set(item.id, item);
  const perAssignment = new Map<string, number>();
  for (const item of items.values()) {
    perAssignment.set(item.assignmentId, (perAssignment.get(item.assignmentId) ?? 0) + 1);
    const subject = byId.get(item.assignmentId);
    // I9: a wake only on a terminal outcome, a question or a stall.
    if (!subject) problems.push(`I9 inbox ${item.id}: names a missing assignment`);
    else if (item.kind === "settled" && !isTerminal(subject)) problems.push(`I9 inbox ${item.id}: settled item for a live assignment`);
    else if (item.kind === "needs_input" && !store.events(subject.id).some(e => e.kind === "parked")) problems.push(`I9 inbox ${item.id}: needs_input item for an assignment never parked`);
    else if (item.kind === "stalled" && subject.outcome !== "stalled") problems.push(`I9 inbox ${item.id}: stalled item for outcome ${subject.outcome ?? "none"}`);
  }
  // I3: no result delivered twice: one settlement item per assignment.
  for (const [id, count] of perAssignment) {
    const settledItems = [...items.values()].filter(i => i.assignmentId === id && i.kind !== "needs_input").length;
    if (settledItems > 1) problems.push(`I3 ${id}: ${count} inbox items, ${settledItems} of them results`);
  }
  return [...new Set(problems)];
}
