// The harness's background job registry (jobs P1,
// docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).
//
// One registry per harness owns every job a bot starts with `job_start`: it
// admits it, runs it (server/jobs/runner.ts), keeps its log and metadata in
// the data folder, stops it, and says when it ended.  Everything a person or
// a bot sees about a job comes from here: the header pill (a debounced
// full-set frame per thread), `job_output`, and the notice the bot reads.
//
// Rules this file keeps, each from the decision doc:
//
//   - Caps: 3 running jobs per thread, 4 per bot, 8 per host.  Past a cap,
//     `job_start` is refused, never queued.
//   - Limits: 60 minutes unless the bot names one, at most 240 (an owner may
//     raise the ceiling to 6 hours).  Deadlines count AWAKE time: the tick
//     credits the monotonic clock's advance (`performance.now()`, which does
//     not run while the Mac sleeps — mach continuous time is the one that
//     does), so a Mac that slept overnight does not wake to every job timed
//     out, and a starved event loop still credits every awake second.
//   - Output: an 8 MiB log, cut back to its newest half when it passes that,
//     checked twice a second while any job runs.  A job printing faster than
//     64 MiB a second is stopped: nothing a person reads prints that fast,
//     and the disk is the owner's.  `jobs.json` keeps at most 500 records; the
//     oldest finished go first, with their files.
//   - Stop: SIGTERM to the group, SIGKILL after 5 s.
//   - Restart (v1): shutdown stops every job and marks it `lost` (a forced
//     update stops them before it restarts).  At boot a job settles from its
//     `exit` file when it has one; otherwise a leader whose start time still
//     matches is killed, and the job is `lost`.  A group whose leader is gone
//     is never signalled by its number — that number may now be someone
//     else's group — so the sweep stops exactly the processes carrying the
//     lost job's id instead.  Nothing at boot wakes a bot.  A five-minute
//     sweep stops any process still carrying the id of a job that is over.
//   - Redaction: labels and output pass `redactSecretsInText` on their way
//     out, and a read never ends inside a line when it can end at one, so a
//     secret is never split across two reads where neither half matches;
//     the raw command is never written to disk.
//
// What this file does NOT do: decide whether to wake a bot (server/jobs/
// wake.ts), or ask anyone for approval (the tool host, behind the per-turn
// grant).  It never publishes on the runtime bus either: a job's events must
// not touch the 20-minute stall watchdog or fold into a turn.

import { existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, closeSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  JOB_CAP_PER_BOT,
  JOB_CAP_PER_HOST,
  JOB_CAP_PER_THREAD,
  JOB_DEFAULT_MINUTES,
  JOB_LOG_MAX_BYTES,
  JOB_MODEL_MAX_MINUTES,
  JOB_OWNER_MAX_MINUTES,
  JOB_RECORD_MAX,
  formatJobDuration,
  isJobActive,
  jobElapsedMs,
  newJobId,
  sortJobsForDisplay,
  type JobKilledBy,
  type JobOnComplete,
  type JobSnapshot,
  type JobsFrame,
} from "../../shared/jobs.ts";
import { writeFileAtomic } from "../atomic.ts";
import { redactSecretsInText } from "../redact.ts";
import { commandLabel, groupAlive, killGroup, signalGroup, startedNear, GROUP_KILL_GRACE_MS } from "../tools/process-group.ts";
import { modelShellEnv } from "../tools/shell-env.ts";
import { admissionRefusal, createHostProbe, DEFAULT_ADMISSION, type AdmissionThresholds, type HostProbe } from "./admission.ts";
import { readExitFile, spawnJobProcess, type JobSpawnResult, type JobSpawnSpec } from "./runner.ts";
import { createJobProcessLister, type JobProcessLister } from "./sweep.ts";

/** The live settings the registry reads on every decision. */
export interface JobsSettings {
  /** Job tools are offered at all (default on for HTTP-lane bots). */
  enabled: boolean;
  /** A finished job may wake an idle bot (the `jobs.wake` kill switch). */
  wake: boolean;
  defaultMinutes: number;
  /** The most a bot may ask for: 240 unless the owner raised it (≤ 360). */
  maxMinutes: number;
  admission: AdmissionThresholds;
  /** Cores' worth of CPU time a job may average over its run limit before
   *  `ulimit -t` ends it. */
  cpuCores: number;
}

export const DEFAULT_JOBS_SETTINGS: JobsSettings = {
  enabled: true,
  wake: true,
  defaultMinutes: JOB_DEFAULT_MINUTES,
  maxMinutes: JOB_MODEL_MAX_MINUTES,
  admission: DEFAULT_ADMISSION,
  cpuCores: 2,
};

/** The config block as an owner may write it in `config.json`. */
export interface JobsConfigInput {
  enabled?: boolean;
  wake?: boolean;
  defaultMinutes?: number;
  maxMinutes?: number;
  admission?: { maxSwapPercent?: number; minFreeDiskMb?: number };
  cpuCores?: number;
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/** Resolve the owner's `jobs` config against the defaults and the hard
 *  ceilings: no setting can lift the run limit past 6 hours. */
export function resolveJobsSettings(input: JobsConfigInput | undefined): JobsSettings {
  const maxMinutes = finite(input?.maxMinutes)
    ? Math.min(JOB_OWNER_MAX_MINUTES, Math.max(1, Math.floor(input.maxMinutes)))
    : JOB_MODEL_MAX_MINUTES;
  const defaultMinutes = finite(input?.defaultMinutes)
    ? Math.min(maxMinutes, Math.max(1, Math.floor(input.defaultMinutes)))
    : Math.min(maxMinutes, JOB_DEFAULT_MINUTES);
  const swap = input?.admission?.maxSwapPercent;
  const disk = input?.admission?.minFreeDiskMb;
  return {
    enabled: input?.enabled !== false,
    wake: input?.wake !== false,
    defaultMinutes,
    maxMinutes,
    admission: {
      maxSwapPercent: finite(swap) ? Math.min(100, Math.max(1, swap)) : DEFAULT_ADMISSION.maxSwapPercent,
      minFreeDiskBytes: finite(disk) ? Math.max(0, disk) * 1024 * 1024 : DEFAULT_ADMISSION.minFreeDiskBytes,
    },
    cpuCores: finite(input?.cpuCores) ? Math.min(64, Math.max(1, input.cpuCores)) : DEFAULT_JOBS_SETTINGS.cpuCores,
  };
}

/** A job as the registry keeps it: the snapshot every client sees, plus what
 *  only the harness needs.  The raw command is deliberately absent. */
interface JobRecord extends JobSnapshot {
  /** The wrapper shell's pid, which is also the job's process-group id. */
  pid: number | null;
  /** Wall time the spawn was recorded, to recognise the leader at boot. */
  spawnedAt: number;
  /** The leader has exited (its pid may now belong to someone else). */
  leaderExited: boolean;
  logPath: string;
  exitPath: string;
  /** Logical byte offsets each reader has consumed up to. */
  modelCursor: number;
  ownerCursor: number;
  /** Logical bytes cut from the front of the log by the 8 MiB cap. */
  droppedBytes: number;
  /** Awake milliseconds the job has run, credited by the tick. */
  awakeMs: number;
  /** The thread has shown this job's "Job Finished" row. */
  announced: boolean;
}

const RecordFile = z.array(
  z.object({
    id: z.string().regex(/^job_[0-9A-Za-z]{10,40}$/),
    botId: z.string(),
    threadId: z.string(),
    turnId: z.string().optional(),
    origin: z.enum(["botfleet", "native"]),
    kind: z.enum(["shell"]),
    label: z.string(),
    cwd: z.string(),
    status: z.enum(["running", "stopping", "completed", "failed", "killed", "lost"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    timeoutMs: z.number(),
    onComplete: z.enum(["wake", "notice", "none"]),
    notice: z.enum(["pending", "delivered", "none"]),
    killedBy: z.enum(["model", "owner", "timeout", "limit", "system"]).optional(),
    reason: z.string().optional(),
    pid: z.number().int().positive().nullable(),
    spawnedAt: z.number(),
    leaderExited: z.boolean(),
    modelCursor: z.number().nonnegative(),
    ownerCursor: z.number().nonnegative(),
    droppedBytes: z.number().nonnegative(),
    awakeMs: z.number().nonnegative(),
    announced: z.boolean().default(false),
  }),
);

export interface JobStartRequest {
  botId: string;
  threadId: string;
  turnId?: string;
  command: string;
  cwd: string;
  /** What the bot asked for; clamped to the settings' ceiling. */
  timeoutMinutes?: number;
  /** `wake` for a 1:1 thread, `notice` for a room. */
  onComplete: Exclude<JobOnComplete, "none">;
}

export type JobStartResult =
  | { ok: true; job: JobSnapshot; note?: string }
  | { ok: false; error: string };

export interface JobOutputChunk {
  /** Redacted text. */
  text: string;
  /** Bytes past this chunk that a further read returns now: more than one
   *  read's worth was waiting.  Zero when the rest is only a line the job is
   *  still printing, which waits for its end rather than being split. */
  remaining: number;
  /** Bytes the reader missed because the log cap cut them first. */
  dropped: number;
  /** Bytes of a line the job is still printing, held back until it ends. */
  held: number;
}

export interface OwnerOutput {
  text: string;
  /** Logical offsets of `text`. */
  from: number;
  to: number;
  /** Logical size of everything the job has printed. */
  end: number;
  /** Logical bytes no longer on disk (the 8 MiB cap). */
  dropped: number;
}

export interface JobRegistryDeps {
  /** `<data folder>/jobs`. */
  dir: string;
  /** The data folder itself — whose disk admission measures. */
  dataDir: string;
  settings: () => JobsSettings;
  /** Whether the rolling spend ceiling refuses unattended work now. */
  spendBlocked: () => boolean;
  /** Why a running job may not keep running, or null when it may: its bot
   *  or thread was deleted, or the bot lost the host-shell grant a job
   *  needs.  Asked on every tick, so a change made on any screen stops the
   *  job within one tick, whatever route made it.  `forget`: the job's
   *  thread or bot is gone, so once it has stopped its record and log go too
   *  — a deleted conversation's output is not left for its bot to read. */
  stopReason?: (job: JobSnapshot) => { reason: string; forget: boolean } | null;
  /** The debounced full-set frame for one thread. */
  broadcast: (frame: JobsFrame) => void;
  /** A job ended (any status).  `notice` is the line the bot should read,
   *  or null when nobody needs telling.  `row`: the thread has not shown a
   *  "Job Finished" row for it yet.  `boot`: the job was settled while the
   *  harness started, which must never wake a bot. */
  onFinished?: (job: JobSnapshot, notice: string | null, how: { row: boolean; boot: boolean }) => void;
  now?: () => number;
  /** Milliseconds that advance only while the machine is awake: the job
   *  deadline clock.  Default `performance.now()`, which libuv takes from
   *  `mach_absolute_time` / `CLOCK_UPTIME_RAW` on macOS and
   *  `CLOCK_MONOTONIC` on Linux — none of them run during sleep. */
  awakeNow?: () => number;
  /** Most awake time one tick may credit.  A safety net should the clock
   *  above ever count a sleep after all: a sleep then costs a job a minute,
   *  never its whole limit. */
  maxTickCreditMs?: number;
  tickMs?: number;
  /** How often running jobs' logs are held to their cap. */
  logCheckMs?: number;
  /** A job whose output grows faster than this is stopped. */
  floodBytesPerSecond?: number;
  sweepMs?: number;
  frameDebounceMs?: number;
  graceMs?: number;
  logMaxBytes?: number;
  recordMax?: number;
  /** Most disk the logs of finished jobs may hold between them. */
  finishedLogBudgetBytes?: number;
  /** How long a finished job's record and log are kept. */
  finishedMaxAgeMs?: number;
  spawn?: (spec: JobSpawnSpec) => JobSpawnResult;
  probe?: HostProbe;
  listProcesses?: JobProcessLister;
  leaderStartedNear?: (pid: number, at: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

/** Finished records a frame carries per thread, newest first. */
const FRAME_FINISHED_LIMIT = 20;

/** Why a job was lost when the harness stopped: true whether it is quitting
 *  or restarting, which a SIGTERM cannot tell apart. */
export const JOB_STOPPED_REASON = "BotFleet's server stopped";

/** How often finished records are checked for a deleted thread or bot, and
 *  held to their age and disk budget. */
const FORGET_CHECK_MS = 60_000;

/** The logs of finished jobs are kept for a week, and no more than this much
 *  of them: the oldest go first.  (500 records of 8 MiB each would be 4 GiB on
 *  a Mac whose disk gates sit at 2 GB free.) */
export const JOB_FINISHED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const JOB_FINISHED_LOG_BUDGET_BYTES = 256 * 1024 * 1024;

/** A finished job whose process could have left strays that matter this long
 *  after it ended.  Past it the sweep has had every chance to stop them. */
const SWEEP_RELEVANT_MS = 24 * 60 * 60_000;

/** Output faster than this is a runaway (`yes`, an error loop), not a log. */
export const JOB_FLOOD_BYTES_PER_SECOND = 64 * 1024 * 1024;

/** A byte that can sit inside a credential: the redactor's patterns are
 *  runs of these, so a cut between two of them can split a secret. */
function tokenByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2b || byte === 0x2d || byte === 0x2e || byte === 0x2f || // + - . /
    byte === 0x3d || byte === 0x5f || byte === 0x7e || // = _ ~
    byte >= 0x80 // inside a multi-byte character: never a place to cut
  );
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Where a read of `buffer[0, length)` may end without splitting a secret.
 *
 *  `final`: nothing more will ever follow (the job ended and this is the end
 *  of its log), so everything goes.  Otherwise the read ends after the last
 *  line break in it — the redactor's header and key-value patterns run to
 *  the end of a line, so a whole line is the unit that redacts right.  A
 *  window with no line break at all (one 16 KB line) ends at the last byte
 *  that cannot be part of a token, so no token is split; only a window that
 *  is one unbroken token is cut where it stands.  A private key whose END
 *  marker is not in the window is left for the next read whole.
 *
 *  `full`: the window was filled, so more is waiting — the read must move
 *  forward.  A window that is not full ends at the job's latest byte; its
 *  unfinished last line waits (`0` when nothing whole is there yet). */
export function safeReadEnd(buffer: Buffer, length: number, final: boolean, full: boolean): number {
  if (final || length === 0) return length;
  let end = 0;
  for (let i = length - 1; i >= 0; i -= 1) {
    const byte = buffer[i]!;
    if (byte === 0x0a || byte === 0x0d) {
      end = i + 1;
      break;
    }
  }
  if (end === 0 && full) {
    for (let i = length - 1; i > 0; i -= 1) {
      if (!tokenByte(buffer[i]!)) {
        end = i + 1;
        break;
      }
    }
    if (end === 0) end = length;
  }
  if (end === 0) return 0;
  // A private key cut before its END marker would leave its body bare in the
  // next read (the PEM pattern anchors on BEGIN).  Hold the block back, from
  // the start of the BEGIN line — also when that is the start of this very
  // read, which is where the hold-back of an earlier read leaves it.
  const text = buffer.subarray(0, end).toString("latin1");
  let lastBegin = -1;
  for (const match of text.matchAll(PEM_BEGIN)) lastBegin = match.index;
  if (lastBegin >= 0 && !PEM_END.test(text.slice(lastBegin))) {
    const lineStart = text.lastIndexOf("\n", lastBegin) + 1;
    if (lineStart > 0) return lineStart;
    // The key opens the window.  More is waiting only when the window is
    // full, and then the key is longer than any real one: the read has to
    // move on (the next read finds itself inside a key, see `startsInsideKey`).
    // Otherwise the rest has not been printed yet: wait for it.
    if (!full) return 0;
  }
  return end;
}

/** How far back from a read's start to look for the BEGIN marker of a private
 *  key the read opens inside.  Real keys are a few KB; one that is longer
 *  than this is not a key worth the extra read. */
const PEM_LOOKBACK_BYTES = 32 * 1024;

/** Whether the log's bytes just before logical offset `at` leave a private
 *  key open: a BEGIN marker with no END after it.  A read that starts there
 *  has the key's body with no marker to anchor the redactor on.  `fd` reads
 *  the log file, whose first byte is logical offset `dropped`. */
function startsInsideKey(fd: number, dropped: number, at: number): boolean {
  const base = Math.max(dropped, at - PEM_LOOKBACK_BYTES);
  const span = at - base;
  if (span <= 0) return false;
  const buffer = Buffer.alloc(span);
  const read = readSync(fd, buffer, 0, span, base - dropped);
  const text = buffer.subarray(0, read).toString("latin1");
  let lastBegin = -1;
  for (const match of text.matchAll(PEM_BEGIN)) lastBegin = match.index;
  return lastBegin >= 0 && !PEM_END.test(text.slice(lastBegin));
}

/** A read that opens inside a private key: what comes before the key's END
 *  marker is key body, and goes; the rest is redacted as any text is. */
function redactInsideKey(raw: string): string {
  if (raw === "") return raw;
  const end = PEM_END.exec(raw);
  return `[private key redacted]\n${end ? redactSecretsInText(raw.slice(end.index)) : ""}`;
}

/** Where a read that starts somewhere arbitrary (the owner's "newest 64 KB",
 *  or the front of a log the cap trimmed) may start without opening inside a
 *  secret: just after the first line break in its first 4 KB, when there is
 *  one. */
function safeReadStart(buffer: Buffer, length: number): number {
  const limit = Math.min(length, 4096);
  for (let i = 0; i < limit; i += 1) {
    const byte = buffer[i]!;
    if (byte === 0x0a || byte === 0x0d) return i + 1;
  }
  return 0;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The signal a shell exit status above 128 stands for, if it is one. */
function signalForStatus(status: number): string | null {
  if (status <= 128) return null;
  const number = status - 128;
  for (const [name, value] of Object.entries(osConstants.signals)) if (value === number) return name;
  return null;
}

/** Cut a buffer back to the last whole UTF-8 character, so a chunk boundary
 *  never prints a replacement character.  Returns the usable length. */
function utf8Boundary(buffer: Buffer, length: number): number {
  let end = length;
  // walk back over at most three continuation bytes to the lead byte
  let back = 0;
  while (end - back - 1 >= 0 && back < 3 && (buffer[end - back - 1]! & 0xc0) === 0x80) back += 1;
  const leadIndex = end - back - 1;
  if (leadIndex < 0) return end;
  const lead = buffer[leadIndex]!;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (width > back + 1) end = leadIndex;
  return end;
}

export class JobRegistry {
  private readonly records = new Map<string, JobRecord>();
  private readonly deps: JobRegistryDeps;
  private readonly now: () => number;
  private readonly probe: HostProbe;
  private readonly spawnJob: (spec: JobSpawnSpec) => JobSpawnResult;
  private readonly listProcesses: JobProcessLister;
  private readonly leaderStartedNear: (pid: number, at: number) => Promise<boolean>;
  private readonly platform: NodeJS.Platform;
  private readonly graceMs: number;
  private readonly tickMs: number;
  private readonly logMaxBytes: number;
  private readonly recordMax: number;
  private readonly finishedLogBudgetBytes: number;
  private readonly finishedMaxAgeMs: number;
  private readonly awakeNow: () => number;
  private readonly maxTickCreditMs: number;
  private readonly floodBytesPerSecond: number;
  private readonly frameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly endWaiters = new Map<string, Set<() => void>>();
  /** Kills in flight, so a second Stop joins the first. */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Records read from `jobs.json` at construction that `adopt()` has not
   *  settled yet.  Loaded at construction, not in `adopt()`, so a job that
   *  starts before boot finishes (a routine or a resource trigger can) is
   *  saved beside them rather than over them — and adopt settles only these. */
  private readonly adoptable = new Set<string>();
  /** Each running job's logical log size at the last log check. */
  private readonly lastLogEnd = new Map<string, number>();
  /** Ids of jobs whose records were deleted with their conversation: the
   *  sweep still stops anything that carries one. */
  private readonly forgotten = new Set<string>();
  private lastTick: number;
  private lastLogCheck: number;
  /** When finished records were last checked for a deleted thread or bot. */
  private lastForgetCheck = Number.NEGATIVE_INFINITY;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private exitHook: (() => void) | null = null;

  constructor(deps: JobRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.awakeNow = deps.awakeNow ?? (() => performance.now());
    this.probe = deps.probe ?? createHostProbe();
    this.spawnJob = deps.spawn ?? spawnJobProcess;
    this.listProcesses = deps.listProcesses ?? createJobProcessLister();
    this.leaderStartedNear = deps.leaderStartedNear ?? startedNear;
    this.platform = deps.platform ?? process.platform;
    this.graceMs = deps.graceMs ?? GROUP_KILL_GRACE_MS;
    this.tickMs = deps.tickMs ?? 5_000;
    this.maxTickCreditMs = deps.maxTickCreditMs ?? 60_000;
    this.logMaxBytes = deps.logMaxBytes ?? JOB_LOG_MAX_BYTES;
    this.floodBytesPerSecond = deps.floodBytesPerSecond ?? JOB_FLOOD_BYTES_PER_SECOND;
    this.recordMax = deps.recordMax ?? JOB_RECORD_MAX;
    this.finishedLogBudgetBytes = deps.finishedLogBudgetBytes ?? JOB_FINISHED_LOG_BUDGET_BYTES;
    this.finishedMaxAgeMs = deps.finishedMaxAgeMs ?? JOB_FINISHED_MAX_AGE_MS;
    this.lastTick = this.awakeNow();
    this.lastLogCheck = this.awakeNow();
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  /** Read `jobs.json` into memory.  Settling what an earlier run left
   *  running is `adopt()`'s, at the end of boot. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(join(this.deps.dir, "jobs.json"), "utf8");
    } catch {
      return; // no history yet
    }
    let parsed: ReturnType<typeof RecordFile.safeParse>;
    try {
      parsed = RecordFile.safeParse(JSON.parse(raw));
    } catch {
      parsed = RecordFile.safeParse(null);
    }
    if (!parsed.success) {
      this.deps.log?.("[jobs] jobs.json did not parse; starting with no job history");
      return;
    }
    for (const record of parsed.data) {
      this.records.set(record.id, {
        ...record,
        logPath: join(this.deps.dir, `${record.id}.log`),
        exitPath: join(this.deps.dir, `${record.id}.exit`),
      });
      this.adoptable.add(record.id);
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────

  get(id: string): JobSnapshot | null {
    const record = this.records.get(id);
    return record ? this.snapshot(record) : null;
  }

  /** Every job, or one bot's or one thread's, in display order. */
  list(filter: { botId?: string; threadId?: string } = {}): JobSnapshot[] {
    return sortJobsForDisplay(
      [...this.records.values()].filter(
        (record) =>
          (filter.botId === undefined || record.botId === filter.botId) &&
          (filter.threadId === undefined || record.threadId === filter.threadId),
      ),
    ).map((record) => this.snapshot(record));
  }

  /** What one thread's frame carries: every running job, and its newest
   *  finished ones. */
  frameJobs(threadId: string): JobSnapshot[] {
    const all = this.list({ threadId });
    const active = all.filter(isJobActive);
    const finished = all.filter((job) => !isJobActive(job)).slice(0, FRAME_FINISHED_LIMIT);
    return [...active, ...finished];
  }

  /** Threads that hold any job, for a client that just connected. */
  threads(): string[] {
    return [...new Set([...this.records.values()].map((record) => record.threadId))];
  }

  running(filter: { botId?: string; threadId?: string } = {}): JobSnapshot[] {
    return this.list(filter).filter(isJobActive);
  }

  // ── start ─────────────────────────────────────────────────────────────

  /** Why a job may not start for this bot on this thread right now, or null
   *  when it may: the platform, the switch, the caps, and admission — every
   *  refusal that does not depend on the command.  The tool host asks this
   *  BEFORE it shows an approval card, so nobody is asked to approve a job
   *  that could never start; `start()` asks it again, because the answer can
   *  change while a card waits. */
  refusal(request: Pick<JobStartRequest, "botId" | "threadId">): string | null {
    if (this.platform === "win32") {
      return "Background jobs are not available on Windows yet: BotFleet cannot reliably stop every process a job starts there.  Run short commands with bash instead.";
    }
    const settings = this.deps.settings();
    if (!settings.enabled) return "Background jobs are turned off in BotFleet's settings.";
    const active = [...this.records.values()].filter(isJobActive);
    if (active.filter((record) => record.threadId === request.threadId).length >= JOB_CAP_PER_THREAD) {
      return `This conversation already has ${JOB_CAP_PER_THREAD} jobs running, the most it may.  Wait for one to finish, or stop one with job_kill.`;
    }
    if (active.filter((record) => record.botId === request.botId).length >= JOB_CAP_PER_BOT) {
      return `You already have ${JOB_CAP_PER_BOT} jobs running, the most a bot may.  Wait for one to finish, or stop one with job_kill.`;
    }
    if (active.length >= JOB_CAP_PER_HOST) {
      return `This computer already runs ${JOB_CAP_PER_HOST} background jobs, the most BotFleet allows.  Try again when one finishes.`;
    }
    return admissionRefusal(this.probe, settings.admission, this.deps.dataDir, this.deps.spendBlocked());
  }

  start(request: JobStartRequest): JobStartResult {
    const settings = this.deps.settings();
    const refused = this.refusal(request);
    if (refused) return { ok: false, error: refused };
    const command = request.command.trim();
    if (!command) return { ok: false, error: "command must be a non-empty string" };
    if (command.length > 16_000) return { ok: false, error: "command is too long (16,000 characters at most)." };
    if (!existsSync(request.cwd)) return { ok: false, error: `The working folder ${request.cwd} does not exist.` };

    let minutes = settings.defaultMinutes;
    let note: string | undefined;
    if (request.timeoutMinutes !== undefined && Number.isFinite(request.timeoutMinutes) && request.timeoutMinutes > 0) {
      minutes = Math.ceil(request.timeoutMinutes);
      if (minutes > settings.maxMinutes) {
        note = `The run limit was lowered to ${settings.maxMinutes} minutes, the most allowed.`;
        minutes = settings.maxMinutes;
      }
    }

    const now = this.now();
    const id = newJobId(now);
    const record: JobRecord = {
      id,
      botId: request.botId,
      threadId: request.threadId,
      turnId: request.turnId,
      origin: "botfleet",
      kind: "shell",
      label: commandLabel(command),
      cwd: request.cwd,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: now,
      endedAt: null,
      timeoutMs: minutes * 60_000,
      onComplete: request.onComplete,
      notice: "none",
      pid: null,
      spawnedAt: now,
      leaderExited: false,
      logPath: join(this.deps.dir, `${id}.log`),
      exitPath: join(this.deps.dir, `${id}.exit`),
      modelCursor: 0,
      ownerCursor: 0,
      droppedBytes: 0,
      awakeMs: 0,
      announced: false,
    };
    // Recorded BEFORE the spawn: the sweep only ever stops a process whose
    // id names a record here, so the record has to exist the moment a
    // process carrying that id can.
    this.records.set(id, record);
    this.prune();
    this.save();

    const spawned = this.spawnJob({
      command,
      cwd: request.cwd,
      env: { ...modelShellEnv(), BOTFLEET_JOB_ID: id },
      logPath: record.logPath,
      exitPath: record.exitPath,
      cpuSeconds: minutes * 60 * settings.cpuCores,
    });
    if (!spawned.ok) {
      this.records.delete(id);
      this.removeFiles(record);
      this.save();
      return { ok: false, error: spawned.error };
    }
    record.pid = spawned.pid;
    record.spawnedAt = this.now();
    spawned.child.on("exit", (code, signal) => this.onLeaderExit(id, code, signal));
    // A spawn that fails after the pid was assigned reports here; the exit
    // event still follows and settles the job.
    spawned.child.on("error", () => undefined);
    this.save();
    this.changed(record.threadId);
    return note ? { ok: true, job: this.snapshot(record), note } : { ok: true, job: this.snapshot(record) };
  }

  // ── output ────────────────────────────────────────────────────────────

  /** The model's next slice of new output: at most `maxBytes`, redacted,
   *  advancing the model's own cursor. */
  readForModel(id: string, maxBytes: number): JobOutputChunk | null {
    const record = this.records.get(id);
    if (!record) return null;
    const chunk = this.readLog(record, record.modelCursor, maxBytes);
    record.modelCursor = chunk.to;
    return {
      text: chunk.text,
      remaining: chunk.full ? chunk.end - chunk.to : 0,
      dropped: chunk.dropped,
      held: chunk.full ? 0 : chunk.end - chunk.to,
    };
  }

  /** What the owner's View Output shows: from `since`, or the newest `limit`
   *  bytes when no offset is given.  Read-only apart from the owner cursor. */
  readForOwner(id: string, options: { since?: number; limit: number }): OwnerOutput | null {
    const record = this.records.get(id);
    if (!record) return null;
    const end = this.logicalEnd(record);
    const from = options.since === undefined ? Math.max(record.droppedBytes, end - options.limit) : options.since;
    // "The newest N bytes" starts wherever N lands, which can be inside a
    // line, and so inside a secret: start at the next line instead.
    const chunk = this.readLog(record, from, options.limit, options.since === undefined && from > record.droppedBytes);
    record.ownerCursor = Math.max(record.ownerCursor, chunk.to);
    return { text: chunk.text, from: chunk.from, to: chunk.to, end: chunk.end, dropped: record.droppedBytes };
  }

  /** Resolves when the job is no longer running, `ms` passes, or `signal`
   *  aborts — whichever is first. */
  waitForEnd(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    const record = this.records.get(id);
    if (!record || !isJobActive(record) || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.endWaiters.get(id) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      this.endWaiters.set(id, waiters);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private logicalEnd(record: JobRecord): number {
    try {
      return record.droppedBytes + statSync(record.logPath).size;
    } catch {
      return record.droppedBytes;
    }
  }

  /** Read `[logicalFrom, +maxBytes)` of a job's log, redacted.  The read
   *  ends where no secret can be split (safeReadEnd); `alignStart` also
   *  moves an arbitrary start to the next line.  `full`: more than this one
   *  read's worth was waiting. */
  private readLog(record: JobRecord, logicalFrom: number, maxBytes: number, alignStart = false) {
    const dropped = Math.max(0, record.droppedBytes - logicalFrom);
    // The cap cut the front of the log since this reader's cursor: whatever
    // is first on disk now may be the back half of a line, so align it.
    const trimmed = logicalFrom < record.droppedBytes;
    const from = Math.max(logicalFrom, record.droppedBytes);
    const end = this.logicalEnd(record);
    const want = Math.max(0, Math.min(maxBytes, end - from));
    if (want === 0) return { text: "", from, to: from, end, dropped, full: false };
    const full = end - from > maxBytes;
    let fd: number | null = null;
    try {
      fd = openSync(record.logPath, "r");
      const buffer = Buffer.alloc(want);
      const read = readSync(fd, buffer, 0, want, from - record.droppedBytes);
      const start = alignStart || trimmed ? safeReadStart(buffer, read) : 0;
      const body = buffer.subarray(start, read);
      // Everything the job will ever print is here: nothing to hold back.
      const final = !isJobActive(record) && from + read >= end;
      // then never split a character, a line, or a token
      const cut = safeReadEnd(body, body.length, final, full);
      const usable = final ? cut : utf8Boundary(body, cut);
      const raw = body.subarray(0, usable).toString("utf8");
      // A private key printed in more than one write, or longer than a
      // window, leaves the next read opening inside it.  Redaction anchors
      // on the BEGIN marker, so that read has to be told.
      const text = startsInsideKey(fd, record.droppedBytes, from + start) ? redactInsideKey(raw) : redactSecretsInText(raw);
      return { text, from, to: from + start + usable, end, dropped, full };
    } catch {
      return { text: "", from, to: from, end, dropped, full: false };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  // ── stop ──────────────────────────────────────────────────────────────

  /** Stop a running job: SIGTERM to its group, SIGKILL after the grace.
   *  Resolves once it is settled.  `model` suppresses the notice; `owner`
   *  and `system` tell the bot without waking it; `timeout` wakes it. */
  async kill(id: string, by: JobKilledBy, reason?: string): Promise<{ ok: boolean; job: JobSnapshot | null; error?: string }> {
    const record = this.records.get(id);
    if (!record) return { ok: false, job: null, error: "no such job" };
    const inFlight = this.stopping.get(id);
    if (inFlight) {
      await inFlight;
      return { ok: true, job: this.snapshot(record) };
    }
    if (!isJobActive(record)) return { ok: false, job: this.snapshot(record), error: "the job already ended" };
    record.status = "stopping";
    record.killedBy = by;
    if (reason) record.reason = reason;
    // The bot's own kill needs no notice; a limit it ran into (time, output)
    // is news it must act on, so it may wake; anyone else's Stop is told on
    // the bot's next turn without waking it.
    record.onComplete = by === "model" ? "none" : by === "timeout" || by === "limit" ? record.onComplete : "notice";
    this.save();
    this.changed(record.threadId);
    const stop = (async () => {
      if (record.pid !== null) {
        await killGroup(record.pid, this.graceMs, () => this.stillOurs(record));
      }
      if (record.status === "stopping") this.finish(record, "killed");
    })();
    this.stopping.set(id, stop);
    try {
      await stop;
    } finally {
      this.stopping.delete(id);
    }
    return { ok: true, job: this.snapshot(record) };
  }

  /** Stop every running job matching `match` (a deleted thread or bot, a
   *  revoked grant).  The bot is told on its next turn, never woken.
   *  `forget`: the jobs' conversation or bot is gone, so once each has
   *  stopped its record and its log are deleted — finished ones included —
   *  the way deleting a conversation deletes its transcript.  Resolves with
   *  how many were running. */
  async killWhere(match: (job: JobSnapshot) => boolean, reason: string, options: { forget?: boolean } = {}): Promise<number> {
    const targets = [...this.records.values()].filter((record) => match(this.snapshot(record)));
    const running = targets.filter(isJobActive);
    await Promise.all(running.map((record) => this.kill(record.id, "system", reason)));
    if (options.forget) this.forget(targets.map((record) => record.id));
    return running.length;
  }

  /** Delete finished jobs' records and files.  A job still running keeps
   *  its record: the sweep needs it to know the job's processes are ours. */
  private forget(ids: readonly string[]): void {
    const threads = new Set<string>();
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || isJobActive(record)) continue;
      this.drop(record);
      threads.add(record.threadId);
    }
    if (threads.size === 0) return;
    this.save();
    for (const threadId of threads) this.changed(threadId);
  }

  /** Whether the group a record names is still the one this job started.
   *  Once the leader has exited, a live process holding its pid means the
   *  group ended and the number now belongs to someone else. */
  private stillOurs(record: JobRecord): boolean {
    if (record.pid === null || !groupAlive(record.pid)) return false;
    return !(record.leaderExited && pidAlive(record.pid));
  }

  // ── settle ────────────────────────────────────────────────────────────

  private onLeaderExit(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const record = this.records.get(id);
    if (!record || !isJobActive(record)) return;
    record.leaderExited = true;
    const written = readExitFile(record.exitPath);
    const status = written ?? code;
    if (status !== null) {
      record.exitCode = status;
      record.signal = signalForStatus(status);
    } else {
      record.signal = signal;
    }
    // A kill in flight settles when the whole group is gone, not when the
    // wrapper shell dies to its SIGTERM.
    if (record.status === "stopping") {
      this.save();
      return;
    }
    if (record.signal === "SIGXCPU") record.reason = "CPU limit reached";
    this.finish(record, status === 0 ? "completed" : "failed");
    // Something the command started (`cmd &`) may outlive it.  The job is
    // over, so it goes too — nothing would ever report on it.
    if (record.pid !== null && this.stillOurs(record)) {
      record.reason = record.reason ?? "processes it left running were stopped";
      void killGroup(record.pid, this.graceMs, () => this.stillOurs(record));
    }
  }

  private finish(record: JobRecord, status: "completed" | "failed" | "killed" | "lost", boot = false): void {
    record.status = status;
    record.endedAt = this.now();
    record.notice = record.onComplete === "none" ? "none" : "pending";
    this.prune();
    this.changed(record.threadId);
    for (const waiter of this.endWaiters.get(record.id) ?? []) waiter();
    this.endWaiters.delete(record.id);
    this.announce(record, boot);
  }

  /** Hand a finished job to the hook: its notice, and whether its row and a
   *  wake are still owed.  Marks the row shown and saves. */
  private announce(record: JobRecord, boot: boolean): void {
    const snapshot = this.snapshot(record);
    const row = !record.announced;
    record.announced = true;
    this.save();
    try {
      this.deps.onFinished?.(snapshot, record.notice === "pending" ? noticeLine(snapshot) : null, { row, boot });
    } catch (error) {
      this.deps.log?.(`[jobs] finish hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The bot was told; it is never told again. */
  markNoticesDelivered(ids: readonly string[]): void {
    let dirty = false;
    for (const id of ids) {
      const record = this.records.get(id);
      if (record && record.notice === "pending") {
        record.notice = "delivered";
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  // ── periodic work ─────────────────────────────────────────────────────

  /** Credit awake time, stop jobs past their limit or without a grant, and
   *  hold logs to their cap.  The credit is the awake clock's advance (it
   *  does not run while the Mac sleeps), capped at `maxTickCreditMs` in case
   *  it ever does: a late tick on a loaded Mac still credits every awake
   *  second, and a sleep never expires a job. */
  tick(): void {
    const awake = this.awakeNow();
    const credit = Math.max(0, Math.min(awake - this.lastTick, this.maxTickCreditMs));
    this.lastTick = awake;
    // Finished records (up to 500) are checked once a minute, not every tick.
    const checkFinished = awake - this.lastForgetCheck >= FORGET_CHECK_MS;
    if (checkFinished) {
      this.lastForgetCheck = awake;
      if (this.prune() > 0) this.save();
    }
    for (const record of this.records.values()) {
      if (this.adoptable.has(record.id)) continue; // adopt() settles these
      if (record.status !== "running") {
        // A finished job whose conversation or bot is gone, deleted by a
        // route that did not stop its jobs itself: drop its output too.
        if (checkFinished && !isJobActive(record) && this.deps.stopReason?.(this.snapshot(record))?.forget) this.forget([record.id]);
        continue;
      }
      record.awakeMs += credit;
      this.capLog(record);
      const stop = this.deps.stopReason?.(this.snapshot(record)) ?? null;
      if (stop) {
        const id = record.id;
        void this.kill(id, "system", stop.reason).then(() => {
          if (stop.forget) this.forget([id]);
        });
        continue;
      }
      if (record.awakeMs >= record.timeoutMs) {
        void this.kill(record.id, "timeout", `it ran past its ${Math.round(record.timeoutMs / 60_000)}-minute limit`);
      }
    }
  }

  /** Twice a second while jobs run: hold every running job's log to its cap,
   *  and stop one printing faster than any log is read.  Between two 5 s
   *  ticks a runaway (`yes`, an error loop) can write gigabytes. */
  checkLogs(): void {
    const awake = this.awakeNow();
    const seconds = Math.max(0.001, (awake - this.lastLogCheck) / 1000);
    this.lastLogCheck = awake;
    for (const record of this.records.values()) {
      if (record.status !== "running" || this.adoptable.has(record.id)) {
        this.lastLogEnd.delete(record.id);
        continue;
      }
      const end = this.logicalEnd(record);
      const before = this.lastLogEnd.get(record.id);
      this.lastLogEnd.set(record.id, end);
      const grew = before === undefined ? 0 : end - before;
      if (grew > this.logMaxBytes && grew / seconds > this.floodBytesPerSecond) {
        const mib = Math.round(this.floodBytesPerSecond / (1024 * 1024));
        void this.kill(record.id, "limit", `it printed more than ${mib} MiB of output a second`);
      }
      this.capLog(record);
    }
  }

  /** Keep the newest half of a log that passed the cap.  The job writes with
   *  O_APPEND, so its next write lands after what is kept.
   *
   *  The job keeps writing while this runs, so the steps are back to back
   *  and the size is read twice: what the job appended between the read of
   *  the tail and the truncate cannot be kept, and is counted as dropped, so
   *  the next reader is told there is a gap.  (What it appends in the instant
   *  between the truncate and the rewrite is overwritten, and cannot be
   *  measured; that window is two adjacent system calls.) */
  private capLog(record: JobRecord): void {
    let size: number;
    try {
      size = statSync(record.logPath).size;
    } catch {
      return;
    }
    if (size <= this.logMaxBytes) return;
    const keep = Math.floor(this.logMaxBytes / 2);
    let fd: number | null = null;
    try {
      fd = openSync(record.logPath, "r+");
      const tail = Buffer.alloc(keep);
      const at = fstatSync(fd).size;
      const read = readSync(fd, tail, 0, keep, at - keep);
      const cutAt = fstatSync(fd).size;
      ftruncateSync(fd, 0);
      writeSync(fd, tail, 0, read, 0);
      record.droppedBytes += cutAt - read;
    } catch (error) {
      this.deps.log?.(`[jobs] could not cap ${record.id}'s log: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /** Whether a stray could exist: a job of ours that ended within a day, or
   *  one deleted since this run began.  Older finished jobs have had two
   *  hundred sweeps to be cleaned up after. */
  private mayHaveStrays(): boolean {
    if (this.forgotten.size > 0) return true;
    const since = this.now() - SWEEP_RELEVANT_MS;
    for (const record of this.records.values()) {
      if (!isJobActive(record) && (record.endedAt ?? record.startedAt) >= since) return true;
    }
    return false;
  }

  /** Stop every process still carrying the id of a job of ours that is
   *  over.  Resolves with how many it stopped. */
  async sweep(): Promise<number> {
    // Listing every process's environment is the expensive part, and there
    // is nothing to find unless a job of ours ended lately (or was deleted).
    if (!this.mayHaveStrays()) return 0;
    const found = await this.listProcesses();
    const strays = found.filter((proc) => {
      if (proc.pid === process.pid) return false;
      const record = this.records.get(proc.jobId);
      return record !== undefined ? !isJobActive(record) : this.forgotten.has(proc.jobId);
    });
    if (strays.length === 0) return 0;
    const jobs = [...new Set(strays.map((proc) => proc.jobId))];
    this.deps.log?.(`[jobs] stopping ${strays.length} stray process(es) of ${jobs.length} finished job(s): ${jobs.join(", ")}`);
    for (const proc of strays) {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.graceMs, 5_000)));
    for (const proc of strays) {
      if (!pidAlive(proc.pid)) continue;
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return strays.length;
  }

  /** Start the tick and the sweep, and stop every job if the process exits. */
  startTimers(sweepMs: number = this.deps.sweepMs ?? 5 * 60_000): void {
    this.lastTick = this.awakeNow();
    this.lastLogCheck = this.awakeNow();
    this.tickTimer ??= setInterval(() => this.tick(), this.tickMs);
    this.tickTimer.unref?.();
    // One stat per running job; nothing at all while none runs.
    this.logTimer ??= setInterval(() => {
      if (this.records.size > 0 && [...this.records.values()].some((record) => record.status === "running")) this.checkLogs();
    }, this.deps.logCheckMs ?? 500);
    this.logTimer.unref?.();
    this.sweepTimer ??= setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, sweepMs);
    this.sweepTimer.unref?.();
    if (!this.exitHook) {
      this.exitHook = () => this.shutdownSync();
      process.on("exit", this.exitHook);
    }
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.tickTimer = null;
    this.logTimer = null;
    this.sweepTimer = null;
    if (this.exitHook) process.off("exit", this.exitHook);
    this.exitHook = null;
    for (const timer of this.frameTimers.values()) clearTimeout(timer);
    this.frameTimers.clear();
  }

  // ── restart ───────────────────────────────────────────────────────────

  /** Stop every running job and mark it lost: the harness is shutting down
   *  (`reason` says so), or a forced update is about to restart it.  Not the
   *  updater's ordinary quiesce, which can still be rolled back — a job
   *  killed for a restart that never came would be work lost for nothing. */
  async quiesce(reason = JOB_STOPPED_REASON): Promise<number> {
    const active = [...this.records.values()].filter(isJobActive);
    await Promise.all(
      active.map(async (record) => {
        record.status = "stopping";
        record.killedBy = "system";
        record.reason = reason;
        if (record.pid !== null) await killGroup(record.pid, this.graceMs, () => this.stillOurs(record));
        record.onComplete = "notice";
        this.finish(record, "lost");
      }),
    );
    return active.length;
  }

  /** The process is exiting: there is no time for a grace period, so every
   *  running job's group is SIGKILLed now and the job marked lost on disk. */
  shutdownSync(): void {
    let dirty = false;
    for (const record of this.records.values()) {
      if (!isJobActive(record)) continue;
      if (record.pid !== null && this.stillOurs(record)) signalGroup(record.pid, "SIGKILL");
      record.status = "lost";
      record.killedBy = "system";
      record.reason = JOB_STOPPED_REASON;
      record.endedAt = this.now();
      record.onComplete = "notice";
      record.notice = "pending";
      dirty = true;
    }
    if (dirty) this.save();
  }

  /** Settle every job an earlier run left running (the records `load()`
   *  read at construction).  Wakes nobody: a settled job's notice waits for
   *  the bot's next turn. */
  async adopt(): Promise<{ settled: number; lost: number }> {
    const loaded = [...this.adoptable].map((id) => this.records.get(id)).filter((record) => record !== undefined);
    this.adoptable.clear();
    let settled = 0;
    let lost = 0;
    let leaderless = false;
    for (const record of loaded) {
      // Nothing at boot wakes a bot: whatever ends up announced is a notice
      // for the bot's next turn.
      record.onComplete = record.onComplete === "none" ? "none" : "notice";
      if (!isJobActive(record)) {
        // An earlier run marked it ended (a shutdown, or a notice it never
        // delivered): announce it again, with the row if it never got one.
        if (record.notice === "pending") this.announce(record, true);
        continue;
      }
      const code = readExitFile(record.exitPath);
      if (code !== null) {
        record.exitCode = code;
        record.signal = signalForStatus(code);
        record.leaderExited = true;
        this.finish(record, code === 0 ? "completed" : "failed", true);
        settled += 1;
        continue;
      }
      if (record.pid !== null && groupAlive(record.pid)) {
        if (pidAlive(record.pid)) {
          // The leader's pid is held: it is ours only if that very shell
          // still holds it, which its start time proves.
          if (!record.leaderExited && (await this.leaderStartedNear(record.pid, record.spawnedAt))) {
            await killGroup(record.pid, this.graceMs, () => this.stillOurs(record));
          }
        } else {
          // A live group with no leader proves nothing: after a reboot, or
          // once our group ended, the number can be anybody's group whose
          // leader exited.  Never signal it by number.  The job's own
          // processes carry its id, and the sweep below stops exactly those.
          leaderless = true;
        }
      }
      record.killedBy = "system";
      record.reason = "BotFleet restarted";
      this.finish(record, "lost", true);
      lost += 1;
    }
    this.prune();
    this.save();
    if (settled + lost > 0) this.deps.log?.(`[jobs] boot: ${settled} job(s) settled from their exit files, ${lost} marked lost`);
    // Not awaited: listing every process's environment can take seconds on
    // a loaded Mac, and boot must not wait on it.
    if (leaderless) void this.sweep().catch(() => undefined);
    return { settled, lost };
  }

  // ── bookkeeping ───────────────────────────────────────────────────────

  private snapshot(record: JobRecord): JobSnapshot {
    const snapshot: JobSnapshot = {
      id: record.id,
      botId: record.botId,
      threadId: record.threadId,
      origin: record.origin,
      kind: record.kind,
      label: redactSecretsInText(record.label),
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      timeoutMs: record.timeoutMs,
      onComplete: record.onComplete,
      notice: record.notice,
    };
    if (record.turnId) snapshot.turnId = record.turnId;
    if (record.killedBy) snapshot.killedBy = record.killedBy;
    if (record.reason) snapshot.reason = record.reason;
    return snapshot;
  }

  /** Finished records are held to three limits, oldest first: how many
   *  (the record cap), how old (a week), and how much disk their logs take
   *  between them.  A running job is never dropped.  Resolves with how many
   *  went. */
  private prune(): number {
    const finished = [...this.records.values()]
      .filter((record) => !isJobActive(record))
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    let dropped = 0;
    const cutoff = this.now() - this.finishedMaxAgeMs;
    while (finished.length > 0 && (this.records.size > this.recordMax || (finished[0]!.endedAt ?? finished[0]!.startedAt) < cutoff)) {
      this.drop(finished.shift()!);
      dropped += 1;
    }
    // Every log is held to the cap while its job runs, so a handful of
    // finished ones cannot reach the budget: stat them only when they could.
    if (finished.length * this.logMaxBytes > this.finishedLogBudgetBytes) {
      const sizes = new Map<string, number>();
      let total = 0;
      for (const record of finished) {
        let size = 0;
        try {
          size = statSync(record.logPath).size;
        } catch {
          /* never written, or already gone */
        }
        sizes.set(record.id, size);
        total += size;
      }
      while (finished.length > 0 && total > this.finishedLogBudgetBytes) {
        const oldest = finished.shift()!;
        total -= sizes.get(oldest.id) ?? 0;
        this.drop(oldest);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Delete a finished job's record and files.  Anything it started that
   *  outlives it is still ours to sweep, so its id is remembered. */
  private drop(record: JobRecord): void {
    this.records.delete(record.id);
    this.adoptable.delete(record.id);
    this.lastLogEnd.delete(record.id);
    this.removeFiles(record);
    // Only a job that ended lately can have strays the sweep still looks for
    // (mayHaveStrays); remembering a week-old one would switch the sweep's
    // process listing back on for the rest of this run.
    if ((record.endedAt ?? record.startedAt) >= this.now() - SWEEP_RELEVANT_MS) {
      this.forgotten.add(record.id);
      if (this.forgotten.size > JOB_RECORD_MAX) this.forgotten.delete(this.forgotten.values().next().value!);
    }
  }

  private removeFiles(record: JobRecord): void {
    for (const path of [record.logPath, record.exitPath, `${record.exitPath}.tmp`]) {
      try {
        unlinkSync(path);
      } catch {
        /* never written, or already gone */
      }
    }
  }

  private save(): void {
    const records = [...this.records.values()].map((record) => {
      // file paths are derived from the id on load; never persisted
      const { logPath: _log, exitPath: _exit, ...stored } = record;
      void _log;
      void _exit;
      return stored;
    });
    try {
      writeFileAtomic(join(this.deps.dir, "jobs.json"), JSON.stringify(records), { mode: 0o600 });
    } catch (error) {
      this.deps.log?.(`[jobs] could not save jobs.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Debounced: one frame per thread per 250 ms, carrying the whole set. */
  private changed(threadId: string): void {
    if (this.frameTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.frameTimers.delete(threadId);
      this.deps.broadcast({ kind: "jobs", threadId, jobs: this.frameJobs(threadId) });
    }, this.deps.frameDebounceMs ?? 250);
    timer.unref?.();
    this.frameTimers.set(threadId, timer);
  }
}

/** The sentence of a notice that sends the bot to a tool.  An engine that has
 *  no job tools reads the notice without it (server/jobs/prompt.ts). */
export const JOB_READ_HINT = "  Read its output with job_output.";

/** The line a bot reads when one of its jobs ended.  Never carries output:
 *  the bot reads that with `job_output`, inside the untrusted-data boundary. */
export function noticeLine(job: JobSnapshot): string {
  const head = `Background job ${job.id} \`${job.label}\``;
  const took = formatJobDuration(jobElapsedMs(job, job.endedAt ?? job.startedAt));
  const read = JOB_READ_HINT;
  switch (job.status) {
    case "completed":
      return `${head} finished: exit code 0 after ${took}.${read}`;
    case "failed":
      if (job.exitCode !== null) {
        const because = job.signal ? ` (${job.signal}${job.reason ? `, ${job.reason}` : ""})` : "";
        return `${head} failed: exit code ${job.exitCode}${because} after ${took}.${read}`;
      }
      return `${head} failed${job.signal ? `: ended by ${job.signal}` : ""} after ${took}.${read}`;
    case "killed":
      if (job.killedBy === "owner") return `${head} was stopped by the owner after ${took}.${read}`;
      if (job.killedBy === "timeout" || job.killedBy === "limit") return `${head} was stopped because ${job.reason ?? "it ran past its limit"}.${read}`;
      if (job.killedBy === "model") return `${head} was stopped by you after ${took}.`;
      return `${head} was stopped${job.reason ? ` because ${job.reason}` : ""} after ${took}.${read}`;
    case "lost":
      return `${head} was lost: ${job.reason ?? "BotFleet restarted"} while it ran.  Start it again if it is still needed.`;
    default:
      return `${head} is ${job.status}.`;
  }
}
