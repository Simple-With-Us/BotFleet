import type { CloudBackend } from "../../server/contracts.ts";
import type { ComputerReach } from "../../server/computer-capability.ts";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

/** The engine's shipped reach, or `null` when the picker has never heard of
 *  the engine at all.  `null` is NOT "no reach": an engine the client does
 *  not know is one the server may well accept, so the callers below let the
 *  server have the last word instead of graying a working destination out.
 *  A known engine whose row carries no reach stays fail-closed. */
function reachFor(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): ComputerReach | null {
  const instance = instances.find(
    (candidate) => candidate.instanceId === bot.modelSelection.instanceId,
  );
  if (!instance) return null;
  return instance.computerReach ?? { box: false, vps: false, vm: false, local: false };
}

/** Can this bot's engine drive the host — the user's own Mac?
 *
 * Host control is the one destination that needs an approval CHANNEL and not
 * just a transport, so it rides its own driver flag.  An engine that can
 * mount a computer as an MCP server has said nothing about whether its asks
 * can reach a person. */
export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  return reachFor(instances, bot)?.local === true;
}

/** Whether the Runs-on “This computer” control should be clickable.
 *  macOS keeps the destination available even before CUA has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet.  Sign out and choose Ubuntu on Xorg to use This Computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME.  Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Computer Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Computer Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  return "Computer Driver is not ready for local computer control.";
}

export function linuxAutoDescription(): string {
  return "Auto uses an ASCII.dev Box when one is configured; otherwise computer use stays off.";
}

export function autoSelectsLocalComputer({
  platform,
  computers,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computers: Bot["computers"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return (
    platform !== "linux" &&
    !(computers ?? []).includes("cloud") &&
    !(computers ?? []).includes("vm") &&
    capabilitiesReady &&
    localSelectable
  );
}

/** Can this bot's engine drive a Local VM?
 *
 * The server refuses at turn time (`server/index.ts`, the `wantsVm` gate),
 * and refusing there alone cost a real fleet 51 failed turns: the person
 * picked a destination the button offered, sent work, and found out when
 * the turn died.  So the picker answers the SAME rule before the choice is
 * made — never show a knob the driver cannot turn — by looking the shipped
 * reach up rather than restating it.  Why each transport reaches what it
 * reaches lives in `server/computer-capability.ts`. */
export function instanceSupportsLocalVm(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const reach = reachFor(instances, bot);
  if (!reach) return true; // unknown engine: let the server have the last word
  return reach.vm;
}

/** Can this bot's engine mount a cloud computer at all?
 *
 * "Cloud" is not one destination: it resolves to a hosted box or a container
 * on the person's own server, and the two have DIFFERENT engine rules — the
 * box-native engine reaches its own box and is refused a VPS outright.  So
 * the resolved backend is an argument: the caller has already resolved it
 * (`resolveCloudBackend`), and a helper that guessed `"box"` is exactly how
 * a VPS-backed bot came to be offered Cloud and then die at
 * `server/vps-computer.ts`'s `vpsDriverError`. */
export function instanceSupportsCloudComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
  cloudBackend: CloudBackend,
): boolean {
  const reach = reachFor(instances, bot);
  if (!reach) return true;
  return cloudBackend === "vps" ? reach.vps : reach.box;
}

/** Is the engine list loaded, so the reach answers above can be believed?
 *
 * The helpers fail OPEN for an instance the picker has never heard of, which
 * is the right answer for an unknown ENGINE and the wrong one for a list that
 * has not arrived yet.  `/api/instances` hydrates in parallel with the panel
 * and a cold describe costs tens of seconds (`server/harness/registry.ts`),
 * so during that window every bot looks like an unknown engine.  A caller
 * that acts on fail-open there is not offering a destination optimistically —
 * the computer panel's cloud lifecycle sends
 * `POST /api/bots/:id/computer/provision`, which performs no capability check
 * of its own and starts a container, or a BILLED ASCII.dev Box.  So the
 * lifecycle holds until this answers true rather than spending on a guess.
 *
 * It cannot hold forever on a fleet that genuinely has no engines: hydration
 * turns `ready` whether or not any row came back, and that ends the hold with
 * the list believed empty.  A FAILED hydrate keeps holding, which is the
 * point — nothing is known, and the app retries and re-hydrates on the next
 * stream hello. */
export function engineReachKnown({
  instances,
  hydrationStatus,
}: {
  instances: InstanceInfo[];
  hydrationStatus: AppState["hydration"]["status"];
}): boolean {
  return instances.length > 0 || hydrationStatus === "ready";
}

/** Shown while the engine list has not arrived, so a grey remote choice is
 *  never a silent control and never a claim about an engine we have not seen. */
export const COMPUTER_REACH_CHECKING = "Checking which computers this engine can use.";

function engineDisplayName(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): string {
  const engine = instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  const name = engine?.displayName?.trim();
  return name ? name : "This engine";
}

/** Host tools only: no box, no VPS, no Local VM.  That is the harness HTTP
 *  tool loop (Grok, MiniMax, OpenAI-compatible). */
function isLocalOnlyReach(reach: ComputerReach | null): boolean {
  return reach !== null && reach.local && !reach.box && !reach.vps && !reach.vm;
}

function localHostPhrase(platformIsMac: boolean): string {
  return platformIsMac ? "this Mac" : "this computer";
}

/** One sentence for an engine that cannot leave the host. */
export function localOnlyComputerReason(name: string, platformIsMac: boolean): string {
  return `${name} runs only on ${localHostPhrase(platformIsMac)}.`;
}

/** Why a computer destination is not offered, in the words the picker shows.
 * `null` means it is available. */
export function computerDestinationDisabledReason(
  mode: "cloud" | "vm",
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
  cloudBackend: CloudBackend,
  platformIsMac = true,
): string | null {
  const supported =
    mode === "vm"
      ? instanceSupportsLocalVm(instances, bot)
      : instanceSupportsCloudComputer(instances, bot, cloudBackend);
  if (supported) return null;
  const name = engineDisplayName(instances, bot);
  const reach = reachFor(instances, bot);
  if (isLocalOnlyReach(reach)) return localOnlyComputerReason(name, platformIsMac);
  return mode === "vm"
    ? `${name} cannot drive a Local VM.\u00A0 Choose Claude or an ACP engine, or another destination.`
    : `${name} cannot drive a remote desktop.\u00A0 Choose Claude or an ACP engine, or another destination.`;
}

/** The line under the Box / Self-hosted VPS control.
 *
 * `null` means both remote backends are available, so the control stays
 * quiet.  A local-only engine gets one plain sentence instead of a tooltip
 * on a button that still looks clickable. */
export function cloudBackendUnavailableNote(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
  platformIsMac: boolean,
): string | null {
  const vps = instanceSupportsCloudComputer(instances, bot, "vps");
  const box = instanceSupportsCloudComputer(instances, bot, "box");
  if (vps && box) return null;
  const name = engineDisplayName(instances, bot);
  const reach = reachFor(instances, bot);
  if (isLocalOnlyReach(reach)) return localOnlyComputerReason(name, platformIsMac);
  if (!vps && !box) return `${name} cannot use a remote computer.`;
  if (!vps) {
    return `${name} can't run a desktop on your own server.\u00A0 Pick an engine that can control a computer, such as Claude, to use Self-hosted VPS.`;
  }
  return `${name} cannot drive a remote desktop.\u00A0 Choose Claude or an ACP engine, or another destination.`;
}

/** The one line under Runs On.
 *
 * The cloud-backend picker owns the remote explanation whenever it is on
 * screen.  Skipping only an identical string left a Box-only engine with two
 * sentences: Runs On said it cannot drive a remote desktop, while the picker
 * correctly said Self-hosted VPS is the part it cannot use. */
export function runsOnDisabledNote(
  cloudReason: string | null,
  vmReason: string | null,
  pickerNote: string | null,
  pickerVisible: boolean,
): string | null {
  const pickerOwnsRemote = pickerVisible && Boolean(pickerNote);
  if (!pickerOwnsRemote && cloudReason) return cloudReason;
  if (vmReason && !(pickerVisible && vmReason === pickerNote)) return vmReason;
  return null;
}
