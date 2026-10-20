/** Small, injected controller so lifecycle decisions can be exercised without a VM. */
export interface ControlTarget { key: string; label: string }
export interface ControlVm { key: string; name: string; running: boolean; state: string }
export interface ControlDeps<T extends ControlTarget> {
  targets(): T[];
  status(target: T): Promise<{ container: string }>;
  owner(target: T): string | undefined;
  busy(): boolean;
  action(action: "stop" | "run", target: T): Promise<void>;
  afterStop(target: T): void;
}

export class ControlConflict extends Error {}

/** Reserve shutdown before its first await.  All callbacks are synchronous. */
export function reserveSystemShutdown(options: {
  guard(): void;
  activeWorkCount(): number;
  fence(): void;
  unfence(): void;
}): { release(): void } {
  options.guard();
  const count = options.activeWorkCount();
  if (count > 0) throw new ControlConflict(`${count} active operation(s) must finish before the server can stop`);
  options.fence();
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    options.unfence();
  } };
}

export function createSystemControl<T extends ControlTarget>(deps: ControlDeps<T>) {
  const guard = (targets: T[]) => {
    if (deps.busy()) throw new ControlConflict("a bot, Local VM setup, or lifecycle change is active");
    const owned = targets.find((target) => deps.owner(target));
    if (owned) throw new ControlConflict(`the Local VM ${owned.label} is being used by a bot`);
  };
  const inspect = async (targets: T[]) => {
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
      if (state.container !== "missing") {
        throw new ControlConflict("This Local VM cannot safely resume.  Recreate it in Computer settings; its disk has been preserved.");
      }
      guard(targets);
      await deps.action("run", shared);
      return { key: shared.key, name: shared.label, running: true, state: "running" };
    },
  };
}
