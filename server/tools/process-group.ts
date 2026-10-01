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

import { redactSecretsInText } from "../redact.ts";

/** How long a group gets between SIGTERM and SIGKILL. */
export const GROUP_KILL_GRACE_MS = 5_000;

/** How long the shell's pipes may stay open after the shell itself exited.
 * Longer means a background child is holding them, and the command's answer
 * should not wait for that child to finish. */
const STDIO_DRAIN_MS = 250;

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

/** SIGTERM the whole group, then SIGKILL whatever is still there after
 * `graceMs`.  Resolves once the group is gone or the SIGKILL has gone out. */
export function killGroup(pgid: number, graceMs: number = GROUP_KILL_GRACE_MS): Promise<void> {
  if (!POSIX) {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pgid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  }
  if (!signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      if (!groupAlive(pgid)) return resolve();
      if (Date.now() - startedAt >= graceMs) {
        signalGroup(pgid, "SIGKILL");
        return resolve();
      }
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

/** The process groups one turn's shell commands started.  Whatever is still
 * alive when the turn ends is a lost job: nothing will ever report on it,
 * and the jobs program's registry is what may keep work past a turn. */
export class TurnProcessGroups {
  private readonly groups = new Map<number, string>();
  private readonly graceMs: number;

  constructor(graceMs: number = GROUP_KILL_GRACE_MS) {
    this.graceMs = graceMs;
  }

  track(pgid: number, label: string): void {
    this.groups.set(pgid, label);
  }

  /** Forget a group whose every process has exited. */
  release(pgid: number): void {
    this.groups.delete(pgid);
  }

  /** How many groups are still tracked, live or not yet checked. */
  get size(): number {
    return this.groups.size;
  }

  /** Stop every tracked group that is still alive, log it, and resolve with
   * the labels of the groups that were stopped. */
  async reap(): Promise<string[]> {
    const lost: Array<[number, string]> = [];
    for (const [pgid, label] of this.groups) {
      if (groupAlive(pgid)) lost.push([pgid, label]);
    }
    this.groups.clear();
    if (lost.length === 0) return [];
    console.warn(
      `[bash] the turn ended with ${lost.length} process group(s) still running; stopping: ${lost
        .map(([, label]) => JSON.stringify(label))
        .join(", ")}`,
    );
    await Promise.all(lost.map(([pgid]) => killGroup(pgid, this.graceMs)));
    return lost.map(([, label]) => label);
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
      // A finished group is forgotten; a stopped one stays tracked until its
      // kill lands, and one with a process left running is the turn's to stop.
      if (pgid !== undefined && !stopped && !leftRunning) options.groups?.release(pgid);
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(stopped ? { stopped } : {}),
        ...(spawnError !== undefined ? { spawnError } : {}),
        leftRunning,
      });
    };
    const stop = (why: NonNullable<GroupedRunResult["stopped"]>) => {
      if (settled) return;
      stopped = why;
      if (pgid !== undefined) void killGroup(pgid, options.graceMs);
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
