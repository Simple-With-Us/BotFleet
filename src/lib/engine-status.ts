// Two engine states the rail, Settings and Usage must not read as setup
// problems.  Shared so every surface answers the same way.
import type { InstanceInfo } from "@/state/store";

/** The last probe gave no answer (a CLI that did not respond in time on a
 *  busy Mac) and there is no earlier answer to stand in for it.  Not "not
 *  installed", not "sign-in required" — the next probe settles it. */
export function isCheckingEngine(instance: Pick<InstanceInfo, "snapshot"> | undefined): boolean {
  return instance?.snapshot.transient === true;
}

/** An optional integration nobody has set up (the ASCII.dev Box engine with no Box token):
 *  left out of the engine rail, Settings → Engines and the Usage rows until
 *  it is configured. */
export function isHiddenEngine(instance: Pick<InstanceInfo, "snapshot"> | undefined): boolean {
  return instance?.snapshot.hidden === true;
}

/** Nothing on this machine can run a bot: every engine has answered and none
 *  is available.  An engine still being checked might be, so it holds the
 *  "install an engine" screen back — a busy Mac is not an empty one. */
export function noEngineCanRun(instances: readonly Pick<InstanceInfo, "snapshot">[]): boolean {
  return (
    instances.length > 0 &&
    !instances.some((instance) => instance.snapshot.state === "available" || isCheckingEngine(instance))
  );
}
