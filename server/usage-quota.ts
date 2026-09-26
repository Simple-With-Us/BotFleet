import { mergeLocalQuotaWindows, readLocalQuotaSnapshot, type LocalQuotaFreshness } from "./local-usage-monitor.ts";
import { quotaCooldowns } from "./model-fallback.ts";
import {
  canonicalQuotaProvider,
  driverKindsForWindow,
  isPlanLevelSkip,
  lookupOwn,
  modelsToSkip,
} from "./quota-window-map.ts";

export {
  driverKindsForWindow,
  familiesForWindow,
  isPlanLevelSkip,
  modelsToSkip,
  modelTypeFromId,
  windowsForDriver,
} from "./quota-window-map.ts";

export type RemoteQuotaWindow = {
  id: string;
  provider: string;
  providerKey?: string;
  providerLabel?: string;
  via?: string;
  occurredAt?: string;
  source?: string;
  sourceApp: string;
  label: string;
  modelId: string | null;
  modelType: string;
  window: string;
  remainingPercent: number | null;
  resetAt: string | null;
  status: string;
  skip: boolean;
  skipReason: string | null;
  /** The plan the allowance belongs to, as the producer names it ("ultra"). */
  planName?: string | null;
  /** What is left and what the plan holds, in `quotaUnit` — dollars for a
   *  Cursor plan, requests for a MiniMax pool, credits for Grok.  A window
   *  can report these with no percentage at all. */
  absoluteRemaining?: number | null;
  absoluteLimit?: number | null;
  quotaUnit?: string | null;
  /** The producer's own exhaustion verdict.  Distinct from a derived 0%:
   *  only this and `fileSkip` are treated as a cap by the local routing
   *  path, because only they mean the collector saw the provider refuse. */
  isExhausted?: boolean;
  /** The file's own status / skip / skipReason, kept under their own names
   *  so the derived `status` and `skip` above keep the meaning every display
   *  path already reads them with. */
  fileStatus?: string | null;
  fileSkip?: boolean;
  fileSkipReason?: string | null;
};

/** The local handoff's health as `/api/quotas` reports it: one flat object
 *  so the renderer reads a state, not a nested shape. */
export type LocalQuotaView = LocalQuotaFreshness & {
  producer: string | null;
  issues: Record<string, string>;
};

export type QuotaWindowsPayload = {
  ok: true;
  generatedAt: string;
  windows: RemoteQuotaWindow[];
  skipModelTypes: string[];
  skipModelIds: string[];
};

export type QuotaPollerSettings = {
  ingestUrl?: string | null;
  ingestToken?: string | null;
  readToken?: string | null;
  /** `usage.localQuotaRouting`.  Absent means on. */
  localQuotaRouting?: boolean;
};

export type QuotaPollerInstance = {
  instanceId: string;
  driverKind: string;
  models?: { options?: Array<{ id: string }> };
};

const POLL_MS = 30_000;
const INGEST_PATH = "/api/ingest/usage";
/** Local caps carry their own source so neither payload's clear can delete
 *  the other's rows — in particular so the empty payload an unconfigured
 *  remote feed applies every 30 s cannot wipe a local cap. */
export const LOCAL_QUOTA_SOURCE = "usage-monitor-local";
/** No locally-observed cap may outlast this.  A handoff that goes stale with
 *  an exhausted row in it must not strand an engine for a billing month. */
const MAX_LOCAL_COOLDOWN_MS = 8 * 86_400_000;
/** Both engines run their own poller against the vendor, on a faster cadence
 *  than this file is written, and those pollers own their cooldowns. */
const LOCAL_ROUTING_EXCLUDED_KINDS = new Set(["antigravityAgent", "minimax", "minimaxAgent"]);
const LOCAL_ROUTING_EXCLUDED_PROVIDERS = new Set(["google-antigravity", "minimax"]);
const NAMED_WINDOW_LENGTHS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  session: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  week: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
  month: 30 * 86_400_000,
} satisfies Readonly<Record<string, number>>;

/** How long one window lasts, from its own token, for a capped row that did
 *  not say when it resets.  An unrecognised token ("billing-cycle", whose
 *  length depends on an account BotFleet cannot see) answers null, and such a
 *  row does not cap at all: an end BotFleet cannot compute is one it could
 *  never release. */
export function windowLengthMs(token: string | null | undefined): number | null {
  const raw = (token ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!raw) return null;
  // `lookupOwn`, never `NAMED_WINDOW_LENGTHS[raw]`: the token comes from the
  // handoff, and a bare index answers `Object.prototype`'s own members, so
  // `window: "constructor"` returned the `Object` function as if it were a
  // length — defeating the rule below that an unrecognised token does not cap.
  const named = lookupOwn(NAMED_WINDOW_LENGTHS, raw);
  if (named) return named;
  const match = /^(\d+)(m|min|minutes?|h|hr|hours?|d|days?|w|weeks?)$/.exec(raw);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2].charAt(0);
  const scale = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
  return count * scale;
}

export function quotaWindowsUrl(ingestUrl?: string | null): string | null {
  const raw = (ingestUrl || process.env.USAGE_MONITOR_INGEST_URL || "").trim();
  if (!raw) return null;
  try {
    let href = raw;
    if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
    const url = new URL(href);
    if (url.pathname.endsWith(INGEST_PATH)) url.pathname = url.pathname.slice(0, -INGEST_PATH.length) || "/";
    url.pathname = "/api/quota-windows";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function resetsAtMs(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

/** When a locally-observed cap lifts: the row's own reset, else one window
 *  length from now, never more than eight days out, and never at all when the
 *  row gives neither — nor when the reset it gives has already passed. */
function localCooldownEnd(window: RemoteQuotaWindow, now: number): number | null {
  const reset = resetsAtMs(window.resetAt);
  const length = windowLengthMs(window.window);
  const end = reset ?? (length === null ? null : now + length);
  // Finite, not merely "not in the past": a non-numeric length would make
  // `now + length` a string, every comparison against which is false, so a
  // NaN end could reach `recordInstanceCap` and be persisted as `null`.
  if (end === null || !Number.isFinite(end) || end <= now) return null;
  return Math.min(end, now + MAX_LOCAL_COOLDOWN_MS);
}

/** Which models one locally-observed cap covers.  A row that names neither a
 *  model nor a model type is a plan-level cap on the whole engine; with a
 *  model type, `modelsToSkip` already owns the family-to-catalog mapping and
 *  is handed the file's own skip, because the display `skip` on a local row
 *  stays false by design.
 *
 *  A `modelId` is kept only when this instance's own catalog lists it.  The
 *  producer spells a model the vendor's way — a dated id such as
 *  `claude-opus-4-1-20250805` — while the catalog carries BotFleet's
 *  (`claude-opus-4-6`), so an id that matches nothing is the ordinary case.
 *  Recorded anyway it becomes a cooldown key no bot ever looks up: `isCooling`
 *  never sees it and nothing is diverted, while the very same row reaches
 *  `/api/quotas` and flips the engine chip to "Partially capped".  It is
 *  re-recorded on every poll, so clearing it by hand does nothing either.
 *  The row falls back to the family it also names, and a row naming only an
 *  id this engine does not have caps nothing: it is not evidence about any
 *  model the engine can run. */
function localCapTargets(window: RemoteQuotaWindow, instance: QuotaPollerInstance): string[] {
  const catalog = instance.models?.options ?? [];
  if (window.modelId && catalog.some((row) => row.id === window.modelId)) return [window.modelId];
  if (!window.modelType) return window.modelId ? [] : ["*"];
  // `modelId: null` because `modelsToSkip` short-circuits on an id, and the
  // only id this row carries is the one the catalog just refused.
  return modelsToSkip({ ...window, modelId: null, skip: true, skipReason: window.fileSkipReason ?? null }, instance);
}

export class UsageQuotaPoller {
  private settingsProvider: (() => QuotaPollerSettings) | null = null;
  private instancesProvider: (() => QuotaPollerInstance[]) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private windows: RemoteQuotaWindow[] = [];
  private localWindows: RemoteQuotaWindow[] = [];
  private localFreshness: LocalQuotaFreshness = { state: "missing" };
  private localProducer: string | null = null;
  private localIssues: Record<string, string> = {};
  private lastError: string | null = null;
  private lastOkAt: string | null = null;
  /** The last local-path failure already reported, so a handoff that is
   *  broken — and stays broken — is logged once instead of every 30 s. */
  private localError: string | null = null;
  private inFlight = false;

  private readonly readNativeQuota: typeof readLocalQuotaSnapshot;

  constructor(readNativeQuota = readLocalQuotaSnapshot) {
    this.readNativeQuota = readNativeQuota;
  }

  configure(opts: {
    settings: () => QuotaPollerSettings;
    instances: () => QuotaPollerInstance[];
  }): void {
    this.settingsProvider = opts.settings;
    this.instancesProvider = opts.instances;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getWindows(): RemoteQuotaWindow[] {
    return mergeLocalQuotaWindows(this.windows, this.localWindows);
  }

  /** Whether the native app is still writing the handoff, which app that is,
   *  and any provider it could not read — so Settings can say why a grid is
   *  empty instead of rendering nothing. */
  getLocalQuota(): LocalQuotaView {
    return { ...this.localFreshness, producer: this.localProducer, issues: this.localIssues };
  }

  getStatus() {
    return {
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      windowCount: this.getWindows().length,
    };
  }

  applyPayload(payload: QuotaWindowsPayload, instances: QuotaPollerInstance[]): void {
    this.windows = Array.isArray(payload.windows) ? payload.windows : [];
    const nextOwned = new Set<string>();
    for (const window of this.windows) {
      const kinds = new Set(driverKindsForWindow(window));
      for (const instance of instances) {
        // Local antigravity-usage poller is fresher than UM's 4h collector.
        if (instance.driverKind === "antigravityAgent") continue;
        if (!kinds.has(instance.driverKind)) continue;
        const models = modelsToSkip(window, instance);
        const planSkip = isPlanLevelSkip(window) || models.includes("*");
        const targets = planSkip ? ["*", ...models.filter((model) => model !== "*")] : models;
        for (const model of targets) {
          const key = `${instance.instanceId}:${model}`;
          quotaCooldowns.recordInstanceCap(instance.instanceId, model, {
            resetsAt: resetsAtMs(window.resetAt),
            error: window.skipReason || `${window.label} remaining ${window.remainingPercent ?? 0}%`,
            source: "usage-monitor",
          });
          nextOwned.add(key);
        }
      }
    }
    quotaCooldowns.clearWhere((cd) => {
      if (cd.source !== "usage-monitor") return false;
      return !nextOwned.has(`${cd.instanceId}:${cd.model}`);
    });
  }

  /** The local half of the same job `applyPayload` does for the remote feed.
   *  Kept separate on purpose: the two sources have different authority and
   *  different clears, and folding local rows into `this.windows` would let
   *  an empty remote payload delete a cap the collector is still reporting.
   *
   *  Only the collector's own verdict caps an engine — `fileSkip` or
   *  `isExhausted`, never a derived 0%, because a passed reset, an unknown
   *  remainder and a real exhaustion all render as 0% and only one of them
   *  means the provider refused. */
  applyLocalPayload(
    windows: RemoteQuotaWindow[],
    instances: QuotaPollerInstance[],
    enabled: boolean,
    now = Date.now(),
  ): void {
    const owned = new Set<string>();
    if (enabled) {
      for (const window of windows) {
        if (window.fileSkip !== true && window.isExhausted !== true) continue;
        if (LOCAL_ROUTING_EXCLUDED_PROVIDERS.has(canonicalQuotaProvider(window))) continue;
        const until = localCooldownEnd(window, now);
        if (until === null) continue;
        const kinds = new Set(driverKindsForWindow(window));
        for (const instance of instances) {
          if (LOCAL_ROUTING_EXCLUDED_KINDS.has(instance.driverKind)) continue;
          if (!kinds.has(instance.driverKind)) continue;
          for (const model of localCapTargets(window, instance)) {
            quotaCooldowns.recordInstanceCap(instance.instanceId, model, {
              resetsAt: until,
              error: window.fileSkipReason || `${window.label} remaining ${window.remainingPercent ?? 0}%`,
              source: LOCAL_QUOTA_SOURCE,
            });
            owned.add(`${instance.instanceId}:${model}`);
          }
        }
      }
    }
    // Only this source's own rows are ever cleared, so the remote feed cannot
    // delete a local cap and turning the flag off restores exactly today's
    // behaviour: every local row goes, and nothing else is touched.
    quotaCooldowns.clearWhere((cd) => cd.source === LOCAL_QUOTA_SOURCE && !owned.has(`${cd.instanceId}:${cd.model}`));
  }

  /** The local half of one poll, fenced off from the poller's own control
   *  flow.  Everything it touches is derived from a file any process running
   *  as this user can write, and `start()` calls `void this.poll()` with no
   *  process-level `unhandledRejection` handler anywhere in the repo (pinned
   *  at server/secret-persistence.test.ts), so a throw escaping here would
   *  terminate the harness — and terminate it again on the next boot, because
   *  the same file is read again.  It logs once and lets the remote feed run. */
  private async pollLocal(settings: QuotaPollerSettings): Promise<void> {
    try {
      const local = await this.readNativeQuota();
      this.localWindows = local.windows;
      this.localFreshness = local.freshness;
      this.localProducer = local.producer;
      this.localIssues = local.issues;
      // Before the remote payload, so a key both sources cap ends up owned by
      // the authenticated feed rather than flapping between them.
      this.applyLocalPayload(this.localWindows, this.instancesProvider?.() ?? [], settings.localQuotaRouting !== false);
      this.localError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.localError) {
        this.localError = message;
        console.error(`[usage-quota] local quota handoff ignored: ${message}`);
      }
    }
  }

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const settings = this.settingsProvider?.() ?? {};
      await this.pollLocal(settings);
      const url = quotaWindowsUrl(settings.ingestUrl);
      const token =
        settings.readToken?.trim() ||
        process.env.USAGE_READ_TOKEN?.trim() ||
        "";
      if (!url || !token) {
        this.applyPayload({ ok: true, generatedAt: new Date().toISOString(), windows: [], skipModelTypes: [], skipModelIds: [] }, this.instancesProvider?.() ?? []);
        this.lastError = null;
        return;
      }
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "BotFleet/1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        // SAFETY: response.json() can return any JSON value; the brace of
        // `ok` / not-`ok` types is the discriminated union the downstream
        // applyPayload expects, and the cast is the boundary that lets us
        // type-narrow from there.
        const body = (await response.json().catch(() => null)) as QuotaWindowsPayload | { error?: string } | null;
        if (
          !response.ok ||
          !body ||
          Object.prototype.toString.call(body) !== "[object Object]" ||
          !("ok" in body) ||
          body.ok !== true
        ) {
          this.lastError = `HTTP ${response.status}`;
          return;
        }
        this.applyPayload(body, this.instancesProvider?.() ?? []);
        this.lastError = null;
        this.lastOkAt = new Date().toISOString();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      // One release for the whole poll, the early return above included.  Left
      // true, every later poll returns at the `inFlight` guard, so a local cap
      // could never lift and the windows behind it never refresh.
      this.inFlight = false;
    }
  }
}

export const usageQuotaPoller = new UsageQuotaPoller();
