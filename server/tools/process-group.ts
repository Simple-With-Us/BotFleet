// Shell commands the HTTP tool lane runs, each in a process group of its own
// (background jobs P0, docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).
//
// `execFile`'s timeout signalled the shell alone.  Anything the shell had
// started — a pipeline stage, `cmd &`, a dev server — was re-parented and kept
// running after the tool reported a timeout, and nothing ever stopped it.  A
// detached spawn makes the shell the leader of a new process group, so one
// signal to `-pgid` reaches every process the command started, unless one
// left the group on purpose (`setsid`, a daemon that double-forks into a
// session of its own).
//
// Windows has no process groups to signal.  There the shell is spawned
// attached and stopped with `taskkill /T`, which reaches the children it can
// still see; the jobs program refuses to start jobs there for this reason.

import { execFile, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { redactSecretsInText } from "../redact.ts";

/** How long a group gets between SIGTERM and SIGKILL. */
export const GROUP_KILL_GRACE_MS = 5_000;

/** How long a SIGKILLed group gets to disappear before it is reported gone. */
const KILL_SETTLE_MS = 1_000;

/** How long the shell's pipes may stay open after the shell itself exited.
 * Longer means a background child is holding them, and the command's answer
 * should not wait for that child to finish. */
const STDIO_DRAIN_MS = 250;

/** How far a process's start time may sit from the moment its spawn was
 * recorded and still be the process that spawn made (the start time comes
 * in whole seconds, and a loaded Mac can take a few to start a shell). */
const LEADER_START_SLACK_MS = 10_000;

const POSIX = process.platform !== "win32";

/** Send `signal` to every process in the group `pgid` leads (signal 0 only
 * asks whether any is left).  False when the group is gone. */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(POSIX ? -pgid : pgid, signal);
    return true;
  } catch (error) {
    // EPERM: the group exists, but some member is not ours to signal.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Whether any process of the group `pgid` is still alive. */
export function groupAlive(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

/** Whether a process with this exact pid is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** SIGTERM the whole group, then SIGKILL whatever is still there after
 * `graceMs`.  Resolves once the group is gone, or a short while after the
 * SIGKILL went out.  `stillOurs` is asked before each signal: a group that
 * ended may have handed its number to someone else's. */
export function killGroup(
  pgid: number,
  graceMs: number = GROUP_KILL_GRACE_MS,
  stillOurs: () => boolean = () => true,
): Promise<void> {
  if (!POSIX) {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pgid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  }
  if (!stillOurs() || !signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let killedAt: number | null = null;
    const poll = () => {
      if (!groupAlive(pgid)) return resolve();
      const now = Date.now();
      if (killedAt === null && now - startedAt >= graceMs) {
        if (!stillOurs()) return resolve();
        signalGroup(pgid, "SIGKILL");
        killedAt = now;
      }
      if (killedAt !== null && now - killedAt >= KILL_SETTLE_MS) return resolve();
      setTimeout(poll, Math.min(100, graceMs));
    };
    setTimeout(poll, Math.min(25, graceMs));
  });
}

/** A command as a log line may show it: secrets masked, one line, short. */
export function commandLabel(command: string): string {
  const flat = redactSecretsInText(command).replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

// ── the ledger ──────────────────────────────────────────────────────────
// Every process group this harness started for a turn and has not yet seen
// end.  Detaching takes a command out of the harness's own group, so it no
// longer dies with the harness the way launchd's job cleanup used to make
// it: the ledger is how a stop, a crash and the next boot still reach it.
// POSIX only — Windows has no groups, and a command there is stopped (or
// finished) before its tool call returns.

interface GroupRecord {
  pgid: number;
  /** commandLabel() of the command: masked, one line */
  label: string;
  /** when the spawn was recorded, ms since the epoch */
  spawnedAt: number;
  /** the shell that leads the group has exited (and its pid was reaped) */
  leaderExited: boolean;
  /** a kill is in flight; it forgets the record when it lands */
  stopping: boolean;
}

const GroupLedgerFile = z.array(
  z.object({ pgid: z.number().int().positive(), label: z.string(), spawnedAt: z.number(), leaderExited: z.boolean() }),
);

const ledger = new Map<number, GroupRecord>();
let ledgerPath: string | null = null;

function saveLedger(): void {
  if (!ledgerPath) return;
  const records = [...ledger.values()].map(({ pgid, label, spawnedAt, leaderExited }) => ({ pgid, label, spawnedAt, leaderExited }));
  try {
    const tmp = `${ledgerPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
    renameSync(tmp, ledgerPath);
  } catch (error) {
    console.warn(`[bash] could not record running process groups: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function forget(pgid: number): void {
  if (ledger.delete(pgid)) saveLedger();
}

/** The shell leading `pgid` exited, and its pid is free again. */
export function markLeaderExited(pgid: number): void {
  const record = ledger.get(pgid);
  if (!record || record.leaderExited) return;
  record.leaderExited = true;
  saveLedger();
}

/** Whether the group a record names still has a process in it, AND is still
 * the group this harness started.  POSIX never hands out a pid that is some
 * live group's id, and never lets a new group take an id still in use; so
 * once our leader has exited, a live process holding its pid means our
 * group ended and the number now belongs to someone else's. */
function stillOurs(record: Pick<GroupRecord, "pgid" | "leaderExited">): boolean {
  if (!groupAlive(record.pgid)) return false;
  return !(record.leaderExited && pidAlive(record.pgid));
}

/** Stop a recorded group, and forget it once it is gone. */
async function stopRecorded(record: GroupRecord, graceMs: number): Promise<void> {
  record.stopping = true;
  await killGroup(record.pgid, graceMs, () => stillOurs(record));
  if (stillOurs(record)) record.stopping = false;
  else forget(record.pgid);
}

if (POSIX) {
  // A graceful stop (SIGTERM → process.exit) has no time for a 5 s grace,
  // and a crash none at all: what is still recorded at exit is SIGKILLed
  // now, synchronously, and the ledger file left empty for the next boot.
  process.on("exit", () => {
    for (const record of ledger.values()) if (stillOurs(record)) signalGroup(record.pgid, "SIGKILL");
    ledger.clear();
    saveLedger();
  });
}

/** Whether the process `pid` started within LEADER_START_SLACK_MS of `at`. */
function startedNear(pid: number, at: number): Promise<boolean> {
  return new Promise((resolve) => {
    // the start time only: never a command line, which can carry credentials
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(false);
      const startedAt = Date.parse(String(stdout).trim());
      resolve(Number.isFinite(startedAt) && Math.abs(startedAt - at) <= LEADER_START_SLACK_MS);
    });
  });
}

/** Keep the ledger at `path` (under the data folder) from now on, and stop
 * every group an earlier harness run recorded there and never saw end — a
 * crash or a SIGKILL leaves them running, re-parented, with nothing that
 * will ever report on them.  Resolves with their labels.  A group whose id
 * has been reused, or whose leader's pid now names a process that started
 * at another time, is left alone.  `null` stops keeping a file (tests). */
export async function adoptGroupLedger(path: string | null): Promise<string[]> {
  let earlier: z.infer<typeof GroupLedgerFile> = [];
  if (path) {
    try {
      const parsed = GroupLedgerFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) earlier = parsed.data;
    } catch {
      /* no ledger yet, or an unreadable one: nothing to adopt */
    }
  }
  ledgerPath = path;
  saveLedger();
  if (!POSIX || earlier.length === 0) return [];
  const lost: Array<z.infer<typeof GroupLedgerFile>[number]> = [];
  for (const record of earlier) {
    if (ledger.has(record.pgid) || !groupAlive(record.pgid)) continue;
    if (pidAlive(record.pgid)) {
      // something holds the leader's pid: ours only if it is that very shell
      if (record.leaderExited || !(await startedNear(record.pgid, record.spawnedAt))) continue;
    }
    lost.push(record);
  }
  if (lost.length === 0) return [];
  console.warn(
    `[bash] an earlier run left ${lost.length} process group(s) running; stopping: ${lost
      .map((record) => JSON.stringify(record.label))
      .join(", ")}`,
  );
  await Promise.all(lost.map((record) => killGroup(record.pgid, GROUP_KILL_GRACE_MS, () => stillOurs(record))));
  return lost.map((record) => record.label);
}

/** The process groups one turn's shell commands started.  Whatever is still
 * alive when the turn ends is a lost job: nothing will ever report on it,
 * and the jobs program's registry is what may keep work past a turn. */
export class TurnProcessGroups {
  private readonly groups = new Set<number>();
  private readonly graceMs: number;

  constructor(graceMs: number = GROUP_KILL_GRACE_MS) {
    this.graceMs = graceMs;
  }

  track(pgid: number, label: string): void {
    // Windows: nothing outlives the call (see the ledger above)
    if (!POSIX) return;
    this.prune();
    this.groups.add(pgid);
    ledger.set(pgid, { pgid, label, spawnedAt: Date.now(), leaderExited: false, stopping: false });
    saveLedger();
  }

  /** Forget a group whose every process has exited. */
  release(pgid: number): void {
    this.groups.delete(pgid);
    forget(pgid);
  }

  /** Forget each group of this turn that ended on its own (or was stopped),
   * so its id is never signalled again once it may name someone else's. */
  prune(): void {
    for (const pgid of [...this.groups]) {
      const record = ledger.get(pgid);
      if (!record) this.groups.delete(pgid);
      else if (!record.stopping && !stillOurs(record)) this.release(pgid);
    }
  }

  /** How many groups are still tracked, live or not yet checked. */
  get size(): number {
    return this.groups.size;
  }

  /** Stop every tracked group that is still alive, log it, and resolve with
   * the labels of the groups that were stopped. */
  async reap(): Promise<string[]> {
    this.prune();
    // a group already being stopped is that stop's to finish
    const lost = [...this.groups].flatMap((pgid) => {
      const record = ledger.get(pgid);
      return record && !record.stopping ? [record] : [];
    });
    // the turn is over; the ledger keeps each group until its kill lands
    this.groups.clear();
    if (lost.length === 0) return [];
    console.warn(
      `[bash] the turn ended with ${lost.length} process group(s) still running; stopping: ${lost
        .map((record) => JSON.stringify(record.label))
        .join(", ")}`,
    );
    await Promise.all(lost.map((record) => stopRecorded(record, this.graceMs)));
    return lost.map((record) => record.label);
  }
}

export interface GroupedRunResult {
  /** The shell's exit code, or null when a signal ended it. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Why the run was cut short, when it was.  The group is being killed. */
  stopped?: "timeout" | "aborted" | "output_limit" | "spawn_error";
  /** The spawn failure's own message, for `stopped: "spawn_error"`. */
  spawnError?: string;
  /** The shell exited, but a process it started is still running. */
  leftRunning: boolean;
}

export interface GroupedRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Per-stream output ceiling, in bytes; past it the group is stopped. */
  maxBuffer: number;
  /** Stop the command when this aborts (the turn was interrupted, or the
   * tool loop's own per-tool clock ran out). */
  signal?: AbortSignal;
  /** Where the group is recorded, so the turn can stop it at settle. */
  groups?: TurnProcessGroups;
  label: string;
  graceMs?: number;
}

/** Run `file args` as the leader of a new process group and resolve with what
 * it printed.  Never rejects.  A timeout, an abort or an output overflow
 * resolves at once and kills the whole group in the background; a command
 * that returns while something it started keeps running resolves as soon as
 * the shell exits, with `leftRunning` set and the group left tracked. */
export function runInProcessGroup(file: string, args: string[], options: GroupedRunOptions): Promise<GroupedRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: POSIX,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        stopped: "spawn_error",
        spawnError: error instanceof Error ? error.message : String(error),
        leftRunning: false,
      });
      return;
    }
    const pgid = child.pid;
    if (pgid !== undefined) options.groups?.track(pgid, options.label);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let exited = false;
    let code: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stopped: GroupedRunResult["stopped"];
    let spawnError: string | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      // Stop reading: a background child may still hold the pipes open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const leftRunning = POSIX && pgid !== undefined && !stopped && exited && groupAlive(pgid);
      // A finished group is forgotten; a stopped one is forgotten when its
      // kill lands, and one with a process left running is the turn's to stop.
      if (pgid !== undefined && !stopped && !leftRunning) options.groups?.release(pgid);
      const result: GroupedRunResult = {
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        leftRunning,
      };
      if (stopped) result.stopped = stopped;
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };
    const stop = (why: NonNullable<GroupedRunResult["stopped"]>) => {
      if (settled) return;
      stopped = why;
      if (pgid !== undefined) {
        // a recorded group is forgotten once its kill lands, so its id is
        // never signalled again after it may name someone else's
        const record = ledger.get(pgid);
        if (record) {
          void stopRecorded(record, options.graceMs ?? GROUP_KILL_GRACE_MS).then(() => {
            if (!ledger.has(pgid)) options.groups?.release(pgid);
          });
        } else void killGroup(pgid, options.graceMs);
      }
      finish();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxBuffer) return stop("output_limit");
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxBuffer) return stop("output_limit");
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      stopped = "spawn_error";
      spawnError = error.message;
      finish();
    });
    child.on("exit", (exitCode, signal) => {
      exited = true;
      if (pgid !== undefined) markLeaderExited(pgid);
      code = exitCode;
      exitSignal = signal;
      // Normally `close` follows at once.  When it does not, a process the
      // command started is holding the pipes: answer with what was printed.
      drainTimer = setTimeout(finish, STDIO_DRAIN_MS);
    });
    child.on("close", finish);

    // Checked one setImmediate late: a timer serviced after an event-loop
    // stall can fire for a command that finished in time and whose exit is
    // still queued (the same trap server/procs.ts's execCli guards).
    const deadline = setTimeout(() => {
      setImmediate(() => {
        if (settled || exited) return;
        stop("timeout");
      });
    }, options.timeoutMs);
    const onAbort = () => stop("aborted");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
