// Background jobs: what the harness, the web client and (from P4) the phone
// all agree a job looks like (docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).
//
// A job is a shell command a bot started with `job_start` that keeps running
// after the tool call returns.  The harness owns it: one registry runs the
// process, keeps its log, shows it in the chat header and tells the bot when
// it ends.  This file is the wire shape and the words, nothing that runs
// anything — the client imports it too.

/** Where a job is in its life.  `stopping` is a kill in flight (SIGTERM sent,
 *  SIGKILL after 5 s).  `lost` is a job the harness stopped tracking: it was
 *  running when the harness shut down or restarted. */
export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed" | "lost";

/** `botfleet`: started by the harness's own job tools.  `native`: an engine's
 *  own background task, mirrored (a later phase). */
export type JobOrigin = "botfleet" | "native";

/** Only shell commands today. */
export type JobKind = "shell";

/** What the bot hears when the job ends: woken (`wake`), told on its next
 *  turn without being woken (`notice`), or nothing (`none`, the bot killed it
 *  itself). */
export type JobOnComplete = "wake" | "notice" | "none";

/** Whether the bot has been told the job ended.  `pending` until a turn (or
 *  a round between tool calls) carries the notice; `none` when nobody needs
 *  telling. */
export type JobNoticeState = "pending" | "delivered" | "none";

/** Who ended a job early.  `limit` is a BotFleet limit other than the
 *  clock: the job printed faster than any log is read.  `system` is the
 *  harness: the thread or bot was deleted, the bot lost its computer grant,
 *  or the harness stopped. */
export type JobKilledBy = "model" | "owner" | "timeout" | "limit" | "system";

/** One job, as every client sees it.  Never carries output: that is read
 *  over REST, on demand. */
export interface JobSnapshot {
  /** `job_<ulid>` */
  id: string;
  botId: string;
  threadId: string;
  /** The turn that started it, when the harness knew it. */
  turnId?: string;
  origin: JobOrigin;
  kind: JobKind;
  /** The command, redacted, on one line, clipped. */
  label: string;
  /** Working directory the command ran in. */
  cwd: string;
  status: JobStatus;
  /** The command's own exit code, when it exited on its own. */
  exitCode: number | null;
  /** The signal that ended it, when one did (`SIGTERM`, `SIGXCPU`). */
  signal: string | null;
  /** Wall-clock epoch ms. */
  startedAt: number;
  endedAt: number | null;
  /** The run limit, in awake milliseconds. */
  timeoutMs: number;
  onComplete: JobOnComplete;
  notice: JobNoticeState;
  killedBy?: JobKilledBy;
  /** A short reason the status alone does not say ("CPU limit reached"). */
  reason?: string;
}

/** The SSE frame the registry broadcasts: every job of one thread, debounced.
 *  A full set rather than a diff, so a client that missed one frame is right
 *  again on the next. */
export interface JobsFrame {
  kind: "jobs";
  threadId: string;
  jobs: JobSnapshot[];
}

// ── limits (docs/plans/2026-10-01-background-jobs-and-subagents-decision.md) ──

/** Running jobs one thread, one bot and the whole harness may hold. */
export const JOB_CAP_PER_THREAD = 3;
export const JOB_CAP_PER_BOT = 4;
export const JOB_CAP_PER_HOST = 8;
/** Run limit when the bot names none, and the most the bot may ask for. */
export const JOB_DEFAULT_MINUTES = 60;
export const JOB_MODEL_MAX_MINUTES = 240;
/** The most an owner's config may raise the bot's ceiling to. */
export const JOB_OWNER_MAX_MINUTES = 360;
/** Most new output one `job_output` call returns. */
export const JOB_OUTPUT_MAX_BYTES = 16 * 1024;
/** A job's log is cut back to its newest half past this size. */
export const JOB_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Metadata records `jobs.json` keeps, newest first. */
export const JOB_RECORD_MAX = 500;
/** Longest `job_output` may wait for a job on the HTTP tool lane. */
export const JOB_OUTPUT_WAIT_MAX_SECONDS_HTTP = 75;

export function isJobActive(job: Pick<JobSnapshot, "status">): boolean {
  return job.status === "running" || job.status === "stopping";
}

/** "4m 12s", "12s", "1h 3m".  Whole seconds; never negative. */
export function formatJobDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** How long a job has run: to now while it runs, to its end once it ended. */
export function jobElapsedMs(job: Pick<JobSnapshot, "startedAt" | "endedAt">, now: number): number {
  return (job.endedAt ?? now) - job.startedAt;
}

/** The chip the dropdown shows beside a job.  Sentence case: it is a value. */
export function jobExitChip(job: Pick<JobSnapshot, "status" | "exitCode" | "signal" | "killedBy">): string {
  switch (job.status) {
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "completed":
      return "Exited 0";
    case "failed":
      // `ulimit -t` ends a job with SIGXCPU, which a shell reports as 152:
      // the limit is the news, not the number.
      if (job.signal === "SIGXCPU") return "CPU limit reached";
      if (job.exitCode !== null) return `Exited ${job.exitCode}`;
      return job.signal ? `Ended by ${job.signal}` : "Failed";
    case "killed":
      if (job.killedBy === "owner") return "Killed by you";
      if (job.killedBy === "model") return "Stopped by the bot";
      if (job.killedBy === "timeout") return "Timed out";
      if (job.killedBy === "limit") return "Output limit";
      return "Stopped";
    case "lost":
      return "Lost after restart";
  }
}

const JOB_STOPPED_BY: Record<JobKilledBy, string> = {
  model: "you",
  owner: "the owner",
  timeout: "timeout",
  limit: "output limit",
  system: "system",
};

/** The line `job_output` ends with:
 *  `[status: completed, exit code: 1, 4m 12s]`. */
export function jobStatusLine(
  job: Pick<JobSnapshot, "status" | "exitCode" | "signal" | "startedAt" | "endedAt" | "killedBy">,
  now: number,
): string {
  const parts: string[] = [`status: ${job.status}`];
  if (job.exitCode !== null && !isJobActive(job)) parts.push(`exit code: ${job.exitCode}`);
  if (job.signal && !isJobActive(job)) parts.push(`signal: ${job.signal}`);
  if (job.status === "killed" && job.killedBy) parts.push(`stopped by: ${JOB_STOPPED_BY[job.killedBy]}`);
  parts.push(formatJobDuration(jobElapsedMs(job, now)));
  return `[${parts.join(", ")}]`;
}

/** One line per running job, for the top of every turn:
 *  ``Running: job_x `pnpm test` 4m 12s``. */
export function jobRunningLine(job: Pick<JobSnapshot, "id" | "label" | "startedAt" | "endedAt">, now: number): string {
  return `Running: ${job.id} \`${job.label}\` ${formatJobDuration(jobElapsedMs(job, now))}`;
}

/** Order for every list a person reads: running first, then finished jobs,
 *  newest first. */
export function sortJobsForDisplay<T extends Pick<JobSnapshot, "status" | "startedAt" | "endedAt">>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => {
    const activeA = isJobActive(a) ? 0 : 1;
    const activeB = isJobActive(b) ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    if (activeA === 0) return b.startedAt - a.startedAt;
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  });
}

/** True when a job ended badly within `windowMs` of `now` — the pill's dot
 *  turns red for a while after a failure. */
export function jobFailedRecently(
  job: Pick<JobSnapshot, "status" | "endedAt" | "killedBy">,
  now: number,
  windowMs = 5 * 60_000,
): boolean {
  if (job.endedAt === null || now - job.endedAt > windowMs) return false;
  if (job.status === "failed" || job.status === "lost") return true;
  return job.status === "killed" && (job.killedBy === "timeout" || job.killedBy === "limit");
}

/** Whether a job's end counts as a failure for the transcript row: red step,
 *  the mascot's failure motion, the roster's alert.  A Stop — the owner's,
 *  the bot's own, or BotFleet's for a deleted conversation — is not one; a
 *  limit the job ran into is. */
export function jobEndedBadly(job: Pick<JobSnapshot, "status" | "killedBy">): boolean {
  if (job.status === "failed" || job.status === "lost") return true;
  return job.status === "killed" && (job.killedBy === "timeout" || job.killedBy === "limit");
}

/** A job id as every route and tool accepts it. */
export const JOB_ID_PATTERN = /^job_[0-9A-Za-z]{10,40}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `job_` plus a ULID: 48 bits of millisecond time and 80 random bits in
 *  Crockford base 32, so ids sort by start time. */
export function newJobId(now: number = Date.now(), random: (bytes: number) => Uint8Array = cryptoBytes): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rest = "";
  for (let i = 0; i < 16; i++) rest += CROCKFORD[bytes[i]! % 32];
  return `job_${time}${rest}`;
}

function cryptoBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** What a "Job Finished" row in the thread carries: enough to draw the row
 *  and open the job, never its output. */
export interface JobRowData {
  id: string;
  label: string;
  status: JobSnapshot["status"];
  exitCode: number | null;
  signal: string | null;
  killedBy?: JobKilledBy;
  startedAt: number;
  endedAt: number | null;
}

export function jobRowData(job: JobSnapshot): JobRowData {
  const row: JobRowData = {
    id: job.id,
    label: job.label,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
  if (job.killedBy) row.killedBy = job.killedBy;
  return row;
}
