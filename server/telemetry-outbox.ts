import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export interface DurableTelemetryEvent {
  eventId: string;
  [key: string]: unknown;
}

export interface DurableTelemetryBatch {
  schemaVersion: 2;
  producerId: string;
  producerInstanceId: string;
  events: DurableTelemetryEvent[];
}

/** HTTP statuses the receiver will never turn into a success no matter how
 * many times the SAME batch is retried: the receiver is rejecting the
 * request itself (bad or expired token, unknown route, malformed body,
 * payload too large, an event it can never process, or a producer-instance
 * conflict) rather than reporting a transient condition.  408, 425, 429 and
 * every 5xx are deliberately absent — those describe THIS attempt, not this
 * batch, and a later attempt can still succeed. */
export const TERMINAL_HTTP_STATUSES = [400, 401, 403, 404, 409, 413, 422] as const;
export type TerminalHttpStatus = (typeof TERMINAL_HTTP_STATUSES)[number];

export function terminalStatusFor(status: number): TerminalHttpStatus | undefined {
  // `.find()`'s return type is already narrowed to the tuple's own element
  // type, so this needs no cast: a match IS a `TerminalHttpStatus`.
  return TERMINAL_HTTP_STATUSES.find((candidate) => candidate === status);
}

export interface TelemetryDeliveryResult {
  acknowledged: boolean;
  rejected: number;
  terminalStatus?: TerminalHttpStatus;
  /** Runs only after the outbox has durably recorded this result.  If the
   * pass's persist fails and rolls back, it is dropped: the batch will be
   * resent, and counting it now would count it twice. */
  onPersisted?: () => void;
}

export interface TelemetryOutboxStatus {
  queuedBatches: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
  droppedBatches: number;
  overflowDroppedBatches: number;
  destinationChangeDroppedBatches: number;
  rejectedEvents: number;
  failedAttempts: number;
  persistenceFailures: number;
  nonDurableBatches: number;
  corruptFilesQuarantined: number;
  terminalQuarantinedBatches: number;
  terminalQuarantineEvictedBatches: number;
  lastTerminalStatus: TerminalHttpStatus | null;
  lastTerminalAt: string | null;
  /** Batches parked after too many consecutive failures at the queue head
   * (OP2b) — a poisoned or unreachable-forever batch that is not one of
   * `TERMINAL_HTTP_STATUSES` (a timeout, a network error, a repeating 5xx)
   * would otherwise block every newer batch behind it indefinitely. */
  deadLetterBatches: number;
  deadLetterEvictedBatches: number;
  lastDeadLetterAt: string | null;
}

const DurableTelemetryBatchSchema = z.object({
  schemaVersion: z.literal(2),
  producerId: z.string().min(1),
  producerInstanceId: z.string().min(1),
  events: z.array(z.object({ eventId: z.string().min(1) }).passthrough()).min(1),
}).passthrough();

const QueuedBatchSchema = z.object({
  queueId: z.string().regex(/^[a-f0-9]{64}$/),
  destinationHash: z.string().regex(/^[a-f0-9]{64}$/),
  enqueuedAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().finite(),
  batch: DurableTelemetryBatchSchema,
});

const QuarantinedBatchSchema = z.object({
  entry: QueuedBatchSchema,
  status: z.union([
    z.literal(400),
    z.literal(401),
    z.literal(403),
    z.literal(404),
    z.literal(409),
    z.literal(413),
    z.literal(422),
  ]),
  quarantinedAt: z.iso.datetime(),
});

const DeadLetteredBatchSchema = z.object({
  entry: QueuedBatchSchema,
  parkedAt: z.iso.datetime(),
});

const StoredOutboxSchema = z.object({
  version: z.literal(2),
  queue: z.array(QueuedBatchSchema),
  droppedBatches: z.number().int().nonnegative(),
  overflowDroppedBatches: z.number().int().nonnegative(),
  destinationChangeDroppedBatches: z.number().int().nonnegative(),
  rejectedEvents: z.number().int().nonnegative(),
  failedAttempts: z.number().int().nonnegative(),
  persistenceFailures: z.number().int().nonnegative(),
  corruptFilesQuarantined: z.number().int().nonnegative(),
  terminalQuarantine: z.array(QuarantinedBatchSchema).default([]),
  terminalQuarantineEvictedBatches: z.number().int().nonnegative().default(0),
  // K consecutive failures of the same head batch (OP2b) park it here
  // instead of blocking every newer batch behind it forever.  Bounded and
  // persisted the same way terminalQuarantine is, for the same reason: kept
  // for forensics, never replayed automatically.
  deadLetter: z.array(DeadLetteredBatchSchema).default([]),
  deadLetterEvictedBatches: z.number().int().nonnegative().default(0),
});

type StoredOutbox = z.infer<typeof StoredOutboxSchema>;

interface DeliveryContext {
  destinationHash: string;
  deliver: (batch: DurableTelemetryBatch) => Promise<TelemetryDeliveryResult>;
}

interface OutboxOptions {
  path: string;
  maxBatches?: number;
  maxQuarantinedBatches?: number;
  /** Bounds the dead-letter list (OP2b): default 20. */
  maxDeadLetterBatches?: number;
  /** Consecutive failed attempts of the SAME head batch before it is
   * parked in the dead-letter list instead of continuing to block every
   * newer batch behind it.  Default 8. */
  maxHeadAttempts?: number;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  writeState?: (path: string, state: StoredOutbox) => void;
  /** One line per terminal-drop or dead-letter event — rare, bounded
   * events worth their own line every time, unlike the per-attempt
   * warnings the caller already dedupes itself.  Defaults to
   * `console.log` tagged `[telemetry]`. */
  log?: (message: string) => void;
  onDiagnostic?: (name: "delivery_failed" | "events_rejected" | "overflow_dropped" | "destination_changed" | "persistence_failed" | "corrupt_quarantined" | "terminal_quarantined" | "terminal_quarantine_evicted" | "dead_lettered" | "dead_letter_evicted", count: number) => void;
}

/** First 12 hex characters of a queueId — a git-abbreviated-hash-style
 * "batch id" for a log line.  The full 64-character sha256 is overkill for
 * a human reading `server.log`; 12 hex characters is 48 bits, far more than
 * enough to stay unambiguous within one bounded quarantine/dead-letter
 * list. */
function shortId(queueId: string): string {
  return queueId.slice(0, 12);
}

const SAFE_EVENT_KEYS = [
  "eventId",
  "environment",
  "provider",
  "service",
  "project",
  "producerKeyRef",
  "providerConnectionRef",
  "billingAccountRef",
  "coverage",
  "billingMode",
  "metricType",
  "quantity",
  "unit",
  "costUsd",
  "requests",
  "credits",
  "limit",
  "limitWindow",
  "tier",
  "confidence",
  "windowStart",
  "windowEnd",
  "occurredAt",
  "providerRequestId",
] as const;

const SAFE_METADATA_KEYS = new Set([
  "botId",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "latencyMs",
  "success",
  "tokenType",
  "model",
  "instanceId",
  "usageReported",
  "roomId",
  "estimatedCostUsd",
]);

export function usageTelemetryDestinationHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function emptyState(): StoredOutbox {
  return {
    version: 2,
    queue: [],
    droppedBatches: 0,
    overflowDroppedBatches: 0,
    destinationChangeDroppedBatches: 0,
    rejectedEvents: 0,
    failedAttempts: 0,
    persistenceFailures: 0,
    corruptFilesQuarantined: 0,
    terminalQuarantine: [],
    terminalQuarantineEvictedBatches: 0,
    deadLetter: [],
    deadLetterEvictedBatches: 0,
  };
}

function defaultWriteState(path: string, state: StoredOutbox): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // POSIX rename durability also requires the containing directory entry to
  // reach disk.  Windows cannot open a directory as a file descriptor.
  if (process.platform !== "win32") {
    const directoryFd = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

function sanitizeBatchForPersistence(batch: DurableTelemetryBatch): DurableTelemetryBatch {
  return {
    schemaVersion: 2,
    producerId: batch.producerId,
    producerInstanceId: batch.producerInstanceId,
    events: batch.events.map((event) => {
      const sanitized: DurableTelemetryEvent = { eventId: event.eventId };
      for (const key of SAFE_EVENT_KEYS) {
        if (key !== "eventId" && event[key] !== undefined) sanitized[key] = event[key];
      }
      // Task titles are derived from the first user message.  Keep the field
      // required by the receiver while ensuring prompt text never reaches the
      // durable retry file.
      sanitized.label = "BotFleet turn";
      const metadata = event.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        sanitized.metadata = Object.fromEntries(
          Object.entries(metadata).filter(([key]) => SAFE_METADATA_KEYS.has(key)),
        );
      }
      return sanitized;
    }),
  };
}

/**
 * Small durable queue for already-sanitized Usage Monitor batches.  It never
 * stores a bearer token or endpoint.  A one-way endpoint hash fences queued
 * batches from a different destination after configuration changes.
 */
export class UsageTelemetryOutbox {
  private readonly path: string;
  private readonly maxBatches: number;
  private readonly maxQuarantinedBatches: number;
  private readonly maxDeadLetterBatches: number;
  private readonly maxHeadAttempts: number;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onDiagnostic: OutboxOptions["onDiagnostic"];
  private readonly writeState: NonNullable<OutboxOptions["writeState"]>;
  private readonly log: NonNullable<OutboxOptions["log"]>;
  private state: StoredOutbox;
  private dispatcher: (() => DeliveryContext | null) | null = null;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private inFlightQueueId: string | null = null;
  private readonly pendingDurability = new Set<string>();

  constructor(options: OutboxOptions) {
    this.path = options.path;
    this.maxBatches = Math.max(1, Math.floor(options.maxBatches ?? 500));
    this.maxQuarantinedBatches = Math.max(1, Math.floor(options.maxQuarantinedBatches ?? 100));
    this.maxDeadLetterBatches = Math.max(1, Math.floor(options.maxDeadLetterBatches ?? 20));
    this.maxHeadAttempts = Math.max(1, Math.floor(options.maxHeadAttempts ?? 8));
    this.now = options.now ?? Date.now;
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 300_000);
    this.onDiagnostic = options.onDiagnostic;
    this.writeState = options.writeState ?? defaultWriteState;
    this.log = options.log ?? ((message) => console.log(`[telemetry] ${message}`));
    this.state = this.readState();
    if (this.state.corruptFilesQuarantined > 0) this.persist();
  }

  configure(dispatcher: (() => DeliveryContext | null) | null): void {
    this.dispatcher = dispatcher;
    if (dispatcher && !this.disposed) this.schedule(0);
  }

  enqueue(destinationHash: string, batch: DurableTelemetryBatch): void {
    if (this.disposed) return;
    while (this.state.queue.length >= this.maxBatches) {
      const dropIndex = this.state.queue.findIndex((entry) => entry.queueId !== this.inFlightQueueId);
      if (dropIndex < 0) {
        this.state.droppedBatches += 1;
        this.state.overflowDroppedBatches += 1;
        this.diagnostic("overflow_dropped", 1);
        this.persist();
        return;
      }
      const [dropped] = this.state.queue.splice(dropIndex, 1);
      if (dropped) this.pendingDurability.delete(dropped.queueId);
      this.state.droppedBatches += 1;
      this.state.overflowDroppedBatches += 1;
      this.diagnostic("overflow_dropped", 1);
    }
    const enqueuedAt = new Date(this.now()).toISOString();
    const queueId = createHash("sha256")
      .update(`${destinationHash}\0${batch.producerInstanceId}\0${batch.events.map((event) => event.eventId).join("\0")}`)
      .digest("hex");
    const persistedBatch = sanitizeBatchForPersistence(batch);
    this.state.queue.push({
      queueId,
      destinationHash,
      enqueuedAt,
      attempts: 0,
      nextAttemptAt: 0,
      batch: persistedBatch as StoredOutbox["queue"][number]["batch"],
    });
    this.pendingDurability.add(queueId);
    // Stable event ids are on disk before the first network attempt begins.
    this.persist();
    this.schedule(0);
  }

  status(): TelemetryOutboxStatus {
    const oldestQueuedAt = this.state.queue[0]?.enqueuedAt ?? null;
    const oldestMs = oldestQueuedAt ? Date.parse(oldestQueuedAt) : Number.NaN;
    return {
      queuedBatches: this.state.queue.length,
      oldestQueuedAt,
      oldestQueuedAgeMs: Number.isFinite(oldestMs) ? Math.max(0, this.now() - oldestMs) : null,
      droppedBatches: this.state.droppedBatches,
      overflowDroppedBatches: this.state.overflowDroppedBatches,
      destinationChangeDroppedBatches: this.state.destinationChangeDroppedBatches,
      rejectedEvents: this.state.rejectedEvents,
      failedAttempts: this.state.failedAttempts,
      persistenceFailures: this.state.persistenceFailures,
      nonDurableBatches: this.pendingDurability.size,
      corruptFilesQuarantined: this.state.corruptFilesQuarantined,
      terminalQuarantinedBatches: this.state.terminalQuarantine.length,
      terminalQuarantineEvictedBatches: this.state.terminalQuarantineEvictedBatches,
      lastTerminalStatus: this.state.terminalQuarantine.at(-1)?.status ?? null,
      lastTerminalAt: this.state.terminalQuarantine.at(-1)?.quarantinedAt ?? null,
      deadLetterBatches: this.state.deadLetter.length,
      deadLetterEvictedBatches: this.state.deadLetterEvictedBatches,
      lastDeadLetterAt: this.state.deadLetter.at(-1)?.parkedAt ?? null,
    };
  }

  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flushing;
  }

  /** Everything this pass mutates lands in `this.state` immediately; the
   * whole pass persists ONCE, here, right before every exit point (HS8) —
   * draining a large backlog used to fsync once per batch AND once per
   * failure, which is quadratic in bytes for a deep queue.  A failed
   * persist rolls the ENTIRE pass back to `snapshot` (not just the last
   * mutation) rather than risk landing on disk half-updated; a resend of an
   * already-acknowledged batch that implies is safe — Usage Monitor dedupes
   * by event id. */
  private async flushLoop(): Promise<void> {
    const snapshot = structuredClone(this.state);
    let mutated = false;
    // Logs, diagnostics and counters that describe a state change in this
    // pass.  They run only once that change is on disk; a rollback drops
    // them, so a failed persist cannot double-count or leave a log line
    // for a dead-letter/quarantine that never happened.
    let afterPersist: Array<() => void> = [];
    const runAfterPersist = (): void => {
      const effects = afterPersist;
      afterPersist = [];
      for (const effect of effects) {
        try {
          effect();
        } catch {
          // A log or counter must never interrupt the queue.
        }
      }
    };
    const persistPass = (): boolean => {
      if (!mutated) {
        runAfterPersist();
        return true;
      }
      if (this.persist()) {
        mutated = false;
        runAfterPersist();
        return true;
      }
      afterPersist = [];
      // `persist()` just incremented `persistenceFailures` on `this.state`.
      // That counter records a real event and must survive the rollback
      // below even though everything else this pass did gets reverted.
      const persistenceFailures = this.state.persistenceFailures;
      this.state = structuredClone(snapshot);
      this.state.persistenceFailures = persistenceFailures;
      return false;
    };

    while (!this.disposed && this.state.queue.length > 0) {
      // Freshly-enqueued batches persist for themselves (`enqueue()`), so
      // this is normally a no-op Set-size check; it only does real work to
      // recover from an enqueue-time persist that failed, and it must land
      // before anything is handed to `deliver` (OP2b's dead-letter path
      // below does not touch this guarantee).
      if (this.pendingDurability.size > 0 && !this.persist()) {
        this.schedule(this.retryBaseMs);
        return;
      }
      // Configuration is live.  Re-read it before every batch so a change
      // during an awaited request cannot route later batches to the old URL.
      const context = this.dispatcher?.() ?? null;
      if (!context) {
        persistPass();
        this.schedule(this.retryBaseMs);
        return;
      }
      const mismatched = this.state.queue.filter((entry) => entry.destinationHash !== context.destinationHash);
      if (mismatched.length > 0) {
        const mismatchedIds = new Set(mismatched.map((entry) => entry.queueId));
        this.state.queue = this.state.queue.filter((entry) => !mismatchedIds.has(entry.queueId));
        for (const entry of mismatched) this.pendingDurability.delete(entry.queueId);
        this.state.droppedBatches += mismatched.length;
        this.state.destinationChangeDroppedBatches += mismatched.length;
        const destinationDropped = mismatched.length;
        afterPersist.push(() => this.diagnostic("destination_changed", destinationDropped));
        mutated = true;
        continue;
      }
      const entry = this.state.queue[0];
      const delay = entry.nextAttemptAt - this.now();
      if (delay > 0) {
        persistPass();
        this.schedule(delay);
        return;
      }
      let result: TelemetryDeliveryResult;
      this.inFlightQueueId = entry.queueId;
      try {
        result = await context.deliver(entry.batch);
      } catch {
        result = { acknowledged: false, rejected: 0 };
      } finally {
        this.inFlightQueueId = null;
      }
      const liveIndex = this.state.queue.findIndex((queued) => queued.queueId === entry.queueId);
      if (result.acknowledged) {
        if (liveIndex >= 0) this.state.queue.splice(liveIndex, 1);
        this.pendingDurability.delete(entry.queueId);
        const rejected = Math.max(0, Math.floor(result.rejected || 0));
        this.state.rejectedEvents += rejected;
        if (rejected > 0) afterPersist.push(() => this.diagnostic("events_rejected", rejected));
        if (result.onPersisted) afterPersist.push(result.onPersisted);
        mutated = true;
        continue;
      }
      if (liveIndex < 0) continue;
      if (result.terminalStatus !== undefined) {
        // Keep the original sanitized batch and event IDs for repair.
        const quarantinedEntry = this.state.queue[liveIndex];
        this.state.terminalQuarantine.push({
          entry: quarantinedEntry,
          status: result.terminalStatus,
          quarantinedAt: new Date(this.now()).toISOString(),
        });
        this.state.queue.splice(liveIndex, 1);
        let evicted = false;
        if (this.state.terminalQuarantine.length > this.maxQuarantinedBatches) {
          this.state.terminalQuarantine.shift();
          this.state.terminalQuarantineEvictedBatches += 1;
          evicted = true;
        }
        mutated = true;
        const terminalStatus = result.terminalStatus;
        afterPersist.push(() => {
          this.diagnostic("terminal_quarantined", 1);
          if (evicted) this.diagnostic("terminal_quarantine_evicted", 1);
          this.log(
            `dropping batch ${shortId(quarantinedEntry.queueId)} after terminal HTTP ${terminalStatus}; will not retry`,
          );
        });
        continue;
      }
      const liveEntry = this.state.queue[liveIndex];
      liveEntry.attempts += 1;
      this.state.failedAttempts += 1;
      this.diagnostic("delivery_failed", 1);
      if (liveEntry.attempts >= this.maxHeadAttempts) {
        // This batch alone has failed enough times that continuing to
        // retry it head-of-line-blocks every newer batch behind it
        // forever (OP2b) — park it and let a fresh head get its turn in
        // THIS pass, rather than waiting out another full backoff cycle.
        this.state.deadLetter.push({ entry: liveEntry, parkedAt: new Date(this.now()).toISOString() });
        this.state.queue.splice(liveIndex, 1);
        let evicted = false;
        if (this.state.deadLetter.length > this.maxDeadLetterBatches) {
          this.state.deadLetter.shift();
          this.state.deadLetterEvictedBatches += 1;
          evicted = true;
        }
        mutated = true;
        const parkedAttempts = liveEntry.attempts;
        afterPersist.push(() => {
          this.diagnostic("dead_lettered", 1);
          if (evicted) this.diagnostic("dead_letter_evicted", 1);
          this.log(
            `parking batch ${shortId(liveEntry.queueId)} in dead-letter after ${parkedAttempts} failed attempts; trying newer batches`,
          );
        });
        continue;
      }
      const backoff = Math.min(
        this.retryMaxMs,
        this.retryBaseMs * 2 ** Math.min(liveEntry.attempts - 1, 20),
      );
      liveEntry.nextAttemptAt = this.now() + backoff;
      mutated = true;
      if (!persistPass()) {
        this.schedule(this.retryBaseMs);
        return;
      }
      this.schedule(backoff);
      return;
    }
    if (!persistPass()) {
      this.schedule(this.retryBaseMs);
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow().catch(() => {
        this.state.failedAttempts += 1;
        this.diagnostic("delivery_failed", 1);
        this.schedule(this.retryBaseMs);
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private readState(): StoredOutbox {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      const result = StoredOutboxSchema.safeParse(parsed);
      if (result.success) return result.data;
      throw new Error("invalid outbox shape");
    } catch {
      const state = emptyState();
      const quarantine = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, quarantine);
        state.corruptFilesQuarantined = 1;
        this.diagnostic("corrupt_quarantined", 1);
      } catch {
        state.persistenceFailures = 1;
        this.diagnostic("persistence_failed", 1);
      }
      return state;
    }
  }

  private persist(): boolean {
    try {
      this.writeState(this.path, this.state);
      this.pendingDurability.clear();
      return true;
    } catch {
      this.state.persistenceFailures += 1;
      this.diagnostic("persistence_failed", 1);
      return false;
    }
  }

  private diagnostic(
    name: "delivery_failed" | "events_rejected" | "overflow_dropped" | "destination_changed" | "persistence_failed" | "corrupt_quarantined" | "terminal_quarantined" | "terminal_quarantine_evicted" | "dead_lettered" | "dead_letter_evicted",
    count: number,
  ): void {
    try {
      this.onDiagnostic?.(name, count);
    } catch {
      // Diagnostic reporting must never interrupt queue persistence.
    }
  }
}
