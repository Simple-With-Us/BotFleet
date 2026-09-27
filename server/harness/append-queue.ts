// A single-writer, bounded append queue — the thing that stands between the
// event bus and the disk.
//
// The tee it feeds used to append synchronously on the publish path: every
// runtime event, from every bot, through `appendFileSync`, on the harness's
// only thread.  The native tee carries whole file contents a tool read, so a
// 5 MB `read_file` result meant a 5 MB blocking write while every other bot's
// turn, the SSE fan-out and `/api/health` waited behind it (audit HS10).
//
// Three rules, in the order they matter:
//
//   Never block the publisher.  `enqueue` does one `Buffer.byteLength`, a push
//   and an arithmetic compare.  The write happens later, off that stack.
//
//   Never grow without a bound.  Queued bytes are capped; past the cap the
//   OLDEST entries go, because under write pressure the newest records are the
//   ones a reader wants and the oldest are the ones already stale.  Dropping is
//   the release valve that lets "never block" be true even when the disk is
//   slower than the fleet.
//
//   Never reorder.  One FIFO drained by one in-flight write, so records land in
//   the order they were published, per file and across files.  Drops only ever
//   take from the front, which cannot reorder what is left.
//
// A drop is counted, not narrated: one summary line per interval, never one
// line per drop, because a log that floods under pressure is the failure it is
// trying to report.

/** Ceiling on bytes waiting to be written.  Sized as a few seconds of a very
 * chatty fleet, not as a buffer that could ever matter to RSS: the whole point
 * is that the queue is small enough to be forgettable and the drop counter is
 * what tells anyone it filled. */
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** How often the drop counter is allowed to speak. */
export const DROP_REPORT_INTERVAL_MS = 60_000;

export interface AppendQueueStats {
  /** entries waiting, not counting the one being written */
  pending: number;
  pendingBytes: number;
  /** cumulative, for the life of the queue */
  dropped: number;
  droppedBytes: number;
}

export interface AppendQueueOptions<Context> {
  maxQueuedBytes?: number;
  /** A write that threw.  The queue never throws at its caller and never
   * retries: the entry is gone, and this is where that is reported. */
  onWriteError?: (context: Context, error: unknown) => void;
  /** An entry evicted under pressure.  Never written, so a caller that keeps
   * a "the log is incomplete" marker arms it here too. */
  onDropped?: (context: Context) => void;
  /** An entry that reached disk. */
  onWritten?: (context: Context) => void;
  /** Seam for the drop-report clock, so a test does not wait a minute. */
  now?: () => number;
  /** Seam for the summary line. */
  report?: (line: string) => void;
  /** Which log the summary line names.  More than one tee runs on this
   * queue, so a drop line has to say which one filled. */
  label?: string;
}

interface QueuedAppend<Context> {
  file: string;
  data: string;
  bytes: number;
  context: Context;
}

export class BoundedAppendQueue<Context> {
  private readonly write: (file: string, data: string) => Promise<void>;
  private readonly maxQueuedBytes: number;
  private readonly onWriteError: (context: Context, error: unknown) => void;
  private readonly onDropped: (context: Context) => void;
  private readonly onWritten: (context: Context) => void;
  private readonly now: () => number;
  private readonly report: (line: string) => void;
  private readonly label: string;

  private queue: QueuedAppend<Context>[] = [];
  private queuedBytes = 0;
  private draining: Promise<void> | null = null;

  /** Cumulative, for `stats()`. */
  private dropped = 0;
  private droppedBytes = 0;
  /** Since the last summary line. */
  private dropsSinceReport = 0;
  private dropBytesSinceReport = 0;
  private lastReportAt = 0;

  constructor(write: (file: string, data: string) => Promise<void>, options: AppendQueueOptions<Context> = {}) {
    this.write = write;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.onWriteError = options.onWriteError ?? (() => undefined);
    this.onDropped = options.onDropped ?? (() => undefined);
    this.onWritten = options.onWritten ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.report = options.report ?? ((line) => console.error(line));
    this.label = options.label ?? "event log tee";
  }

  enqueue(file: string, data: string, context: Context): void {
    const bytes = Buffer.byteLength(data);
    this.queue.push({ file, data, bytes, context });
    this.queuedBytes += bytes;
    // `> 1` keeps the entry just enqueued even when it alone is over the cap.
    // A single record larger than the bound is the one shape a bound cannot
    // help, and dropping the newest would mean a huge tool result silently
    // erased the record of itself.
    const evicted: Context[] = [];
    while (this.queuedBytes > this.maxQueuedBytes && this.queue.length > 1) {
      const oldest = this.queue.shift()!;
      this.queuedBytes -= oldest.bytes;
      this.dropped += 1;
      this.droppedBytes += oldest.bytes;
      this.dropsSinceReport += 1;
      this.dropBytesSinceReport += oldest.bytes;
      evicted.push(oldest.context);
    }
    if (!this.draining) this.draining = this.drain();
    // Callbacks last, and never from inside the eviction loop: a handler is
    // free to publish again (the bus arms an "incomplete log" marker here),
    // and a re-entrant `enqueue` mid-loop would be mutating the array this
    // loop is walking.
    this.reportDrops(false);
    for (const context of evicted) this.guarded(() => this.onDropped(context));
  }

  /** Resolves when everything queued at the moment of the call has been
   * written or failed — including anything enqueued while it waited, so a
   * shutdown flush does not race a publisher that is still going. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
    this.reportDrops(true);
  }

  stats(): AppendQueueStats {
    return {
      pending: this.queue.length,
      pendingBytes: this.queuedBytes,
      dropped: this.dropped,
      droppedBytes: this.droppedBytes,
    };
  }

  /** Nothing a handler does may reject the drain.  The drain promise is only
   * awaited at shutdown, so a rejection would sit unhandled for the life of
   * the process — and an unhandled rejection takes the harness down on Node
   * 24.  A tee that cannot write is a degraded log; it is never a reason to
   * stop the fleet. */
  private guarded(run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error("append-queue: an entry handler threw", error);
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.queuedBytes -= next.bytes;
        try {
          await this.write(next.file, next.data);
          this.guarded(() => this.onWritten(next.context));
        } catch (error) {
          this.guarded(() => this.onWriteError(next.context, error));
        }
      }
    } finally {
      this.draining = null;
    }
  }

  private reportDrops(force: boolean): void {
    if (this.dropsSinceReport === 0) return;
    const at = this.now();
    if (!force && at - this.lastReportAt < DROP_REPORT_INTERVAL_MS) return;
    const entries = this.dropsSinceReport === 1 ? "1 entry" : `${this.dropsSinceReport} entries`;
    this.guarded(() =>
      this.report(
        `append-queue: dropped ${entries} (${this.dropBytesSinceReport} bytes) from the ${this.label} — ` +
          `writes are behind the fleet and the queue is capped at ${this.maxQueuedBytes} bytes.  Live delivery is unaffected.`,
      ),
    );
    this.lastReportAt = at;
    this.dropsSinceReport = 0;
    this.dropBytesSinceReport = 0;
  }
}
