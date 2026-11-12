// Teardown primitives for suites that spawn a real process against a
// throwaway home directory.
//
// Both halves of that pattern have a race in them, and both races surface
// as a red suite whose assertions all passed — the most expensive kind of
// failure to read. These two helpers exist so the fix lives in one place
// instead of being re-derived (or forgotten) per suite.
//
// A third failure mode lives here too: a suite that spawns the real harness
// (server/index.ts) and then never gets to run its own cleanup at all — a
// vitest worker SIGKILLed on timeout under load (six ~4.4 GB harness
// processes were found orphaned with parent pid 1 on 2026-09-12, right after
// a run this loaded) leaves that child running forever, because Node never
// kills a process's children just because the process itself exited.
// `spawnDetached` and the exit guard below are the two defenses that live in
// this module for it; server/test-parent-watchdog.ts is the third, for the
// case where nothing in this process ever gets to run again either.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

import { containerRuntimeLockdownEnv } from "../container-runtime-guard.ts";

/** How `waitForExit` should end the child, and how long to allow. */
export interface WaitForExitOptions {
  /** Sent immediately. Omit for a child the caller has already signalled. */
  signal?: NodeJS.Signals;
  /** How long the polite signal gets before SIGKILL. */
  graceMs?: number;
}

// Children created by `spawnDetached`, tracked so the process-`exit` guard
// below can sweep any that are still alive when this worker shuts down
// without running the suite's own `afterAll` — an uncaught exception, a hook
// that threw before reaching its cleanup line, or any other early exit that
// still leaves this process itself alive long enough to fire the event.
// Kept on `globalThis`, not a module-level `const`, because vitest gives
// each test file its own copy of this module: without a process-wide home,
// every file's copy would install its own listener and track only its own
// children, which still works but piles up `exit` listeners one per file
// for the life of the worker.
const globalKey = "__botfleetTrackedTestChildren";
const guardKey = "__botfleetTestExitGuardInstalled";
const registry = globalThis as unknown as Record<string, unknown>;
const trackedChildren: Set<ChildProcess> = (registry[globalKey] as Set<ChildProcess> | undefined) ?? new Set();
registry[globalKey] = trackedChildren;

// Only children this module itself made a process-group leader (see
// `spawnDetached`) go in here — `endChild` uses membership as its proof that
// a `-pid` group signal is safe to send, so it can never land on an
// unrelated process group by pid coincidence. On `globalThis` for the same
// reason as `trackedChildren` above: a module-scoped `const` here would give
// each test file its own empty WeakSet, and the process-`exit` guard only
// ever installs once (see `guardKey` below) — so its closure would keep
// reading whichever file's WeakSet happened to load first, and every later
// file's children would look like non-leaders to it and fall back to a
// single-pid kill, leaving their grandchildren behind.
const groupLeaderKey = "__botfleetTestGroupLeaders";
const groupLeaders: WeakSet<ChildProcess> = (registry[groupLeaderKey] as WeakSet<ChildProcess> | undefined) ?? new WeakSet();
registry[groupLeaderKey] = groupLeaders;

if (!registry[guardKey]) {
  registry[guardKey] = true;
  process.on("exit", () => {
    for (const child of trackedChildren) {
      if (child.exitCode === null && child.signalCode === null) endChild(child, "SIGKILL");
    }
  });
}

/**
 * Send `signal` to a child's whole process group when it is one `spawnDetached`
 * made, a plain per-pid `child.kill` otherwise. `waitForExit` and the exit
 * guard both end children through here so a driver CLI or MCP proxy the
 * harness itself spawned dies along with it, not just the top-level process.
 *
 * Windows has no POSIX process group at all — `detached`/`-pid` are POSIX-only
 * concepts, and `child.kill()` there only ever terminates the single process
 * Node knows about, not whatever it spawned. `taskkill /T` walks the same
 * parent-child tree Windows itself tracks, so it is the tree-kill regardless
 * of whether `spawnDetached` happened to set `detached` for this child.
 * `spawnSync`, not `execFile`, because this also has to run to completion
 * from the synchronous `exit` guard below, where an async call could be
 * abandoned mid-flight when the process finishes exiting anyway.
 */
function endChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    // A non-zero exit here just means taskkill itself found nothing to do —
    // already gone, or another /T pass already swept it — not a failure.
    // Only fall back if taskkill could not even be launched.
    if (result.error) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (groupLeaders.has(child)) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // group already gone — fall through to the direct signal below
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Drop-in replacement for `child_process.spawn` for any suite that starts
 * the real harness (or another long-lived child) against a throwaway home.
 * Same signature and return type as `spawn` — only the process-group and
 * cleanup wiring is new:
 *
 *  - POSIX: the child becomes the leader of its own process group, so
 *    `waitForExit` (and the exit guard) can kill it and everything it
 *    spawned with one `-pid` signal instead of just the one process.
 *  - The child is tagged with BOTFLEET_TEST_CHILD / BOTFLEET_TEST_PARENT_PID,
 *    which server/test-parent-watchdog.ts uses to notice when the caller
 *    (this test worker) is gone and there is nobody left to send it a signal
 *    at all — the backstop for a parent that is SIGKILLed outright.
 *  - The child is tracked for the exit guard above, and untracked as soon as
 *    it actually closes.
 *
 * Windows has no POSIX process group to make this a leader of — `detached`
 * is skipped there entirely, and it is not tracked in `groupLeaders` either,
 * since `endChild` above takes the `taskkill /T` tree-kill path for every
 * Windows child regardless of that membership (see server/procs.ts's own
 * win32 branch, which does the same for driver CLIs). It still gets the env
 * markers and exit-guard tracking, matching what `waitForExit` already did
 * for every caller before this existed.
 */
export function spawnDetached(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, {
    ...options,
    ...(process.platform === "win32" ? {} : { detached: true }),
    env: {
      ...options.env,
      // A harness child gets a throwaway HOME but shares the machine's ONE
      // container daemon, and the Local VM container name derives from the OS
      // username, not HOME.  Without this a test turned the Local VM on and
      // created (then orphaned) the owner's real container.  Set last so a
      // suite's env cannot drop it; a suite that shadows `docker` with a
      // script names the directory in BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR.
      ...containerRuntimeLockdownEnv(),
      BOTFLEET_TEST_CHILD: "1",
      BOTFLEET_TEST_PARENT_PID: String(process.pid),
    },
  });
  if (process.platform !== "win32") groupLeaders.add(child);
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

/**
 * End a child process and wait for it to actually be gone.
 *
 * `kill()` asks; it does not wait. A caller that proceeds straight from the
 * kill call to deleting the child's home directory is racing a process that
 * may still be mid-write, and on Linux that surfaces as an EACCES or ENOTEMPTY
 * from `rm` rather than anything that names the real cause.
 *
 * Pass `signal` and this sends it, rather than leaving the caller to send one
 * and then wait out a grace period that has already started counting. Both
 * halves of "stop it, and know that it stopped" then live in one call.
 *
 * From there: resolve on `close`, escalate to SIGKILL only after `graceMs`,
 * and keep waiting for `close` even then — a SIGKILL is not an exit either,
 * it just makes one imminent. The final backstop bounds the whole thing so a
 * wedged child can never hang the suite.
 *
 * A loaded CI runner loses that race; a laptop wins it every time, which is
 * why it reads as a phantom.
 */
export function waitForExit(
  child: ChildProcess | undefined,
  options: WaitForExitOptions | number = {},
): Promise<void> {
  const { signal, graceMs = 5_000 } = typeof options === "number" ? { graceMs: options } : options;

  return new Promise<void>((resolve) => {
    // signalCode, not just exitCode: a process killed by a signal reports its
    // death in the former and leaves the latter null.
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("close", done);

    if (signal) endChild(child, signal);

    timer = setTimeout(() => {
      endChild(child, "SIGKILL");
      timer = setTimeout(done, 2_000);
      timer.unref?.();
    }, graceMs);
    timer.unref?.();
  });
}

/**
 * Remove a temp directory, and never fail a green suite over one.
 *
 * A just-killed child lets go of its files a beat after the kill returns, and
 * `rmSync`'s own `maxRetries` does not cover an EACCES/EPERM on the directory
 * itself. Retry briefly; if the directory still will not go, warn and leave
 * it for the OS to reap. A leaked temp dir is a non-event — a red CI run that
 * says nothing about the code under test is not.
 */
export async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${dir}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
