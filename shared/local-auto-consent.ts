export interface LocalAutoConsentBot {
  id: string;
  name: string;
}

export type LocalComputerDestination = "cloud" | "vm" | "local";

/** The four computer providers the operator can enable. Each maps to one or
 * more legacy `LocalComputerDestination`s (see
 * `migrateAllowedComputersToProviders`). `localMac` is the host running the
 * app ("This Computer"); `localVm` is a containerized CUA desktop the
 * operator has prepared on this machine; `asciiBox` is the hosted
 * ASCII.dev Box; `selfHostedVps` is a container on the operator's own
 * server, reached over SSH. */
export type ComputerProviderId = "asciiBox" | "selfHostedVps" | "localVm" | "localMac";

/** Persisted allowlist of enabled providers. `true` means "the operator
 * has turned this provider on"; `false` means "the operator has turned
 * it off, and any bot that still references it loses that leg of its
 * grant".  A missing key defaults to `false` so a partial save is
 * fail-closed: an unknown future provider simply reads as off. */
export type ComputerProviders = Record<ComputerProviderId, boolean>;

/** Shared vs per-bot mode for the self-hosted VPS.  `shared` means every
 * bot that has `selfHostedVps` in its grant shares one managed container
 * (the shipped default); `per-bot` means each bot gets a private container
 * and durable workspace.  `null` means "the operator has not chosen a
 * mode" — only legal when `selfHostedVps` is also off, otherwise the
 * migration raises. */
export type VpsMode = "shared" | "per-bot" | null;

/** Provider labels in the operator UI.  Centralized so the toggle row,
 * the matrix header, and any future tooltip stay in sync. */
export const COMPUTER_PROVIDER_LABEL: Record<ComputerProviderId, string> = {
  asciiBox: "ASCII.dev Box",
  selfHostedVps: "Self-Hosted VPS",
  localVm: "Local VM",
  localMac: "This Computer",
};

/** Caption the toggle row shows under the button when the provider is on,
 * explaining what turning it off would actually do to existing grants. */
export const COMPUTER_PROVIDER_DISABLE_IMPACT: Record<ComputerProviderId, string> = {
  asciiBox: "Turning this off blocks every bot that currently uses ASCII.dev Box.  Each affected bot would need a new computer picked manually.",
  selfHostedVps: "Turning this off stops new use of the VPS; existing containers and workspaces stay until removed.  Bots that use it lose the VPS until they get another computer.",
  localVm: "Turning this off stops the Local VM container from starting.  Affected bots lose their VM desktop.",
  localMac: "Turning this off keeps every bot off this computer.  Bots that use This Computer lose it, and Auto approvals stop working for them.",
};

/** Sentinel value used by the schema migrator when the stored config
 * carries the legacy `allowedComputers` shape.  Kept exported so the
 * boot migration in `electron/main.mjs` can name what it is replacing
 * without re-importing zod. */
export const LEGACY_ALLOWED_COMPUTERS_KEY = "allowedComputers";

/** Every provider on: the per-provider spelling of the legacy "no
 * allowlist = every destination is allowed" default.  Used when neither
 * `computerProviders` nor `allowedComputers` is on disk, so an upgrade
 * never revokes a Local VM or This Computer grant the legacy gate allowed. */
export const DEFAULT_COMPUTER_PROVIDERS: ComputerProviders = {
  asciiBox: true,
  selfHostedVps: true,
  localVm: true,
  localMac: true,
};

/** Default VPS mode whenever `selfHostedVps` is on.  Both modes are
 * implemented: shared gives every bot one container with per-bot isolated
 * desktops, per-bot gives each bot its own container and durable workspace.
 * Shared turn leases are keyed per bot while lifecycle stays on one container. */
export const DEFAULT_VPS_MODE: VpsMode = "shared";

/** All four keys as a stable iteration order so tests and UI code do not
 * depend on `Object.keys` (which is insertion-order in modern engines but
 * worth pinning here). */
export const COMPUTER_PROVIDER_ORDER: readonly ComputerProviderId[] = [
  "asciiBox",
  "selfHostedVps",
  "localVm",
  "localMac",
] as const;

/** Migrate a legacy `allowedComputers: ("cloud" | "vm" | "local")[]` to
 * the new `ComputerProviders` shape.  Each entry of the legacy array maps
 * to one or more provider keys:
 * - `"cloud"` enabled both hosted Box and self-hosted VPS, so the
 *   legacy `["cloud"]` becomes `{ asciiBox: true, selfHostedVps: true }`.
 * - `"vm"` enables only the Local VM.
 * - `"local"` enables only the host.
 *
 * Three distinct input shapes are honored:
 * - `null` / `undefined`: legacy meaning was "every destination is
 *   allowed", which translates to all four providers on.  The caller
 *   can pass a `vpsMode`; absent that we pin it to `shared` (the
 *   runtime default the server has always assumed when "cloud" was
 *   allowed).
 * - `[]` (empty array): an explicit deny-all.  Preserved verbatim —
 *   every provider off, `vpsMode: null`.  A config that intentionally
 *   disabled everything must NOT silently re-enable Box and VPS on
 *   upgrade.
 * - non-empty array: each entry maps to the provider keys above.
 *
 * Throws if the migrated shape would land a `null` vpsMode with
 * `selfHostedVps: true` — that is the lone combination the new schema
 * refuses, because the VPS container's mode is its first question. */
export function migrateAllowedComputersToProviders(
  allowedComputers: readonly LocalComputerDestination[] | null | undefined,
  vpsMode?: VpsMode,
): { providers: ComputerProviders; vpsMode: VpsMode } {
  // Fresh install or legacy "every destination is allowed": all four
  // providers on.  A fresh install has no `allowedComputers` and the
  // legacy "null = every destination is allowed" answer lands here
  // for any workspace that never narrowed the allowlist.
  if (allowedComputers === null || allowedComputers === undefined) {
    return {
      providers: { ...DEFAULT_COMPUTER_PROVIDERS },
      vpsMode: vpsMode ?? DEFAULT_VPS_MODE,
    };
  }
  if (!Array.isArray(allowedComputers) || allowedComputers.length === 0) {
    // Explicit deny-all: preserved verbatim.  Every provider off, no
    // VPS mode (the VPS provider is off, so the mode question is
    // moot).
    return { providers: { asciiBox: false, selfHostedVps: false, localVm: false, localMac: false }, vpsMode: null };
  }
  const providers: ComputerProviders = {
    asciiBox: false,
    selfHostedVps: false,
    localVm: false,
    localMac: false,
  };
  let hasCloud = false;
  for (const dest of allowedComputers) {
    if (dest === "cloud") {
      providers.asciiBox = true;
      providers.selfHostedVps = true;
      hasCloud = true;
    } else if (dest === "vm") {
      providers.localVm = true;
    } else if (dest === "local") {
      providers.localMac = true;
    }
    // any unrecognized entry is silently ignored — the saved shape is
    // already type-checked at write time, but a hand-edited file is
    // tolerated rather than crashing the boot migration.
  }
  const resolvedVpsMode: VpsMode = vpsMode !== undefined ? vpsMode : hasCloud ? DEFAULT_VPS_MODE : null;
  if (providers.selfHostedVps && resolvedVpsMode === null) {
    throw new Error("Cannot migrate to computerProviders: vpsMode is null but selfHostedVps is enabled");
  }
  return { providers, vpsMode: resolvedVpsMode };
}

/** Idempotency check for the boot migration: if the stored config already
 * carries the new shape, return `true` so the migrator knows to skip the
 * write.  A config with both keys (the brief window after deploy but
 * before the first save) also returns `true` — the existing
 * `computerProviders` wins, and `allowedComputers` is left untouched for
 * the legacy code paths that still read it. */
export function computerProvidersAlreadyMigrated(value: unknown): boolean {
  return typeof value === "object" && value !== null && "computerProviders" in value;
}

/** Host and engine facts that only the automatic-discovery fallback needs.
 * Explicit and inherited Local grants stay consent-relevant without them. */
export type LocalAutoConsentCapability = {
  hostPlatform?: string;
  providerSupportsLocal?: boolean;
};

/** Whether Auto mode can gain host control from this stored selection.
 * Explicit and inherited Local grants remain consent-relevant while the
 * allowlist blocks them because they become active when it is widened.  A
 * truly unconfigured bot uses automatic discovery, whose host fallback is
 * the Darwin Auto path in `server/local-routing.ts` and is relevant only
 * while the allowlist permits Local, the host is Darwin, and the engine
 * can broker host approvals. */
export function requiresLocalAutoConsent(
  computers: readonly (LocalComputerDestination | "off")[] | undefined,
  workspaceDefault: readonly LocalComputerDestination[] | undefined,
  allowedComputers: readonly LocalComputerDestination[] | null | undefined,
  capability: LocalAutoConsentCapability = {},
): boolean {
  if (computers !== undefined) return computers.includes("local");
  if (workspaceDefault?.length) return workspaceDefault.includes("local");
  if (capability.providerSupportsLocal === false) return false;
  if (capability.hostPlatform !== undefined && capability.hostPlatform !== "darwin") return false;
  return allowedComputers == null || allowedComputers.includes("local");
}

/** The operator allowlist as host control actually sees it.  The legacy
 * `allowedComputers` array (`null` = every destination allowed) is narrowed
 * by the per-provider toggle: once `computerProviders` is stored, "This
 * Computer" is available only while `localMac === true`, the same rule
 * `resolveGrants` applies (a missing key reads as off).  Consent checks feed
 * this to `requiresLocalAutoConsent` so that turning the provider back on is
 * seen as widening the allowlist, not as no change. */
export function hostAwareAllowedComputers(
  allowedComputers: readonly LocalComputerDestination[] | null | undefined,
  providers: Partial<ComputerProviders> | undefined,
): LocalComputerDestination[] | null {
  const allowed = allowedComputers == null ? null : [...allowedComputers];
  if (!providers || providers.localMac === true) return allowed;
  const base: LocalComputerDestination[] = allowed ?? ["cloud", "vm", "local"];
  return base.filter((entry) => entry !== "local");
}

/** Consent covers exactly the identities and names shown in the warning. */
export function matchesLocalAutoConsent(value: unknown, required: LocalAutoConsentBot[]): boolean {
  if (!Array.isArray(value) || value.length !== required.length) return false;
  const remaining = new Map(required.map((bot) => [bot.id, bot.name]));
  for (const bot of value) {
    if (!bot || typeof bot !== "object" || typeof bot.id !== "string" ||
        typeof bot.name !== "string" || !remaining.has(bot.id) || remaining.get(bot.id) !== bot.name) return false;
    remaining.delete(bot.id);
  }
  return remaining.size === 0;
}
