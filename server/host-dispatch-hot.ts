import { readHostLoad, type HostLoad } from "./drivers/acp/init-deadline.ts";
import { createHostProbe, type HostProbe } from "./jobs/admission.ts";
import { webhookDispatchHoldReason, webhookDispatchHot } from "./resource-triggers.ts";

/** Lazy host probe shared by webhook admission and engine describe deferral. */
let sharedProbe: HostProbe | undefined;

function hostDispatchInputs() {
  sharedProbe ??= createHostProbe();
  return {
    swapUsedPercent: sharedProbe.swapUsedPercent(),
    load: readHostLoad(),
  };
}

export function hostDispatchHotFromMetrics(metrics: {
  swapUsedPercent: number | null;
  load: HostLoad | null;
}): boolean {
  return webhookDispatchHot(metrics);
}

/** Why a new unattended webhook wake is waiting on the host, or null when cool.
 *  Uses the same swap and load inputs as `webhookDispatchHot`. */
export function readHostDispatchHoldReason(): string | null {
  return webhookDispatchHoldReason(hostDispatchInputs());
}

/** Whether the host is hot enough that new unattended work should wait.
 *  Uses the same swap and load inputs as `webhookDispatchHot`. */
export function readHostDispatchHot(): boolean {
  return hostDispatchHotFromMetrics(hostDispatchInputs());
}

/** Test hook — reset the lazy probe between cases. */
export function resetHostDispatchHotProbe(): void {
  sharedProbe = undefined;
}
