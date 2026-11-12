// The workspace's effective computer providers, as the Computer settings
// section reads them, and whether its controls may write yet.  Kept out of
// the component so it can be tested without a browser.
import type { ConfigStatus } from "@/state/store";
import {
  DEFAULT_VPS_MODE,
  migrateAllowedComputersToProviders,
  type ComputerProviders,
  type VpsMode,
} from "../../shared/local-auto-consent";

/** Derive the new per-provider shape from the legacy allowlist array,
 * for the read path on configs that pre-date the migration.  Uses
 * `migrateAllowedComputersToProviders` itself so the renderer and the
 * boot migrations cannot disagree: null/undefined is every provider on,
 * [] is every provider off. */
function providersFromAllowedComputers(allowed: Array<"cloud" | "vm" | "local"> | null | undefined): {
  providers: ComputerProviders;
  vpsMode: VpsMode;
} {
  return migrateAllowedComputersToProviders(allowed);
}

/** True while the provider controls must not write.  Before the config
 * has hydrated, `resolveWorkspaceProviders` has nothing to read and falls
 * back to the every-provider-on default; a toggle saved from that state
 * would re-enable providers that are off on disk, and skip the impact
 * confirm because the bots look like they use nothing it would remove.
 *
 * The config is not the only input to that confirm.  Bots, routines,
 * webhooks and resource triggers arrive on their own requests, and the
 * impact list reads all of them (a Off bot with a cloud automation still
 * uses the cloud backend).  So the lock also holds until the whole
 * hydration pass has finished: a disable clicked while the automations are
 * still in flight would find no affected bot and save without asking. */
export function providerControlsLocked(
  config: ConfigStatus | null | undefined,
  saving: boolean,
  hydrationStatus: "idle" | "loading" | "ready" | "failed" = "ready",
): boolean {
  return saving || config === null || config === undefined || hydrationStatus !== "ready";
}

/** Resolve the workspace's effective providers, applying the migration
 * fall-through on configs that have not been migrated yet.  Returns
 * both the providers and the resolved VPS mode so the parent can hand
 * them to the toggles without re-doing the same lookup. */
export function resolveWorkspaceProviders(config: ConfigStatus | null | undefined): {
  providers: ComputerProviders;
  vpsMode: VpsMode;
  resolvedFromLegacy: boolean;
} {
  const defaults = config?.botDefaults;
  if (defaults?.computerProviders) {
    return {
      providers: {
        asciiBox: Boolean(defaults.computerProviders.asciiBox),
        selfHostedVps: Boolean(defaults.computerProviders.selfHostedVps),
        localVm: Boolean(defaults.computerProviders.localVm),
        localMac: Boolean(defaults.computerProviders.localMac),
      },
      vpsMode: defaults.vpsMode ?? (defaults.computerProviders.selfHostedVps ? DEFAULT_VPS_MODE : null),
      resolvedFromLegacy: false,
    };
  }
  const legacy = providersFromAllowedComputers(defaults?.allowedComputers);
  return {
    providers: legacy.providers,
    vpsMode: legacy.providers.selfHostedVps ? (defaults?.vpsMode ?? legacy.vpsMode ?? DEFAULT_VPS_MODE) : null,
    resolvedFromLegacy: true,
  };
}

/** The body "Apply new default to all" sends: the workspace computer
 * defaults and nothing else.  Provider policy (toggles, VPS mode, legacy
 * allowlist) goes through `PUT /api/config` only, where the consent and
 * revocation gates run; the apply route refuses it.  Sending this window's
 * copy of the toggles could also write back a stale state over a newer one.
 * With no stored default the body is empty and the server applies what it
 * has. */
export function applyDefaultsBody(
  botDefaults: { computers?: Array<"cloud" | "vm" | "local">; cloudBackend?: "box" | "vps" } | null | undefined,
): { botDefaults?: { computers?: Array<"cloud" | "vm" | "local">; cloudBackend?: "box" | "vps" } } {
  const next: { computers?: Array<"cloud" | "vm" | "local">; cloudBackend?: "box" | "vps" } = {};
  if (botDefaults?.computers !== undefined) next.computers = [...botDefaults.computers];
  if (botDefaults?.cloudBackend !== undefined) next.cloudBackend = botDefaults.cloudBackend;
  return Object.keys(next).length > 0 ? { botDefaults: next } : {};
}

/** The current config a stale provider save was refused with (409
 * `computer_providers_stale`), so the window can show the real toggles
 * instead of the ones it tried to write over.  Null for any other error. */
export function staleProviderConfig(error: unknown): ConfigStatus | null {
  const body = (error as { status?: unknown; body?: { code?: unknown; config?: unknown } } | null)?.body;
  if (!body || body.code !== "computer_providers_stale") return null;
  const config = body.config;
  return config && typeof config === "object" ? (config as ConfigStatus) : null;
}

/** The refusal a provider disable gets (409 `computer_impact_changed`) when
 * the server finds bots the confirmed list did not name: those bots, and the
 * current config.  Null for any other error. */
export function impactChangedRefusal(
  error: unknown,
): { impacted: { id: string; name: string }[]; config: ConfigStatus | null } | null {
  const body = (error as { body?: { code?: unknown; impacted?: unknown; config?: unknown } } | null)?.body;
  if (!body || body.code !== "computer_impact_changed" || !Array.isArray(body.impacted)) return null;
  const impacted = body.impacted
    .filter((bot): bot is { id: string; name?: unknown } =>
      Boolean(bot) && typeof bot === "object" && typeof (bot as { id?: unknown }).id === "string")
    .map((bot) => ({ id: bot.id, name: typeof bot.name === "string" ? bot.name : bot.id }));
  const config = body.config && typeof body.config === "object" ? (body.config as ConfigStatus) : null;
  return { impacted, config };
}

/** The host platform the Auto This Computer fallback is judged against: the
 * one the server reports, because that is where turns run.  A desktop app
 * talking to its own server knows it locally too, so that is the fallback for
 * an older server that does not report it.  A plain browser knows nothing
 * ("other"), and guessing from it hid every Auto bot's host grant, so with
 * neither source the answer is `undefined`, which keeps the matrix's
 * optimistic default. */
export function autoHostPlatform(
  config: ConfigStatus | null | undefined,
  clientPlatform: "darwin" | "linux" | "win32" | "other",
): "darwin" | "linux" | "win32" | "other" | undefined {
  const reported = config?.host?.platform;
  if (typeof reported === "string" && reported) {
    return reported === "darwin" || reported === "linux" || reported === "win32" ? reported : "other";
  }
  return clientPlatform === "other" ? undefined : clientPlatform;
}
