// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecretsForLog } from "../redact.ts";
import { appendBoundedAsync, EVENTS_LOG_MAX_BYTES, type AppendWriter } from "../transcript-retention.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";
import { BoundedAppendQueue, type AppendQueueStats } from "./append-queue.ts";

const INCOMPLETE_LOG_MESSAGE =
  "Canonical event history is incomplete: BotFleet could not write one or more events to disk. Live updates will continue.";

/** How many settled turns the duplicate-terminal detector remembers.  A
 * bound, not a lifetime: the check exists to catch a driver bug within the
 * same conversation, not to keep a ledger. */
const SETTLED_TURN_MEMORY = 512;

/** What the tee queue hands back when an entry settles.  The event is what
 * names the thread a gap belongs to; the flag says whether this entry was the
 * one carrying a pending "history is incomplete" marker, so the marker is
 * retired only when it actually reached disk. */
interface TeeEntry {
  event: RuntimeEvent;
  carriesWarning: boolean;
}

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private unsubscribes = new Map<string, () => void>();
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  /** Threads whose pending marker is already inside a queued entry.  Without
   * it, every event published before that entry drains would carry the marker
   * again and the log would collect duplicates of it. */
  private warningsInFlight = new Set<string>();
  /** `threadId:turnId` of every turn that has already produced a terminal
   * event.  Insertion-ordered, so the oldest entry is the one evicted. */
  private settledTurns = new Set<string>();
  private readonly appendLog: AppendWriter;
  private readonly writes: BoundedAppendQueue<TeeEntry>;

  constructor(appendLog: AppendWriter = appendFile, options: { maxQueuedBytes?: number } = {}) {
    this.appendLog = appendLog;
    this.writes = new BoundedAppendQueue<TeeEntry>(
      (file, data) => appendBoundedAsync(file, data, EVENTS_LOG_MAX_BYTES, { mode: 0o600 }, this.appendLog),
      {
        maxQueuedBytes: options.maxQueuedBytes,
        onWritten: (entry) => {
          if (!entry.carriesWarning) return;
          this.warningsInFlight.delete(entry.event.threadId);
          this.pendingLogWarnings.delete(entry.event.threadId);
        },
        onWriteError: (entry, error) => {
          if (entry.carriesWarning) this.warningsInFlight.delete(entry.event.threadId);
          this.noteLogGap(entry.event, error);
        },
        // A dropped entry never reached disk either, so the log has the same
        // hole a failed write leaves and says so the same way.  The count and
        // the reason are the queue's own summary line; this is the marker that
        // lands IN the log a reader is holding.
        onDropped: (entry) => {
          if (entry.carriesWarning) this.warningsInFlight.delete(entry.event.threadId);
          this.noteLogGap(entry.event, undefined);
        },
      },
    );
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      this.detach(instance.instanceId);
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        // Second hard invariant: exactly one terminal event per turn.  Every
        // consumer of turn.completed — the watchdog, the Sentry span closer,
        // the routine receipt, the repeat detector, the room waiter, the
        // usage fold, the queue drains — assumes it fires once, and a driver
        // that emits it twice settles a turn twice with no error anywhere.
        // This is a DETECTOR, not a gate: it drops the duplicate and says
        // so, so a driver bug shows up as a log line instead of a double
        // receipt.  It buys coverage for consumers nobody has written yet.
        if (this.isDuplicateTerminal(event)) {
          console.error(
            `bus: dropped a second turn.completed for ${event.threadId}:${event.turnId} from ${instance.instanceId} — a driver emitted two terminal events for one turn (harness bug)`,
          );
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.set(instance.instanceId, unsub);
    }
  }

  detach(instanceId: string) {
    const unsub = this.unsubscribes.get(instanceId);
    if (unsub) {
      unsub();
      this.unsubscribes.delete(instanceId);
    }
  }

  /** True when this turn has already settled.  A terminal event with no
   * turnId cannot be correlated, so it is always let through — the check
   * never guesses. */
  private isDuplicateTerminal(event: RuntimeEvent): boolean {
    if (event.type !== "turn.completed" || !event.turnId) return false;
    const key = `${event.threadId}:${event.turnId}`;
    if (this.settledTurns.has(key)) return true;
    this.settledTurns.add(key);
    if (this.settledTurns.size > SETTLED_TURN_MEMORY) {
      const oldest = this.settledTurns.values().next();
      if (!oldest.done) this.settledTurns.delete(oldest.value);
    }
    return false;
  }

  publish(event: RuntimeEvent) {
    // Two destinations, and only one of them is ever redacted.  Live
    // subscribers — the SSE fan-out, the inspector, the server-side message
    // folder — have always received the event object itself, whole; the
    // redacted copy exists because the canonical log is a file people paste
    // into bug reports.  That asymmetry is what makes the log entry safe to
    // CUT as well as scrub: eliding the tail of a multi-megabyte tool result
    // costs a reader the end of one record and costs a subscriber nothing,
    // and it is the difference between bounded work per event and eight
    // global regexes over however many megabytes a tool just read.
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    const carriesWarning = pendingWarning !== undefined && !this.warningsInFlight.has(event.threadId);
    const persistedEvents = carriesWarning ? [pendingWarning, event] : [event];
    const line = persistedEvents.map((entry) => JSON.stringify(redactSecretsForLog(entry))).join("\n") + "\n";
    if (carriesWarning) this.warningsInFlight.add(event.threadId);
    // Queued, never written here.  The bus publishes on the harness's only
    // thread; an `appendFileSync` of a 5 MB record used to hold every other
    // bot's turn, the SSE fan-out and `/api/health` behind it.  The queue is
    // bounded and drops its oldest entries rather than growing or blocking,
    // and the marker below is how a reader learns a record went missing.
    // Rotation at EVENTS_LOG_MAX_BYTES still happens inside the write, and
    // the injected writer is still the one that touches disk, so a test that
    // fails the write fails it exactly where it used to.
    this.writes.enqueue(join(EVENTS_DIR, `${event.threadId}.ndjson`), line, { event, carriesWarning });
    this.deliver(event);
  }

  /** Everything queued has reached disk, or failed trying.  Shutdown awaits
   * this so a SIGTERM does not take the tail of every live thread's log with
   * it — the write is off the publish path now, not optional. */
  async flush(): Promise<void> {
    await this.writes.flush();
  }

  /** Queue depth and the cumulative drop count, for tests and for anyone
   * wiring the tee into a health endpoint later. */
  teeStats(): AppendQueueStats {
    return this.writes.stats();
  }

  /** Record that the canonical log for this thread has a hole in it — a write
   * that failed, or an entry dropped under pressure — and say so exactly once
   * per outage.
   *
   * Never feed the warning back through publish(): that would re-enter the
   * same failing write and recurse.  It is delivered live once, and persisted
   * ahead of the first event that reaches disk after recovery, so the log
   * itself carries the gap rather than quietly closing over it. */
  private noteLogGap(event: RuntimeEvent, error: unknown): void {
    if (this.pendingLogWarnings.has(event.threadId)) return;
    const warning: RuntimeEvent = {
      eventId: newId(),
      provider: event.provider,
      providerInstanceId: event.providerInstanceId,
      threadId: event.threadId,
      createdAt: new Date().toISOString(),
      turnId: event.turnId,
      type: "runtime.error",
      message: INCOMPLETE_LOG_MESSAGE,
      raw: { source: "botfleet.event-log", payload: { kind: error === undefined ? "dropped" : "write-failed" } },
    };
    this.pendingLogWarnings.set(event.threadId, warning);
    // A drop is already counted in the queue's own summary line; only a write
    // failure carries an error worth printing here.
    if (error !== undefined) console.error("bus: canonical event log write failed", error);
    this.deliver(warning);
  }

  private deliver(event: RuntimeEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detachAll() {
    for (const unsub of this.unsubscribes.values()) unsub();
    this.unsubscribes.clear();
  }
}
