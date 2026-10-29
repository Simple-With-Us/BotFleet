/** Small, injected controller so lifecycle decisions can be exercised without a VM. */
export interface ControlTarget { key: string; label: string }
export interface ControlVm { key: string; name: string; running: boolean; state: string }
export interface ControlDeps<T extends ControlTarget> {
  targets(): T[];
  status(target: T): Promise<{ container: string }>;
  /** Optional: read every target's state in one pass, keyed by target key.
   *
   *  `status` is called once per target, and each call repeats the probes
   *  that are identical for every target: is a container runtime usable, and
   *  is the prepared desktop image there.  With N targets that is N runtime
   *  probes and N image probes for the same answers.  A caller that can share
   *  those probes passes `statusAll` and gets one shared pass instead.  A
   *  target the batch does not answer falls back to `status`. */
  statusAll?(targets: T[]): Promise<Map<string, { container: string }>>;
  owner(target: T): string | undefined;
  busy(): boolean;
  action(action: "stop" | "run" | "start", target: T): Promise<void>;
  afterStop(target: T): void;
}

export class ControlConflict extends Error {}

export interface ShutdownReservation { release(): void }

/**
 * What is holding a stop, named the way a person would say it.
 *
 * A bare count tells the owner that something is in flight but not what to
 * do about it: the number is a sum over ~18 kinds of work, and the Control
 * app's confirmation dialog counts only bot turns.  So a refusal could say
 * "2 active operation(s) must finish" while the dialog right above it said
 * "0 bot turn(s) are active", which reads as a contradiction rather than as
 * an explanation.  Naming the kinds turns the refusal into something the
 * owner can act on: wait for the routine, stop the bot, or quit it.
 */
export interface BlockingWork {
  /** The count of work of this kind. */
  count: number;
  /** What to call it, e.g. "routine run" or "queued message". */
  label: string;
}

/**
 * Reserve shutdown before its first await.  All callbacks are synchronous.
 *
 * `blockingWork` is optional and only shapes the refusal message: a caller
 * that cannot name its kinds still gets a correct, countable refusal.
 */
export function reserveSystemShutdown(options: {
  guard(): void;
  activeWorkCount(): number;
  /** The kinds of work in flight, for a refusal the owner can act on. */
  blockingWork?(): BlockingWork[];
  fence(): void;
  unfence(): void;
}): ShutdownReservation {
  options.guard();
  const count = options.activeWorkCount();
  if (count > 0) throw new ControlConflict(shutdownRefusal(count, options.blockingWork?.()));
  options.fence();
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    options.unfence();
  } };
}

/** The message the owner sees when a stop is refused. */
export function shutdownRefusal(count: number, blocking?: BlockingWork[]): string {
  const head = `${count} active operation(s) must finish before the server can stop`;
  const named = (blocking ?? []).filter((entry) => entry.count > 0);
  if (!named.length) return head;
  const breakdown = named.map((entry) => `${entry.count} ${entry.label}${entry.count === 1 ? "" : "s"}`).join(", ");
  return `${head}: ${breakdown}`;
}

export function createSystemControl<T extends ControlTarget>(deps: ControlDeps<T>) {
  const guard = (targets: T[]) => {
    if (deps.busy()) throw new ControlConflict("a bot, Local VM setup, or lifecycle change is active");
    const owned = targets.find((target) => deps.owner(target));
    if (owned) throw new ControlConflict(`the Local VM ${owned.label} is being used by a bot`);
  };
  const inspect = async (targets: T[]) => {
    if (deps.statusAll) {
      const shared = await deps.statusAll(targets);
      return Promise.all(targets.map(async (target) => ({
        target,
        state: shared.get(target.key) ?? await deps.status(target),
      })));
    }
    const states = await Promise.all(targets.map(async (target) => ({ target, state: await deps.status(target) })));
    return states;
  };
  return {
    guard: () => guard(deps.targets()),
    async list(): Promise<ControlVm[]> {
      return (await inspect(deps.targets())).map(({ target, state }) => ({
        key: target.key, name: target.label, running: state.container === "running", state: state.container,
      }));
    },
    async stopAll(): Promise<{ stopped: boolean; note?: string }> {
      const targets = deps.targets();
      guard(targets);
      const states = await inspect(targets);
      const failures: string[] = [];
      let stopped = false;
      for (const { target, state } of states) {
        if (state.container !== "running") continue;
        // Re-check before each mutation because a new turn may take a lease
        // while an earlier VM is stopping.
        guard(targets);
        try {
          await deps.action("stop", target);
          deps.afterStop(target);
          stopped = true;
        } catch (error) {
          failures.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length) throw new Error(`Local VM stop failed: ${failures.join("; ")}`);
      return { stopped };
    },
    async startShared(): Promise<ControlVm> {
      const targets = deps.targets();
      guard(targets);
      const shared = targets.find((target) => target.key === "shared");
      if (!shared) throw new ControlConflict("the shared Local VM is unavailable");
      const state = await deps.status(shared);
      if (state.container === "running") return { key: shared.key, name: shared.label, running: true, state: "running" };
      if (state.container !== "missing" && state.container !== "created") {
        throw new ControlConflict("This Local VM cannot safely resume.  Recreate it in Computer settings; its disk has been preserved.");
      }
      guard(targets);
      await deps.action(state.container === "created" ? "start" : "run", shared);
      return { key: shared.key, name: shared.label, running: true, state: "running" };
    },
  };
}
