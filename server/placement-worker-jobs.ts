/**
 * Runs a leased placement job through the real job runner (the remainder of
 * transport slice T5, docs/plans/2026-11-03-placement-transport-slices.md).
 *
 * `PlacementWorkerRuntime` takes its process handling as injected
 * dependencies.  This file is the production-shaped set: `spawnJob`,
 * `stopJob`, `watchProcess`, `isProcessAlive` and `readExit`, built on
 * `spawnJobProcess` (server/jobs/runner.ts) and the process-group helpers
 * (server/tools/process-group.ts).  Nothing in production constructs it:
 * server/index.ts passes no worker runtime, and activation is slice T9.
 *
 * What it keeps, and why:
 *
 *   - No `JobRecord`.  The record lives on the controller and the worker
 *     holds a lease (docs/plans/2026-10-29-native-server-mode.md), so a
 *     leased job never enters this host's `JobRegistry`: it is not announced
 *     to a thread, not counted by the registry, and not stopped by the
 *     registry's quiesce on shutdown.  A leased job outlives a worker restart
 *     on purpose, and the restarted worker settles it from its exit file.
 *   - Files under `<dataDir>/placement/jobs`, never `/tmp`.  The job id is an
 *     arbitrary string on the wire, so a file is named by a digest of the job
 *     and lease ids (the report spool's rule).  Both ids are in the lease
 *     record already, so a restarted worker finds the same files without any
 *     new persisted field, and a second lease of one job never reads the
 *     first lease's exit status.
 *   - The environment is exactly `modelShellEnv()` plus `BOTFLEET_JOB_ID`.
 *     The wire carries no bot or thread, so there is no launch identity to
 *     give (see the known gaps below).
 *   - The run limit is enforced here.  The runner only sets the CPU limit.
 *     A timer counts it while this process lives; after a restart what is
 *     left is counted from the recorded spawn, so time the worker was down
 *     counts against the job.
 *   - A lease runs at most once.  A log or an exit file for the lease means
 *     it was started here before, and a second spawn is refused, whatever a
 *     restart did to the worker's memory or its lease records.  A start that
 *     failed ran nothing, so it takes back the empty log it made and the
 *     lease may be tried again.
 *   - A group is signalled only when it is proved the lease's own.  For a
 *     job adopted after a restart the proof is the leader's start time, read
 *     with `ps`.  A start time that was read and does not match is a
 *     stranger holding the pid.  A start time that could not be read proves
 *     nothing either way: the job stays adopted and watched, nothing is
 *     signalled, and a stop or a run limit that fell due is tried again.  The
 *     adopted poll reads the start time again every few polls, so a leader
 *     that ended without an exit file, and whose pid a stranger now holds, is
 *     settled as unobservable and not waited on until the run limit.
 *   - A passive adapter (the read-only rollback build, #1556) refuses to
 *     spawn and never signals a process.  It hands the runtime its
 *     `passiveReason`, and a runtime given it admits no work, pulls no lease
 *     and acknowledges no stop.
 *
 * Known gaps, for whoever composes this (none is hidden by a default):
 *
 *   - A passive worker.  The composer must pass `passiveReason` on to the
 *     runtime, or not start the runtime at all.  A runtime that pulls a
 *     lease for a passive adapter gets the spawn refusal, and that settles
 *     the job as failed on the controller for good: nothing requeues it,
 *     where the registry's passive build holds its queued jobs.  Whether a
 *     rollback build should run the worker runtime at all is slice T9's
 *     decision.
 *   - Launch identity.  A worker-run job gets the scrubbed model shell
 *     environment and no bot seat, because `launchEnv(botId, threadId)` has
 *     nothing to be called with until the wire carries both.
 *   - The running cap.  The runtime's own cap does not count this host's
 *     registry jobs.  The composer must pass a cap, or an admission verdict,
 *     that counts `running()` here together with the registry's jobs against
 *     `JOB_CAP_PER_HOST`.
 *   - Output.  The log is written and never capped or delivered: no worker
 *     intent carries output yet, and the registry's log cap and flood stop
 *     watch registry records only.
 *   - The registry's stray sweep does not cover leased jobs (it matches the
 *     registry's own ids and records).  After a worker restart, processes a
 *     finished job left running are not signalled, because a leaderless group
 *     number proves nothing.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

import { JOB_OWNER_MAX_MINUTES } from "../shared/jobs.ts";
import { readExitFile, spawnJobProcess, type JobSpawnResult, type JobSpawnSpec } from "./jobs/runner.ts";
import type { PlacementWorkerRuntimeDeps, WorkerJobExit, WorkerLocalLeaseRecord } from "./placement-worker-runtime.ts";
import { GROUP_KILL_GRACE_MS, groupAlive, killGroup } from "./tools/process-group.ts";
import { modelShellEnv } from "./tools/shell-env.ts";

/** How long a finished lease's log and exit file are kept: the week the
 *  registry keeps a finished job's (`JOB_FINISHED_MAX_AGE_MS`). */
export const PLACEMENT_JOB_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** No leased job may ask for more than the registry's own hard ceiling. */
const MAX_TIMEOUT_MS = JOB_OWNER_MAX_MINUTES * 60_000;

/** How far a process's start time may sit from the recorded spawn and still
 *  be that spawn's process: `LEADER_START_SLACK_MS` of
 *  server/tools/process-group.ts, which keeps it private. */
const LEADER_START_SLACK_MS = 10_000;

/** How long one synchronous `ps` may hold the worker's event loop.  The call
 *  sits on the restart reconciliation, the adopted poll and every kill check,
 *  and a worker that is blocked cannot answer a heartbeat.  `ps` answers in
 *  milliseconds; one that has not in this long reads as "could not be read",
 *  which keeps the job adopted and tries again, and never signals anyone. */
const PS_TIMEOUT_MS = 500;

/** The longest wait between two tries of a kill that could not go out. */
const OWED_RETRY_MAX_MS = 30_000;

/** An adopted leader's start time is read again every this many polls, to
 *  catch a pid that a stranger took over once the leader ended without an
 *  exit file.  Each read is one synchronous `ps`, so it is not done per poll. */
const ADOPTED_PROOF_EVERY_POLLS = 10;

/** The wrapper writes the exit file just before it exits.  A poll that finds
 *  the file while the leader still lives waits this many polls for the leader
 *  to go, so what the command left running is judged against a leader that is
 *  gone and not one that is only finishing. */
const EXIT_WAIT_POLLS = 3;

const FILE_NAME = /^(job-[0-9a-f]{32})\.(?:log|exit|exit\.tmp)$/;

/** Why a passive adapter runs nothing.  It is the runtime's `passiveReason`
 *  and, for a runtime that pulled a lease anyway, the reason on the failed
 *  report: it must not say the job is held, because that report ends it. */
export const PLACEMENT_JOB_PASSIVE_REFUSAL = "This read-only placement rollback build runs no background jobs.";
const RUN_LIMIT_REASON = "run limit reached";
const CPU_LIMIT_REASON = "CPU limit reached";
const LEFT_RUNNING_REASON = "processes it left running were stopped";

export interface PlacementWorkerJobsDeps {
  /** The worker's data folder.  Job files go under `placement/jobs` in it. */
  dataDir: string;
  /** The `jobs.cpuCores` setting, read at every spawn. */
  cpuCores: () => number;
  /** The read-only rollback build: refuse to spawn, never signal. */
  passive?: boolean;
  /** How long a group gets between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** How often an adopted job's leader is checked. */
  adoptedPollMs?: number;
  /** How long a finished lease's files are kept. */
  fileMaxAgeMs?: number;
  now?: () => number;
  spawn?: (spec: JobSpawnSpec) => JobSpawnResult;
  /** Whether `pid` started within the slack of `at`: true or false when its
   *  start time was read, null when it could not be.  Synchronous, because
   *  the runtime's liveness check is. */
  leaderStartedNear?: (pid: number, at: number) => boolean | null;
}

type RuntimeProcessDeps = Required<Pick<PlacementWorkerRuntimeDeps, "spawnJob" | "stopJob" | "watchProcess" | "isProcessAlive" | "readExit">>
  & Pick<PlacementWorkerRuntimeDeps, "passiveReason">;

/** Where one lease's output and exit status live. */
export interface PlacementJobFiles {
  logPath: string;
  exitPath: string;
}

export interface PlacementWorkerJobs extends RuntimeProcessDeps {
  /** Leased jobs this adapter holds a running slot for. */
  running(): number;
  files(lease: { jobId: string; leaseId: string }): PlacementJobFiles;
}

/** One leased job whose process group this adapter may signal. */
interface LeasedJob {
  jobId: string;
  /** The wrapper shell's pid, which is also the group's id. */
  pid: number;
  stem: string;
  exitPath: string;
  /** The wrapper shell is gone, so its pid may name someone else by now. */
  leaderExited: boolean;
  /** Set for a job adopted after a restart: there is no child handle, so the
   *  leader's start time is what proves the pid is still its. */
  leaderStartedAt?: number;
  /** The earliest the leader's start time is read again (adopted jobs). */
  nextProofAt: number;
  /** Polls spent waiting for a leader that left its exit status and lives. */
  exitWaits: number;
  /** The run limit ended it. */
  timedOut: boolean;
  timer?: NodeJS.Timeout;
  /** The one kill in flight: a stop, the run limit, or leftovers. */
  kill?: Promise<void>;
  /** A kill that fell due and could not go out, because the adopted
   *  leader's start time could not be read.  The adopted poll tries it
   *  again from `nextAt`, a little later each time. */
  owed?: { grace: number; limit: boolean; tries: number; nextAt: number };
}

/** Whether a job's process group is still the one its lease started, or
 *  `unknown` when that could not be established right now. */
type Ownership = "ours" | "gone" | "unknown";

/** Whether a process with this exact pid is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The signal a shell exit status above 128 stands for, if it is one. */
function signalForStatus(status: number): NodeJS.Signals | null {
  if (status <= 128) return null;
  const signals = osConstants.signals;
  let name: keyof typeof signals;
  for (name in signals) if (signals[name] === status - 128) return name;
  return null;
}

/** `startedNear` of server/tools/process-group.ts, synchronously.  Asks for
 *  the start time only, never a command line, and gives `ps` the scrubbed
 *  environment.
 *
 *  `ps` prints the time in its own zone and names no zone.  The scrubbed
 *  environment carries no `TZ`, so left alone `ps` would print in the
 *  system's zone while this process reads in its own, and the two differ
 *  whenever the harness runs with `TZ` set.  `ps` is told UTC and the answer
 *  is read as UTC, which depends on neither.
 *
 *  Null when `ps` gave no start time (it failed, timed out, or printed
 *  nothing readable): that is not an answer, and never proof of a stranger. */
function leaderStartedNearNow(pid: number, at: number): boolean | null {
  try {
    const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...modelShellEnv(), LC_ALL: "C", TZ: "UTC0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PS_TIMEOUT_MS,
    });
    const startedAt = Date.parse(`${stdout.trim()} UTC`);
    if (!Number.isFinite(startedAt)) return null;
    return Math.abs(startedAt - at) <= LEADER_START_SLACK_MS;
  } catch {
    return null;
  }
}

export function createPlacementWorkerJobs(deps: PlacementWorkerJobsDeps): PlacementWorkerJobs {
  const passive = deps.passive === true;
  const directory = join(deps.dataDir, "placement", "jobs");
  const graceMs = deps.graceMs ?? GROUP_KILL_GRACE_MS;
  const adoptedPollMs = deps.adoptedPollMs ?? 1_000;
  const fileMaxAgeMs = deps.fileMaxAgeMs ?? PLACEMENT_JOB_FILE_MAX_AGE_MS;
  const now = deps.now ?? (() => Date.now());
  const spawn = deps.spawn ?? spawnJobProcess;
  const readStart = deps.leaderStartedNear ?? leaderStartedNearNow;
  /** A start time that cannot be read, including by a check that throws, is
   *  `null`: no answer, never proof of a stranger.  It runs inside timers and
   *  the runtime's own callbacks, where a throw would be uncaught. */
  const startedNear = (pid: number, at: number): boolean | null => {
    try {
      return readStart(pid, at);
    } catch {
      return null;
    }
  };
  const jobs = new Map<string, LeasedJob>();

  const stemFor = (lease: { jobId: string; leaseId: string }): string =>
    `job-${createHash("sha256").update(lease.jobId).update("\0").update(lease.leaseId).digest("hex").slice(0, 32)}`;

  const files = (lease: { jobId: string; leaseId: string }): PlacementJobFiles => {
    const stem = stemFor(lease);
    return { logPath: join(directory, `${stem}.log`), exitPath: join(directory, `${stem}.exit`) };
  };

  /** Whether the group a job names is still the one its lease started.
   *  Once the leader is gone, a live process holding its pid means the group
   *  ended and the number now belongs to someone else. */
  const ownership = (job: LeasedJob): Ownership => {
    if (!groupAlive(job.pid)) return "gone";
    if (job.leaderExited) return pidAlive(job.pid) ? "gone" : "ours";
    if (!pidAlive(job.pid)) {
      job.leaderExited = true;
      return "ours";
    }
    if (job.leaderStartedAt === undefined) return "ours";
    const near = startedNear(job.pid, job.leaderStartedAt);
    // No start time was read.  That is not a stranger: the leader is not
    // written off, and nothing is signalled on a guess.
    if (near === null) return "unknown";
    if (near) return "ours";
    // The pid is held by a process that started at another time: the
    // adopted leader ended, and what holds its number is a stranger.
    job.leaderExited = true;
    return "gone";
  };

  const stillOurs = (job: LeasedJob): boolean => ownership(job) === "ours";

  /** Whether a stranger now holds an adopted job's pid: the leader ended
   *  without an exit file and its number was handed out again.  Only a start
   *  time that was read and does not match says so, and it is read at most
   *  every `ADOPTED_PROOF_EVERY_POLLS` polls.  A stranger's pid is the same
   *  as an ended leader to the poll, which then settles the job. */
  const strangerHolds = (job: LeasedJob): boolean => {
    if (job.leaderStartedAt === undefined || now() < job.nextProofAt) return false;
    job.nextProofAt = now() + adoptedPollMs * ADOPTED_PROOF_EVERY_POLLS;
    if (startedNear(job.pid, job.leaderStartedAt) !== false) return false;
    job.leaderExited = true;
    return true;
  };

  /** SIGTERM the job's whole group, then SIGKILL what is left.  One kill per
   *  job: a second caller waits on the first.  A passive adapter signals
   *  nothing.  Nor is anything signalled while the group cannot be proved
   *  the lease's own: the kill is then owed, not spent, and the adopted poll
   *  tries it again.  `limit` marks the run limit's kill. */
  const killJob = (job: LeasedJob, grace: number, limit = false): Promise<void> => {
    if (passive) return Promise.resolve();
    if (job.kill) return job.kill;
    let unproved = false;
    let signalled = false;
    const kill = killGroup(job.pid, grace, () => {
      const owner = ownership(job);
      unproved = owner === "unknown";
      if (owner !== "ours") return false;
      signalled = true;
      if (limit) job.timedOut = true;
      return true;
    }).then(() => {
      if (job.kill !== kill) return;
      if (!unproved) {
        job.owed = undefined;
        return;
      }
      // Either signal was held back for want of proof, so the group may
      // still be running.  Whatever already had its SIGTERM gets no second
      // grace period.
      const tries = (job.owed?.tries ?? 0) + 1;
      job.kill = undefined;
      job.owed = {
        grace: signalled ? 0 : grace,
        limit,
        tries,
        nextAt: now() + Math.min(adoptedPollMs * 2 ** (tries - 1), OWED_RETRY_MAX_MS),
      };
    });
    job.kill = kill;
    return kill;
  };

  const expire = (job: LeasedJob): void => {
    if (passive || job.leaderExited || job.kill) return;
    // Nobody awaits the run limit's kill, so a failure of it is caught here.
    killJob(job, graceMs, true).catch(() => undefined);
  };

  const armRunLimit = (job: LeasedJob, ms: number): void => {
    job.timer = setTimeout(() => expire(job), Math.max(0, ms));
    // A running job never holds the harness open.
    job.timer.unref();
  };

  /** The leader is gone.  A kill in flight is waited out, so a stopped job
   *  settles once its whole group is gone.  Otherwise whatever the command
   *  left running (`cmd &`) is stopped too: nothing would ever report on it. */
  const afterLeader = (job: LeasedJob, settle: (leftRunning: boolean) => void): void => {
    job.leaderExited = true;
    if (job.timer) clearTimeout(job.timer);
    const finish = (leftRunning: boolean): void => {
      if (jobs.get(job.jobId) === job) jobs.delete(job.jobId);
      settle(leftRunning);
    };
    if (job.kill) {
      // The leader is gone either way: a kill that failed does not keep the
      // job from settling.
      void job.kill.then(() => finish(false), () => finish(false));
      return;
    }
    const leftRunning = !passive && stillOurs(job);
    if (leftRunning) killJob(job, graceMs).catch(() => undefined);
    finish(leftRunning);
  };

  /** What the runtime is told.  The exit file is the job's own word and wins
   *  over the leader's exit event. */
  const exitOf = (job: LeasedJob, status: number | null, signal: NodeJS.Signals | null, leftRunning: boolean): WorkerJobExit => {
    const exit: WorkerJobExit = status === null ? { exitCode: null, signal } : { exitCode: status, signal: signalForStatus(status) };
    if (job.timedOut && status !== 0) exit.reason = RUN_LIMIT_REASON;
    else if (exit.signal === "SIGXCPU") exit.reason = CPU_LIMIT_REASON;
    else if (leftRunning) exit.reason = LEFT_RUNNING_REASON;
    return exit;
  };

  /** Drop the files of leases that ended long ago.  A job this adapter still
   *  holds keeps its files whatever their age. */
  const pruneFiles = (): void => {
    const held = new Set([...jobs.values()].map((job) => job.stem));
    const cutoff = now() - fileMaxAgeMs;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const match = FILE_NAME.exec(name);
      if (!match?.[1] || held.has(match[1])) continue;
      const path = join(directory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* already gone, or not removable: the next spawn tries again */
      }
    }
  };

  const spawnJob: RuntimeProcessDeps["spawnJob"] = async (job) => {
    if (passive) throw new Error(PLACEMENT_JOB_PASSIVE_REFUSAL);
    const { cwd, timeoutMs } = job;
    if (cwd === undefined || cwd.length === 0) throw new Error("The leased job names no working folder.");
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("The leased job carries no run limit.");
    }
    if (timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`The leased job asks for a run limit past the ${JOB_OWNER_MAX_MINUTES} minutes BotFleet allows.`);
    }
    const cpuCores = deps.cpuCores();
    if (!Number.isFinite(cpuCores) || cpuCores <= 0) throw new Error("The CPU limit for background jobs could not be read.");
    if (jobs.has(job.jobId)) throw new Error("This leased job is already running on this worker.");

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const stem = stemFor(job);
    const { logPath, exitPath } = files(job);
    // The log is opened when a lease is spawned and the exit file is written
    // when its command ends, so either one means this lease was started here
    // before, by this process or by one before a restart.  Starting it again
    // could run its command twice.
    if (existsSync(logPath) || existsSync(exitPath)) throw new Error("This lease was already started on this worker.");
    pruneFiles();

    const spawned = spawn({
      command: job.command,
      cwd,
      env: { ...modelShellEnv(), BOTFLEET_JOB_ID: job.jobId },
      logPath,
      exitPath,
      cpuSeconds: (timeoutMs / 1000) * cpuCores,
    });
    if (!spawned.ok) {
      // The runner opens the log before it starts the shell, so a start that
      // failed leaves an empty log behind.  Nothing ran, and that file must
      // not make the once-only guard above refuse the lease's next attempt.
      // This call made it: the guard just found no log.
      try {
        unlinkSync(logPath);
      } catch {
        /* never created, or already gone: the spawn error is what matters */
      }
      throw new Error(spawned.error);
    }

    const entry: LeasedJob = { jobId: job.jobId, pid: spawned.pid, stem, exitPath, leaderExited: false, nextProofAt: 0, exitWaits: 0, timedOut: false };
    jobs.set(job.jobId, entry);
    const done = new Promise<WorkerJobExit>((resolve) => {
      spawned.child.once("exit", (code, signal) => {
        const status = readExitFile(exitPath) ?? code;
        afterLeader(entry, (leftRunning) => resolve(exitOf(entry, status, signal, leftRunning)));
      });
    });
    // A spawn that fails after the pid was assigned reports here; the exit
    // event still follows and settles the job.
    spawned.child.on("error", () => undefined);
    armRunLimit(entry, timeoutMs);
    return { pid: spawned.pid, done };
  };

  const stopJob: RuntimeProcessDeps["stopJob"] = async (jobId, signal) => {
    const job = jobs.get(jobId);
    if (!job) return;
    await killJob(job, signal === "SIGKILL" ? 0 : graceMs);
  };

  const watchProcess: RuntimeProcessDeps["watchProcess"] = (pid, record) => {
    if (!record) return Promise.reject(new Error("No lease record names this process."));
    if (jobs.has(record.jobId)) return Promise.reject(new Error("This leased job is already watched."));
    const job: LeasedJob = {
      jobId: record.jobId,
      pid,
      stem: stemFor(record),
      exitPath: files(record).exitPath,
      leaderExited: false,
      leaderStartedAt: record.spawnedAt,
      nextProofAt: 0,
      exitWaits: 0,
      timedOut: false,
    };
    jobs.set(record.jobId, job);
    // The limit ran while the worker was down, so what is left is counted
    // from the recorded spawn.  A record without a limit is past it: an
    // adopted job is never left to run unbounded.
    if (!passive) armRunLimit(job, record.timeoutMs === undefined ? 0 : record.spawnedAt + record.timeoutMs - now());
    return new Promise<WorkerJobExit>((resolve, reject) => {
      const poll = setInterval(() => {
        const written = readExitFile(job.exitPath);
        // The leader is held while a process with its pid lives and no
        // stranger is proved to have taken the number.
        const held = !job.leaderExited && pidAlive(pid) && !strangerHolds(job);
        if (held && written === null) {
          // Still running.  A stop or a run limit that could not go out is
          // tried again here, so neither is lost to one failed `ps`.
          if (job.owed && !job.kill && now() >= job.owed.nextAt) killJob(job, job.owed.grace, job.owed.limit).catch(() => undefined);
          return;
        }
        // The wrapper writes the exit file just before it exits, so a leader
        // that lives with its status on disk is on its way out.  Settling now
        // would call it exited while it still holds its pid, and what the
        // command left running would be taken for a stranger's.
        if (held && job.exitWaits < EXIT_WAIT_POLLS) {
          job.exitWaits += 1;
          return;
        }
        clearInterval(poll);
        afterLeader(job, (leftRunning) => {
          if (written !== null || job.timedOut) resolve(exitOf(job, written, null, leftRunning));
          else reject(new Error("The adopted job ended without leaving an exit status."));
        });
      }, adoptedPollMs);
      poll.unref();
    });
  };

  const isProcessAlive: RuntimeProcessDeps["isProcessAlive"] = (pid, record) => {
    for (const job of jobs.values()) if (job.pid === pid) return !job.leaderExited && pidAlive(pid);
    // A bare pid proves nothing after a restart: without the lease's spawn
    // time there is no telling the job from whoever holds its number now.
    if (!record || !pidAlive(pid)) return false;
    // Only a start time that was read and does not match proves a stranger.
    // When it could not be read the job is taken as alive: it is then
    // adopted and watched, never reported lost on a guess, and never
    // signalled until its start time is proved.
    return startedNear(pid, record.spawnedAt) !== false;
  };

  const readExit: RuntimeProcessDeps["readExit"] = (record: WorkerLocalLeaseRecord) => {
    const status = readExitFile(files(record).exitPath);
    return status === null ? null : { exitCode: status, signal: signalForStatus(status) };
  };

  return {
    spawnJob,
    stopJob,
    watchProcess,
    isProcessAlive,
    readExit,
    passiveReason: passive ? PLACEMENT_JOB_PASSIVE_REFUSAL : undefined,
    running: () => jobs.size,
    files,
  };
}
