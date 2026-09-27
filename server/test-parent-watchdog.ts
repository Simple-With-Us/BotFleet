// Self-preservation for a harness process spawned by the test suite.
//
// A vitest worker that gets SIGKILLed (the timeout-under-load scenario that
// left six ~4.4 GB harness processes running with parent pid 1 on 2026-09-12,
// after their worker died mid-suite) never runs another line of JS on the
// way out, so nothing ever signals this process — its own `afterAll`,
// `waitForExit`, and the process-`exit` guard in server/testing/cleanup.ts
// are all just as dead as the worker. The only way this process can still
// die with its test is to notice its parent is gone and act on its own.
//
// Gated by the caller on the BOTFLEET_TEST_CHILD marker (see
// server/testing/cleanup.ts's spawnDetached): the always-on launchd harness
// (app.botfleet.server) never sets it, so this module changes nothing
// about production behavior, where the parent legitimately is launchd for
// the whole life of the process.

/** How often to check in production. A liveness probe (`process.kill(pid,
 * 0)`) is cheap on every platform Node supports, so this can afford to be
 * frequent without measurable cost. */
const DEFAULT_CHECK_INTERVAL_MS = 2_000;

/**
 * True if `pid` still names a live process. `process.kill(pid, 0)` sends no
 * signal — it only asks the OS whether the target exists — and Node
 * implements that existence probe the same way on POSIX and Windows.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll whether the pid recorded at spawn time is still alive and call
 * `onOrphaned` the moment it is not — proof the original parent is gone,
 * whether it exited cleanly or was SIGKILLed outright.
 *
 * This checks liveness of the recorded pid directly rather than comparing
 * `process.ppid` against it, because the two platforms disagree on what a
 * changed `ppid` even means: POSIX reparents an orphan to launchd/init the
 * moment its parent dies, so a live `process.ppid` read reflects that right
 * away, but Windows has no reparenting at all — `InheritedFromUniqueProcessId`
 * is fixed at process creation and never updated by the OS, so a dead
 * parent's pid would sit there unchanged forever and this would never fire.
 * A direct liveness probe on the recorded pid gives the same answer on both.
 *
 * Fires `onOrphaned` at most once: the interval is cleared the moment the
 * parent is found gone, and a boolean guard backs that up in case a tick was
 * already queued when it fired. `server/index.ts`'s `onOrphaned` re-sends
 * itself SIGTERM, and that handler is not itself guarded against re-entry —
 * without this, a still-alive-but-slow `registry.disposeAll()` would see a
 * second SIGTERM before the first shutdown finished, since nothing here
 * would otherwise stop checking (a dead parent does not come back) and
 * `onOrphaned` would fire again on every subsequent tick.
 *
 * Returns the interval so a caller that wants to stop watching early (tests
 * do) can `clearInterval` it. Production never needs to: the process either
 * notices its parent died — at which point this has already cleared itself —
 * or is asked to stop by that same parent first.
 */
export function installTestParentWatchdog(
  parentPidAtBoot: number,
  onOrphaned: () => void,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  let fired = false;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (fired) return;
    if (!isAlive(parentPidAtBoot)) {
      fired = true;
      clearInterval(timer);
      onOrphaned();
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
