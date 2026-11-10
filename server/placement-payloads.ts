import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { JOB_RECORD_MAX } from "../shared/jobs.ts";
import { PendingCommandSpool, type PendingIdentity } from "./jobs/pending-spool.ts";
import { commandDigest, type StoredPlacementJob } from "./placement-store.ts";

// The reviewed local waiter queue uses this same 1,440-minute default.
export const PLACEMENT_QUEUE_WINDOW_MS = 1440 * 60_000;

export interface PlacementPayloads {
  put(job: StoredPlacementJob, command: string): void;
  read(job: StoredPlacementJob): string | null;
  remove(job: StoredPlacementJob): void;
  reconcile(jobs: readonly StoredPlacementJob[]): void;
}

function identity(job: StoredPlacementJob): PendingIdentity {
  return {
    id: `job_${createHash("sha256").update(job.jobId).digest("hex").slice(0, 32)}`,
    botId: job.botId, threadId: job.threadId, turnId: job.fingerprint,
    origin: "placement-controller:v1", cwd: job.cwd, timeoutMs: job.timeoutMs,
    // Neither wall clock nor mutable host/controller assignments bind a payload.
    startedAt: 0,
  };
}

/** Controller reads never consume a worker's durable one-shot launch claim.
 * Commands stay in the reviewed bounded private spool, outside SQLite metadata. */
export class PlacementPayloadSpool implements PlacementPayloads {
  private readonly spool: PendingCommandSpool;
  private readonly directory: string;

  constructor(dataDir: string, maxCount = JOB_RECORD_MAX) {
    // The root may not exist yet, and canonicalizing a missing path throws.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const root = realpathSync(dataDir);
    const dir = join(root, "placement-payloads");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.spool = new PendingCommandSpool(dir, maxCount);
    this.directory = join(dir, "pending-commands");
    // Persist both new directory names before any enqueue can reference them.
    for (const path of [dir, root]) this.sync(path);
  }

  private sync(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  put(job: StoredPlacementJob, command: string): void {
    if (commandDigest(command) !== job.payloadDigest) throw new Error("Placement payload does not match its immutable digest");
    const entry = identity(job);
    const existing = this.spool.read(entry);
    if (existing !== null) {
      if (existing !== command) throw new Error("Placement payload conflicts with its immutable binding");
      // A prior failed transaction can leave a complete orphan publication.
      this.sync(this.directory);
      return;
    }
    this.spool.put(entry, command);
  }

  read(job: StoredPlacementJob): string | null {
    const command = this.spool.read(identity(job));
    return command !== null && commandDigest(command) === job.payloadDigest ? command : null;
  }

  remove(job: StoredPlacementJob): void { this.spool.remove(identity(job).id); }

  reconcile(jobs: readonly StoredPlacementJob[]): void {
    this.spool.reconcile(new Set(jobs.map((job) => identity(job).id)));
  }
}
