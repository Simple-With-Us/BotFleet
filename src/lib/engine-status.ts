// Two engine states the rail, Settings and Usage must not read as setup
// problems.  Shared so every surface answers the same way.
import type { InstanceInfo } from "@/state/store";

/** The last probe gave no answer (a CLI that did not respond in time on a
 *  busy Mac) and there is no earlier answer to stand in for it.  Not "not
 *  installed", not "sign-in required" — the next probe settles it. */
export function isCheckingEngine(instance: Pick<InstanceInfo, "snapshot"> | undefined): boolean {
  return instance?.snapshot.transient === true;
}

/** An optional integration nobody has set up (Computer with no Box token):
 *  left out of the engine rail, Settings → Engines and the Usage rows until
 *  it is configured. */
export function isHiddenEngine(instance: Pick<InstanceInfo, "snapshot"> | undefined): boolean {
  return instance?.snapshot.hidden === true;
}
