// Cross-platform process spawning for the agent CLIs. Three Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";

/** How long past a probe's soft `timeout` execCli waits for stdio to close before forcing the callback. */
const HARD_EXEC_GRACE_MS = 2_000;
/** A deadline timer this late means the event loop was stalled. */
const STALL_SLACK_MS = 500;
/** How long a late deadline waits for queued child events before acting. */
const STALL_GRACE_MS = 250;
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  // execFile's own `timeout` only sends the kill signal; the callback still
  // waits for the child's stdio to close. A CLI that ignores SIGTERM, or
  // leaves a grandchild holding the pipe (Cursor 2026.08 prints and never
  // exits), would otherwise hang every probe — and the harness boot with it.
  // A hard deadline a little past the soft one guarantees the caller settles.
  //
  // Both deadlines are this function's own timers rather than execFile's
  // `timeout`, because a timer is serviced BEFORE the poll phase that
  // delivers a finished child's output and exit status.  After the event
  // loop stalls (a busy harness paged out under swap), execFile's timer
  // fired for a child that had answered in milliseconds, destroyed the
  // unread stdout and reported `(null, "")` — a working CLI read as "not
  // found" and a signed-in one as signed out.  Each deadline here waits one
  // setImmediate, which runs after that poll phase, and kills only a child
  // that is genuinely still running.
  const softTimeout = typeof opts.timeout === "number" && opts.timeout > 0 ? opts.timeout : 0;
  const killSignal = opts.killSignal ?? "SIGTERM";
  const execOpts: ExecFileOptions = { ...opts };
  delete execOpts.timeout;
  let settled = false;
  let timedOut = false;
  let softTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (err: Error | null, stdout: string, stderr?: string) => {
    if (settled) return;
    settled = true;
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    // Typed so a driver can tell "the CLI did not answer in time" (probe
    // inconclusive) from "the CLI answered no" without parsing messages.
    if (err && timedOut) (err as ProbeTimeoutError).timedOut = true;
    cb(err, stdout, stderr);
  };
  const child = execFile(
    resolved.command,
    resolved.args,
    { ...execOpts, windowsHide: true, encoding: "utf8" },
    (err, stdout, stderr) => finish(err, stdout, stderr),
  );
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  // Stop waiting on the pipes.  execFile keeps what it already read and hands
  // it to the callback once the streams close.
  const stopReading = () => {
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // already closed
    }
  };
  // The child answered and exited, but its output has not been delivered
  // yet (a stall, or a grandchild still holding the pipe): let the close land
  // on its own, then stop waiting on the pipes so execFile hands over what it
  // read.
  let draining = false;
  const drainExited = () => {
    if (draining) return;
    draining = true;
    setTimeout(() => {
      if (!settled) stopReading();
    }, 250).unref?.();
  };
  const giveUp = () => {
    if (settled) return;
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    finish(Object.assign(new Error(`\`${cli}\` did not exit within ${softTimeout}ms`), { killed: true }), "");
  };
  // A deadline timer that fires well after it was due means the event loop
  // was stalled, and whatever the child did meanwhile may still be queued
  // behind it.  Such a deadline looks once more after a short grace instead
  // of acting on a stale view — once, so a loop that keeps stalling still
  // settles.
  const firedLate = (dueAt: number) => Date.now() - dueAt > STALL_SLACK_MS;
  const onSoftDeadline = (dueAt: number, rearmed: boolean) => () => {
    setImmediate(() => {
      if (settled) return;
      if (exited()) return drainExited();
      if (!rearmed && firedLate(dueAt)) {
        softTimer = setTimeout(onSoftDeadline(Date.now() + STALL_GRACE_MS, true), STALL_GRACE_MS);
        return;
      }
      timedOut = true;
      stopReading();
      try {
        child.kill(killSignal);
      } catch {
        // already gone
      }
    });
  };
  const onHardDeadline = (dueAt: number, rearmed: boolean) => () => {
    setImmediate(() => {
      if (settled) return;
      if (exited()) {
        // It did answer — a stall held the delivery back.  Drain first and
        // only give up if even that does not settle.
        drainExited();
        setTimeout(giveUp, 1_000).unref?.();
        return;
      }
      if (!rearmed && firedLate(dueAt)) {
        hardTimer = setTimeout(onHardDeadline(Date.now() + STALL_GRACE_MS, true), STALL_GRACE_MS);
        hardTimer.unref?.();
        return;
      }
      giveUp();
    });
  };
  if (softTimeout) {
    const startedAt = Date.now();
    softTimer = setTimeout(onSoftDeadline(startedAt + softTimeout, false), softTimeout);
    hardTimer = setTimeout(
      onHardDeadline(startedAt + softTimeout + HARD_EXEC_GRACE_MS, false),
      softTimeout + HARD_EXEC_GRACE_MS,
    );
    hardTimer.unref?.();
  }
}

/** An execCli error from a probe that ran past its deadline. */
export type ProbeTimeoutError = Error & { timedOut?: boolean; killed?: boolean; signal?: string | null };

const HARD_TIMEOUT_TEXT = /did not exit within \d+ms/;

/** Whether a probe failed because it ran out of time (or was killed) rather
 * than because the CLI answered.  A timed-out probe is inconclusive: it says
 * nothing about whether the CLI is installed or signed in. */
export function isProbeTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { timedOut?: unknown; code?: unknown; message?: unknown };
  // Evidence that WE ran out of the deadline: execCli marks its own kill
  // `timedOut`.  A bare `killed` flag or a signal is not evidence: a CLI that
  // dies on SIGSEGV or SIGABRT crashed, it did not run out of time.
  return (
    e.timedOut === true ||
    e.code === "ETIMEDOUT" ||
    (typeof e.message === "string" && HARD_TIMEOUT_TEXT.test(e.message))
  );
}

/** Spawn errno codes that mean "the Mac could not start a process right
 * now" — out of process slots, file descriptors or memory.  Transient. */
const TRANSIENT_SPAWN_CODES = new Set(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "EBUSY", "EINTR"]);

/** What a failed `<cli> --version` probe means for the engine's snapshot. */
export type VersionProbeFailure =
  /** The binary is missing or cannot run: a setup problem the user fixes. */
  | { kind: "setup"; reason: string }
  /** The probe gave no answer (timeout, kill, no process slots): try again. */
  | { kind: "transient"; reason: string }
  /** The CLI ran and failed on its own: report it, do not retry blindly. */
  | { kind: "failed"; reason: string };

/** Classify a `--version` probe that produced no version.
 *
 * Only a spawn failure the user must fix (ENOENT, EACCES, a shebang whose
 * interpreter is missing) reads as "CLI not found".  A probe that ran out of
 * time — or printed nothing by the time its deadline passed — is transient:
 * the CLI is there, the Mac was just too busy to hear back. */
export function classifyVersionProbeFailure(
  err: Error | null,
  cli: string,
  engine: string,
  elapsedMs: number,
  timeoutMs: number,
): VersionProbeFailure {
  const e = err as (NodeJS.ErrnoException & { status?: unknown; signal?: unknown }) | null;
  if (e && typeof e.code === "string") {
    const spawn = describeSpawnFailure(e, cli);
    if (spawn.setup) {
      return { kind: "setup", reason: e.code === "ENOENT" ? `\`${cli}\` CLI not found` : spawn.message };
    }
    if (TRANSIENT_SPAWN_CODES.has(e.code)) {
      return { kind: "transient", reason: `${engine} could not be checked right now` };
    }
  }
  // 127 is the shell's "command not found" — a node-shebang CLI whose
  // `node` is gone exits with it.  That is setup, not a slow answer.
  if (e && (e.code as unknown) === 127) return { kind: "setup", reason: `\`${cli}\` CLI not found` };
  // A child that died on a signal without timeout evidence crashed; a long
  // run before the crash does not make it a slow answer.
  const crashed = !!e && typeof e.signal === "string" && e.signal.length > 0 && !isProbeTimeout(e);
  if (!crashed && (isProbeTimeout(e) || (timeoutMs > 0 && elapsedMs >= timeoutMs))) {
    return { kind: "transient", reason: `${engine} did not answer in time` };
  }
  if (e) {
    const code = typeof e.code === "number" ? ` (exit ${e.code})` : crashed ? ` (${String(e.signal)})` : "";
    return { kind: "failed", reason: `\`${cli} --version\` failed${code}` };
  }
  return { kind: "failed", reason: `\`${cli} --version\` printed no version` };
}

/** One log line per failed engine probe: which engine, which command, why,
 * and how long it took.  Never stdout or stderr — those can carry account
 * details — only the error's shape. */
export function logProbeFailure(engine: string, command: string, err: Error | null, elapsedMs: number): void {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; timedOut?: boolean }) | null;
  const parts: string[] = [];
  if (e?.timedOut) parts.push("timed out");
  if (e?.code !== undefined && e?.code !== null) parts.push(`code=${String(e.code)}`);
  if (e?.killed) parts.push("killed");
  if (e?.signal) parts.push(`signal=${e.signal}`);
  if (!e) parts.push("no output");
  console.warn(`[probe] ${engine}: \`${command}\` failed after ${Math.round(elapsedMs)}ms (${parts.join(", ") || "error"})`);
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (!err) return;
      try {
        // taskkill is unavailable or the tree lookup failed. At least stop
        // the process we own instead of leaving the entire turn running.
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    ? `\\\\.\\pipe\\botfleet-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
