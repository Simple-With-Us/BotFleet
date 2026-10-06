import { readHostLoad, type HostLoad } from "./drivers/acp/init-deadline.ts";
import { createHostProbe, type HostProbe } from "./jobs/admission.ts";
import { webhookDispatchHot } from "./resource-triggers.ts";

/** Lazy host probe shared by webhook admission and engine describe deferral. */
let sharedProbe: HostProbe | undefined;

export function hostDispatchHotFromMetrics(metrics: {
  swapUsedPercent: number | null;
  load: HostLoad | null;
}): boolean {
  return webhookDispatchHot(metrics);
}

/** Whether the host is hot enough that new unattended work should wait.
 *  Uses the same swap and load inputs as `webhookDispatchHot`. */
export function readHostDispatchHot(): boolean {
  sharedProbe ??= createHostProbe();
  return hostDispatchHotFromMetrics({
    swapUsedPercent: sharedProbe.swapUsedPercent(),
    load: readHostLoad(),
  });
}

/** Test hook — reset the lazy probe between cases. */
export function resetHostDispatchHotProbe(): void {
  sharedProbe = undefined;
}
