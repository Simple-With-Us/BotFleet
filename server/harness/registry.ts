// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { usageQuotaPoller } from "../usage-quota.ts";
import { windowHeadlines, windowsLabelFromHeadlines } from "../../src/lib/quota-display.ts";
import { lastAntigravityQuotaSnapshot, quotaModelsFromSnapshot } from "../antigravity-quota.ts";
import { decodeMinimaxConfig, resolveMinimaxCredentials, type MinimaxConfig } from "../drivers/minimax.ts";
import { findCliCandidates } from "../env-path.ts";
import { applyMiniMaxBalanceToRegistry, getCachedLocalMiniMaxConfig, getMiniMaxBalance } from "../minimax-balance.ts";
import { quotaCooldowns } from "../model-fallback.ts";
import { computerReach, type ComputerReach } from "../computer-capability.ts";
import { quotaProviderForDriver } from "../quota-window-map.ts";
import type {
  AnyProviderDriver,
  InstanceConfig,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

/** The instance id the default fleet reserves for each driver whose reserved
 * id is not simply its own kind.  `isCustom` — which drives the delete button,
 * the "added by you" callout and the engine rail — asks whether an instance is
 * one the operator added rather than one the default fleet ships.
 *
 * Only the exceptions live here.  Every other driver's reserved id IS its
 * driver kind (`claude`/`claudeAgent` aside, the default fleet names each
 * instance after its engine), so the fallback below answers for a driver
 * nobody remembered to list — and answers the SAFE way: an id that is not the
 * reserved one is treated as operator-added, which offers a delete button for
 * something deletable rather than hiding one for something that is. */
const RESERVED_INSTANCE_ID = new Map<string, InstanceId>([
  ["openai-compat", "openaiCompat"],
  ["claudeAgent", "claude"],
  ["grokAgent", "grok"],
  ["dshAgent", "dsh"],
  ["droidAgent", "droid"],
  ["cursorAgent", "cursor"],
  ["antigravityAgent", "antigravity"],
  ["boxAgent", "computer"],
  ["kimiAgent", "kimi"],
  ["qwenAgent", "qwen"],
  ["hermesAgent", "hermes"],
  ["piAgent", "pi"],
]);

export function isCustomInstance(driverKind: string, instanceId: InstanceId): boolean {
  return instanceId !== (RESERVED_INSTANCE_ID.get(driverKind) ?? driverKind);
}

/** MiniMax's global-region API host — the value `decodeMinimaxConfig` falls
 *  back to, and the one `MinimaxDriver.create()` compares against when it
 *  decides whether ~/.mmx/config.json's host outranks the instance's own.
 *  That driver keeps its copy private (the file is a keep-out for this
 *  change), so this mirror is pinned against the driver's own behavior by
 *  registry-minimax-url.test.ts rather than left to drift. */
export const MINIMAX_DEFAULT_URL = "https://api.minimax.io/v1";

/** The host MiniMax turns for `instanceId` actually go to, reproducing
 *  `MinimaxDriver.create()`'s own precedence exactly: ~/.mmx/config.json's
 *  host (written by `mmx auth login`, machine-wide) is a workspace-wide
 *  DEFAULT, so it reaches only the reserved instance and only when nothing
 *  chose a host.
 *
 *  Whether a host was chosen is answered by the decoded config's PROVENANCE,
 *  never by comparing its url to MINIMAX_DEFAULT_URL — the driver's own gate
 *  was corrected the same way, and for the same reason: "nothing configured"
 *  and "pinned to the global host in Settings" resolve to the identical
 *  string, so a value comparison sent a reserved instance that deliberately
 *  configured the global url off to whatever region ~/.mmx names.  The two
 *  must agree, or the balance lookup asks a host the turns never bill. */
export function resolveMinimaxApiUrl(instanceId: InstanceId, config: MinimaxConfig, localUrl: string): string {
  const isReservedInstance = instanceId === "minimax";
  return isReservedInstance && config.urlSource === "default" ? localUrl : config.url;
}

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

function fullAutoOfRaw(raw: unknown): boolean {
  return (raw as { fullAuto?: unknown } | undefined)?.fullAuto === true;
}

export interface DescribedInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string;
  enabled?: boolean;
  snapshot: ProviderSnapshot;
  models: { default: string; options: Array<{ id: string; name?: string; contextWindow?: number }> };
  capabilities: {
    computerMcp: boolean;
    agentsMcp: boolean;
    localComputerMcp: boolean;
    composioMcp?: boolean;
    phoneMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly string[];
    queueing?: boolean;
    approvalReview?: boolean;
    /** True when this engine runs the harness HTTP tool loop. */
    toolLoop: boolean;
  };
  /** Which computer destinations this engine can be given at all — the ONE
   *  answer, derived from the adapter's own flags in `computer-capability.ts`
   *  and shipped so the picker looks it up rather than restating it. */
  computerReach: ComputerReach;
  access: string;
  install: unknown;
  cli: string | undefined;
  cliDefault: string | undefined;
  cliCandidates: string[];
  fullAuto: boolean;
  iconUrl?: string;
  isCustom?: boolean;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private fullAutoByInstance = new Map<InstanceId, boolean>();
  private enabledByInstance = new Map<InstanceId, boolean>();
  /** The key and host this instance's TURNS use, resolved ONCE at
   *  registration from exactly the inputs MinimaxDriver.create() receives.
   *  Resolved once rather than per describe() on purpose: the driver
   *  captures its own key and url in a closure at create() and never
   *  re-reads them, so a balance lookup that re-resolved them live would
   *  report one account's quota while every turn billed another the moment
   *  `mmx auth login --api-key …` rewrote ~/.mmx/config.json mid-session —
   *  and `minimaxInstanceCapped` feeds `quota.capped`, so that mismatch
   *  removed a usable engine from auto-fallback, or kept an exhausted one
   *  in it.  reloadInstance() re-captures, which is the same moment the
   *  driver itself picks a config change up.  Only ever set for driver
   *  "minimax". */
  private minimaxContextByInstance = new Map<InstanceId, { apiKey: string; apiUrl: string }>();
  private driversByKind: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  private async loadEntry(instanceId: InstanceId, entry: InstanceConfig): Promise<ProviderInstance | null> {
    const isFullAuto = fullAutoOfRaw(entry.config);
    if (isFullAuto) this.fullAutoByInstance.set(instanceId, true);
    else this.fullAutoByInstance.delete(instanceId);

    // Record enabled before any shadow/decode branch so a Mac-disabled
    // engine that cannot load still describes with enabled: false.  Shadows
    // used to omit the flag, and phones treat a missing enabled as on.
    const enabled = entry.enabled !== false;
    this.enabledByInstance.set(instanceId, enabled);

    const driver = this.driversByKind.get(entry.driver);
    if (!driver) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
        },
      });
      return null;
    }
    try {
      const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
      // Override detection is on the RAW config, never the decoded one:
      // decodeConfig fills in the driver default ("claude", "codex", …),
      // so reading `cli` there would flag every instance as overridden.
      const rawCli = cliOfRaw(entry.config);
      if (rawCli) this.cliByInstance.set(instanceId, rawCli);
      else this.cliByInstance.delete(instanceId);
      // Same inputs MinimaxDriver.create() below receives, resolved the
      // same way and at the same moment — retained here (rather than read
      // back off `live`, which exposes no such getter) so describeEntry's
      // balance lookup reports the account this instance's turns actually
      // bill.  The instance's own config goes through the driver's exported
      // decoder rather than `config` above, because `config` comes from
      // whichever driver object is registered for the kind and only the
      // real decoder is guaranteed to fill `url` in.
      if (entry.driver === "minimax") {
        const local = getCachedLocalMiniMaxConfig();
        const decoded = decodeMinimaxConfig(entry.config);
        this.minimaxContextByInstance.set(instanceId, {
          // resolveMinimaxCredentials's third argument restricts the
          // process.env / ~/.mmx/config.json fallback to the reserved
          // "minimax" instance, which is what stops a second MiniMax
          // connection silently inheriting the reserved instance's key —
          // and therefore its quota — when its own key is unset.
          apiKey: resolveMinimaxCredentials(entry.environment ?? {}, local, instanceId),
          apiUrl: resolveMinimaxApiUrl(instanceId, decoded, local.url),
        });
      } else {
        this.minimaxContextByInstance.delete(instanceId);
      }
      const live = await driver.create({
        instanceId,
        displayName: entry.displayName ?? driver.metadata.displayName,
        environment: entry.environment ?? {},
        enabled,
        config,
      });
      this.byId.set(instanceId, { instanceId, live });
      return live;
    } catch (e) {
      this.byId.set(instanceId, {
        instanceId,
        shadow: {
          instanceId,
          driverKind: entry.driver,
          displayName: entry.displayName ?? driver.metadata.displayName,
          cli: cliOfRaw(entry.config),
          shadow: true,
          reason: e instanceof Error ? e.message : String(e),
        },
      });
      return null;
    }
  }

  async load(configs: InstanceConfigMap) {
    this.lastDescribe = null;
    for (const [instanceId, entry] of Object.entries(configs)) {
      await this.loadEntry(instanceId, entry);
    }
  }

  /** Reload a single instance after an override/setting change without tearing
   * down the whole fleet. */
  async reloadInstance(instanceId: InstanceId, entry: InstanceConfig): Promise<ProviderInstance | null> {
    const existing = this.byId.get(instanceId);
    if (existing?.live) {
      await existing.live.dispose().catch(() => {});
    }
    return this.loadEntry(instanceId, entry);
  }

  /** Drop a single instance (deleted custom engine) without tearing down the
   * whole fleet. Mirrors reloadInstance's dispose-then-forget half, minus the
   * reload: deleting one unused custom engine must not settle every OTHER
   * bot's in-flight turn as interrupted, which a global reloadProviders()
   * would do by disposing the entire registry. */
  async removeInstance(instanceId: InstanceId): Promise<void> {
    const existing = this.byId.get(instanceId);
    if (existing?.live) {
      await existing.live.dispose().catch(() => {});
    }
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.fullAutoByInstance.delete(instanceId);
    this.enabledByInstance.delete(instanceId);
    this.minimaxContextByInstance.delete(instanceId);
    this.lastDescribe = null;
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  /** The last full describe(), shared with callers that accept a slightly
   * stale view. Probing every engine CLI (`--version`, auth status, model
   * discovery) costs seconds on a machine with many CLIs installed, and a
   * bot being created does not need a fresher answer than the rail did a
   * moment ago. In-flight describes are shared too, so a burst of callers
   * spawns one probe per engine, not one per caller. */
  private lastDescribe: { at: number; result: Promise<DescribedInstance[]> } | null = null;
  private diskCachePath: string | null = null;

  setDiskCachePath(path: string | null): void {
    this.diskCachePath = path;
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      // Legacy shape was a bare array with no captured timestamp — treat it
      // as probed now, the best available answer. The current shape carries
      // the time the probe actually finished, so a caller passing maxAgeMs
      // without staleWhileRevalidate does not treat a cache written minutes
      // or hours ago as if it just landed.
      const legacy = Array.isArray(parsed);
      const at = legacy ? Date.now() : typeof parsed?.at === "number" ? parsed.at : Date.now();
      const instances = legacy ? parsed : parsed?.instances;
      if (Array.isArray(instances) && instances.length > 0) {
        this.lastDescribe = { at, result: Promise.resolve(instances as DescribedInstance[]) };
      }
    } catch {
      // Corrupt or unreadable cache — ignore and start fresh
    }
  }

  private saveDiskCache(instances: DescribedInstance[]): void {
    if (!this.diskCachePath) return;
    try {
      const dir = dirname(this.diskCachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileAtomic(this.diskCachePath, JSON.stringify({ at: Date.now(), instances }));
    } catch {
      // Non-fatal if saving cache fails
    }
  }

  async describe(opts?: { maxAgeMs?: number; staleWhileRevalidate?: boolean }) {
    const maxAge = opts?.maxAgeMs ?? 0;
    const now = Date.now();
    const memo = this.lastDescribe;
    if (maxAge > 0 && memo && now - memo.at <= maxAge) return memo.result;

    // A caller that can live with a slightly old answer gets the previous one
    // immediately while a new probe runs behind it.  Probing every engine CLI
    // takes tens of seconds on a machine with many installed, which is longer
    // than the phone waits before giving up — so making every caller block on
    // it is what makes the model picker look empty rather than slow.
    if (opts?.staleWhileRevalidate && memo) {
      void this.refreshDescribe(now);
      return memo.result;
    }

    return this.refreshDescribe(now);
  }

  private refreshDescribe(at: number) {
    const result = this.describeFresh();
    this.lastDescribe = { at, result };
    // describeFresh() already persists the disk cache once on success (see
    // below); only guard against a failed probe here, or every probe would
    // write the cache twice.
    void result.catch(() => {
      if (this.lastDescribe?.result === result) this.lastDescribe = null;
    });
    return result;
  }

  async describeFresh(): Promise<DescribedInstance[]> {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const instances = await Promise.all(
      this.entries().map((entry) => this.describeEntry(entry, candidatesByName)),
    );
    this.saveDiskCache(instances);
    return instances;
  }

  private async describeEntry(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
  ): Promise<DescribedInstance> {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    const candidatesFor = (d: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(d);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    if (entry.shadow) {
      const enabled = this.enabledByInstance.get(entry.instanceId) ?? true;
      return {
        instanceId: entry.instanceId,
        driverKind: entry.shadow.driverKind,
        displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
        enabled,
        snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
        models: { default: "", options: [] },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false, toolLoop: false },
        // A shadow has no adapter to ask, so the derivation is fed the same
        // all-false capabilities reported above.  That leaves the box-native
        // engine reaching its own box — which is what the client computed
        // for a shadow before this was shipped rather than recomputed.
        computerReach: computerReach({
          driverKind: entry.shadow.driverKind,
          capabilities: { computerMcp: false, localComputerMcp: false },
        }),
        // an unknown driver has no driver record, hence no install path
        access: driver?.metadata.access ?? "subscription",
        install: driver?.install,
        cli: entry.shadow.cli,
        cliDefault: cliDefaultOf(driver),
        // a shadow is exactly the "your CLI is broken, pick another"
        // case where the detected-path dropdown matters most
        cliCandidates: candidatesFor(driver),
        fullAuto: this.fullAutoByInstance.get(entry.instanceId) ?? false,
        iconUrl: undefined,
        isCustom: isCustomInstance(entry.shadow.driverKind, entry.instanceId),
      };
    }
    const inst = entry.live!;
    const enabled = this.enabledByInstance.get(entry.instanceId) ?? true;
    let snapshot: ProviderSnapshot;
    if (!enabled || inst.enabled === false) {
      snapshot = { state: "unavailable", reason: "Disabled in settings" };
    } else {
      try {
        await inst.refreshModels?.();
        snapshot = await inst.snapshot();
        const wildcard = quotaCooldowns.get("*", inst.instanceId, "*")
          ?? quotaCooldowns.list().find((cd) => cd.instanceId === inst.instanceId && cd.model === "*");
        const perModel = quotaCooldowns.list().filter(
          (cd) => cd.instanceId === inst.instanceId && cd.model !== "*",
        );
        const models: NonNullable<ProviderSnapshot["quota"]>["models"] = {};
        for (const cd of perModel) {
          models[cd.model] = {
            capped: true,
            remainingPercent: null,
            resetsAt: cd.resetsAt,
            error: cd.error,
          };
        }
        const catalogIds = inst.models?.options?.map((option) => option.id) ?? [];
        if (inst.instanceId === "antigravity") {
          const agModels = quotaModelsFromSnapshot(lastAntigravityQuotaSnapshot());
          Object.assign(models, agModels);
        } else if (inst.instanceId !== "minimax") {
          // Driver kinds (e.g. "claudeAgent", "codexAgent", "grokAgent") do not match the canonical
          // provider keys quota windows are tagged with ("anthropic", "openai", "xai", ...). Use the
          // shared DRIVER_KIND_PROVIDERS map so the filter actually finds the windows; the previous
          // identity mapping made `instanceWindows` empty for every non-MiniMax engine and silently
          // dropped every injected quota window.  See Sentry thread PRRT_kwDOUHUvas6j6pZT.
          const providerKey = quotaProviderForDriver(inst.driverKind);
          if (providerKey) {
          const instanceWindows = usageQuotaPoller.getWindows().filter(w => w.providerKey === providerKey);
          if (instanceWindows.length > 0) {
            const headlines = windowHeadlines(instanceWindows as any);
            const externalWindowsLabel = windowsLabelFromHeadlines(headlines);
            const has5h = headlines.find((h) => h.bucket === "5h");
            const hasWeekly = headlines.find((h) => h.bucket === "weekly");
            const hasMonthly = headlines.find((h) => h.bucket === "monthly");
            const primary = has5h || headlines.find((h) => h.bucket === "hourly" || h.bucket === "daily");
            const secondary = hasWeekly || hasMonthly;

            const externalPrimaryPercent = primary?.remainingPercent ?? undefined;
            const externalSecondaryPercent = secondary?.remainingPercent ?? undefined;
            const isExhausted = primary?.exhausted || secondary?.exhausted;

            if (externalWindowsLabel || isExhausted) {
              for (const id of catalogIds) {
                const existing = models[id];
                models[id] = {
                  ...existing,
                  capped: existing?.capped || Boolean(isExhausted),
                  remainingPercent: existing?.remainingPercent ?? externalPrimaryPercent ?? null,
                  secondaryRemainingPercent: existing?.secondaryRemainingPercent ?? externalSecondaryPercent ?? null,
                  windowsLabel: existing?.windowsLabel ?? externalWindowsLabel,
                };
              }
            }
          }
          }
        }
        // MiniMax's Token Plan quota (server/minimax-balance.ts) reports one
        // pool PER PRODUCT ("general" = chat, "video" = video generation, …)
        // keyed by MiniMax's own pool name — every consumer of `models`
        // (ModelPicker.tsx's per-row badge and "Partial quota" chip,
        // turn-safety.ts's auto-fallback eligibility) keys by CATALOG model
        // id instead. Only "general" governs chat models, so it is the only
        // pool mapped in here — onto every id this instance's own catalog
        // reports, never hardcoded — so an exhausted, unrelated "video" pool
        // can never mislabel a chat model (or the whole engine) as capped.
        // Every pool the endpoint reported is still on `balance.models` and
        // reaches the client via `minimaxSummary` below for a future
        // "video quota" display; it just never enters this dict.
        let minimaxSummary: NonNullable<ProviderSnapshot["quota"]>["minimax"] | undefined;
        let minimaxInstanceCapped = false;
        if (inst.driverKind === "minimax") {
          // The key and host this instance's turns bill, captured at
          // loadEntry (see minimaxContextByInstance) rather than re-resolved
          // here: the driver closes over its own copy at create(), so
          // reading ~/.mmx/config.json live meant an `mmx auth login`
          // mid-session moved the quota reading to a different account than
          // the turns — and this reading is what publishes `quota.capped`.
          const ctx = this.minimaxContextByInstance.get(inst.instanceId);
          const balance = await getMiniMaxBalance(ctx?.apiKey, ctx?.apiUrl);
          // Broadcast an account-level cap (wallet empty, both Token
          // Plan windows at 0%) to every bot reusing the instance so
          // they fall to their fallback chain instead of each bot
          // re-paging the same dead wallet. Mirrors how
          // `applyAntigravityUsageToRegistry` handles Antigravity —
          // see server/antigravity-quota.ts:185 and board
          // 555c5227 for the original finding. Idempotent across
          // consecutive describe() calls; cleared automatically when
          // the balance recovers to `ok` or `near_cap`.
          applyMiniMaxBalanceToRegistry(balance);
          const general = balance.models?.general;
          // A pay-as-you-go account with an empty wallet has no "general"
          // pool at all (server/minimax-balance.ts never populates `models`
          // for an account-balance response) — without this, every catalog
          // model kept reading as uncapped while the account could not
          // actually place a call, so auto-fallback kept routing turns at
          // it instead of failing over.
          const walletExhausted = !general && balance.source === "account-balance" && balance.status === "capped";
          // BOTH of MiniMax's windows bind. A weekly allowance at 0% blocks
          // every call even while a fresh 5-hour interval still reads 100%,
          // so the per-model verdict takes the more restrictive of the two
          // (the same "most restrictive wins" rule the snapshot's own
          // status uses) and reports the reset of whichever window is
          // actually holding the account back — never the 5-hour one when
          // the week is the one that has run out.
          const generalCapped = general
            ? Math.min(general.remainingPercent ?? 100, general.secondaryRemainingPercent ?? 100) <= 0
            : walletExhausted;
          const weeklyBinds = general != null && (general.secondaryRemainingPercent ?? 100) <= 0;
          const generalResetsAt = general
            ? (weeklyBinds ? general.weeklyResetsAt ?? general.resetsAt : general.resetsAt)
            : null;
          // ModelPicker.tsx and turn-safety.ts's eligibleAutoFallbackChain
          // read only the top-level and per-model `capped` fields, never
          // `quota.minimax.status` — so an account MiniMax already reports
          // as exhausted has to reach the top-level verdict too, including
          // when this instance's catalog is momentarily empty and the
          // per-model loop below writes nothing at all.
          minimaxInstanceCapped = generalCapped;
          if (general || walletExhausted) {
            for (const id of catalogIds) {
              // A live cooldown (server/index.ts's quotaCooldowns.record, a
              // REAL 429/quota error from an actual turn) is the more
              // authoritative, real-time signal — never overwritten, only
              // filled in with the balance check's remaining-percent and
              // window label, which the cooldown loop above never sets.
              const existing = models[id];
              if (existing) {
                models[id] = {
                  ...existing,
                  remainingPercent: general?.remainingPercent ?? existing.remainingPercent,
                  secondaryRemainingPercent: general?.secondaryRemainingPercent ?? existing.secondaryRemainingPercent,
                  windowsLabel: general?.windowsLabel ?? existing.windowsLabel,
                };
              } else if (general) {
                models[id] = {
                  capped: generalCapped,
                  remainingPercent: general.remainingPercent,
                  secondaryRemainingPercent: general.secondaryRemainingPercent,
                  windowsLabel: general.windowsLabel,
                  resetsAt: generalResetsAt,
                };
              } else {
                models[id] = { capped: true, remainingPercent: 0, secondaryRemainingPercent: null, resetsAt: null };
              }
            }
          }
          minimaxSummary = {
            source: balance.source,
            capExists: balance.capExists,
            status: balance.status,
            balanceUsd: balance.balanceUsd,
            remainingPercent: balance.remainingPercent,
            secondaryRemainingPercent: balance.secondaryRemainingPercent,
            resetsAt: balance.resetsAt,
            weeklyResetsAt: balance.weeklyResetsAt,
            error: balance.error,
          };
        }
        // Generalized dual-window badge: pick it from whatever landed in
        // `models` rather than special-casing one instanceId. Antigravity's
        // antigravity-usage CLI and MiniMax's Token Plan quota (above) are
        // the two sources today; either can report a bare "5hr" reading or a
        // dual "5hr/Week" one, and a model reporting both wins over one that
        // only reports the shorter window.
        const modelsWithLabel = Object.values(models).filter((m) => m.windowsLabel);
        const windowsLabel = modelsWithLabel.length > 0
          ? modelsWithLabel.find((m) => m.windowsLabel?.includes("/"))?.windowsLabel ?? modelsWithLabel[0].windowsLabel
          : undefined;
        // The driver's OWN verdict, merged in rather than replaced.  A
        // driver that probed its API and got a 402/429 back reports
        // `quota: { capped: true }` off that probe (MiniMax does), and this
        // block used to assign straight over it — so a blocked account whose
        // balance endpoint answered "plenty left", or did not answer at all,
        // published `capped: false`, rendered the green "Available" chip and
        // stayed in eligibleAutoFallbackChain.  Everything below only ever
        // ADDS a reason to be capped; nothing here can clear one the driver
        // already found.
        const driverQuota = snapshot.quota;
        const mergedModels = { ...driverQuota?.models, ...models };
        const allCatalogCapped =
          catalogIds.length > 0 && catalogIds.every((id) => mergedModels[id]?.capped === true);
        if (wildcard || Object.keys(mergedModels).length > 0 || windowsLabel || minimaxSummary) {
          snapshot.quota = {
            ...driverQuota,
            capped: Boolean(wildcard)
              || allCatalogCapped
              || minimaxInstanceCapped
              || driverQuota?.capped === true,
            // A live cooldown's own reset/error is the more specific
            // signal; the driver's is carried over when there is none.
            resetsAt: wildcard?.resetsAt ?? driverQuota?.resetsAt,
            error: wildcard?.error ?? driverQuota?.error,
            ...(windowsLabel ? { windowsLabel } : {}),
            ...(Object.keys(mergedModels).length > 0 ? { models: mergedModels } : {}),
            ...(minimaxSummary ? { minimax: minimaxSummary } : {}),
          };
        }
      } catch (e) {
        snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      instanceId: inst.instanceId,
      driverKind: inst.driverKind,
      displayName: inst.displayName ?? inst.driverKind,
      enabled,
      snapshot,
      models: inst.models,
      capabilities: {
        computerMcp: inst.adapter.capabilities.computerMcp === true,
        agentsMcp: inst.adapter.capabilities.agentsMcp === true,
        composioMcp: inst.adapter.capabilities.composioMcp === true,
        phoneMcp: inst.adapter.capabilities.phoneMcp === true,
        images: inst.adapter.capabilities.images === true,
        effortLevels: inst.adapter.capabilities.effortLevels,
        queueing: inst.adapter.capabilities.queueing === true,
        localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
        approvalReview: inst.reviewPermission !== undefined,
        toolLoop: inst.adapter.capabilities.toolLoop === true,
      },
      // Derived here, on the one wire where adapter capabilities already
      // become an InstanceInfo, so the client never recomputes it and can
      // never drift from the dispatch again.
      computerReach: computerReach({
        driverKind: inst.driverKind,
        capabilities: inst.adapter.capabilities,
      }),
      access: driver?.metadata.access ?? "subscription",
      install: driver?.install,
      cli: this.cliByInstance.get(inst.instanceId),
      cliDefault: cliDefaultOf(driver),
      // every copy of the driver's default binary on the augmented PATH —
      // the dropdown's "detected" entries. Snapshotted per describe() so a
      // newly installed CLI shows up on the next refresh.
      cliCandidates: candidatesFor(driver),
      fullAuto: this.fullAutoByInstance.get(inst.instanceId) ?? false,
      iconUrl: inst.iconUrl,
      isCustom: isCustomInstance(inst.driverKind, inst.instanceId),
    };
  }

  /** Probes ONLY the modified instance and updates the cached describe
   * snapshot in place, avoiding cold sweeps across all unrelated engines. */
  async describeWithFreshInstance(instanceId: InstanceId): Promise<DescribedInstance[]> {
    const entry = this.byId.get(instanceId);
    if (!entry) return this.describe();

    const candidatesByName = new Map<string, string[]>();
    const freshInfo = await this.describeEntry(entry, candidatesByName);

    if (this.lastDescribe) {
      try {
        while (this.lastDescribe) {
          const current: { at: number; result: Promise<DescribedInstance[]> } = this.lastDescribe;
          const list: DescribedInstance[] = await current.result;
          if (this.lastDescribe !== current) {
            // A concurrent describe completed in the meantime; re-merge into the fresher snapshot
            continue;
          }
          const index = list.findIndex((item) => item.instanceId === instanceId);
          const nextList = [...list];
          if (index >= 0) {
            nextList[index] = freshInfo;
          } else {
            nextList.push(freshInfo);
          }
          this.lastDescribe = { at: Date.now(), result: Promise.resolve(nextList) };
          this.saveDiskCache(nextList);
          return nextList;
        }
      } catch {
        // Fall back to full describe if cached promise errored
      }
    }

    return this.refreshDescribe(Date.now());
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.fullAutoByInstance.clear();
    this.enabledByInstance.clear();
    this.minimaxContextByInstance.clear();
  }
}
