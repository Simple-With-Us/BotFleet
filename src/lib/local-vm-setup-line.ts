// The Local VM card's one-line header while setup is unfinished.
//
// The harness sends a `problem` string with every status, and the card used to
// print it verbatim.  That trusts the string over the facts beside it: a
// harness that answered `daemonUp: true` could still carry "Start docker
// first" (a stale or older build, or a probe that flapped between two reads),
// and the header then told a person to start a runtime that was running.  The
// header is derived from the structured facts for the setup states, in setup
// order, and the harness's wording is used only where it describes something
// the facts cannot (a VM that exists but is unsafe, a desktop still starting).

export interface LocalVmSetupFacts {
  runtime: string | null;
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  problem: string | null;
}

export function localVmSetupLine(status: LocalVmSetupFacts | null, perBot: boolean): string {
  if (!status) return "Not ready";
  // No runtime at all: the harness may be saying why none is allowed (a
  // disabled-runtime notice), which no fact here can improve on.
  if (!status.runtime) return status.problem ?? "Install a container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  // The daemon answers.  With no image and no VM, the real next step is to
  // prepare the desktop and then create the VM; per-bot VMs are created from
  // each bot's own Computer panel, so only the first step belongs here.
  if (!status.image && status.container === "missing") {
    return perBot ? "Next: prepare the Linux desktop" : "Next: prepare the Linux desktop, then create the VM";
  }
  return status.problem ?? "Not ready";
}
