// The native session id each engine child last reported, per thread and
// engine instance.
//
// Usage Monitor hears about a BotFleet turn twice when the child harness
// (Claude Code, Codex) also exports its own telemetry.  The child's session
// id on BotFleet's turn event is what lets Usage Monitor pair the two and
// count the turn once.
//
// The task's saved resume cursor is not enough: it is per task (a room turn
// has none), and a turn that fails over clears it before the turn's
// telemetry is built.  Every driver that runs a child (claude, codex, ACP,
// antigravity, pi) emits `session.started` on each turn, so this keeps what
// the child said, in memory, bounded, and never persisted: it is read once
// when the turn settles and stamped on the event, which then never changes
// (a replayed event must be identical or Usage Monitor refuses the batch).

const DEFAULT_CAPACITY = 2000;

/** One child's last report:  its session id and the turn it reported it in. */
interface ReportedSession {
  sessionId: string;
  turnId?: string;
}

export class ChildSessionIds {
  private readonly ids = new Map<string, ReportedSession>();
  private readonly capacity: number;

  // Not a parameter property: the harness runs under Node's strip-only
  // TypeScript mode, which rejects `constructor(private readonly x)`.
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  private static key(threadId: string, instanceId: string): string {
    return `${threadId}\u0000${instanceId}`;
  }

  /** A child said which native session it is running.  A null or blank id
   *  (a fresh session the engine has not named yet) forgets the old one, so
   *  a turn is never stamped with a previous session's id. */
  note(threadId: string, instanceId: string, sessionId: string | null | undefined, turnId?: string): void {
    const key = ChildSessionIds.key(threadId, instanceId);
    this.ids.delete(key);
    const id = (sessionId ?? "").trim();
    if (!id) return;
    this.ids.set(key, turnId ? { sessionId: id, turnId } : { sessionId: id });
    // Oldest first: a Map iterates in insertion order, and `delete` above
    // moves a refreshed entry to the end.
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.keys().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  /** The session must never be resumed again (`session.invalidated`):  drop
   *  it, but only while it is still the one saved, so a newer report stays. */
  forget(threadId: string, instanceId: string, sessionId: string): void {
    const key = ChildSessionIds.key(threadId, instanceId);
    if (this.ids.get(key)?.sessionId === sessionId) this.ids.delete(key);
  }

  /** The session id to stamp on the turn `turnId` that just settled, or
   *  undefined.  A session the child reported during this very turn is its
   *  own.  A session reported in an earlier turn counts only when the child
   *  demonstrably ran this turn (`childRan`: it reported usage), because a
   *  warm process reports its session once and keeps it across turns.  A
   *  turn that failed before its child reported anything gets no id, so
   *  Usage Monitor never pairs it with the previous turn's native events.
   *  Never an empty string. */
  forTurn(threadId: string, instanceId: string, turnId: string | undefined, childRan: boolean): string | undefined {
    const reported = this.ids.get(ChildSessionIds.key(threadId, instanceId));
    if (!reported) return undefined;
    const sameTurn = turnId !== undefined && reported.turnId === turnId;
    return sameTurn || childRan ? reported.sessionId : undefined;
  }

  get size(): number {
    return this.ids.size;
  }
}
