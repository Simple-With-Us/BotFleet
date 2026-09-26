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
  // SAFETY: resolved.command and resolved.args are non-empty validated
  // spawn inputs from resolveCli; spawn is variadic so the cast keeps the
  // ChildProcessByStdio<Writable,Readable,Readable> contract without forcing
  // a string[] clone that would discard the narrowing resolveCli produced.
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
  let settled = false;
  const finish = (err: Error | null, stdout: string, stderr?: string) => {
    if (settled) return;
    settled = true;
    if (hardTimer) clearTimeout(hardTimer);
    cb(err, stdout, stderr);
  };
  const child = execFile(
    resolved.command,
    resolved.args,
    { ...opts, windowsHide: true, encoding: "utf8" },
    (err, stdout, stderr) => finish(err, stdout, stderr),
  );
  const timeoutMs = opts.timeout ?? 0;
const softTimeout = timeoutMs > 0 ? timeoutMs : 0;
  const hardTimer = softTimeout
    ? setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish(new Error(`\`${cli}\` did not exit within ${softTimeout}ms`), "");
      }, softTimeout + HARD_EXEC_GRACE_MS)
    : undefined;
  hardTimer?.unref?.();
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
