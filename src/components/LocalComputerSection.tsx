// One-place setup for which computer providers this workspace allows, and
// a master view of every bot's per-provider grant.  The redesigned
// Computer settings UI splits "which providers are available" (here)
// from "how to install the Local VM runtime" (now in
// `LocalVmRuntimeCard.tsx`); the operator-facing toggle row is the
// answer to the first, and the runtime card still owns the second.
//
// What ships in this file:
// - `<ComputerProviderToggle>` row per provider (ASCII.dev Box, Self-
//   Hosted VPS, Local VM, This Computer), each with a caption explaining
//   the impact of turning it off.
// - `<VpsModeToggle>` next to the VPS row so the operator can pick
//   Shared, Per-Bot, or Not Used.
// - `<BotComputerMatrix>` so every bot's grant is visible in one table,
//   with a one-click "Apply new default to all" that opens a confirm
//   dialog.
// - `<ComputerImpactConfirmModal>` opens before any provider toggle
//   turns off, listing the bots that would lose a leg of their grant.
//
// State lives in `state.config.botDefaults.computerProviders` (and
// `vpsMode`); writes go through `PUT /api/config` and the legacy
// `allowedComputers` field is back-filled from the new shape so the
// server-side allowlist gate keeps working through the cut-over.
import { useCallback, useMemo, useState } from "react";
import { ApiError, api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { ComputerProviderToggle } from "./ComputerProviderToggle";
import { VpsModeToggle } from "./VpsModeToggle";
import { BotComputerMatrix } from "./BotComputerMatrix";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { engineReachKnown, instanceSupportsLocalComputer } from "@/lib/local-computer";
import { ComputerImpactConfirmModal } from "./ComputerImpactConfirmModal";
import { impactedBotsForProvider, mergeServerImpact, revalidateImpact, type ImpactedBot } from "@/lib/computer-impact";
import {
  applyDefaultsBody,
  autoHostPlatform,
  impactChangedRefusal,
  providerControlsLocked,
  resolveWorkspaceProviders,
  staleProviderConfig,
} from "@/lib/workspace-providers";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  COMPUTER_PROVIDER_ORDER,
  DEFAULT_VPS_MODE,
  type ComputerProviderId,
  type ComputerProviders,
  type VpsMode,
} from "../../shared/local-auto-consent";

/** Derive the legacy `allowedComputers: Destination[]` array from the
 * new per-provider shape so the server-side allowlist gate
 * (`server/computer-grants.ts`) keeps answering the same question
 * through the cut-over.  The legacy `"cloud"` destination is
 * ambiguous between ASCII Box and Self-Hosted VPS; for the cut-over
 * we keep the legacy field's contract narrow (`["cloud"]` means
 * "either cloud backend is allowed", `null` means "every legacy
 * destination is allowed") and rely on `server/computer-grants.ts`'s
 * later `computerProviders` consult to enforce the per-backend
 * distinction.  Returns `null` only when ALL four providers are on
 * AND `selfHostedVps` is on (the only combination where every legacy
 * destination is meaningfully on). */
function allowedComputersFromProviders(providers: ComputerProviders): Array<"cloud" | "vm" | "local"> | null {
  const cloud = providers.asciiBox || providers.selfHostedVps;
  const vm = providers.localVm;
  const local = providers.localMac;
  // Every provider on (the legitimate "null = every destination is
  // allowed" answer).  Returning null here is correct: it matches the
  // legacy "no allowlist = every destination is allowed" semantics.
  if (cloud && vm && local) return null;
  // Otherwise, write an explicit narrowed array.  A partial-cloud
  // shape (only one of {asciiBox, selfHostedVps} on) intentionally
  // serializes `"cloud"` here so the server-side allowlist keeps the
  // box-vs-vps decision; the later `computerProviders` consult in
  // server/computer-grants.ts then picks the right backend.
  const result: Array<"cloud" | "vm" | "local"> = [];
  if (cloud) result.push("cloud");
  if (vm) result.push("vm");
  if (local) result.push("local");
  return result;
}

export function LocalComputerSection() {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const resolved = useMemo(() => resolveWorkspaceProviders(state.config), [state.config?.botDefaults]);
  const providers = resolved.providers;
  const vpsMode = resolved.vpsMode;
  const bots = state.bots ?? [];
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const configReady = state.config !== null && state.config !== undefined;
  const locked = providerControlsLocked(state.config, saving, state.hydration.status);
  const [error, setError] = useState<string | null>(null);
  // The provider pending confirmation: set when the user clicks an
  // enabled provider (would turn it off) and there is at least one bot
  // that currently uses it.  `null` = no modal open.
  const [impact, setImpact] = useState<{ provider: ComputerProviderId; impacted: ImpactedBot[] } | null>(null);
  // Set when the server refuses an apply-defaults with
  // `needsAcknowledgement`: the named bots would gain Auto with nobody
  // having seen the warning.  Non-null shows the shared confirm dialog;
  // confirming resubmits the same defaults with the exact identities
  // shown in the warning.
  const [pendingAck, setPendingAck] = useState<{
    bots: { id: string; name: string }[];
    request: { path: "/api/config" | "/api/bots/apply-defaults"; method: "PUT" | "POST"; body: unknown };
  } | null>(null);

  // The bots that would lose a leg of their grant if the named
  // provider were disabled.  Used both to gate the toggle (no affected
  // bots -> commit without a modal) and to populate the modal list.
  // Auto bots (`computers === undefined`) are included: their grant is
  // the workspace default, so disabling a provider does effectively
  // remove a leg of their grant, and the modal must list them so the
  // operator confirms before that change ships.
  // The Auto This Computer fallback only mounts on macOS with an
  // engine that has a local approval channel
  // (`shouldMountLocalComputer({ requested: undefined, ... })` on the
  // server).  Resolving the same gate here keeps the matrix and this
  // impact list from naming bots the runtime would never mount — a
  // Linux/Windows host or an engine without local reach means no
  // fallback, so no leg of the grant is lost when the provider turns
  // off.  While the instance list is still hydrating the engine side
  // stays fail-open (`undefined`), matching the picker.
  // The server's platform, not this window's: a browser pointed at a macOS
  // harness reports "other", which would hide every Auto bot's host grant
  // and let a This Computer disable skip the affected-bots confirm.
  const hostPlatform = autoHostPlatform(state.config, capabilities.host.platform);
  const instances = state.instances ?? [];
  const reachKnown = engineReachKnown({ instances, hydrationStatus: state.hydration.status });
  const autoLocalFor = useCallback(
    (bot: Bot) =>
      hostPlatform === undefined
        ? undefined
        : {
            hostPlatform,
            engineSupportsLocal: reachKnown ? instanceSupportsLocalComputer(instances, bot) : undefined,
          },
    [hostPlatform, instances, reachKnown],
  );
  // A routine, webhook or resource trigger set to run in the cloud gets the
  // cloud destination even on a bot whose computers are off (resolveGrants).
  // The matrix and the impact confirm read the same list.
  const automations = useMemo(
    () => ({
      routines: state.routines,
      webhooks: state.webhooks,
      resourceTriggers: state.resourceTriggers,
    }),
    [state.routines, state.webhooks, state.resourceTriggers],
  );
  const botsUsingProvider = useCallback(
    (provider: ComputerProviderId): ImpactedBot[] =>
      impactedBotsForProvider(provider, {
        bots,
        workspaceProviders: providers,
        workspaceCloudBackend: state.config?.botDefaults?.cloudBackend,
        workspaceDefaultComputers: state.config?.botDefaults?.computers,
        autoLocalFor,
        automations,
      }),
    [
      bots,
      providers,
      state.config?.botDefaults?.cloudBackend,
      state.config?.botDefaults?.computers,
      autoLocalFor,
      automations,
    ],
  );

  // Persist a new providers shape.  Always writes both the new key and
  // the legacy `allowedComputers` (back-filled from the new shape)
  // so the server-side allowlist gate stays in lock-step with the
  // operator-facing toggle.  When the server refuses with
  // `needsAcknowledgement` (e.g. enabling This Computer would newly
  // grant local Auto access to an auto-approved bot), the existing
  // `<LocalComputerAutoWarning>` dialog is opened so the operator can
  // consent and resubmit; a plain error is not surfaced in that case.
  const persist = useCallback(
    (nextProviders: ComputerProviders, nextVpsMode: VpsMode, acknowledgedImpact: readonly string[] = []) => {
      const body = {
        botDefaults: {
          computerProviders: nextProviders,
          vpsMode: nextVpsMode,
          allowedComputers: allowedComputersFromProviders(nextProviders),
        },
        // What this window showed.  The server refuses the save if the
        // stored toggles have moved since, so a stale window cannot turn a
        // provider back on that another window just turned off.
        expectedComputerProviders: providers,
        // The bots the confirm named (none when no confirm was needed).  The
        // server recomputes the impact on its own state and refuses the save
        // when it finds a bot this list did not name.
        acknowledgedImpact: [...acknowledgedImpact],
      };
      setSaving(true);
      setError(null);
      api("/api/config", { method: "PUT", body: JSON.stringify(body) })
        .then((config: ConfigStatus) => {
          dispatch({ type: "configStatus", config });
        })
        .catch((e) => {
          if (e instanceof ApiError && Array.isArray(e.body?.needsAcknowledgement) && e.body.needsAcknowledgement.length > 0) {
            setPendingAck({
              bots: e.body.needsAcknowledgement,
              request: { path: "/api/config", method: "PUT", body },
            });
            return;
          }
          const refusal = impactChangedRefusal(e);
          if (refusal) {
            if (refusal.config) dispatch({ type: "configStatus", config: refusal.config });
            const disabled = COMPUTER_PROVIDER_ORDER.find((id) => providers[id] === true && nextProviders[id] !== true);
            if (disabled) {
              setImpact({
                provider: disabled,
                impacted: mergeServerImpact(botsUsingProvider(disabled), refusal.impacted, disabled),
              });
              return;
            }
          }
          const stale = staleProviderConfig(e);
          if (stale) dispatch({ type: "configStatus", config: stale });
          setError(e.message);
        })
        .finally(() => setSaving(false));
    },
    [dispatch, providers, botsUsingProvider],
  );

  const handleProviderToggle = (provider: ComputerProviderId, next: boolean) => {
    if (locked) return;
    if (!next) {
      // Disable path.  If any bot currently uses the provider, gate
      // the change on the modal; otherwise commit immediately.
      const impacted = botsUsingProvider(provider);
      if (impacted.length === 0) {
        const nextProviders = { ...providers, [provider]: false };
        // Disabling the VPS provider clears its mode.  Other providers
        // leave the existing mode untouched (the VPS mode is its
        // question; the cloudBackend for the ASCII Box provider is
        // unrelated).
        persist(nextProviders, provider === "selfHostedVps" ? null : vpsMode);
        return;
      }
      setImpact({ provider, impacted });
      return;
    }
    // Enable path: no modal, the only impact is that more bots can use
    // the provider from this point on.  When re-enabling the VPS
    // provider after a disable, atomically restore the shipped
    // default mode so the toggle and the mode control do not
    // deadlock — the operator would otherwise have to pick a mode
    // before re-enabling, with no UI path to do either first.
    const nextProviders = { ...providers, [provider]: true };
    const nextVpsMode = provider === "selfHostedVps" && vpsMode === null ? DEFAULT_VPS_MODE : vpsMode;
    persist(nextProviders, nextVpsMode);
  };

  // The mode control and the VPS toggle drive the same state, so neither
  // may refuse on account of the other.  Picking a mode while the VPS is
  // off turns it on with that mode in one save; picking "Not Used" while it
  // is on goes through the same disable path as the toggle, impact confirm
  // included.
  const handleVpsModeChange = (next: VpsMode) => {
    if (locked) return;
    if (next === null) {
      if (providers.selfHostedVps) handleProviderToggle("selfHostedVps", false);
      return;
    }
    persist({ ...providers, selfHostedVps: true }, next);
  };

  // Apply workspace defaults to every bot.  Mirrors the existing
  // `BotComputerDefaults.tsx` consent handshake: the server may refuse
  // with `needsAcknowledgement` if any bot would gain This Computer +
  // Auto with nobody having seen the warning.  The handler stores the
  // original request (path + method + body) so the acknowledgement
  // dialog can resubmit to the SAME endpoint — a `PUT /api/config`
  // toggle must not accidentally route through `/api/bots/apply-defaults`.
  const submitRequest = (
    request: { path: "/api/config" | "/api/bots/apply-defaults"; method: "PUT" | "POST"; body: unknown },
    acknowledgedBots?: { id: string; name: string }[],
    busySignal?: "apply" | "save",
  ) => {
    if (busySignal === "apply") setApplying(true);
    else if (busySignal === "save") setSaving(true);
    setError(null);
    api(request.path, {
      method: request.method,
      body: JSON.stringify({
        ...(request.body as Record<string, unknown>),
        ...(acknowledgedBots ? { acknowledgeLocalAuto: true, acknowledgedBots } : {}),
      }),
    })
      .then((response: ConfigStatus | { applied: number; config: ConfigStatus }) => {
        setPendingAck(null);
        const config = "config" in response ? response.config : response;
        dispatch({ type: "configStatus", config });
      })
      .catch((e) => {
        if (e instanceof ApiError && Array.isArray(e.body?.needsAcknowledgement) && e.body.needsAcknowledgement.length > 0) {
          setPendingAck({ bots: e.body.needsAcknowledgement, request });
        } else {
          // An acknowledged resubmit carries the same expected toggles, so
          // it can go stale too; show the current state it was refused for.
          setPendingAck(null);
          const refusal = impactChangedRefusal(e);
          if (refusal) {
            if (refusal.config) dispatch({ type: "configStatus", config: refusal.config });
            const sent = (request.body as { botDefaults?: { computerProviders?: ComputerProviders } } | null)
              ?.botDefaults?.computerProviders;
            const disabled = sent
              ? COMPUTER_PROVIDER_ORDER.find((id) => providers[id] === true && sent[id] !== true)
              : undefined;
            if (disabled) {
              setImpact({
                provider: disabled,
                impacted: mergeServerImpact(botsUsingProvider(disabled), refusal.impacted, disabled),
              });
              return;
            }
          }
          const stale = staleProviderConfig(e);
          if (stale) dispatch({ type: "configStatus", config: stale });
          setError(e.message);
        }
      })
      .finally(() => {
        if (busySignal === "apply") setApplying(false);
        else if (busySignal === "save") setSaving(false);
      });
  };

  const applyToAll = () => {
    if (!configReady) return;
    submitRequest(
      {
        path: "/api/bots/apply-defaults",
        method: "POST",
        body: applyDefaultsBody(state.config?.botDefaults),
      },
      undefined,
      "apply",
    );
  };

  return (
    <>
      <Card
        title="Providers"
        subtitle="The computer providers any bot in this workspace is allowed to use.  Disabling a provider here keeps every bot off it, no matter what a bot's own settings say.  Leave the shipped set on to keep the current behavior."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {COMPUTER_PROVIDER_ORDER.map((id) => (
            <ComputerProviderToggle
              key={id}
              provider={id}
              enabled={providers[id]}
              busy={locked}
              onToggle={(next) => handleProviderToggle(id, next)}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-1.5 border-t border-hairline/40 pt-4">
          <div className="text-[12px] font-medium text-ink">Self-Hosted VPS Mode</div>
          <VpsModeToggle value={vpsMode} busy={locked} onChange={handleVpsModeChange} />
        </div>
        {configReady && resolved.resolvedFromLegacy && (
          <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            Loaded from the legacy <code className="font-mono">allowedComputers</code> shape.  The next save will write the new per-provider key alongside it.
          </div>
        )}
      </Card>

      <Card
        title="Bots"
        subtitle="Which providers every bot in this workspace has.  Per-bot edits live in each bot's settings; the matrix is the master view."
      >
        <BotComputerMatrix
          bots={bots}
          workspaceProviders={providers}
          workspaceDefaultComputers={state.config?.botDefaults?.computers}
          workspaceCloudBackend={state.config?.botDefaults?.cloudBackend}
          hostPlatform={hostPlatform}
          instances={instances}
          instancesReady={reachKnown}
          automations={automations}
          busy={applying || saving || !configReady}
          onApplyToAll={applyToAll}
        />
      </Card>

      {error && (
        <div className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger" title={error}>
          {error}
        </div>
      )}

      <ComputerImpactConfirmModal
        open={impact !== null}
        disabledProvider={impact?.provider ?? "asciiBox"}
        bots={impact?.impacted ?? []}
        busy={saving}
        onCancel={() => setImpact(null)}
        onConfirm={() => {
          if (!impact) return;
          // The list was computed when the modal opened.  Bots, grants and
          // automations can change while it is open, so recompute it now: a
          // bot the operator never saw listed must not lose the provider on
          // this click.  If the list grew, show the new one and ask again.
          const decision = revalidateImpact(impact.impacted, botsUsingProvider(impact.provider));
          if (decision.kind === "changed") {
            setImpact({ provider: impact.provider, impacted: decision.impacted });
            return;
          }
          if (locked || providers[impact.provider] !== true) {
            // Already off (another window saved it) or a save is in flight.
            setImpact(null);
            return;
          }
          const nextProviders = { ...providers, [impact.provider]: false };
          setImpact(null);
          persist(
            nextProviders,
            impact.provider === "selfHostedVps" ? null : vpsMode,
            impact.impacted.map((bot) => bot.id),
          );
        }}
      />

      <LocalComputerAutoWarning
        open={pendingAck !== null}
        onCancel={() => setPendingAck(null)}
        bots={pendingAck?.bots}
        busy={applying || saving}
        onConfirm={() => {
          if (!pendingAck) return;
          // Resubmit to the SAME endpoint the original request went to.
          // The acknowledgement dialog is a single consent handshake;
          // routing a provider toggle through /api/bots/apply-defaults
          // would unexpectedly reconfigure every bot on confirm.
          const busySignal = pendingAck.request.path === "/api/bots/apply-defaults" ? "apply" : "save";
          submitRequest(pendingAck.request, pendingAck.bots, busySignal);
        }}
      />
    </>
  );
}
