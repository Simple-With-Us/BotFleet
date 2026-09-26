import type { ComputerProviderId } from "../shared/local-auto-consent.ts";
import type { JsonValue } from "./schema.ts";

// Which top-level config keys a `PUT /api/config` can change without
// rebuilding the provider fleet.  `reloadProviders()` disposes every
// provider and interrupts every in-flight turn, so only a key a driver
// actually reads may trigger it.
//
// Profile, voice, VPS, and room timeout changes do not rebuild the fleet:
// no driver reads them.  Terminology is only a display word, so renaming
// rooms must never kill a turn that is running.  `botDefaults` (the
// workspace computer providers, VPS mode, the New Bots default and the
// legacy allowlist) is read per turn by `resolveTurnComputerMounts` from
// the live `cfg`, never by a driver, so flipping a provider toggle in
// Settings must not rebuild the fleet.  A provider turned OFF is still a
// revocation, though: the turns that hold it are interrupted one by one
// (see `disabledComputerProviders` / `turnUsesComputerProvider`) while every
// other turn keeps running.
export const CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD: ReadonlySet<string> = new Set([
  "profile",
  "tts",
  "imageGen",
  "vps",
  "rooms",
  "localVm",
  "autoUpdate",
  "ingress",
  "usage",
  "observability",
  "infisical",
  "features",
  "terminology",
  "terminologyCustom",
  "conversationMode",
  "botDefaults",
]);

/** The keys in a config patch that require rebuilding the provider fleet. */
export function providerReloadKeys(patch: Record<string, JsonValue>): string[] {
  return Object.keys(patch).filter((key) => !CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD.has(key));
}

type ProviderFlags = Partial<Record<ComputerProviderId, boolean>> | null | undefined;
type Destination = "cloud" | "vm" | "local";

const PROVIDER_IDS: readonly ComputerProviderId[] = ["asciiBox", "selfHostedVps", "localVm", "localMac"];

/** Whether the runtime treats a provider as on.  Mirrors the per-turn filter
 * in `server/computer-grants.ts`: an install with no `computerProviders` yet
 * keeps the legacy behavior (every provider available), and once the object
 * exists only an explicit `true` is on. */
function providerOn(providers: ProviderFlags, id: ComputerProviderId): boolean {
  return providers == null ? true : providers[id] === true;
}

/** Providers a config save turned from on to off.  An off-to-on change, or
 * no change, interrupts nothing: granting more cannot invalidate a turn. */
export function disabledComputerProviders(before: ProviderFlags, after: ProviderFlags): ComputerProviderId[] {
  return PROVIDER_IDS.filter((id) => providerOn(before, id) && !providerOn(after, id));
}

/** Providers a save revoked through the legacy `botDefaults.allowedComputers`
 * allowlist.  An older client narrows only that field; before the per-provider
 * pass existed, such a save rebuilt the fleet and so revoked every mount, and
 * it must still revoke the mounts it removes.  `null` is every destination
 * allowed.  The legacy field cannot tell Box from VPS, so removing `cloud`
 * revokes both cloud providers. */
export function legacyAllowlistRevokedProviders(
  before: readonly Destination[] | null,
  after: readonly Destination[] | null,
): ComputerProviderId[] {
  const allows = (list: readonly Destination[] | null, destination: Destination) =>
    list === null || list.includes(destination);
  const revoked = (destination: Destination) => allows(before, destination) && !allows(after, destination);
  const result: ComputerProviderId[] = [];
  if (revoked("cloud")) result.push("asciiBox", "selfHostedVps");
  if (revoked("vm")) result.push("localVm");
  if (revoked("local")) result.push("localMac");
  return result;
}

/** Everything a config save took away: per-provider toggles turned off plus
 * destinations removed from the legacy allowlist, in provider order. */
export function revokedComputerProviders(
  before: { providers: ProviderFlags; allowed: readonly Destination[] | null },
  after: { providers: ProviderFlags; allowed: readonly Destination[] | null },
): ComputerProviderId[] {
  const revoked = new Set([
    ...disabledComputerProviders(before.providers, after.providers),
    ...legacyAllowlistRevokedProviders(before.allowed, after.allowed),
  ]);
  return PROVIDER_IDS.filter((id) => revoked.has(id));
}

/** Whether a turn resolved under the pre-save settings may be using one of
 * `disabled`.  Conservative for Auto bots: an Auto turn may have reached any
 * destination the auto path was still allowed to look at, so it counts as
 * holding that provider.  The cloud destination maps to exactly one provider,
 * picked by the resolved cloud backend. */
export function turnUsesComputerProvider(
  turn: {
    granted: readonly Destination[];
    auto: boolean;
    autoAllows: readonly Destination[];
    cloudBackend: "box" | "vps";
  },
  disabled: readonly ComputerProviderId[],
): boolean {
  if (disabled.length === 0) return false;
  const reaches = (destination: Destination) =>
    turn.granted.includes(destination) || (turn.auto && turn.autoAllows.includes(destination));
  const held = new Set<ComputerProviderId>();
  if (reaches("cloud")) held.add(turn.cloudBackend === "box" ? "asciiBox" : "selfHostedVps");
  if (turn.granted.includes("vm")) held.add("localVm");
  if (reaches("local")) held.add("localMac");
  return disabled.some((id) => held.has(id));
}

/** Whether a provider is closed to new use under the current settings, by
 * either spelling: its Computer settings toggle is off, or the legacy
 * `allowedComputers` allowlist excludes its destination.  Turn mounting
 * already honors both (`resolveGrants` plus the per-provider filter), so the
 * lifecycle routes that provision, wake, join or start a computer must too;
 * otherwise an older client that narrows only the legacy field keeps a billed
 * Box or VPS, or the Local VM, one click away. */
export function computerProviderBlocked(
  providers: ProviderFlags,
  allowed: readonly Destination[] | null,
  id: ComputerProviderId,
): boolean {
  if (!providerOn(providers, id)) return true;
  const destination: Destination = id === "localVm" ? "vm" : id === "localMac" ? "local" : "cloud";
  return allowed !== null && !allowed.includes(destination);
}

/** The providers a turn can actually hold under one set of settings: its
 * resolved grant (`resolveGrants`), mapped through the cloud backend, then
 * the per-provider filter — the same steps turn mounting takes.  Auto counts
 * every destination the auto path may still look at. */
export function heldComputerProviders(
  turn: {
    granted: readonly Destination[];
    auto: boolean;
    autoAllows: readonly Destination[];
    cloudBackend: "box" | "vps";
  },
  providers: ProviderFlags,
): ComputerProviderId[] {
  const reaches = (destination: Destination) =>
    turn.granted.includes(destination) || (turn.auto && turn.autoAllows.includes(destination));
  const held: ComputerProviderId[] = [];
  if (reaches("cloud")) held.push(turn.cloudBackend === "box" ? "asciiBox" : "selfHostedVps");
  if (turn.granted.includes("vm")) held.push("localVm");
  if (reaches("local")) held.push("localMac");
  return PROVIDER_IDS.filter((id) => held.includes(id) && providerOn(providers, id));
}

/** What a save took away from one running turn: providers it held under the
 * old settings and no longer holds under the new ones.  This covers every way
 * `botDefaults` can revoke a mount, not just the provider toggles: the legacy
 * allowlist, the workspace default an Auto bot inherits (say `local` to
 * `cloud`), and the workspace cloud backend. */
export function revokedTurnProviders(
  before: readonly ComputerProviderId[],
  after: readonly ComputerProviderId[],
): ComputerProviderId[] {
  return before.filter((id) => !after.includes(id));
}

/** A provider-settings save carries the flags its window saw, and the server
 * refuses it when the stored flags have moved since: otherwise a stale second
 * window, writing the whole four-flag object, silently turns back on a
 * provider another window just turned off.  `current` is what the server
 * resolves today (stored flags, or the legacy migration); `expected` is what
 * the client showed. */
export function computerProvidersStale(
  expected,
  current: Record<ComputerProviderId, boolean>,
): boolean {
  // SAFETY: tag-check without `typeof`; only plain JSON objects can be the
  // expected flags shape a client window sent.
  if (!expected || Object.prototype.toString.call(expected) !== "[object Object]" || Array.isArray(expected)) return true;
  // SAFETY: same invariant — after the JSON-object guard, the cast to a
  // Record keeps the per-id boolean lookups below honest.
  const shown = expected as Record<string, JsonValue>;
  return PROVIDER_IDS.some((id) => shown[id] !== current[id]);
}

/** The bots a provider disable would take something from that the window did
 * not show when the operator confirmed.  `acknowledged` is the list of bot ids
 * the confirm named (or none, when no confirm was shown); `impacted` is what
 * the server finds on its own bots and automations at save time.  Anything
 * left over was added by another client after the window checked, and must be
 * confirmed before the save goes through.  A list that only shrank passes. */
export function unacknowledgedImpact<T extends { id: string }>(acknowledged, impacted: readonly T[]): T[] {
  // SAFETY: array-element tag-check without `typeof`; the cast to string is
  // exact after the toString-call filter.
  const seen = new Set(
    Array.isArray(acknowledged) ? acknowledged.filter((id): id is string => Object.prototype.toString.call(id) === "[object String]") : [],
  );
  return impacted.filter((bot) => !seen.has(bot.id));
}
