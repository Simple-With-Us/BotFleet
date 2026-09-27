// Collapses a stream of repeated, identical failures into one line per
// incident plus a periodic summary, instead of one line per attempt
// forever.  Two days of `server.log` held 279 `[telemetry]` lines and 350
// `[antigravity-quota]` lines, almost all repeats of the same failure
// (HS23) — this is the shared mechanism both pollers route their failure
// logging through.
//
// A "kind" is a short, stable label for what class of failure this is (an
// HTTP status, an error name, a CLI-output shape).  The SAME kind repeating
// is what gets collapsed; a different kind — including recovery back to
// success via `reset()` — always logs immediately, even mid-window, so a
// genuinely new problem is never hidden behind an old one's summary timer.

export interface FailureLogDedupOptions {
  /** How long a run of identical-kind failures stays silent before a
   * summary line is due. */
  summaryIntervalMs: number;
  /** Where lines go.  Callers own their own tag, e.g.
   * `(m) => console.warn(\`[telemetry] ${m}\`)`. */
  log: (message: string) => void;
  /** Builds the periodic summary line from the number of repeats since the
   * window started (not counting the one occurrence that logged on its
   * own), a "since" HH:MM label (local time), and the most recent
   * occurrence's detail text. */
  formatSummary: (count: number, sinceLabel: string, lastDetail: string) => string;
  now?: () => number;
}

export class FailureLogDedup {
  private readonly summaryIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly formatSummary: (count: number, sinceLabel: string, lastDetail: string) => string;
  private readonly now: () => number;

  private lastKind: string | null = null;
  private lastDetail = "";
  private windowStart = 0;
  private countSinceLog = 0;

  constructor(options: FailureLogDedupOptions) {
    this.summaryIntervalMs = options.summaryIntervalMs;
    this.log = options.log;
    this.formatSummary = options.formatSummary;
    this.now = options.now ?? Date.now;
  }

  /** Report one failure.  Logs immediately the first time `kind` is seen
   * (or is seen again after a different kind or a `reset()`); every
   * further report of the SAME kind is counted silently until either the
   * summary window elapses (the count so far is flushed as one line) or
   * the kind changes (any pending count is flushed, then the new kind logs
   * its own first line). */
  report(kind: string, detail: string): void {
    const now = this.now();
    if (kind !== this.lastKind) {
      this.flush();
      this.log(detail);
      this.lastKind = kind;
      this.lastDetail = detail;
      this.windowStart = now;
      // The occurrence that just triggered the kind change was already
      // printed on its own line above — only REPEATS beyond it belong in a
      // later summary, or a kind seen exactly once would earn a redundant
      // "1 failed since…" the moment anything else happens.
      this.countSinceLog = 0;
      return;
    }
    this.countSinceLog += 1;
    this.lastDetail = detail;
    if (now - this.windowStart >= this.summaryIntervalMs) {
      this.flush();
      this.windowStart = now;
    }
  }

  /** Call once things are healthy again: prints any pending summary, then
   * clears state so the next failure — of any kind — logs immediately
   * rather than reading as a continuation of the incident that just
   * ended. */
  reset(): void {
    this.flush();
    this.clear();
  }

  /** Drops any pending count WITHOUT printing it.  For reconfiguration
   * boundaries where the run that produced the count no longer applies (a
   * new settings provider installed, a test case tearing down) — printing
   * a summary for an incident nobody is tracking anymore would be a stray,
   * confusing log line. */
  clear(): void {
    this.lastKind = null;
    this.lastDetail = "";
    this.countSinceLog = 0;
  }

  private flush(): void {
    if (this.countSinceLog <= 0) return;
    this.log(this.formatSummary(this.countSinceLog, hhmm(this.windowStart), this.lastDetail));
    this.countSinceLog = 0;
  }
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
