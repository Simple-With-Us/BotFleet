// How one background job's process is started (jobs P1,
// docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).
//
// The rules the decision doc sets, and how each is kept here:
//
//   - A detached process group.  `/bin/sh` is spawned with `detached`, so it
//     leads a new group and one signal to `-pgid` reaches everything the
//     command starts.  The registry, not this file, decides when to send it.
//   - `nice -n 10 taskpolicy -c utility` with a `ulimit -t` CPU limit.  A job
//     is background work on the owner's own Mac; it must not take the
//     foreground's CPU, and a runaway loop must end on its own.  `taskpolicy`
//     is macOS only, so elsewhere it is `nice` alone.
//   - The environment is exactly what the caller passes: `modelShellEnv()`
//     plus `BOTFLEET_JOB_ID`.  Never the harness's own environment, which
//     holds provider keys.
//   - Output goes to a 0600 file in the data folder through a file
//     descriptor.  Never a pipe: a pipe ties the job to this process, and a
//     restart that kept jobs running (a later phase) would have to break it.
//     Never `/tmp`, which other users can list.
//   - The exit code is written atomically to an `exit` file (`printf > tmp &&
//     mv tmp exit`), so a harness that was not running when the job ended can
//     still settle it from disk at boot.
//
// The wrapper is `/bin/sh` on every POSIX host, whatever `SHELL` says: it is
// the one shell guaranteed to exist.  The command itself runs in the owner's
// shell, the same one the `bash` tool uses.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";

const TASKPOLICY = "/usr/sbin/taskpolicy";

/** The wrapper `/bin/sh` runs.  Positional parameters, never interpolation:
 *  `$1` is the command, `$2` the exit file, `$3` the owner's shell, `$4` the
 *  CPU limit in seconds.  The command never touches this script's text, so
 *  nothing in it can break out of a quote. */
export function wrapperScript(useTaskpolicy: boolean): string {
  const runner = useTaskpolicy ? `nice -n 10 ${TASKPOLICY} -c utility "$3" -c "$1"` : `nice -n 10 "$3" -c "$1"`;
  return [
    `ulimit -t "$4" 2>/dev/null`,
    runner,
    `code=$?`,
    `printf '%s\\n' "$code" > "$2.tmp" && mv -f "$2.tmp" "$2"`,
    `exit "$code"`,
  ].join("\n");
}

export interface JobSpawnSpec {
  command: string;
  cwd: string;
  /** Exactly the job's environment: `modelShellEnv()` + `BOTFLEET_JOB_ID`. */
  env: NodeJS.ProcessEnv;
  logPath: string;
  exitPath: string;
  /** `ulimit -t` for every process the job starts. */
  cpuSeconds: number;
  /** The shell the command runs in; defaults to the owner's. */
  shell?: string;
}

export type JobSpawnResult = { ok: true; child: ChildProcess; pid: number } | { ok: false; error: string };

/** The shell a job's command runs in: the owner's, when it exists, else
 *  `/bin/sh`. */
export function jobShell(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL;
  return shell && existsSync(shell) ? shell : "/bin/sh";
}

/** Start the job.  Never throws.  The returned child is unref'd: a running
 *  job never holds the harness open, and the registry stops every job on the
 *  way out anyway. */
export function spawnJobProcess(spec: JobSpawnSpec): JobSpawnResult {
  if (process.platform === "win32") {
    return { ok: false, error: "Background jobs are not available on Windows yet." };
  }
  let logFd: number;
  try {
    // "a": the registry may have written nothing yet, and a restart that
    // adopts jobs later must never truncate a log the job still writes.
    logFd = openSync(spec.logPath, "a", 0o600);
  } catch (error) {
    return { ok: false, error: `Could not open the job's log: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        wrapperScript(process.platform === "darwin" && existsSync(TASKPOLICY)),
        "botfleet-job",
        spec.command,
        spec.exitPath,
        spec.shell ?? jobShell(spec.env),
        String(Math.max(1, Math.floor(spec.cpuSeconds))),
      ],
      {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );
    if (child.pid === undefined) {
      // spawn reports ENOENT and friends on the next tick through `error`;
      // a child with no pid never started.
      child.on("error", () => undefined);
      return { ok: false, error: "The job's shell did not start." };
    }
    child.unref();
    return { ok: true, child, pid: child.pid };
  } catch (error) {
    return { ok: false, error: `Could not start the job: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // The child holds its own copy of the descriptor; ours is not needed.
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
  }
}

/** The exit code a finished job wrote, or null when there is none (the job
 *  is still running, or was killed before the wrapper could write it). */
export function readExitFile(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^\d{1,3}$/.test(text)) return null;
    return Number(text);
  } catch {
    return null;
  }
}
