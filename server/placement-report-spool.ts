/** Durable, bounded spool of terminal placement reports (transport slice T1
 *  of docs/plans/2026-11-03-placement-transport-slices.md).
 *
 *  A terminal result is written and fsynced here before the worker attempts
 *  delivery, and the row is removed only after the controller's own
 *  acknowledgement.  A dropped acknowledgement, a crash before delivery or a
 *  dead link therefore replays the identical ReportMessage, which the lease
 *  book answers idempotently, so a terminal result settles exactly once no
 *  matter how many times delivery is retried.  The spool never rewrites a
 *  different terminal result over an existing row for the same job: once a
 *  result is durable, it is the durable record of what was decided.
 *
 *  Layout and durability follow the outgoing Zulip webhook spool
 *  (server/zulip/outgoing-spool.ts): atomic file replace, then a directory
 *  fsync, before the caller is told the row is durable. */
import { chmodSync, fsyncSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { HOST_ID_PATTERN, type ReportMessage } from "../shared/placement.ts";
import { PlacementWorkerClient, type WorkerCallOutcome } from "./placement-worker-client.ts";

export const PLACEMENT_REPORT_MAX_PENDING = 10_000;
export const PLACEMENT_REPORT_MAX_ATTEMPTS = 12;
const ROW_NAME = /^report-[0-9a-f]{32}\.json$/;
const rowSchema = z.object({
  message: z.object({
    version: z.string().min(1),
    controllerId: z.string().min(1).max(64).regex(HOST_ID_PATTERN),
    epoch: z.number().int().nonnegative(),
    jobId: z.string().min(1).max(200),
    leaseId: z.string().min(1).max(200),
    hostId: z.string().min(1).max(64).regex(HOST_ID_PATTERN),
    status: z.enum(["completed", "failed", "killed", "lost"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    endedAt: z.number(),
    reason: z.string().optional(),
  }).strict(),
  attempts: z.number().int().nonnegative().optional(),
}).strict();

export interface PlacementReportRow {
  message: ReportMessage;
  attempts: number;
}

export function supportsReportDirectoryFsync(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function rowName(jobId: string): string {
  // The job id is an arbitrary string on the wire, so the file name is its
  // digest; the row itself carries the id a human reads.
  return `report-${createHash("sha256").update(jobId).digest("hex").slice(0, 32)}.json`;
}

function sameReport(a: ReportMessage, b: ReportMessage): boolean {
  // Field-by-field, never a serialized-key comparison: two durably equal
  // results must stay equal however their object keys happen to be ordered.
  return a.version === b.version && a.controllerId === b.controllerId && a.epoch === b.epoch
    && a.jobId === b.jobId && a.leaseId === b.leaseId && a.hostId === b.hostId
    && a.status === b.status && a.exitCode === b.exitCode && a.signal === b.signal
    && a.endedAt === b.endedAt && a.reason === b.reason;
}

export class PlacementReportSpool {
  readonly directory: string;
  private damagedRows = 0;

  constructor(
    dataDir: string,
    private readonly readDirectory: (directory: string) => string[] = (directory) => readdirSync(directory),
  ) {
    this.directory = join(dataDir, "placement", "reports");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.directory, 0o700);
  }

  /** Atomically persist a terminal result and fsync it to disk before
   *  returning.  Returns false when the identical row is already pending;
   *  throws when a different terminal result is already durable for the job,
   *  because the durable row is the record of what was decided. */
  add(message: ReportMessage): boolean {
    const checked = rowSchema.safeParse({ message });
    if (!checked.success) throw new TypeError("invalid terminal placement report");
    const path = join(this.directory, rowName(message.jobId));
    const existing = this.readRow(path);
    if (existing) {
      if (!sameReport(existing.message, message)) {
        throw new Error("a different terminal result is already durable for this job");
      }
      // A prior attempt may have installed the row and then failed the
      // directory fsync.  The retry must establish durability before acking.
      this.fsyncDirectory();
      return false;
    }
    // The capacity bound counts names, not rows: every name in this
    // directory was written by this class, so a malformed row still holds
    // its slot, and the check costs one readdir with no parsing.
    const count = this.readDirectory(this.directory).filter((entry) => ROW_NAME.test(entry)).length;
    if (count >= PLACEMENT_REPORT_MAX_PENDING) throw new Error("the terminal report spool is full");
    writeFileAtomic(path, `${JSON.stringify({ message })}\n`, { mode: 0o600 });
    this.fsyncDirectory();
    return true;
  }

  pending(): PlacementReportRow[] {
    const rows: PlacementReportRow[] = [];
    this.damagedRows = 0;
    for (const entry of this.readDirectory(this.directory)) {
      if (!ROW_NAME.test(entry)) continue;
      const row = this.readRow(join(this.directory, entry));
      if (!row) { this.damagedRows += 1; continue; }
      rows.push(row);
    }
    return rows.sort((a, b) => a.message.endedAt - b.message.endedAt || (a.message.jobId < b.message.jobId ? -1 : 1));
  }

  /** Malformed rows are counted, never crashed on and never silently lost:
   *  an operator reads this count before trusting an empty spool. */
  damaged(): number {
    return this.damagedRows;
  }

  has(jobId: string): boolean {
    return this.readRow(join(this.directory, rowName(jobId))) !== undefined;
  }

  remove(jobId: string): void {
    const path = join(this.directory, rowName(jobId));
    try {
      unlinkSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    this.fsyncDirectory();
  }

  recordFailure(jobId: string): number {
    const path = join(this.directory, rowName(jobId));
    const row = this.readRow(path);
    if (!row) throw new Error("no pending terminal report for this job");
    const attempts = row.attempts + 1;
    writeFileAtomic(path, `${JSON.stringify({ message: row.message, attempts })}\n`, { mode: 0o600 });
    this.fsyncDirectory();
    return attempts;
  }

  private readRow(path: string): PlacementReportRow | undefined {
    try {
      const parsed = rowSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) return undefined;
      // SAFETY: the strict row schema above checked every field of the
      // stored message; this assertion only re-tags it as the wire type.
      return { message: parsed.data.message as ReportMessage, attempts: parsed.data.attempts ?? 0 };
    } catch {
      return undefined;
    }
  }

  private fsyncDirectory(): void {
    if (!supportsReportDirectoryFsync()) return;
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export interface SettleOutcome {
  jobId: string;
  result: "settled" | "kept" | "exhausted";
  attempts: number;
  reason?: string;
}

function outcomeReason(outcome: WorkerCallOutcome<unknown>): string | undefined {
  if (outcome.outcome === "accepted") return undefined;
  return outcome.reason;
}

/** Deliver every pending terminal report once.  A row leaves the spool only
 *  on the controller's accepted acknowledgement.  A stale-epoch refusal is
 *  not counted as an attempt because convergence after a takeover is the
 *  expected next step, and neither is a link failure or an inactive
 *  transport, because an outage must never exhaust a terminal result: the
 *  report is the last word on the job, and giving up on it would leave the
 *  lease unsettled forever.  Only a controller's explicit refusal of the row
 *  itself burns an attempt, so exhaustion means the controller refused this
 *  exact result repeatedly, which is a contradiction worth surfacing, not a
 *  network condition.  Rows past the cap are left in place and reported
 *  exhausted; terminal evidence is never silently dropped. */
export async function settlePendingReports(spool: PlacementReportSpool, client: PlacementWorkerClient): Promise<SettleOutcome[]> {
  const outcomes: SettleOutcome[] = [];
  for (const row of spool.pending()) {
    if (row.attempts >= PLACEMENT_REPORT_MAX_ATTEMPTS) {
      outcomes.push({ jobId: row.message.jobId, result: "exhausted", attempts: row.attempts });
      continue;
    }
    const reply = await client.report({
      jobId: row.message.jobId,
      leaseId: row.message.leaseId,
      status: row.message.status,
      exitCode: row.message.exitCode,
      signal: row.message.signal,
      endedAt: row.message.endedAt,
      reason: row.message.reason,
    });
    if (reply.outcome === "accepted") {
      spool.remove(row.message.jobId);
      outcomes.push({ jobId: row.message.jobId, result: "settled", attempts: row.attempts });
      continue;
    }
    const reason = outcomeReason(reply);
    if (reply.outcome === "refused" && !/stale (?:controller|lease) epoch/.test(reply.reason)) {
      outcomes.push({ jobId: row.message.jobId, result: "kept", attempts: spool.recordFailure(row.message.jobId), reason });
      continue;
    }
    // A stale epoch, an inactive transport and a link failure all keep the
    // row at its current attempt count: none of them is the controller
    // refusing this result.
    outcomes.push({ jobId: row.message.jobId, result: "kept", attempts: row.attempts, reason });
    if (reply.outcome === "link-failed") break;
  }
  return outcomes;
}
