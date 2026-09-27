// Master view of every bot's per-provider grant.  Renders one row per
// bot with four columns (one per `ComputerProviderId`); each cell shows
// a check-mark when the bot currently has that provider in its grant,
// otherwise a neutral dash.  The header carries an "Apply new default
// to all" button that opens a confirmation modal so an operator can
// batch-set every bot's grant in one click.
//
// The matrix is intentionally read-only at the cell level: clicking a
// cell never opens a per-bot editor.  Per-bot edits live in the bot's
// own Settings panel (`SettingsPanel.tsx`'s Computer section).  The
// matrix is the canonical "what does every bot have" surface, and the
// batch button is the canonical "make everyone match the workspace
// default" surface.
import { useState } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Bot, InstanceInfo } from "@/state/store";
import { instanceSupportsLocalComputer } from "@/lib/local-computer";
import type { ComputerProviderId, ComputerProviders } from "../../shared/local-auto-consent";
import {
  COMPUTER_PROVIDER_LABEL,
  COMPUTER_PROVIDER_ORDER,
} from "../../shared/local-auto-consent";
import { ConfirmDialog } from "./ConfirmDialog";

/** What the host and the bot's engine mean for the Auto path's This
 * Computer fallback.  The server mounts that fallback only on macOS
 * with an engine whose reach includes local control
 * (`shouldMountLocalComputer({ requested: undefined, ... })` in
 * server/local-routing.ts), so lighting the column without this
 * information overstates the grant on Linux/Windows hosts and for
 * engines with no approval channel — and the disable-impact modal
 * then names bots the toggle cannot actually affect. */
export type AutoLocalFallback = {
  /** Platform of the host the server runs on
   * (`capabilities.host.platform`).  The Auto host fallback mounts on
   * macOS only: Linux local control is a beta that must be picked
   * explicitly per bot, and Windows has no local driver. */
  hostPlatform: DesktopCapabilities["host"]["platform"];
  /** The bot engine's local-computer reach (`reach.local`).  Pass
   * `undefined` while the instance list is still hydrating: an
   * unknown engine stays fail-open here, same as the picker's "the
   * server has the last word" rule, instead of flashing the column
   * dark on every load. */
  engineSupportsLocal: boolean | undefined;
};

/** Provider keys per bot.  The matrix derives this from the bot's
 * `computers[]` field (the legacy wire shape) and the workspace
 * `botDefaults.computerProviders` so a cell lights up whether the bot
 * itself selected the provider or inherited the workspace default.
 *
 * For the `"cloud"` destination, the matrix lights up exactly the
 * backend the runtime will pick: the bot's own `cloudBackend` if set,
 * else the workspace default, else `"box"`.  This matches
 * `server/computer-grants.ts:resolveCloudBackend` so the matrix
 * reflects what the bot actually has, not a fictional "cloud as
 * either backend" superset.
 *
 * For Auto bots (`computers === undefined`), the bot inherits the
 * workspace default destinations (`botDefaults.computers`); we
 * intersect those with the per-provider allowlist so an Auto bot whose
 * workspace default is `["local"]` only lights up the Local Mac
 * column, not every enabled provider.  This matches
 * `server/computer-grants.ts:resolveGrants`.  Keeping the mapping in
 * one place means a future server-side change to the grant shape only
 * touches this helper, not the cell render. */
export function providersForBot(
  bot: Bot,
  workspaceProviders: ComputerProviders | undefined,
  workspaceCloudBackend?: "box" | "vps",
  workspaceDefaultComputers?: readonly ("cloud" | "vm" | "local")[],
  autoLocal?: AutoLocalFallback,
): ComputerProviders {
  // "off" means the operator disabled the bot — no providers light up.
  if (bot.computers !== undefined && bot.computers.length === 0) {
    return { asciiBox: false, selfHostedVps: false, localVm: false, localMac: false };
  }
  // Auto (computers undefined): the bot inherits the workspace
  // default destinations, intersected with the per-provider allowlist.
  // `cloud` in the default lights the resolved backend only — same
  // rule as the explicit-selection branch below.  With no workspace
  // default the bot is on true Auto, which lights only what the auto
  // path can mount.
  if (bot.computers === undefined) {
    const defaultComputers = workspaceDefaultComputers ?? [];
    const fromDefault = {
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: false,
    };
    // Auto bots route through the bot's own cloudBackend first, same as
    // `resolveCloudBackend` on the server.
    const resolvedCloud: "box" | "vps" = bot.cloudBackend ?? workspaceCloudBackend ?? "box";
    if (defaultComputers.length === 0) {
      // No workspace default: the server's auto path (`AUTO_DESTINATIONS`
      // in server/computer-grants.ts) looks for the resolved cloud backend
      // and falls back to this computer.  It never reaches the Local VM or
      // the other cloud backend, so those columns stay dark.
      if (resolvedCloud === "box") fromDefault.asciiBox = true;
      else fromDefault.selfHostedVps = true;
      // The host fallback is gated the same way the server gates it
      // (`shouldMountLocalComputer({ requested: undefined, ... })`):
      // macOS only, and only for an engine with a local approval
      // channel.  A caller that cannot say keeps the historical
      // optimistic answer; an unknown engine stays fail-open.
      fromDefault.localMac =
        autoLocal === undefined ||
        (autoLocal.hostPlatform === "darwin" && autoLocal.engineSupportsLocal !== false);
    } else {
      for (const dest of defaultComputers) {
        if (dest === "cloud") {
          if (resolvedCloud === "box") fromDefault.asciiBox = true;
          else fromDefault.selfHostedVps = true;
        } else if (dest === "vm") {
          fromDefault.localVm = true;
        } else if (dest === "local") {
          fromDefault.localMac = true;
        }
      }
    }
    // Intersect with the per-provider allowlist so a workspace default
    // that lists `cloud` does NOT light up the Box column when the
    // operator has since turned the Box provider off.
    return {
      asciiBox: fromDefault.asciiBox && Boolean(workspaceProviders?.asciiBox),
      selfHostedVps: fromDefault.selfHostedVps && Boolean(workspaceProviders?.selfHostedVps),
      localVm: fromDefault.localVm && Boolean(workspaceProviders?.localVm),
      localMac: fromDefault.localMac && Boolean(workspaceProviders?.localMac),
    };
  }
  // Explicit selection: map each legacy destination back onto the
  // provider keys.  "cloud" lights the resolved backend only —
  // `asciiBox` if the runtime would pick Box, `selfHostedVps` if it
  // would pick VPS.  This stops the matrix from reporting a
  // nonexistent grant when the operator toggles one cloud backend off
  // while the bot's resolved backend is the other.
  let asciiBox = false;
  let selfHostedVps = false;
  let localVm = false;
  let localMac = false;
  const resolvedCloud: "box" | "vps" = bot.cloudBackend ?? workspaceCloudBackend ?? "box";
  for (const dest of bot.computers) {
    if (dest === "cloud") {
      if (resolvedCloud === "box") asciiBox = true;
      else selfHostedVps = true;
    } else if (dest === "vm") {
      localVm = true;
    } else if (dest === "local") {
      localMac = true;
    }
  }
  // Intersect with the per-provider allowlist, same as the Auto branch, so
  // an explicit ["vm"] or ["cloud"] grant does NOT light a provider the
  // operator has turned off.  An install with no `computerProviders` yet
  // defers to the legacy allowlist, same as `server/computer-grants.ts`.
  if (!workspaceProviders) return { asciiBox, selfHostedVps, localVm, localMac };
  return {
    asciiBox: asciiBox && Boolean(workspaceProviders.asciiBox),
    selfHostedVps: selfHostedVps && Boolean(workspaceProviders.selfHostedVps),
    localVm: localVm && Boolean(workspaceProviders.localVm),
    localMac: localMac && Boolean(workspaceProviders.localMac),
  };
}

/** The minimum a routine, webhook or resource trigger needs to say for the
 * matrix and the impact list: whose it is, where it runs, and whether it
 * can fire. */
export type CloudAutomationSource = {
  botId: string;
  runOn: "bot" | "cloud";
  enabled: boolean;
};

export type CloudAutomations = {
  routines?: readonly CloudAutomationSource[];
  webhooks?: readonly CloudAutomationSource[];
  resourceTriggers?: readonly CloudAutomationSource[];
};

export type CloudAutomationKind = "routine" | "webhook" | "resourceTrigger";

/** Which of the bot's automations run in the cloud and can fire. */
export function cloudAutomationKindsFor(botId: string, automations: CloudAutomations | undefined): CloudAutomationKind[] {
  if (!automations) return [];
  const kinds: CloudAutomationKind[] = [];
  const has = (list: readonly CloudAutomationSource[] | undefined) =>
    (list ?? []).some((item) => item.botId === botId && item.enabled && item.runOn === "cloud");
  if (has(automations.routines)) kinds.push("routine");
  if (has(automations.webhooks)) kinds.push("webhook");
  if (has(automations.resourceTriggers)) kinds.push("resourceTrigger");
  return kinds;
}

/** The cloud provider a bot's cloud automations run on, or null when it has
 * none that can fire or that backend is off.  `runOn: "cloud"` grants the
 * cloud destination whatever the bot's own computers say (`resolveGrants`),
 * including a bot turned Off, and the per-provider filter then keeps it only
 * while the resolved backend is on. */
export function cloudAutomationProviderFor(
  bot: Bot,
  automations: CloudAutomations | undefined,
  workspaceProviders: ComputerProviders | undefined,
  workspaceCloudBackend?: "box" | "vps",
): ComputerProviderId | null {
  if (cloudAutomationKindsFor(bot.id, automations).length === 0) return null;
  const provider: ComputerProviderId =
    (bot.cloudBackend ?? workspaceCloudBackend ?? "box") === "box" ? "asciiBox" : "selfHostedVps";
  const on = workspaceProviders ? workspaceProviders[provider] === true : true;
  return on ? provider : null;
}

/** Everything a bot can reach: its own grant (`providersForBot`) plus the
 * cloud backend its cloud automations run on.  The matrix and the
 * disable-impact list both read this, so a cell and the confirm list never
 * disagree about a bot. */
export function effectiveProvidersForBot(
  bot: Bot,
  input: {
    workspaceProviders: ComputerProviders | undefined;
    workspaceCloudBackend?: "box" | "vps";
    workspaceDefaultComputers?: readonly ("cloud" | "vm" | "local")[];
    autoLocal?: AutoLocalFallback;
    automations?: CloudAutomations;
  },
): ComputerProviders {
  const providers = {
    ...providersForBot(
      bot,
      input.workspaceProviders,
      input.workspaceCloudBackend,
      input.workspaceDefaultComputers,
      input.autoLocal,
    ),
  };
  const cloud = cloudAutomationProviderFor(bot, input.automations, input.workspaceProviders, input.workspaceCloudBackend);
  if (cloud) providers[cloud] = true;
  return providers;
}

export type BotComputerMatrixProps = {
  bots: Bot[];
  workspaceProviders: ComputerProviders | undefined;
  /** Workspace default destinations (`botDefaults.computers`) — used
   * to compute the inherited grant for Auto bots (`computers ===
   * undefined`).  Without this hint, an Auto bot whose workspace
   * default is `["local"]` would light up every enabled provider in
   * the matrix, overstating the bot's actual grant. */
  workspaceDefaultComputers?: readonly ("cloud" | "vm" | "local")[];
  /** Workspace default cloud backend — used by Auto bots with `cloud`
   * in their inherited default. */
  workspaceCloudBackend?: "box" | "vps";
  /** Platform of the host the server runs on — gates the Auto This
   * Computer fallback so non-macOS hosts do not light a grant the
   * runtime will never mount.  Omit to keep the optimistic answer. */
  hostPlatform?: DesktopCapabilities["host"]["platform"];
  /** Engine rows (`state.instances`) used to resolve each bot's
   * local-computer reach for the same fallback. */
  instances?: InstanceInfo[];
  /** Whether `instances` can be believed yet (`engineReachKnown`).
   * While false, every engine is unknown and the fallback stays
   * fail-open instead of flashing dark during hydration. */
  instancesReady?: boolean;
  /** Routines, webhooks and resource triggers.  A cloud one grants its bot
   * the resolved cloud backend even when the bot's computers are off, so
   * the matrix lights that cell the way the impact confirm counts it. */
  automations?: CloudAutomations;
  /** Disabled while the apply-all-to-bots save is in flight, so the
   * button does not double-fire and the rows do not flicker. */
  busy?: boolean;
  /** Called when the operator confirms "Apply new default to all".
   * The parent is expected to fire `POST /api/bots/apply-defaults`
   * with the workspace defaults and surface any `needsAcknowledgement`
   * the server returns. */
  onApplyToAll: () => void | Promise<void>;
};

export function BotComputerMatrix({
  bots,
  workspaceProviders,
  workspaceDefaultComputers,
  workspaceCloudBackend,
  hostPlatform,
  instances,
  instancesReady,
  automations,
  busy,
  onApplyToAll,
}: BotComputerMatrixProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-testid="bot-computer-matrix">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">
          Per-bot grants
        </div>
        <button
          type="button"
          disabled={busy || bots.length === 0}
          onClick={() => setConfirmOpen(true)}
          className={cn(
            "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110",
            (busy || bots.length === 0) && "opacity-50",
          )}
          data-testid="matrix-apply-default-button"
        >
          {busy ? "Applying…" : "Apply new default to all"}
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-hairline/40">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-control text-[11.5px] uppercase tracking-wide text-ink-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Bot</th>
              {COMPUTER_PROVIDER_ORDER.map((id) => (
                <th key={id} className="px-3 py-2 text-center font-medium">
                  {COMPUTER_PROVIDER_LABEL[id]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bots.length === 0 ? (
              <tr>
                <td colSpan={COMPUTER_PROVIDER_ORDER.length + 1} className="px-3 py-3 text-center text-ink-secondary">
                  No bots yet.
                </td>
              </tr>
            ) : (
              bots.map((bot) => {
                const providers = effectiveProvidersForBot(bot, {
                  workspaceProviders,
                  workspaceCloudBackend,
                  workspaceDefaultComputers,
                  autoLocal:
                    hostPlatform === undefined
                      ? undefined
                      : {
                          hostPlatform,
                          engineSupportsLocal:
                            instancesReady && instances ? instanceSupportsLocalComputer(instances, bot) : undefined,
                        },
                  automations,
                });
                const isOff = bot.computers !== undefined && bot.computers.length === 0;
                return (
                  <tr key={bot.id} className="border-t border-hairline/40">
                    <td className="px-3 py-2 text-ink">
                      <span className={cn(isOff && "text-ink-secondary")}>{bot.name}</span>
                      {isOff && (
                        <span className="ml-2 rounded bg-hairline/40 px-1.5 py-0.5 text-[10.5px] uppercase text-ink-secondary">
                          Off
                        </span>
                      )}
                    </td>
                    {COMPUTER_PROVIDER_ORDER.map((id) => {
                      const on = providers[id] === true;
                      return (
                        <td key={id} className="px-3 py-2 text-center">
                          {on ? (
                            <span
                              className="inline-flex size-5 items-center justify-center rounded-full bg-accent/15 text-accent"
                              data-testid={`matrix-cell-${bot.id}-${id}-on`}
                              aria-label={`${bot.name}: ${COMPUTER_PROVIDER_LABEL[id]} on`}
                            >
                              <Check size={12} />
                            </span>
                          ) : (
                            <span
                              className="inline-flex size-5 items-center justify-center text-ink-secondary"
                              data-testid={`matrix-cell-${bot.id}-${id}-off`}
                              aria-label={`${bot.name}: ${COMPUTER_PROVIDER_LABEL[id]} off`}
                            >
                              <Minus size={12} />
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Apply the workspace default to every bot?"
        body="Every bot in this workspace will be set to the workspace default, intersected with the provider toggles above.  Bots you have already turned off stay off."
        confirmLabel="Apply to all"
        destructive={false}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setConfirmOpen(false);
          await onApplyToAll();
        }}
      />
    </div>
  );
}
