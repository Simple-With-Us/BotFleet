// Tree reads the runtime makes over stored rows and their events. Nothing
// here writes. Event ids are one global, monotonic order, which is why
// "what happened since this turn began" is read from them and never from
// timestamps: a frozen test clock or a wall clock stepping back could put
// a child of the previous turn inside the current one, and the node would
// wait on work it already returned.
import type { RuntimeStore } from "./store.ts";
import { terminal, type Assignment, type Owner, type TurnEvidence } from "./types.ts";

/** A turn a restart cut runs again once; cut again, it ends with this. */
export const CUT_TWICE = "Interrupted by another BotFleet restart after resuming once; not resumed again. Some of its steps may already have taken effect.";

/** A cut turn that already acted outward is not run again: its outcome
 * detail opens with this (the host's restart line and a requester's restart
 * note read it), then names what it did. */
export const INTERRUPTED_OUTWARD = "Interrupted by a BotFleet restart after it already";

const OUTWARD_SHOWN = 4;
const OUTWARD_LABEL_MAX = 48;

/** A short label of an outward action as a verb phrase: the host names the
 * tool ("GMAIL_SEND_EMAIL", "git push"); the person reads what it did. */
function describeOutward(label: string): string {
  // Tool slugs join words with underscores, which are word characters, so
  // the money words are matched bare rather than on word boundaries.
  if (/\bgit\s+push\b/i.test(label)) return `pushed (${label})`;
  if (/\bgit\s+commit\b/i.test(label)) return `committed (${label})`;
  if (/pay|charge|refund|transfer/i.test(label)) return `made a payment (${label})`;
  if (/mail/i.test(label)) return `sent an email (${label})`;
  if (/send|message|reply/i.test(label)) return `sent a message (${label})`;
  if (/post|publish|tweet/i.test(label)) return `posted (${label})`;
  return `completed an outward action (${label})`;
}

/** The outcome detail of a cut turn that acted outward (contract §5):
 * what it already did, and that nothing is done twice. */
export function outwardDetail(labels: readonly string[]): string {
  const seen = new Set<string>();
  for (const label of labels) {
    const short = clip(label.replace(/\s+/g, " ").trim(), OUTWARD_LABEL_MAX);
    if (short) seen.add(short);
  }
  const all = [...seen];
  const shown = all.slice(0, OUTWARD_SHOWN).map(describeOutward);
  const more = all.length > OUTWARD_SHOWN ? ` and ${all.length - OUTWARD_SHOWN} more` : "";
  return `${INTERRUPTED_OUTWARD} ${shown.join(", ")}${more}; not resumed, so nothing is done twice.`;
}

/** Whether a restart ended this node because its cut turn had acted outward. */
export const outwardInterrupted = (a: Assignment): boolean =>
  a.outcome === "interrupted" && (a.outcomeDetail?.startsWith(INTERRUPTED_OUTWARD) ?? false);

// ── the continuation loop guard (contract §2, §6) ───────────────────────

/** Consecutive continuations without a successful tool call that stop a node. */
export const NO_PROGRESS_STRIKES = 2;
/** Identical error texts in a row, across continuing executions, that stop a node. */
export const SAME_ERROR_STRIKES = 3;
const ERROR_TEXT_MAX = 200;
const STOP_TEXT_MAX = 300;

export type LoopGuard = NonNullable<Assignment["guard"]>;

/** The guard's record after one more execution ended with a continue. An
 * execution whose evidence names no ok count is progress-unknown: not a
 * strike, and not a reset either. */
export function nextGuard(previous: LoopGuard | undefined, evidence: TurnEvidence | undefined): LoopGuard {
  const before = previous?.stale ?? 0;
  const stale = evidence?.okToolCalls === undefined ? before : evidence.okToolCalls === 0 ? before + 1 : 0;
  const fresh = (evidence?.errors ?? []).map(text => clip(text.trim(), ERROR_TEXT_MAX)).filter(Boolean);
  const errors = [...(previous?.errors ?? []), ...fresh].slice(-SAME_ERROR_STRIKES);
  return { stale, errors };
}

/** Why the node must not continue, or undefined while it still makes
 * progress: `reason` for the audit event, `detail` for the outcome. */
export function loopStop(guard: LoopGuard, text: string): { reason: string; detail: string } | undefined {
  if (guard.stale >= NO_PROGRESS_STRIKES) {
    return { reason: `${guard.stale} continuations without a successful tool call`,
      detail: `Stopped after ${guard.stale} continuations without progress: ${clip(text.trim(), STOP_TEXT_MAX)}` };
  }
  const [first] = guard.errors;
  if (first !== undefined && guard.errors.length >= SAME_ERROR_STRIKES && guard.errors.every(error => error === first)) {
    return { reason: `the same error ${SAME_ERROR_STRIKES} times`, detail: `Stopped after ${SAME_ERROR_STRIKES} identical errors: ${first}` };
  }
  return undefined;
}

/** Renders elapsed milliseconds as whole minutes, or seconds under one minute. */
export const duration = (ms: number): string => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

export const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max) : text;

export const isTerminal = (a: Assignment): boolean => terminal(a.status);

/** The children a parent waits on: one-way notices come back with nothing,
 * so they neither hold the parent nor appear in its resume. */
export const awaited = (children: readonly Assignment[]): Assignment[] => children.filter(c => c.reply !== "none");

/** Root first, the node last. Throws on a cycle: the store never writes one,
 * so finding one means the file was edited by hand. */
export function path(store: RuntimeStore, n: Assignment): Assignment[] {
  const out: Assignment[] = [];
  const seen = new Set<string>();
  for (let cur: Assignment | undefined = n; cur; cur = cur.parentId ? store.get(cur.parentId) : undefined) {
    if (seen.has(cur.id)) throw new Error("Invalid assignment ancestry");
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** The id of the event that began the node's latest turn that was not cut
 * by a restart (0 when none). A turn a restart cut and set to run again
 * never returned anything, so what "began since" it began is still owed:
 * its rerun anchors at the turn before it. */
export function lastStartedId(store: RuntimeStore, id: string): number {
  const events = store.events(id);
  let cut = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "restart_reconciled" && /: rerun /.test(event.detail ?? "")) cut += 1;
    else if (event.kind === "started") {
      if (cut > 0) { cut -= 1; continue; }
      return event.id;
    }
  }
  return 0;
}

/** How many times the node has continued in place so far (a step cap, a
 * seat it could not get): counted from its events, so the count outlives the
 * continuation the dispatch consumes and a later limit can read it. */
export function continuations(store: RuntimeStore, id: string): number {
  return store.events(id).filter(e => e.kind === "continued").length;
}

/** Children handed out by the node's latest turn: enqueued after it began. */
export function childrenSince(store: RuntimeStore, n: Assignment): Assignment[] {
  const since = lastStartedId(store, n.id);
  return store.children(n.id).filter(c => (store.events(c.id)[0]?.id ?? 0) > since);
}

/** The lane a node's result is written to: its requester, as recorded (a
 * bot turn's thread, an external runtime's run id). */
export function wakeOwner(n: Assignment): Owner {
  const owner: Owner = {};
  if (n.requester.botId !== undefined) owner.botId = n.requester.botId;
  if (n.requester.threadId !== undefined) owner.threadId = n.requester.threadId;
  if (n.requester.runId !== undefined) owner.runId = n.requester.runId;
  return owner;
}

/** Whether this node is the conversation an owner names: a thread (with
 * its bot, when given) or, for an external runtime, the roots of its run. */
export function ownsConversation(n: Assignment, owner: Owner): boolean {
  if (owner.threadId !== undefined) {
    return n.assignee.destination.threadId === owner.threadId && (owner.botId === undefined || n.assignee.botId === owner.botId);
  }
  if (owner.runId !== undefined) return !n.parentId && n.requester.runId === owner.runId;
  return false;
}

/** What a restart did to this node's turn and to the work it waits on, for
 * the first line of the turn after it ("" when nothing): a cut turn runs
 * again in its own conversation, so it checks before it repeats, and a
 * requester learns which of its teammates ran again. */
export function restartNote(n: Assignment, children: readonly Assignment[], nameOf: (child: Assignment) => string): string {
  if (!n.restart) return "";
  const own = n.restart === "rerun"
    ? "BotFleet restarted while your previous turn here was running and cut it off; this turn continues it. First check what that turn already did (files, commits, messages, anything sent or started) and verify anything uncertain, so nothing is done twice; then finish and report as usual. A restart alone is not a blocker."
    : n.restart === "cut" ? "BotFleet restarted before your previous turn here finished, after it sent work to teammates. Check what that turn already did before repeating any of it." : "";
  // Only a rerun that completed is known to have finished; any other end
  // (never started, start refused, stopped or expired mid-run) may leave
  // part of it done, and its result says how it ended. A turn that had
  // acted outward was not resumed at all: its result names what it did.
  const cut = children.filter(child => child.restarts > 0 || outwardInterrupted(child)).map(child => `${nameOf(child)} (${
    outwardInterrupted(child) ? "cut after an outward action, not resumed: see its result"
      : child.outcome === "interrupted" ? "cut again while resuming, so not resumed a second time: it may be partly done"
      : child.status === "completed" ? "resumed once in place and told to check what it had already done"
      : `set to resume once but ended ${child.status} before finishing, so it may be partly done: see its result`})`);
  const teammates = cut.length ? `A restart cut these teammates' turns: ${cut.join("; ")}. Check their results as usual.` : "";
  return own || teammates ? `${[own, teammates].filter(Boolean).join(" ")}\n` : "";
}
