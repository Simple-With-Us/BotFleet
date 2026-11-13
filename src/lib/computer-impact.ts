// Which bots lose something when the operator turns a computer provider
// off, and how to name what they use in product terms.
//
// The list has to match what the runtime actually mounts, which is
// `resolveGrants` plus the per-provider filter in
// `server/computer-grants.ts`.  Two rules there matter here:
//
// - A turn started by a routine, webhook or resource trigger with
//   `runOn: "cloud"` gets the cloud destination whatever the bot's own
//   computers say, including a bot whose computers are turned off.
// - The per-provider filter then drops that cloud destination when the
//   bot's resolved backend (its own `cloudBackend`, else the workspace
//   default, else Box) is the provider being turned off.
//
// So a bot with an enabled cloud automation uses its resolved cloud
// backend even when `providersForBot` says it has no computer at all,
// and turning that backend off breaks the automation.
import type { Bot } from "@/state/store";
import {
  cloudAutomationKindsFor,
  effectiveProvidersForBot,
  providersForBot,
  type AutoLocalFallback,
  type CloudAutomationKind,
  type CloudAutomations,
} from "@/components/BotComputerMatrix";
import {
  COMPUTER_PROVIDER_LABEL,
  COMPUTER_PROVIDER_ORDER,
  type ComputerProviderId,
  type ComputerProviders,
} from "../../shared/local-auto-consent";

export type { CloudAutomationSource, CloudAutomations } from "@/components/BotComputerMatrix";

const AUTOMATION_LABEL: Record<CloudAutomationKind, string> = {
  routine: "Cloud Routine",
  webhook: "Cloud Webhook",
  resourceTrigger: "Cloud Resource Trigger",
};

export type ImpactedBot = {
  id: string;
  name: string;
  /** What the bot uses today, in product names ("Auto", "ASCII.dev Box",
   * "Cloud Routine on Self-Hosted VPS"), for the confirm list. */
  usage: string;
  /** Per-provider state the bot currently has, counting cloud automations. */
  providers: ComputerProviders;
};

export type ImpactInput = {
  bots: readonly Bot[];
  workspaceProviders: ComputerProviders | undefined;
  workspaceCloudBackend?: "box" | "vps";
  workspaceDefaultComputers?: readonly ("cloud" | "vm" | "local")[];
  autoLocalFor?: (bot: Bot) => AutoLocalFallback | undefined;
  automations?: CloudAutomations;
};

/** Every bot with the provider in its effective grant, with a product-name
 * description of what it uses.  Mirrors `resolveGrants` and the
 * per-provider filter; see the file header. */
export function impactedBotsForProvider(provider: ComputerProviderId, input: ImpactInput): ImpactedBot[] {
  const result: ImpactedBot[] = [];
  for (const bot of input.bots) {
    const off = bot.computers !== undefined && bot.computers.length === 0;
    const granted = providersForBot(
      bot,
      input.workspaceProviders,
      input.workspaceCloudBackend,
      input.workspaceDefaultComputers,
      input.autoLocalFor?.(bot),
    );
    // Same derivation the matrix renders, so the two never disagree.
    const providers: ComputerProviders = effectiveProvidersForBot(bot, {
      workspaceProviders: input.workspaceProviders,
      workspaceCloudBackend: input.workspaceCloudBackend,
      workspaceDefaultComputers: input.workspaceDefaultComputers,
      autoLocal: input.autoLocalFor?.(bot),
      automations: input.automations,
    });
    const kinds = cloudAutomationKindsFor(bot.id, input.automations);
    const cloudProvider: ComputerProviderId =
      (bot.cloudBackend ?? input.workspaceCloudBackend ?? "box") === "box" ? "asciiBox" : "selfHostedVps";
    const cloudBackendOn = input.workspaceProviders ? input.workspaceProviders[cloudProvider] === true : true;
    if (providers[provider] !== true) continue;

    const parts: string[] = [];
    const grantedNames = COMPUTER_PROVIDER_ORDER.filter((id) => granted[id]).map((id) => COMPUTER_PROVIDER_LABEL[id]);
    if (bot.computers === undefined) {
      parts.push(grantedNames.length > 0 ? `Auto (${grantedNames.join(", ")})` : "Auto");
    } else if (!off) {
      parts.push(...grantedNames);
    }
    if (kinds.length > 0 && cloudBackendOn) {
      parts.push(`${kinds.map((kind) => AUTOMATION_LABEL[kind]).join(", ")} on ${COMPUTER_PROVIDER_LABEL[cloudProvider]}`);
    }
    result.push({ id: bot.id, name: bot.name, usage: parts.join(" · "), providers });
  }
  return result;
}

/** Re-check a disable-impact list at confirm time against a fresh one.
 * `changed` when the fresh list names a bot the shown list did not, or
 * describes a listed bot's usage differently: the operator confirmed a list
 * that is no longer the truth, so it has to be shown again.  A list that only
 * shrank is still covered by what was confirmed. */
export function revalidateImpact(
  shown: readonly ImpactedBot[],
  current: readonly ImpactedBot[],
): { kind: "confirmed" } | { kind: "changed"; impacted: ImpactedBot[] } {
  const seen = new Map(shown.map((bot) => [bot.id, bot.usage]));
  const changed = current.some((bot) => seen.get(bot.id) !== bot.usage);
  return changed ? { kind: "changed", impacted: [...current] } : { kind: "confirmed" };
}

/** Fold the bots the server named when it refused a disable (409
 * `computer_impact_changed`) into this window's own list.  The server judges
 * on its own bots and automations, so it can know a bot this window has not
 * heard about yet; such a bot is listed by name with a plain usage line, and
 * the confirm then acknowledges every bot either side found. */
export function mergeServerImpact(
  local: readonly ImpactedBot[],
  server: readonly { id: string; name: string }[],
  provider: ComputerProviderId,
): ImpactedBot[] {
  const known = new Set(local.map((bot) => bot.id));
  const extra = server
    .filter((bot) => !known.has(bot.id))
    .map((bot): ImpactedBot => ({
      id: bot.id,
      name: bot.name,
      usage: COMPUTER_PROVIDER_LABEL[provider],
      providers: { asciiBox: false, selfHostedVps: false, localVm: false, localMac: false, [provider]: true },
    }));
  return [...local, ...extra];
}
