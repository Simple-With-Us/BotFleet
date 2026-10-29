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

export class ChildSessionIds {
  private readonly ids = new Map<string, string>();
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
  note(threadId: string, instanceId: string, sessionId: string | null | undefined): void {
    const key = ChildSessionIds.key(threadId, instanceId);
    this.ids.delete(key);
    const id = (sessionId ?? "").trim();
    if (!id) return;
    this.ids.set(key, id);
    // Oldest first: a Map iterates in insertion order, and `delete` above
    // moves a refreshed entry to the end.
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.keys().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  /** The session id last reported for this thread and instance, or
   *  undefined when none is known.  Never an empty string. */
  get(threadId: string, instanceId: string): string | undefined {
    return this.ids.get(ChildSessionIds.key(threadId, instanceId));
  }

  get size(): number {
    return this.ids.size;
  }
}
