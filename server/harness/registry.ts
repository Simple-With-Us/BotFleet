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
import { KNOWN_VERSION_MAX_AGE_MS } from "../procs.ts";
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
  ["mcodeAgent", "mcode"],
]);

export function isCustomInstance(driverKind: string, instanceId: InstanceId): boolean {
  return instanceId !== (RESERVED_INSTANCE_ID.get(driverKind) ?? driverKind);
}

/** How many engines one describe sweep probes at once.  Every engine used to
 * be probed in parallel, and on a saturated Mac the pile-up is what pushed
 * each CLI past its own deadline. */
const DEFAULT_PROBE_CONCURRENCY = 6;
/** How long one engine may take to describe before the sweep answers for it
 * from its last definitive snapshot.  The probe keeps running; its answer is
 * folded in (and pushed to clients) when it lands. */
const DEFAULT_ENTRY_DEADLINE_MS = 30_000;
/** How long a definitive snapshot may stand in for inconclusive probes, and
 * a sign-in for auth checks that give no answer (aged from the probe that
 * actually answered it).  A driver's remembered `--version` and sign-in age
 * out after the same span (procs.ts LastKnownAnswer), so an engine that never
 * answers again settles as "did not answer in time", and its sign-in as
 * unknown, once both have lapsed: at most twice this after the CLI last
 * really answered. */
const DEFINITIVE_MAX_AGE_MS = KNOWN_VERSION_MAX_AGE_MS;
/** First look again at engines a describe left as "Checking" (their probe
 * gave no answer and nothing definitive stood in).  Doubles on each look
 * that still gets no answer, up to the max, so a wedged CLI costs one probe
 * every few minutes rather than one per sweep. */
const DEFAULT_TRANSIENT_RECHECK_MS = 20_000;
const TRANSIENT_RECHECK_MAX_MS = 5 * 60_000;

export interface ProviderRegistryOptions {
  probeConcurrency?: number;
  entryDeadlineMs?: number;
  /** First re-check delay for "Checking" engines; 0 turns re-checks off. */
  transientRecheckMs?: number;
}

/** Called when a completed describe changes what clients were last told. */
export type DescribeListener = (instances: DescribedInstance[], describedAt: number) => void;

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A snapshot read back from engine-cache.json.  Available rows are served
 * as they were; an unavailable row written by an earlier process — possibly
 * one that mistook a slow probe for a missing CLI — is shown as "checking"
 * until this process has probed it, never as a verdict. */
function seedFromDisk(info: DescribedInstance): DescribedInstance {
  const snapshot = info.snapshot;
  if (!snapshot || snapshot.state === "available" || snapshot.reason === "Disabled in settings" || snapshot.hidden) {
    return info;
  }
  return { ...info, snapshot: { ...snapshot, transient: true } };
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
  private readonly probeConcurrency: number;
  private readonly entryDeadlineMs: number;
  private readonly transientRecheckMs: number;

  constructor(drivers: readonly AnyProviderDriver[], options: ProviderRegistryOptions = {}) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    this.probeConcurrency = Math.max(1, options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY);
    this.entryDeadlineMs = options.entryDeadlineMs ?? DEFAULT_ENTRY_DEADLINE_MS;
    this.transientRecheckMs = Math.max(0, options.transientRecheckMs ?? DEFAULT_TRANSIENT_RECHECK_MS);
    this.recheckDelayMs = this.transientRecheckMs;
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

  private loadedOnce = false;

  async load(configs: InstanceConfigMap) {
    // A new fleet: nothing completed before this describes it, and a sweep
    // still running against the old instances must not become the answer.
    this.generation++;
    this.lastDone = null;
    this.latestSettled.clear();
    // The definitive baselines describe the old fleet too: a config change
    // (CLI path, enabled, credentials) must not be masked by what an engine
    // said before it.
    // Disk-seeded baselines (seq 0) are bootstrap-only: they survive the
    // first load of the process and are dropped by every later one, so a
    // credential reload is never masked by a cache written before it.
    for (const [instanceId, record] of this.lastDefinitive) {
      if (record.seq > 0 || this.loadedOnce) this.lastDefinitive.delete(instanceId);
    }
    this.loadedOnce = true;
    for (const [instanceId, entry] of Object.entries(configs)) {
      await this.loadEntry(instanceId, entry);
    }
  }

  /** Reload a single instance after an override/setting change without tearing
   * down the whole fleet. */
  async reloadInstance(instanceId: InstanceId, entry: InstanceConfig): Promise<ProviderInstance | null> {
    // Its config changed (CLI path, enabled, credentials): what it said
    // before is no longer a safe stand-in for an inconclusive probe.
    this.forgetInstanceProbes(instanceId);
    const existing = this.byId.get(instanceId);
    if (existing?.live) {
      await existing.live.dispose().catch(() => {});
    }
    // A probe of the old entry that started while dispose was awaited carries
    // the generation bumped above; invalidate again so it cannot pass as the
    // replacement's, and once more after the install for probes begun in
    // between.
    this.forgetInstanceProbes(instanceId);
    const loaded = await this.loadEntry(instanceId, entry);
    this.forgetInstanceProbes(instanceId);
    return loaded;
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
    this.forgetInstanceProbes(instanceId);
    this.generation++;
    this.lastDone = null;
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

  /** instance snapshots for the model picker: id, driver, models, health
   *
   * Probing every engine CLI (`--version`, auth status, model discovery)
   * costs seconds, and tens of seconds on a busy Mac.  So:
   *  - `lastDone` is the last COMPLETED describe and the time it finished.
   *    Callers that accept a slightly old answer get it immediately.
   *  - `inFlight` is at most one running sweep.  Every caller that may share
   *    it does; nothing starts a second one beside it.  (A sweep used to be
   *    stamped with its START time, so once it ran past the 15 s memo every
   *    passive refresh started another full sweep on top of it.)
   *  - A caller that must not be answered from before its own request (the
   *    "Check again" button, a just-created engine) never joins a sweep that
   *    started earlier: it queues one trailing sweep instead. */
  private lastDone: { at: number; result: DescribedInstance[] } | null = null;
  private inFlight: { startedAt: number; generation: string; promise: Promise<DescribedInstance[]> } | null = null;
  private trailing: { createdAt: number; promise: Promise<DescribedInstance[]> } | null = null;
  /** Bumped when the fleet itself changes (load, removeInstance). */
  private generation = 0;
  /** Bumped when ONE instance is reloaded.  A sweep that started before it
   *  probed the old config of that engine, so it must neither be joined nor
   *  committed, exactly like a sweep of a previous fleet. */
  private sweepEpoch = 0;
  /** Monotonic start order of engine probes.  Overlapping probes of one
   *  engine are ordered by when they STARTED, not when they settled: a slow
   *  earlier probe landing last must not overwrite a newer answer. */
  private probeSeq = 0;
  /** Bumped per instance when that one instance is reloaded. */
  private instanceGeneration = new Map<InstanceId, number>();
  /** One running probe per instance, shared by overlapping sweeps. */
  private entryProbes = new Map<InstanceId, { startedAt: number; seq: number; gen: string; promise: Promise<DescribedInstance> }>();
  /** The last definitive answer per engine — never a timeout — which an
   * inconclusive probe falls back to, field by field. */
  private lastDefinitive = new Map<InstanceId, { at: number; seq: number; info: DescribedInstance; authAt: number }>();
  /** The newest settled describe per instance, so a sweep that finishes after
   * a single-engine refresh (or a late probe) never puts an older answer back. */
  private latestSettled = new Map<InstanceId, { at: number; seq: number; gen: string; info: DescribedInstance }>();
  /** When each describe result finished, for the client's ordering guard. */
  private describedAtByResult = new WeakMap<DescribedInstance[], number>();
  /** Settle time and generation of each entry a probe produced. */
  private entryMeta = new WeakMap<DescribedInstance, { at: number; seq: number; gen: string }>();
  /** Snapshots whose snapshot() threw — an error, not a verdict. */
  private thrownSnapshots = new WeakSet<ProviderSnapshot>();
  private describeListeners = new Set<DescribeListener>();
  private diskCachePath: string | null = null;
  /** The pending re-check of "Checking" engines, and the delay the next one
   *  will wait (see DEFAULT_TRANSIENT_RECHECK_MS). */
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckDelayMs = 0;
  /** The describedAt of the last commit (see commit()). */
  private lastDescribedAt = 0;

  /** Subscribe to completed describes that changed the answer — a finished
   * background sweep, a single-engine refresh, a slow probe landing late. */
  onDescribed(listener: DescribeListener): () => void {
    this.describeListeners.add(listener);
    return () => this.describeListeners.delete(listener);
  }

  /** When a list this registry returned was produced (ms since epoch). */
  describedAtOf(result: DescribedInstance[]): number | undefined {
    return this.describedAtByResult.get(result);
  }

  private sweepKey(): string {
    return `${this.generation}:${this.sweepEpoch}`;
  }

  private genOf(instanceId: InstanceId): string {
    return `${this.generation}:${this.instanceGeneration.get(instanceId) ?? 0}`;
  }

  private forgetInstanceProbes(instanceId: InstanceId): void {
    this.instanceGeneration.set(instanceId, (this.instanceGeneration.get(instanceId) ?? 0) + 1);
    this.sweepEpoch++;
    this.lastDefinitive.delete(instanceId);
    this.latestSettled.delete(instanceId);
    this.entryProbes.delete(instanceId);
  }

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
        const seeded = (instances as DescribedInstance[]).map(seedFromDisk);
        this.lastDone = { at, result: seeded };
        this.describedAtByResult.set(seeded, at);
        // An engine that was working when this cache was written is the
        // baseline for this process's first, possibly slow, probes.
        // Unavailable rows are not: an older build wrote a slow probe as
        // "CLI not found", and that must not become ground truth.
        // Aged from when the cache was written, not from now: a day-old cache
        // must not look fresh to the DEFINITIVE_MAX_AGE_MS check.
        for (const info of instances as DescribedInstance[]) {
          if (info?.snapshot?.state === "available" && !info.snapshot.transient && !this.lastDefinitive.has(info.instanceId)) {
            this.lastDefinitive.set(info.instanceId, { at, seq: 0, info, authAt: at });
          }
        }
      }
    } catch {
      // Corrupt or unreadable cache — ignore and start fresh
    }
  }

  private saveDiskCache(instances: DescribedInstance[], at: number = Date.now()): void {
    if (!this.diskCachePath) return;
    try {
      const dir = dirname(this.diskCachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Already merged field by field against each engine's last definitive
      // snapshot, so a timeout never overwrites a good row here.
      writeFileAtomic(this.diskCachePath, JSON.stringify({ at, instances }));
    } catch {
      // Non-fatal if saving cache fails
    }
  }

  async describe(opts?: { maxAgeMs?: number; staleWhileRevalidate?: boolean }): Promise<DescribedInstance[]> {
    const maxAge = opts?.maxAgeMs ?? 0;
    const now = Date.now();
    const done = this.lastDone;
    // A sweep already running that started after the last completed one is
    // the newest answer there is, and a caller that decides something from
    // engine health (the automatic fallback walk) must see it rather than an
    // older completed answer that is merely inside maxAge.  Callers that
    // accept a stale answer (staleWhileRevalidate) keep getting the completed
    // one immediately.
    if (maxAge > 0 && !opts?.staleWhileRevalidate) {
      const running = this.inFlight;
      if (
        running &&
        running.generation === this.sweepKey() &&
        now - running.startedAt <= maxAge &&
        (!done || running.startedAt > done.at)
      ) {
        return running.promise;
      }
    }
    if (maxAge > 0 && done && now - done.at <= maxAge) return done.result;

    // A caller that can live with a slightly old answer gets the last
    // completed one immediately while a new probe runs behind it.  Probing
    // every engine CLI takes tens of seconds on a machine with many
    // installed, which is longer than the phone waits before giving up — so
    // making every caller block on it is what makes the model picker look
    // empty rather than slow.
    if (opts?.staleWhileRevalidate && done) {
      void this.ensureSweep().catch(() => {});
      return done.result;
    }

    // Accepts an answer up to maxAge old: a sweep already running is at
    // least that fresh.
    if (maxAge > 0) return this.ensureSweep();

    // No memo at all: the user's own action ("Check again", a just-created
    // or just-deleted engine) must never be served a sweep that started
    // before it.
    return this.freshSweep(now);
  }

  /** Join the running sweep of the current fleet, or start one. */
  private ensureSweep(): Promise<DescribedInstance[]> {
    const running = this.inFlight;
    if (running && running.generation === this.sweepKey()) return running.promise;
    return this.startSweep(0);
  }

  /** A sweep that starts no earlier than `requestedAt`. */
  private freshSweep(requestedAt: number): Promise<DescribedInstance[]> {
    const running = this.inFlight;
    // Nothing running, or only a sweep of a fleet that has since been
    // reloaded: start now.
    if (!running || running.generation !== this.sweepKey()) return this.startSweep(requestedAt);
    if (running.startedAt >= requestedAt) return running.promise;
    if (!this.trailing) {
      const createdAt = Date.now();
      const promise: Promise<DescribedInstance[]> = running.promise
        .then(() => undefined, () => undefined)
        .then(() => {
          if (this.trailing?.promise === promise) this.trailing = null;
          // Something else started a sweep after every caller sharing this
          // trailing one asked: that sweep already answers them.
          const now = this.inFlight;
          if (now && now.startedAt >= createdAt && now.generation === this.sweepKey()) return now.promise;
          return this.startSweep(createdAt);
        });
      this.trailing = { createdAt, promise };
    }
    return this.trailing.promise;
  }

  private startSweep(notBefore: number): Promise<DescribedInstance[]> {
    const generation = this.sweepKey();
    const startedAt = Date.now();
    // notBefore 0: this caller accepts any answer still being produced, so a
    // slow engine's probe left running by an earlier sweep is joined rather
    // than spawned a second time.
    const promise = this.describeFresh({ notBefore }).then((result) => {
      // A sweep that began before load()/removeInstance() describes a fleet
      // that no longer exists: its callers get it, the memo does not.
      if (generation === this.sweepKey()) {
        this.commit(result, this.describedAtByResult.get(result) ?? Date.now(), false);
        return result;
      }
      // The fleet was reloaded while this sweep ran: what it found describes
      // engines that are gone, so its callers get an answer for the current
      // fleet, not the obsolete one.
      return this.freshSweep(startedAt);
    });
    const slot = { startedAt, generation, promise };
    this.inFlight = slot;
    const clear = () => {
      if (this.inFlight === slot) this.inFlight = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** Make `result` the last completed describe and tell listeners if it
   * changed anything. */
  private commit(result: DescribedInstance[], answeredAt: number, persist: boolean): void {
    // Strictly increasing, so two different answers never share a stamp and
    // the client's describedAt guard is a total order: the last commit wins
    // wherever its REST response and SSE push arrive in between.
    const at = Math.max(answeredAt, this.lastDescribedAt + 1);
    this.lastDescribedAt = at;
    const previous = this.lastDone;
    this.lastDone = { at, result };
    this.describedAtByResult.set(result, at);
    if (persist) this.saveDiskCache(result, at);
    this.scheduleRecheck(result);
    if (this.describeListeners.size === 0) return;
    if (previous && JSON.stringify(previous.result) === JSON.stringify(result)) return;
    for (const listener of [...this.describeListeners]) {
      try {
        listener(result, at);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /** An engine left as "Checking" (its probe gave no answer and nothing
   * definitive stood in) is looked at again on its own, so the UI's promise
   * to update it holds without anyone reopening a menu.  One timer at a
   * time; the delay doubles while engines stay unanswered and resets once
   * every engine has answered. */
  private scheduleRecheck(result: DescribedInstance[]): void {
    if (this.transientRecheckMs <= 0) return;
    const waiting = result.some((info) => info.snapshot.transient && !info.snapshot.hidden);
    if (!waiting) {
      this.recheckDelayMs = this.transientRecheckMs;
      if (this.recheckTimer) clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
      return;
    }
    if (this.recheckTimer) return;
    const delay = this.recheckDelayMs;
    this.recheckDelayMs = Math.min(delay * 2, Math.max(TRANSIENT_RECHECK_MAX_MS, this.transientRecheckMs));
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.recheckTransient().catch(() => {});
    }, delay);
    this.recheckTimer.unref?.();
  }

  /** Probe only the engines the last describe left as "Checking", one at a
   * time — a busy Mac is why they did not answer. */
  private async recheckTransient(): Promise<void> {
    const done = this.lastDone;
    if (!done) return;
    for (const info of done.result) {
      if (!info.snapshot.transient || info.snapshot.hidden) continue;
      // A probe still running (one that missed its sweep's deadline) lands
      // on its own; a second one beside it would only add load.
      if (this.entryProbes.has(info.instanceId) || !this.byId.has(info.instanceId)) continue;
      await this.describeWithFreshInstance(info.instanceId).catch(() => undefined);
    }
    // Nothing committed (every engine was skipped): keep looking.
    if (this.lastDone) this.scheduleRecheck(this.lastDone.result);
  }

  /** Probe every engine (a few at a time), merge each answer against that
   * engine's last definitive snapshot, persist, and return the list.  Public
   * for tests; callers go through describe(). */
  async describeFresh(opts?: { notBefore?: number }): Promise<DescribedInstance[]> {
    const notBefore = opts?.notBefore ?? Date.now();
    const sweepKeyAtStart = this.sweepKey();
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    // The fleet as it is NOW.  Probes start a few at a time, so most start
    // later; each is bound to its engine's generation from this moment, never
    // the one current when its turn comes.  An engine reloaded meanwhile has
    // a disposed instance in `entries`, and probing that under the NEW
    // generation would let the old config's answer pass as the replacement's.
    const entries = this.entries();
    const gens = new Map(entries.map((entry) => [entry.instanceId, this.genOf(entry.instanceId)] as const));
    const probed = await mapWithConcurrency(entries, this.probeConcurrency, (entry) => {
      const gen = gens.get(entry.instanceId)!;
      // The fleet changed since this sweep began: its answer is thrown away
      // (startSweep), so it starts no more probes beside its replacement's.
      if (this.sweepKey() !== sweepKeyAtStart || this.genOf(entry.instanceId) !== gen || this.byId.get(entry.instanceId) !== entry) {
        return Promise.resolve(this.supersededEntry(entry, candidatesByName, gen));
      }
      return this.probeEntryWithDeadline(entry, candidatesByName, notBefore, gen);
    });
    const merged = probed.map((info) => this.newestFor(info));
    const at = Date.now();
    // An obsolete sweep (the fleet was reloaded meanwhile) never persists.
    if (sweepKeyAtStart === this.sweepKey()) this.saveDiskCache(merged, at);
    this.describedAtByResult.set(merged, at);
    return merged;
  }

  /** `info`, unless a newer answer for the same instance settled meanwhile —
   * a single-engine refresh after a Settings change, or this engine's own
   * slow probe landing after the sweep answered for it. */
  private newestFor(info: DescribedInstance): DescribedInstance {
    const latest = this.latestSettled.get(info.instanceId);
    if (!latest || latest.gen !== this.genOf(info.instanceId)) return info;
    const meta = this.entryMeta.get(info);
    if (!meta || meta.gen !== latest.gen || latest.seq >= meta.seq) return latest.info;
    return info;
  }

  /** One engine's describe, shared with any overlapping sweep whose caller
   * accepts a probe that started no earlier than `notBefore`. */
  private probeEntry(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
    notBefore: number,
    gen: string,
  ): Promise<DescribedInstance> {
    const id = entry.instanceId;
    const running = this.entryProbes.get(id);
    if (running && running.gen === gen && running.startedAt >= notBefore) return running.promise;
    const startedAt = Date.now();
    const seq = ++this.probeSeq;
    const promise = this.describeEntry(entry, candidatesByName).then((raw) => this.settleEntry(raw, gen, seq));
    const slot = { startedAt, seq, gen, promise };
    this.entryProbes.set(id, slot);
    const clear = () => {
      if (this.entryProbes.get(id) === slot) this.entryProbes.delete(id);
    };
    promise.then(clear, clear);
    return promise;
  }

  /** probeEntry with a deadline: past it, the engine is answered from its
   * last definitive snapshot (or reported as not answering yet), and the
   * probe's own answer is folded in when it lands. */
  private probeEntryWithDeadline(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
    notBefore: number,
    gen: string = this.genOf(entry.instanceId),
  ): Promise<DescribedInstance> {
    const probe = this.probeEntry(entry, candidatesByName, notBefore, gen);
    if (!(this.entryDeadlineMs > 0) || entry.shadow) return probe;
    // The probe just started or joined: its own order, for the stand-in.
    const probeSeq = this.entryProbes.get(entry.instanceId)?.seq ?? this.probeSeq;
    return new Promise<DescribedInstance>((resolve) => {
      let answered = false;
      const timer = setTimeout(() => {
        answered = true;
        console.warn(
          `[engines] ${entry.instanceId} took longer than ${this.entryDeadlineMs}ms to describe; answering from its last known state`,
        );
        resolve(this.deadlineFallback(entry, candidatesByName, gen, probeSeq));
        void probe.then((late) => this.applyLateEntry(late)).catch(() => {});
      }, this.entryDeadlineMs);
      timer.unref?.();
      probe.then(
        (info) => {
          if (answered) return;
          clearTimeout(timer);
          resolve(info);
        },
        () => {
          if (answered) return;
          clearTimeout(timer);
          resolve(this.deadlineFallback(entry, candidatesByName, gen, probeSeq));
        },
      );
    });
  }

  private deadlineFallback(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
    gen: string,
    probeSeq: number,
  ): DescribedInstance {
    const shell = this.entryShell(entry, candidatesByName, {
      state: "unavailable",
      transient: true,
      reason: `${entry.live?.displayName || entry.instanceId} did not answer in time`,
    });
    // No quota was computed for this engine this time: keep what the last
    // definitive answer knew rather than dropping a cap.  Only for the
    // engine as it still is: a reloaded one's baseline is not this entry's.
    const info = gen === this.genOf(entry.instanceId) ? this.mergeWithDefinitive(shell, { keepPreviousQuota: true }) : shell;
    // Ordered just before the probe it fell back on, so that probe's real
    // answer replaces this stand-in when it lands.
    this.entryMeta.set(info, { at: Date.now(), seq: probeSeq - 0.5, gen });
    return info;
  }

  /** A row for an engine this sweep no longer describes: the fleet changed
   * before its probe started.  Never probed, settled or shared.  newestFor
   * swaps in the engine's current answer when there is one, and startSweep
   * discards the obsolete sweep anyway. */
  private supersededEntry(entry: RegistryEntry, candidatesByName: Map<string, string[]>, gen: string): DescribedInstance {
    const name = entry.live?.displayName || entry.shadow?.displayName || entry.instanceId;
    const info = this.entryShell(entry, candidatesByName, {
      state: "unavailable",
      transient: true,
      reason: `${name} is being checked again after a settings change`,
    });
    this.entryMeta.set(info, { at: Date.now(), seq: 0, gen });
    return info;
  }

  /** A probe that missed its sweep's deadline landed: fold it into the last
   * completed describe so clients see it without asking again. */
  private applyLateEntry(late: DescribedInstance): void {
    const done = this.lastDone;
    if (!done) return;
    let info = late;
    let meta = this.entryMeta.get(info);
    if (!meta || meta.gen !== this.genOf(info.instanceId)) return;
    // A probe that started later may already have settled while the sweep
    // that owns lastDone is still waiting on other engines.  The newest
    // settled answer wins, not merely this one.
    const latest = this.latestSettled.get(info.instanceId);
    if (latest && latest.gen === meta.gen && latest.seq > meta.seq) {
      info = latest.info;
      meta = this.entryMeta.get(info) ?? { at: latest.at, seq: latest.seq, gen: latest.gen };
    }
    const index = done.result.findIndex((item) => item.instanceId === info.instanceId);
    if (index < 0) return;
    const current = this.entryMeta.get(done.result[index]);
    if (current && current.gen === meta.gen && current.seq >= meta.seq) return;
    const next = [...done.result];
    next[index] = info;
    this.commit(next, Date.now(), true);
  }

  /** Record a probe's answer: merge it against the engine's last definitive
   * snapshot, and make it the new baseline when it is itself definitive. */
  private settleEntry(raw: DescribedInstance, gen: string, seq: number): DescribedInstance {
    const current = gen === this.genOf(raw.instanceId);
    const info = current ? this.mergeWithDefinitive(raw) : raw;
    const at = Date.now();
    this.entryMeta.set(info, { at, seq, gen });
    if (!current) return info;
    if (!raw.snapshot.transient && !this.thrownSnapshots.has(raw.snapshot)) {
      const baseline = this.lastDefinitive.get(raw.instanceId);
      if (!baseline || baseline.seq <= seq) {
        // A sign-in borrowed from the baseline (this probe's own auth check
        // gave no answer) keeps the age of the answer that set it, so
        // repeated auth timeouts cannot renew an old verdict for ever.
        const borrowedAuth = raw.snapshot.authenticated === undefined && typeof info.snapshot.authenticated === "boolean";
        this.lastDefinitive.set(raw.instanceId, { at, seq, info, authAt: borrowedAuth && baseline ? baseline.authAt : at });
      }
    }
    const latest = this.latestSettled.get(raw.instanceId);
    if (!latest || latest.gen !== gen || latest.seq <= seq) {
      this.latestSettled.set(raw.instanceId, { at, seq, gen, info });
    }
    return info;
  }

  /** Field-by-field merge against the engine's last definitive snapshot.
   *  - A transient snapshot (the probe gave no answer) is replaced by the
   *    last definitive one.  So is a snapshot() that threw, for a CLI that is
   *    still on disk and was working.
   *  - An unknown `authenticated` (auth probe timed out) keeps the last
   *    definitive true/false instead of reading as signed out.
   *  - Anything definitive stands: a real sign-out, "Disabled in settings",
   *    "too old", a missing CLI. */
  private mergeWithDefinitive(
    curr: DescribedInstance,
    opts: { keepPreviousQuota?: boolean } = {},
  ): DescribedInstance {
    const record = this.lastDefinitive.get(curr.instanceId);
    const now = Date.now();
    if (!record || now - record.at > DEFINITIVE_MAX_AGE_MS) return curr;
    const prev = record.info;
    if (prev.driverKind !== curr.driverKind || (prev.enabled !== false) !== (curr.enabled !== false)) return curr;
    // Whether the baseline's sign-in is still young enough to stand in: it
    // ages from the probe that actually answered it, not from later probes
    // that only borrowed it.
    const authFresh = now - record.authAt <= DEFINITIVE_MAX_AGE_MS;
    const thrown =
      this.thrownSnapshots.has(curr.snapshot) &&
      prev.snapshot.state === "available" &&
      curr.cliCandidates.length > 0;
    if (curr.snapshot.transient || thrown) {
      // Quota (cooldowns, windows) was computed for THIS describe; only a
      // deadline fallback, which computed none, borrows the old one.
      const { quota: previousQuota, authenticated: previousAuth, ...previous } = prev.snapshot;
      const quota = opts.keepPreviousQuota ? curr.snapshot.quota ?? previousQuota : curr.snapshot.quota;
      const standIn = authFresh && previousAuth !== undefined ? { ...previous, authenticated: previousAuth } : previous;
      return {
        ...curr,
        snapshot: quota ? { ...standIn, quota } : standIn,
        models: curr.models.options.length > 0 ? curr.models : prev.models,
      };
    }
    if (
      curr.snapshot.state === "available" &&
      curr.snapshot.authenticated === undefined &&
      prev.snapshot.state === "available" &&
      typeof prev.snapshot.authenticated === "boolean" &&
      authFresh
    ) {
      return { ...curr, snapshot: { ...curr.snapshot, authenticated: prev.snapshot.authenticated } };
    }
    return curr;
  }

  /** Everything describe() reports for an entry except what its probe
   * found, around the given snapshot. */
  private entryShell(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
    snapshot: ProviderSnapshot,
  ): DescribedInstance {
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
        snapshot,
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

  private async describeEntry(
    entry: RegistryEntry,
    candidatesByName: Map<string, string[]>,
  ): Promise<DescribedInstance> {
    if (entry.shadow) {
      return this.entryShell(entry, candidatesByName, { state: "unavailable", reason: entry.shadow.reason });
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
        this.thrownSnapshots.add(snapshot);
      }
    }
    return this.entryShell(entry, candidatesByName, snapshot);
  }

  /** Probes ONLY the modified instance and updates the cached describe
   * snapshot in place, avoiding cold sweeps across all unrelated engines. */
  async describeWithFreshInstance(instanceId: InstanceId): Promise<DescribedInstance[]> {
    const entry = this.byId.get(instanceId);
    if (!entry) return this.describe();

    // A probe that starts now: the caller just changed this engine.
    const gen = this.genOf(instanceId);
    const freshInfo = await this.probeEntryWithDeadline(entry, new Map(), Date.now(), gen);

    // No completed describe to patch yet, but one is running: it will pick
    // this answer up (newestFor), so wait for it rather than starting a
    // second full sweep.
    if (!this.lastDone && this.inFlight && this.inFlight.generation === this.sweepKey()) {
      await this.inFlight.promise.catch(() => undefined);
    }
    // The engine was reloaded or removed while this probe ran (a Settings
    // save during a background re-check): its answer describes a config that
    // no longer exists, so it is never committed.  Ask the current one.
    if (gen !== this.genOf(instanceId) || this.byId.get(instanceId) !== entry) {
      return this.byId.has(instanceId) ? this.describeWithFreshInstance(instanceId) : this.describe();
    }
    const done = this.lastDone;
    if (!done) return this.describe();

    const nextList = [...done.result];
    const index = nextList.findIndex((item) => item.instanceId === instanceId);
    const newest = this.newestFor(freshInfo);
    if (index >= 0) nextList[index] = newest;
    else nextList.push(newest);
    this.commit(nextList, Date.now(), true);
    return nextList;
  }

  async disposeAll() {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.fullAutoByInstance.clear();
    this.enabledByInstance.clear();
    this.minimaxContextByInstance.clear();
  }
}
