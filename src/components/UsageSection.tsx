// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched.
import * as React from "react";
import { Check, CheckCircle, ChevronDown, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, useSecretSources, useStore, type ConfigStatus, type TaskUsage } from "@/state/store";
import { cn } from "@/lib/cn";
import { BotMascot } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { ProviderMark } from "./ProviderIcons";
import type { BotColor } from "@/lib/mascot";
import { SecretSourceBadge } from "./SecretSourceBadge";
import { UsageMonitorQuotaGrid } from "./UsageMonitorQuotaGrid";
import { UsageWhatIfProjection } from "./UsageWhatIfProjection";
import { ENGINE_CAPABILITIES, engineIdFromDriverKind, uniqueModelToEngineId } from "@/lib/engine-capabilities";
import { telemetryBadge, telemetryHost, type TelemetryStatusView } from "@/lib/telemetry-status";
import { buildUsageConfigPatch } from "@/lib/usage-config";
import { antigravityGroupSummary, antigravityQuotaLines, formatResetCountdown, headlinesExhausted, headlinesNearCap, isEngineUnconfigured, localQuotaStatusLine, minimaxQuotaLine, providerIssueLine, quotaLinesSummary, usageWindowLines, windowHeadlines, windowsLabelFromHeadlines, type LocalQuotaFreshnessView } from "@/lib/quota-display";
import {
  antigravityQuotaCapped,
  antigravityDisplayWindows,
  isHiddenQuotaEngine,
  isBotFleetQuotaWindow,
  isMiniMaxVideoQuotaWindow,
} from "@/lib/usage-monitor-quota";
import { engineMeterNote, isPlanLevelSkip, quotaProviderForDriver, windowsForDriver } from "../../server/quota-window-map";
import { botUsage, botUsageByModel, cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, sumUsage, usageDetail } from "@/lib/usage";
import { productErrorHeadline } from "@/lib/product-error";

interface QuotaCooldownInfo {
  botId: string;
  instanceId: string;
  model: string;
  resetsAt?: number | null;
  error: string;
  recordedAt: number;
}

interface AntigravityUsageModel {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime?: string;
  isAutocompleteOnly?: boolean;
}

interface AntigravityUsageSnapshot {
  timestamp: string;
  method?: string;
  models: AntigravityUsageModel[];
  promptCredits?: {
    available?: number;
    monthly?: number;
    usedPercentage?: number;
    remainingPercentage?: number;
  };
}

interface DeepSeekBalanceView {
  balanceUsd: number | null;
  grantedUsd: number | null;
  toppedUpUsd: number | null;
  availability: "available" | "exhausted" | "unknown";
  fetchedAt: number;
  error: string | null;
}

/** Mirror of server/grok-quota.ts GrokUsageSnapshot, narrowed to what the
 *  Settings panel reads.  Kept inline so the Vite client does not import
 *  server modules (same boundary as the Antigravity/DeepSeek siblings). */
interface GrokUsageSnapshot {
  timestamp: string;
  method: "no-source" | "cli-quota" | "http-api";
  noSourceReason?: string;
  models: Array<{
    label: string;
    modelId: string;
    remainingPercentage: number | null;
    isExhausted: boolean;
    resetTime?: string;
  }>;
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

function formatCountdown(resetsAt?: number | null): string {
  if (!resetsAt) return "Rolling refresh window";
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return "Refreshing now";
  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

function formatUsdBalance(balance: number | null): string {
  if (balance == null) return "Balance unavailable";
  if (balance === 0) return "$0.00 remaining";
  return `$${balance.toFixed(2)} remaining`;
}

function formatSpendUsd(amount: number): string {
  if (!amount || amount === 0) return "$0.00";
  if (amount < 0.01) return `<$0.01 ($${amount.toFixed(4)})`;
  return `$${amount.toFixed(2)}`;
}

import {
  ENGINE_PLAN_OPTIONS,
  FALLBACK_MODEL_NAMES,
  modelDisplayName,
  defaultEnginePlan,
  findMatchingPreset,
  getInitialEnginePlans,
  type EnginePlanOption,
} from "@/lib/usage-plans";

export {
  ENGINE_PLAN_OPTIONS,
  FALLBACK_MODEL_NAMES,
  modelDisplayName,
  defaultEnginePlan,
  findMatchingPreset,
  getInitialEnginePlans,
  type EnginePlanOption,
};



export function UsageSection() {
  const { state, dispatch } = useStore();
  const [telemetryStatus, setTelemetryStatus] = React.useState<TelemetryStatusView | null>(null);
  const [telemetryFetchError, setTelemetryFetchError] = React.useState<string | null>(null);
  const [quotas, setQuotas] = React.useState<QuotaCooldownInfo[]>([]);
  const [antigravityQuota, setAntigravityQuota] = React.useState<AntigravityUsageSnapshot | null>(null);
  const [grokQuota, setGrokQuota] = React.useState<GrokUsageSnapshot | null>(null);
  const [deepseekBalance, setDeepSeekBalance] = React.useState<DeepSeekBalanceView | null>(null);
  const [engineSpend, setEngineSpend] = React.useState<Record<string, { spend5hUsd: number; spend7dUsd: number }>>({});
  const [quotaWindows, setQuotaWindows] = React.useState<Array<{
    id: string;
    provider: string;
    providerKey?: string | null;
    providerLabel?: string | null;
    sourceApp?: string | null;
    source?: string | null;
    via?: string | null;
    label: string;
    remainingPercent: number | null;
    resetAt: string | null;
    skip: boolean;
    status: string;
    window?: string | null;
    occurredAt?: string | null;
    modelId?: string | null;
    skipReason?: string | null;
    planName?: string | null;
    absoluteRemaining?: number | null;
    absoluteLimit?: number | null;
    quotaUnit?: string | null;
    isExhausted?: boolean;
    fileStatus?: string | null;
    fileSkip?: boolean;
    fileSkipReason?: string | null;
  }>>([]);
  const [localQuota, setLocalQuota] = React.useState<LocalQuotaFreshnessView | null>(null);
  const [expandedQuota, setExpandedQuota] = React.useState<string | null>(null);
  const usageConfig = state.config?.usage;
  const secretSources = useSecretSources();
  const infisicalConfigured = Boolean(state.config?.infisical?.configured);
  const writeThrough = Boolean(state.config?.infisical?.writeThrough);
  const ingestUrlSource = secretSources.get("usage.ingestUrl");
  const ingestTokenSource = secretSources.get("usage.ingestToken");
  const readTokenSource = secretSources.get("usage.readToken");
  // A 409 the operator cannot explain is the failure this prevents: with
  // Write Through off, Infisical is the only place a managed field can
  // change, so it disables outright instead of failing a save silently.
  const ingestUrlLocked = (ingestUrlSource?.managed ?? false) && !writeThrough;
  const ingestTokenLocked = (ingestTokenSource?.managed ?? false) && !writeThrough;
  const readTokenLocked = (readTokenSource?.managed ?? false) && !writeThrough;
  const [ingestUrl, setIngestUrl] = React.useState(usageConfig?.ingestUrl ?? "");
  const [ingestToken, setIngestToken] = React.useState("");
  const [readToken, setReadToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveOk, setSaveOk] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error: string | null } | null>(null);
  const [routingSaving, setRoutingSaving] = React.useState(false);
  // Absent means on: an install that predates the flag keeps the behaviour
  // the engine rows already describe.
  const localQuotaRouting = usageConfig?.localQuotaRouting !== false;

  const configuredEnginePlans = usageConfig?.enginePlans;
  const [enginePlans, setEnginePlans] = React.useState<Record<string, { planName: string; costPerMonth: number | null }>>(() =>
    getInitialEnginePlans(configuredEnginePlans),
  );
  const [savingPlans, setSavingPlans] = React.useState(false);
  const [savePlansOk, setSavePlansOk] = React.useState(false);
  const [savePlansError, setSavePlansError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEnginePlans(getInitialEnginePlans(configuredEnginePlans));
  }, [configuredEnginePlans]);

  const saveEnginePlans = async () => {
    setSavingPlans(true);
    setSavePlansError(null);
    setSavePlansOk(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ usage: { enginePlans } }),
      });
      dispatch({ type: "configStatus", config });
      setSavePlansOk(true);
      setTimeout(() => setSavePlansOk(false), 3000);
    } catch (_caught) {
      setSavePlansError("Couldn't save engine plans.\u00a0 Try again.");
    } finally {
      setSavingPlans(false);
    }
  };

  React.useEffect(() => {
    if (usageConfig?.ingestUrl !== undefined) setIngestUrl(usageConfig.ingestUrl);
  }, [usageConfig?.ingestUrl]);

  React.useEffect(() => {
    fetch("/api/telemetry/status")
      .then((res) => res.json())
      .then((data) => {
        setTelemetryStatus(data && typeof data === "object" ? data : null);
        setTelemetryFetchError(null);
      })
      .catch(() => {
        setTelemetryFetchError("Failed to fetch telemetry status");
      });

    const fetchQuotas = () => {
      fetch("/api/quotas")
        .then((res) => res.json())
        .then((data) => {
          if (data?.ok && Array.isArray(data.cooldowns)) {
            setQuotas(data.cooldowns);
          }
          if (data?.antigravity && Array.isArray(data.antigravity.models)) {
            setAntigravityQuota(data.antigravity);
          }
          // Grok's quota poller returns a no-source stub today (see
          // server/grok-quota.ts); still set state so the Settings panel
          // can render the "no quota source available yet" line and the
          // future swap to a real reader doesn't have to change this
          // block.
          if (data?.grok && typeof data.grok === "object") {
            setGrokQuota(data.grok);
          }
          if (Array.isArray(data?.windows)) {
            setQuotaWindows(data.windows);
          }
          if (data?.localQuota && typeof data.localQuota === "object") {
            setLocalQuota(data.localQuota);
          }
          if (data?.deepseek && typeof data.deepseek === "object") {
            setDeepSeekBalance(data.deepseek);
          }
          // MiniMax's balance/quota is no longer on this payload — it is
          // per-instance (a second connection has its own account) and
          // reaches the client on that instance's own GET /api/instances
          // snapshot.quota.minimax instead. See server/index.ts's comment
          // on this route.
          if (data?.engineSpend && typeof data.engineSpend === "object") {
            setEngineSpend(data.engineSpend);
          }
        })
        .catch(() => {});
    };
    fetchQuotas();
    const quotaInterval = setInterval(fetchQuotas, 30_000);
    return () => clearInterval(quotaInterval);
  }, []);
  const badge = telemetryBadge(telemetryStatus, telemetryFetchError);
  // Whatever host the operator pointed this at — never a built-in name.
  const host = telemetryHost(telemetryStatus);

  const refreshTelemetry = async () => {
    try {
      const refreshed = await fetch("/api/telemetry/status").then((r) => r.json());
      setTelemetryStatus(refreshed && typeof refreshed === "object" ? refreshed : null);
      setTelemetryFetchError(null);
    } catch {
      setTelemetryFetchError("Failed to fetch telemetry status");
    }
  };

  const saveUsage = async (): Promise<boolean> => {
    const built = buildUsageConfigPatch({ ingestUrl, ingestToken, readToken });
    if (!built.ok) {
      setSaveError(built.error);
      setSaveOk(false);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      // ingestUrl is always present in the built patch (blank means "clear"),
      // but the field disables outright when Infisical manages it and Write
      // Through is off — it cannot have changed here, and resending its
      // current value on every unrelated save would hit the 409 refusal gate
      // just for saving the read token.  ingestToken/readToken need no such
      // handling: their inputs are disabled the same way, and both are
      // already omitted from the patch whenever the field reads blank.
      const { ingestUrl: lockedIngestUrl, ...patchWithoutIngestUrl } = built.patch;
      void lockedIngestUrl;
      const usagePatch = ingestUrlLocked ? patchWithoutIngestUrl : built.patch;
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ usage: usagePatch }),
      });
      dispatch({ type: "configStatus", config });
      if (built.patch.ingestToken) setIngestToken("");
      if (built.patch.readToken) setReadToken("");
      await refreshTelemetry();
      setSaveOk(true);
      return true;
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleLocalQuotaRouting = async () => {
    setRoutingSaving(true);
    setSaveError(null);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ usage: { localQuotaRouting: !localQuotaRouting } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRoutingSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await saveUsage();
      if (!saved) {
        setTestResult({ ok: false, error: "Save the URL and ingest token before testing." });
        return;
      }
      const res = await fetch("/api/telemetry/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string | null };
      setTestResult({
        ok: Boolean(data.ok),
        error: data.ok ? null : (data.error || "Usage Monitor did not accept the probe."),
      });
      await refreshTelemetry();
    } catch (caught) {
      setTestResult({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  };

  const canTest = Boolean(ingestUrl.trim() || usageConfig?.ingestUrl) && Boolean(ingestToken.trim() || usageConfig?.hasToken);

  const usageInputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  const rows = state.bots
    .filter((b) => !b.hidden)
    .map((bot) => {
      const usage = botUsage(bot);
      const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
      return { bot, usage, billing: instance?.snapshot.billing };
    })
    .filter((r) => r.usage.turns > 0)
    // money first, then volume. Non-finite/missing costs sort last.
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) =>
        hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY;
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output);
    });
  const total = sumUsage(rows.map((r) => r.usage));
  const billings = new Set(rows.map((r) => r.billing));
  const botFleetQuotaWindows = quotaWindows.filter(isBotFleetQuotaWindow);
  // Why the grid is empty, in the one case where the answer is the native
  // app rather than the engine: nothing to show at all, or a handoff that
  // stopped being refreshed while BotFleet kept rendering the last of it.
  const localQuotaNotice =
    botFleetQuotaWindows.length === 0 || localQuota?.state === "stale" || localQuota?.state === "unreadable"
      ? localQuotaStatusLine(localQuota)
      : null;

  // "Expand all / collapse all" sits in the Card header; state lives at the
  // UsageSection level so a click anywhere on the page flips every bot at
  // once.  Persist-in-row expansion is local — same shape the engine picker
  // already uses for its cloud/local rail.
  const [expandedBots, setExpandedBots] = React.useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = React.useState(false);
  const toggleBot = React.useCallback((botId: string) => {
    setExpandedBots((prev) => {
      const next = { ...prev, [botId]: !prev[botId] };
      return next;
    });
  }, []);
  const setAll = React.useCallback((on: boolean) => {
    setAllExpanded(on);
    if (on) {
      const next: Record<string, boolean> = {};
      for (const { bot } of rows) next[bot.id] = true;
      setExpandedBots(next);
    } else {
      setExpandedBots({});
    }
  }, [rows]);

  // Map every bot's instanceId back to the registry key.  A user can
  // add a second MiniMax connection with a custom instanceId (the
  // multi-instance route in server/index.ts permits it), and that
  // custom id does not equal "minimax" verbatim.  Without this map,
  // those tokens fall through every aggregation filter and the
  // projection's MiniMax row stays at zero — Codex flagged it.
  const instanceIdToEngineId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const instance of state.instances) {
      const registryId = engineIdFromDriverKind(instance.driverKind) ?? engineIdFromDriverKind(instance.instanceId);
      if (registryId) map.set(instance.instanceId, registryId);
    }
    // Always map the canonical id verbatim so the default instance
    // aggregates into the registry row.
    for (const id of Object.keys(ENGINE_CAPABILITIES)) {
      if (!map.has(id)) map.set(id, id);
    }
    return map;
  }, [state.instances]);

  // Attribution helpers shared by the what-if projection rows and the
  // unattributed scan below.  A bucket banked with engine metadata wins;
  // a legacy bucket (no engineId) resolves only through a live instance
  // id — history from a deleted connection goes to the unattributed
  // total rather than being guessed onto the task's configured engine.
  const engineFor = (instanceId: string) =>
    instanceIdToEngineId.get(instanceId) ?? engineIdFromDriverKind(instanceId) ?? instanceId;
  const bucketEngine = (instanceId: string, engineId?: string) =>
    (engineId && (engineIdFromDriverKind(engineId) ?? instanceIdToEngineId.get(engineId) ?? engineId)) || engineFor(instanceId);
  // Only model ids unique to one engine map at all — a shared id
  // (claude-sonnet-4.5 is listed under Cursor AND Claude) used to
  // first-win onto Cursor and steal legacy Claude usage.
  const modelToEngineId = uniqueModelToEngineId();
  const resolveModelEngine = (model: string | undefined, fallbackEngine: string | null): string | null => {
    if (model) {
      if (model.toLowerCase().includes("minimax")) return "minimax";
      if (model.toLowerCase().includes("deepseek")) return "deepseek-harness";
      const byModelId = modelToEngineId.get(model);
      if (byModelId) return byModelId;
    }
    return fallbackEngine;
  };
  const legacyEngine = (instanceId: string | undefined, model?: string) => {
    if (model) {
      if (model.toLowerCase().includes("minimax")) return "minimax";
      if (model.toLowerCase().includes("deepseek")) return "deepseek-harness";
      const byModelId = modelToEngineId.get(model);
      if (byModelId) return byModelId;
    }
    if (instanceId) {
      const resolved = engineFor(instanceId);
      if (ENGINE_CAPABILITIES[resolved]) return resolved;
    }
    return null;
  };
  // A metadata-free bucket keyed by a custom connection slug must NOT
  // resolve through the live instance map: the slug can be deleted and
  // recreated with a different driver, and the live id would then credit
  // the new driver with the old bucket's history (forkKey kept the
  // buckets apart — the lookup must not rejoin them).  Only built-in,
  // driver-kind instance ids are stable enough to resolve.
  const legacyBucketEngine = (instanceId: string) =>
    instanceId.startsWith("custom-") ? null : legacyEngine(instanceId, undefined);
  // One pass over the same records the projection walks: metadata-free
  // buckets whose instance id no longer resolves to a registry engine
  // (deleted connections) cannot be honestly credited to any engine row,
  // so they total into an unattributed figure the projection footnote
  // shows instead of dropping the history.
  let unattributedTokens30d = 0;
  {
    const periodStartMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const bot of state.bots) {
      for (const task of bot.tasks ?? []) {
        if ((task.lastActivity ?? task.createdAt) < periodStartMs) continue;
        const buckets = Object.entries(task.usageByInstance ?? {});
        let bucketedTurns = 0;
        let bucketedInput = 0;
        let bucketedOutput = 0;
        for (const [bucketInstanceId, bucketUsage] of buckets) {
          bucketedTurns += bucketUsage.turns ?? 0;
          bucketedInput += bucketUsage.input;
          bucketedOutput += bucketUsage.output;
          if ((bucketUsage.turns ?? 0) <= 0) continue;
          if (bucketUsage.engineId) continue;
          if (legacyBucketEngine(bucketInstanceId)) continue;
          if (bucketUsage.byModel && Object.keys(bucketUsage.byModel).length > 0) {
            const hasResolved = Object.keys(bucketUsage.byModel).some((m) => resolveModelEngine(m, null) != null);
            if (hasResolved) continue;
          }
          unattributedTokens30d += bucketUsage.input + bucketUsage.output;
        }
        // Un-bucketed usage (a task with no buckets at all, or the
        // pre-banking remainder) whose legacy resolution comes back null
        // — a deleted custom connection with an unknown model — is
        // counted nowhere in the engine rows; total it here too.
        const legacy = task.usage;
        if (!legacy || (legacy.turns ?? 0) <= 0) continue;
        if (legacyEngine(task.modelSelection?.instanceId ?? bot.modelSelection?.instanceId, task.modelSelection?.model)) continue;
        if (buckets.length === 0) {
          unattributedTokens30d += legacy.input + legacy.output;
        } else if ((legacy.turns ?? 0) - bucketedTurns > 0) {
          unattributedTokens30d += Math.max(0, legacy.input - bucketedInput) + Math.max(0, legacy.output - bucketedOutput);
        }
      }
      for (const [roomInstanceId, roomUsage] of Object.entries(bot.roomUsageByInstance ?? {})) {
        if (roomUsage.lastAt < periodStartMs) continue;
        if ((roomUsage.turns ?? 0) <= 0) continue;
        if (roomUsage.engineId) continue;
        if (legacyBucketEngine(roomInstanceId)) continue;
        if (roomUsage.byModel && Object.keys(roomUsage.byModel).length > 0) {
          const hasResolved = Object.keys(roomUsage.byModel).some((m) => resolveModelEngine(m, null) != null);
          if (hasResolved) continue;
        }
        unattributedTokens30d += roomUsage.input + roomUsage.output;
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Usage"
        subtitle={`Tokens and cost per bot, added up from every settled turn.\u00A0  Click a bot to expand its sessions and see model, tokens in/out, $/turn, and the per-session cumulative.\u00A0  A turn that ran on a fallback is billed as that fallback reported it, not as the bot's current model.\u00A0  Only engines that report a price show one.`}
        actions={
          rows.length > 0 ? (
            <button
              type="button"
              onClick={() => setAll(!allExpanded)}
              className="rounded-md border border-hairline/40 bg-inset/30 px-2 py-0.5 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          ) : null
        }
      >
        {rows.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">Nothing spent yet — figures appear after a bot's first turn.</div>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>Bot</span>
              <span className="text-right">Turns</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
            </div>
            {rows.map(({ bot, usage }) => {
              const open = allExpanded || Boolean(expandedBots[bot.id]);
              return (
                <UsageRow
                  key={bot.id}
                  bot={bot}
                  usage={usage}
                  open={open}
                  instances={state.instances}
                  onToggle={() => {
                    toggleBot(bot.id);
                    if (allExpanded) setAllExpanded(false);
                  }}
                />
              );
            })}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
              <span>All bots</span>
              <span className="text-right tabular-nums">{total.turns}</span>
              <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(total.input + total.output)}</span>
              <span className="text-right tabular-nums">{hasFiniteCost(total.costUsd) ? formatUsd(total.costUsd) : "—"}</span>
            </div>
            {cachedInput(total) > 0 && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Tokens count everything the model read and wrote. Each turn resends the whole conversation with the system prompt and tool
                schemas, so {formatTokens(cachedInput(total))} of the input was context re-read from the provider's cache rather than new text —
                hover a figure for the split.
              </div>
            )}
            {hasFiniteCost(total.costUsd) && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Cost is {billings.size === 1 ? costCaption([...billings][0]) : "as each engine reports it — on a subscription it's an equivalent, not a charge"}.
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Engine Quotas"
        subtitle="Live remaining usage for each engine.  Hover or click a row for the full remaining breakdown."
      >
        {localQuotaNotice && (
          <div className="mb-2 rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
            {localQuotaNotice}
          </div>
        )}
        <div className="flex flex-col divide-y divide-hairline/20">
          {state.instances.filter((instance) => {
            if (instance.enabled === false || isHiddenQuotaEngine(instance.driverKind)) return false;
            const isDeepSeek =
              instance.driverKind === "deepseekAgent" ||
              instance.driverKind === "dshAgent" ||
              instance.driverKind === "deepseek";
            const spend =
              engineSpend[instance.driverKind] ??
              engineSpend[instance.instanceId] ??
              (isDeepSeek ? (engineSpend["deepseek"] ?? engineSpend["deepseekAgent"]) : undefined);
            const instanceCooldowns = quotas.filter((q) => q.instanceId === instance.instanceId);
            const instanceWindows = windowsForDriver(botFleetQuotaWindows, instance.driverKind)
              .filter((window) => !(instance.instanceId === "minimax" && isMiniMaxVideoQuotaWindow(window)));
            const isMiniMax = instance.driverKind === "minimax";
            const hasQuotaData =
              Boolean(instance.snapshot.quota?.capped) ||
              Boolean(instance.snapshot.quota?.models && Object.keys(instance.snapshot.quota.models).length > 0) ||
              instanceCooldowns.length > 0 ||
              instanceWindows.length > 0 ||
              (instance.instanceId === "antigravity" && (antigravityQuota?.models?.length ?? 0) > 0) ||
              // Grok's quota poller returns a no-source stub today
              // (see server/grok-quota.ts); a configured Grok instance
              // still renders because we want the "no quota source
              // available yet" line to show under the row.
              instance.instanceId === "grok" ||
              (isDeepSeek && deepseekBalance?.balanceUsd != null) ||
              // MiniMax's row must render whenever the engine is configured,
              // not only once it's capped or has spent something — a fresh
              // Token Plan/pay-as-you-go account with a real capExists
              // reading counts as "has quota data" on its own. Read off this
              // INSTANCE's own snapshot (server/harness/registry.ts computes
              // it per instance) — never a value shared across every
              // MiniMax row, which is what let a second connection show the
              // reserved instance's numbers.
              (isMiniMax && Boolean(instance.snapshot.quota?.minimax?.capExists)) ||
              Boolean(spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0));
            // A configured engine that has gone unavailable — a Box token set
            // but the API unreachable, a login that expired, a CLI that stops
            // launching — must still show its row with the real failure
            // reason below. Only engines never set up (no CLI, no key/token)
            // or explicitly disabled are worth hiding when they have no
            // quota data of their own.
            if (instance.snapshot.state !== "available" && !hasQuotaData) {
              return !isEngineUnconfigured(instance.snapshot.reason);
            }
            return true;
          }).map((instance) => {
            const isMiniMax = instance.driverKind === "minimax";
            const wildcardCap = Boolean(instance.snapshot.quota?.capped);
            const instanceCooldowns = quotas.filter((q) => q.instanceId === instance.instanceId);
            const quotaCooldown = instanceCooldowns.find((q) => q.model === "*") ?? instanceCooldowns[0];
            const agModels = instance.instanceId === "antigravity"
              ? (antigravityQuota?.models ?? []).filter((model) => !model.isAutocompleteOnly)
              : [];
            const agGroups = antigravityGroupSummary(agModels, antigravityQuota?.promptCredits);
            const agLines = antigravityQuotaLines(agModels, antigravityQuota?.promptCredits);
            const allInstanceWindows = windowsForDriver(botFleetQuotaWindows, instance.driverKind);
            const miniMaxVideoWindows = instance.instanceId === "minimax"
              ? allInstanceWindows.filter(isMiniMaxVideoQuotaWindow)
              : [];
            const instanceWindows = allInstanceWindows.filter((window) => !miniMaxVideoWindows.includes(window));
            const usageMonitorAGWindows = instance.instanceId === "antigravity"
              ? antigravityDisplayWindows(botFleetQuotaWindows, agModels, antigravityQuota?.timestamp)
              : [];
            const hasUsageMonitorAG = usageMonitorAGWindows.length > 0;
            const headlines = windowHeadlines(instanceWindows);
            const windowLines = usageWindowLines(instanceWindows);
            const planSkip = !hasUsageMonitorAG && instanceWindows.some((window) => isPlanLevelSkip(window));
            // The chip reads the same headline buckets the grid under it
            // renders.  planSkip alone could never see a local window: it
            // requires window.skip, which the local parser keeps false by
            // design, so a spent Codex week showed a red 0% cell under a
            // green "Available" chip.
            const windowsExhausted = !hasUsageMonitorAG && headlinesExhausted(headlines);
            const windowsNearCap = !hasUsageMonitorAG && headlinesNearCap(headlines);
            const agExhausted = agGroups.filter((line) => line.exhausted);
            const minimaxRow = isMiniMax ? instance.snapshot.quota?.minimax ?? null : null;
            const minimaxLine = minimaxRow ? minimaxQuotaLine(minimaxRow) : null;
            // Cap accounts for Usage Monitor Antigravity pools, MiniMax token-plan
            // exhaustion, and local group exhaustion so an all-spent pool is not
            // hidden behind an average remaining percent.
            const isCapped = wildcardCap || planSkip || windowsExhausted || minimaxRow?.status === "capped" || (hasUsageMonitorAG
              ? antigravityQuotaCapped(usageMonitorAGWindows)
              : agGroups.length > 0
                ? agExhausted.length === agGroups.length
                : instanceCooldowns.some((q) => q.model === "*"));
            // DeepSeek balance only applies to the DeepSeek engine. Surfaced
            // as a third status line so the user can see "$12.34 remaining"
            // (or "Balance unavailable") without expanding the row.
            const isDeepSeek =
              instance.driverKind === "deepseekAgent" ||
              instance.driverKind === "dshAgent" ||
              instance.driverKind === "deepseek";
            const deepseekRow = isDeepSeek
              ? deepseekBalance
              : null;
            // deepseek-balance.ts's own contract: "Set when the key is
            // missing, the request failed, or the response was not
            // parseable. The UI hides the chip when this is set." — so the
            // line is shown only when there is an actual balance to report,
            // never as a substitute for the engine's real state (capped,
            // disabled, unavailable) below.
            const deepseekLine = deepseekRow && !deepseekRow.error && deepseekRow.balanceUsd != null
              ? formatUsdBalance(deepseekRow.balanceUsd)
              : null;
            const spend =
              engineSpend[instance.driverKind] ??
              engineSpend[instance.instanceId] ??
              (isDeepSeek ? (engineSpend["deepseek"] ?? engineSpend["deepseekAgent"]) : undefined);
            let deepseekStatus = deepseekLine;
            if (deepseekLine && spend) {
              deepseekStatus = `${deepseekLine}  ·  Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            } else if (!isMiniMax && spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0)) {
              // Not for MiniMax: its own block below composes the same spend
              // figures onto its quota line, and both strings are appended to
              // the same headline strip — so without this guard the row read
              // "Spent: … · 94% left this week … · Spent: …".  Every other
              // engine keeps the standalone spend line it has always had.
              deepseekStatus = `Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            }
            // Same "quota headline + spend" composition as DeepSeek above,
            // for MiniMax's own quota/balance line — the only other engine
            // with both a real quota reading and a real per-turn cost today.
            let minimaxStatus = minimaxLine;
            if (isMiniMax && minimaxLine && spend) {
              minimaxStatus = `${minimaxLine}  ·  Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            } else if (isMiniMax && spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0)) {
              minimaxStatus = `Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            }
            const isPartial = !isCapped && (hasUsageMonitorAG
              ? usageMonitorAGWindows.some((window) => window.skip || window.remainingPercent === 0)
              : agExhausted.length > 0 || instanceCooldowns.some((q) => q.model !== "*"));
            // "Near cap" is a reading about a healthy engine, so it only
            // applies while the engine IS healthy.  The balance snapshot is
            // cached for five minutes, so a key revoked mid-window leaves a
            // stale near_cap reading sitting where the real "MiniMax key
            // rejected (HTTP 401)" belongs unless the state gates it.
            // MiniMax keeps its own API's 10% verdict; every other engine's
            // windows warn at quota-display.ts's NEAR_CAP_PERCENT, the same
            // share the server already derives its near_cap status at.
            const isNearCap = instance.snapshot.state === "available"
              && !isCapped && !isPartial && (minimaxRow?.status === "near_cap" || windowsNearCap);
            const isDisabled = instance.snapshot.reason === "Disabled in settings";
            const isUnavailable = instance.snapshot.state !== "available";
            const isAvailable = !isUnavailable && !isCapped && !isPartial && !isNearCap && !isDisabled;
            const showGenericGrid = !hasUsageMonitorAG && instanceWindows.length > 0;
            // A provider the collector could not read publishes no window at
            // all, so the engine used to vanish from the grid with nothing
            // said.  Its reason is the producer's own user-safe text and is
            // rendered as plain text, never markup.
            const engineProvider = quotaProviderForDriver(instance.driverKind);
            const engineIssue = !showGenericGrid && !hasUsageMonitorAG && engineProvider
              ? providerIssueLine(instance.displayName, localQuota?.issues?.[engineProvider], localQuota?.producer)
              : null;
            const baseDetailLines = hasUsageMonitorAG
              ? []
              : agLines.length > 0
                ? agLines
                : showGenericGrid
                  ? []
                  : windowLines;
            const detailLines = [...baseDetailLines];
            if (minimaxRow && minimaxLine) {
              detailLines.unshift({
                label: minimaxRow.source === "account-balance" ? "Remaining Balance" : "Token Plan Quota",
                value: minimaxLine,
                exhausted: minimaxRow.status === "capped",
                group: "external" as const,
              });
            }
            if (isDeepSeek && deepseekRow && !deepseekRow.error && deepseekRow.balanceUsd != null) {
              detailLines.unshift({
                label: "Remaining Balance",
                value: formatUsdBalance(deepseekRow.balanceUsd),
                exhausted: deepseekRow.availability === "exhausted" || deepseekRow.balanceUsd <= 0,
                group: "external" as const,
              });
              if (deepseekRow.grantedUsd != null && deepseekRow.toppedUpUsd != null) {
                detailLines.push({
                  label: "Granted / Topped Up",
                  value: `$${deepseekRow.grantedUsd.toFixed(2)} granted · $${deepseekRow.toppedUpUsd.toFixed(2)} topped up`,
                  exhausted: false,
                  group: "external" as const,
                });
              }
            }
            if (spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0 || isDeepSeek)) {
              detailLines.push({
                label: "Spend (Past 5 Hours)",
                value: formatSpendUsd(spend.spend5hUsd),
                exhausted: false,
                group: "window" as const,
              });
              detailLines.push({
                label: "Spend (Past Week)",
                value: formatSpendUsd(spend.spend7dUsd),
                exhausted: false,
                group: "window" as const,
              });
            }
            const fullSummary = detailLines.length > 0
              ? quotaLinesSummary(detailLines)
              : null;
            // Headline lines sit directly under the engine name for ordinary
            // engines.  Usage Monitor Antigravity windows render in the
            // always-visible four-cell grid below the row.
            const headlineLines = hasUsageMonitorAG
              ? []
              : agGroups.length > 0
              ? agGroups.map((group) => {
                  if (group.headline) return group.headline;
                  const value = group.remainingPercent == null
                    ? "not reported"
                    : `${group.remainingPercent}% available`;
                  return `${group.label}: ${value} (5h window)`;
                })
              : [
                  // The wildcard cooldown (Cursor's monthly cap, an exhausted
                  // anonymous bucket from a custom driver, etc.) is a real
                  // signal the user needs to read in the headline strip —
                  // without it the chip says "At Usage Cap" with no source.
                  // Skip when Usage Monitor already produced a Monthly row.
                  ...(wildcardCap && !headlines.some((headline) => headline.display === "Monthly")
                    ? [{
                        display: "Monthly",
                        remainingPercent: 0,
                        resetAtMs: typeof quotaCooldown?.resetsAt === "number"
                          ? quotaCooldown.resetsAt
                          : typeof quotaCooldown?.resetsAt === "string"
                            ? Date.parse(quotaCooldown.resetsAt) || null
                            : null,
                      }]
                    : []),
                  ...headlines,
                ].map((headline) => {
                  const value = headline.remainingPercent == null
                    ? "not reported"
                    : `${headline.remainingPercent}% available`;
                  const reset = formatResetCountdown(headline.resetAtMs);
                  return reset ? `${headline.display} ${value} · resets in ${reset}` : `${headline.display} ${value}`;
                });
            const allHeadlineLines = [
              ...headlineLines,
              ...(deepseekStatus ? [deepseekStatus] : []),
              ...(minimaxStatus ? [minimaxStatus] : []),
            ];
            // Antigravity's own "Gemini"/"Third-Party" summary already names
            // its windows explicitly, so the combined badge below is only
            // for the other engines whose windows come through Usage
            // Monitor (Claude, Codex, Cursor, Kimi, Grok, DSH, DeepSeek) —
            // generalizing the "5hr" / "5hr/Week" vocabulary antigravity-quota.ts
            // and minimax-balance.ts already use, instead of leaving it
            // Antigravity-only.
            const combinedWindowsLabel = agGroups.length === 0 ? windowsLabelFromHeadlines(headlines) : undefined;
            // pi, qwen, hermes, opencodeGo and boxAgent have no Usage Monitor
            // window family at all (quota-window-map.ts's engineMeterNote) —
            // say so explicitly instead of falling through to generic
            // "Active and ready for turns" filler.
            const meterNote = engineMeterNote(instance.driverKind);
            // The engine's real state — capped, partially capped, disabled,
            // or otherwise unavailable — must win over a headline percentage
            // line, not the other way around: a stale "70% available" (or a
            // DeepSeek balance chip) sitting where "At Usage Cap" or
            // "Disabled in settings" belongs is what let the DeepSeek row
            // read "balance unavailable" forever instead of its real status.
            // Grok quota poller returns a no-source snapshot today — render an
            // honest "no quota source available yet" line instead of a
            // fabricated 100% / Ready chip.  When xAI ships a quota
            // endpoint the swap is in `server/grok-quota.ts`, not here.
            const isGrokNoSource =
              instance.instanceId === "grok" && (!grokQuota || grokQuota.method === "no-source");
            const grokNoSourceLine = isGrokNoSource
              ? (grokQuota?.noSourceReason ?? "No quota source available yet for Grok.")
              : null;

            // The headline/fullSummary lines are shown only for the healthy,
            // uncapped path they were designed for.  Grok's no-source line
            // sits with them — below the capped/partial/disabled/unavailable
            // branches, because the engine's real state must outrank it.
            const statusLine = isCapped
              // MiniMax's own line already names the binding window's real
              // reset time (minimaxQuotaLine); the generic cooldown-based
              // wording below has nothing for MiniMax specifically and
              // fell back to "Rolling refresh window" for it.
              ? (isMiniMax && minimaxRow?.status === "capped" && minimaxLine
                  ? minimaxLine
                  : `${quotaCooldown?.error ?? "Session limit or usage quota reached"} · ${formatCountdown(quotaCooldown?.resetsAt)}`)
              : isPartial
              ? `${quotaCooldown?.error ?? "Some models are at a usage cap"} · ${formatCountdown(quotaCooldown?.resetsAt)}`
              : isDisabled
              ? "Disabled in settings · subscription inactive"
              : isUnavailable
              ? instance.snapshot.reason ?? "Unavailable"
              : grokNoSourceLine
              ? grokNoSourceLine
              : isNearCap
              ? (minimaxLine ?? (allHeadlineLines.length > 0 ? allHeadlineLines.join("  ·  ") : "Approaching its usage cap"))
              : allHeadlineLines.length > 0
              ? allHeadlineLines.join("  ·  ")
              : fullSummary
              ? fullSummary
              : meterNote
              ? meterNote.copy
              : instance.snapshot.version ? `v${instance.snapshot.version} · Ready` : "Active and ready for turns";
            const open = expandedQuota === instance.instanceId;

            return (
              <div key={instance.instanceId} className="py-1">
                <button
                  type="button"
                  onClick={() => setExpandedQuota(open ? null : instance.instanceId)}
                  aria-expanded={open}
                  title={statusLine}
                  className="flex w-full items-center justify-between py-1.5 text-left text-[13px] hover:bg-control/40 rounded-lg px-1 -mx-1"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-control/60">
                      <ProviderMark driverKind={instance.driverKind} size={16} iconUrl={instance.iconUrl} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-ink">
                        {instance.displayName}
                        {combinedWindowsLabel && (
                          <span className="ml-1 font-normal text-[11px] text-ink-secondary">({combinedWindowsLabel})</span>
                        )}
                      </span>
                      <span className="truncate text-[11.5px] text-ink-secondary">
                        {statusLine}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pl-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                        isCapped
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          : isPartial
                          ? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
                          : isDisabled
                          ? "bg-inset text-ink-secondary"
                          : isUnavailable
                          ? "bg-inset text-ink-secondary"
                          : isNearCap
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : isAvailable
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-inset text-ink-secondary"
                      }`}
                    >
                      {isCapped ? "At Usage Cap" : isPartial ? "Partial Cap" : isDisabled ? "Disabled" : isUnavailable ? "Unavailable" : isNearCap ? "Near Cap" : isAvailable ? "Available" : "Unavailable"}
                    </span>
                    <ChevronDown
                      size={14}
                      className={cn("text-ink-secondary transition-transform", open && "rotate-180")}
                    />
                  </div>
                </button>
                {hasUsageMonitorAG && <UsageMonitorQuotaGrid windows={usageMonitorAGWindows} />}
                {showGenericGrid && <UsageMonitorQuotaGrid windows={instanceWindows as any} />}
                {engineIssue && (
                  <div className="ml-9 mt-1.5 rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-secondary" title={engineIssue}>
                    {engineIssue}
                  </div>
                )}
                {open && detailLines.length > 0 && (
                  <div className="mb-1.5 ml-9 flex flex-col gap-1 rounded-lg border border-hairline/20 bg-inset/30 p-2.5">
                    {detailLines.map((line) => (
                      <div key={`${line.group}:${line.label}`} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="min-w-0 truncate text-ink" title={line.label}>{line.label}</span>
                        <span className={cn("shrink-0 tabular-nums", line.exhausted ? "text-amber-700 dark:text-amber-300" : "text-ink-secondary")}>
                          {line.value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {miniMaxVideoWindows.length > 0 && (
                  <details className="ml-9 mt-1.5 rounded-lg border border-hairline/20 bg-inset/20 px-2.5 py-1.5 text-[11px]">
                    <summary className="cursor-pointer text-ink-secondary">Video Quota ({miniMaxVideoWindows.length})</summary>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {miniMaxVideoWindows.map((window) => {
                        // SAFETY: `/api/quotas` windows include id/resetAt; QuotaWindowMatch omits these optional transport fields.
                        const quotaWindow = window as typeof window & { id?: string; resetAt?: string | null };
                        const resetAt = quotaWindow.resetAt;
                        const windowId = quotaWindow.id ?? `${window.provider}:${window.label}:${window.modelId ?? ""}`;
                        const percent = window.remainingPercent != null && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100
                          ? `${Math.round(window.remainingPercent)}% remaining`
                          : "not reported";
                        const reset = resetAt ? Date.parse(resetAt) : Number.NaN;
                        const countdown = Number.isFinite(reset) ? formatResetCountdown(reset) : "reset unknown";
                        return (
                          <div key={windowId} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-ink" title={window.label}>{window.label}</span>
                            <span className="shrink-0 tabular-nums text-ink-secondary" title={resetAt ?? undefined}>
                              {percent} · {countdown}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
          Usage Monitor quota snapshots are read while the app is open and considered fresh for 15 minutes — its own five-minute refresh plus two missed cycles.{'\u00A0'} Antigravity shows four shared windows: Gemini Models and Third-Party Models across 5-hour and weekly periods.{'\u00A0'} Exhausted models fail over to the saved chain before the next turn.
        </div>
      </Card>

      <Card
        title="Pricing Mode by Engine"
        subtitle={'What you actually pay on each engine.\u00A0 Select your plan or enter a custom monthly cost so the estimate below matches what you pay.'}
      >
        <div className="flex flex-col">
          <div className="grid grid-cols-[1.3fr_1.8fr_1.1fr_0.9fr] gap-x-3 border-b border-hairline/40 pb-2 text-[11.5px] font-medium text-ink-secondary">
            <span>Engine</span>
            <span>Your Plan</span>
            <span className="text-right">Monthly Cost</span>
            <span className="text-right">Per 1k In</span>
          </div>
          {Object.entries(ENGINE_CAPABILITIES).map(([id, entry]) => {
            const currentPlan = enginePlans[id] ?? defaultEnginePlan(id);
            const options = ENGINE_PLAN_OPTIONS[id] ?? [];
            const sub = entry.pricing.kind === "subscription" || entry.pricing.kind === "subscription+api"
              ? entry.pricing.subscription
              : null;
            const api = entry.pricing.kind === "api" || entry.pricing.kind === "subscription+api"
              ? entry.pricing.api
              : null;
            const allRowsHaveApi = Object.values(ENGINE_CAPABILITIES).every((entry) =>
              entry.pricing.kind === "subscription+api" || entry.pricing.kind === "api",
            );
            const showNumericApi = api != null && allRowsHaveApi;
            const apiCost = showNumericApi ? `$${api.inputPer1k.toFixed(5)}` : "—";
            const matchingPreset = findMatchingPreset(id, currentPlan.planName, currentPlan.costPerMonth);
            const isCustom = !matchingPreset;

            return (
              <div key={id} className="grid grid-cols-[1.3fr_1.8fr_1.1fr_0.9fr] items-center gap-x-3 border-b border-hairline/20 py-2.5 text-[13px]">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-ink" title={entry.displayName}>{entry.displayName}</span>
                  <span className="truncate text-[11px] text-ink-secondary/90" title={entry.pricing.notes ?? sub?.notes ?? api?.notes ?? ""}>
                    {entry.pricing.kind === "api" ? "API pay-as-you-go" : entry.pricing.kind === "free" ? "Free engine" : "Subscription engine"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <select
                    value={isCustom ? "custom" : matchingPreset.planName}
                    onChange={(e) => {
                      const selectedVal = e.target.value;
                      if (selectedVal === "custom") {
                        setEnginePlans((prev) => ({
                          ...prev,
                          [id]: { planName: matchingPreset ? "Custom Plan" : (currentPlan.planName || "Custom Plan"), costPerMonth: currentPlan.costPerMonth ?? 0 },
                        }));
                      } else {
                        const opt = options.find((o) => o.planName === selectedVal);
                        if (opt) {
                          setEnginePlans((prev) => ({
                            ...prev,
                            [id]: { planName: opt.planName, costPerMonth: opt.costPerMonth },
                          }));
                        }
                      }
                    }}
                    className="rounded border border-hairline/40 bg-control px-2 py-1 text-[12px] text-ink"
                  >
                    {options.map((opt) => (
                      <option key={opt.planName} value={opt.planName}>
                        {opt.label}
                      </option>
                    ))}
                    <option value="custom">Custom Plan…</option>
                  </select>
                  {isCustom && (
                    <input
                      type="text"
                      placeholder="Plan Name"
                      value={currentPlan.planName ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEnginePlans((prev) => ({
                          ...prev,
                          [id]: { planName: val, costPerMonth: prev[id]?.costPerMonth ?? currentPlan.costPerMonth ?? null },
                        }));
                      }}
                      className="rounded border border-hairline/40 bg-control px-2 py-0.5 text-[11.5px] text-ink"
                    />
                  )}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <span className="text-[12px] text-ink-secondary">$</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="0.00"
                    disabled={currentPlan.costPerMonth === null && !isCustom && entry.pricing.kind !== "subscription+api"}
                    value={currentPlan.costPerMonth != null ? currentPlan.costPerMonth : ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? null : parseFloat(e.target.value);
                      setEnginePlans((prev) => ({
                        ...prev,
                        [id]: { planName: prev[id]?.planName ?? currentPlan.planName ?? "Custom Plan", costPerMonth: val != null && !isNaN(val) ? val : null },
                      }));
                    }}
                    className="w-20 rounded border border-hairline/40 bg-control px-1.5 py-1 text-right text-[12px] tabular-nums text-ink disabled:opacity-40"
                  />
                  <span className="text-[11px] text-ink-secondary">/mo</span>
                </div>
                <span className="text-right tabular-nums text-ink-secondary" title={showNumericApi ? `${api?.inputPer1k}/1k in · ${api?.outputPer1k}/1k out` : "Subscription pricing"}>
                  {showNumericApi ? apiCost : <span className="text-emerald-700 dark:text-emerald-300">Included</span>}
                </span>
              </div>
            );
          })}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline/20 pt-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void saveEnginePlans()}
                disabled={savingPlans}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingPlans ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save Engine Plans
              </button>
              {savePlansOk && (
                <span className="flex items-center gap-1 text-[12px] text-success">
                  <CheckCircle size={13} />
                  Saved
                </span>
              )}
              {savePlansError && (
                <span className="text-[12px] text-danger">{savePlansError}</span>
              )}
            </div>
            <span className="text-[11.5px] text-ink-secondary">
              Plans are stored in your settings so the estimate below matches what you pay.
            </span>
          </div>
        </div>
      </Card>

      <UsageWhatIfProjection
        periodLabel="Last 30 days"
        unattributedTokens={unattributedTokens30d}
        byEngine={[
          ...Object.entries(ENGINE_CAPABILITIES).flatMap(([id, entry]) => {
            if (entry.pricing.kind !== "subscription+api" && entry.pricing.kind !== "api") return [];
            const periodStartMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
            let tokensForEngine = 0;
            let cachedForEngine = 0;
            let inputForEngine = 0;
            let outputForEngine = 0;
            for (const bot of state.bots) {
              const botInstanceId = bot.modelSelection?.instanceId;
              for (const task of bot.tasks ?? []) {
                if ((task.lastActivity ?? task.createdAt) < periodStartMs) continue;
                const buckets = task.usageByInstance && Object.keys(task.usageByInstance).length > 0
                  ? Object.entries(task.usageByInstance)
                  : null;
                if (buckets) {
                  let bucketedTurns = 0;
                  let bucketedInput = 0;
                  let bucketedOutput = 0;
                  let bucketedCached = 0;
                  for (const [bucketInstanceId, bucketUsage] of buckets) {
                    bucketedTurns += bucketUsage.turns ?? 0;
                    bucketedInput += bucketUsage.input;
                    bucketedOutput += bucketUsage.output;
                    bucketedCached += cachedInput(bucketUsage);
                    if ((bucketUsage.turns ?? 0) <= 0) continue;
                    const resolvedBucketEngine = bucketUsage.engineId
                      ? bucketEngine(bucketInstanceId, bucketUsage.engineId)
                      : legacyBucketEngine(bucketInstanceId);

                    const byModelEntries = Object.entries(bucketUsage.byModel ?? {});
                    if (byModelEntries.length > 0) {
                      let modeledTurns = 0;
                      let modeledInput = 0;
                      let modeledOutput = 0;
                      let modeledCached = 0;
                      for (const [modelName, modelUsage] of byModelEntries) {
                        modeledTurns += modelUsage.turns ?? 0;
                        modeledInput += modelUsage.input;
                        modeledOutput += modelUsage.output;
                        modeledCached += cachedInput(modelUsage);
                        const modelEngine = resolveModelEngine(modelName, resolvedBucketEngine);
                        if (modelEngine === id) {
                          tokensForEngine += modelUsage.input + modelUsage.output;
                          cachedForEngine += cachedInput(modelUsage);
                          inputForEngine += modelUsage.input;
                          outputForEngine += modelUsage.output;
                        }
                      }
                      const remTurns = (bucketUsage.turns ?? 0) - modeledTurns;
                      if (remTurns > 0) {
                        const remInput = Math.max(0, bucketUsage.input - modeledInput);
                        const remOutput = Math.max(0, bucketUsage.output - modeledOutput);
                        const remCached = Math.max(0, cachedInput(bucketUsage) - modeledCached);
                        if (resolvedBucketEngine === id) {
                          tokensForEngine += remInput + remOutput;
                          cachedForEngine += remCached;
                          inputForEngine += remInput;
                          outputForEngine += remOutput;
                        }
                      }
                    } else {
                      if (resolvedBucketEngine === id) {
                        tokensForEngine += bucketUsage.input + bucketUsage.output;
                        cachedForEngine += cachedInput(bucketUsage);
                        inputForEngine += bucketUsage.input;
                        outputForEngine += bucketUsage.output;
                      }
                    }
                  }
                  const legacy = task.usage;
                  if (legacy && (legacy.turns ?? 0) - bucketedTurns > 0) {
                    const fallback = legacyEngine(task.modelSelection?.instanceId ?? botInstanceId, task.modelSelection?.model);
                    const legacyEngineId = resolveModelEngine(task.modelSelection?.model, fallback);
                    if (legacyEngineId === id) {
                      const rInput = Math.max(0, legacy.input - bucketedInput);
                      const rOutput = Math.max(0, legacy.output - bucketedOutput);
                      const rCached = Math.max(0, cachedInput(legacy) - bucketedCached);
                      tokensForEngine += rInput + rOutput;
                      cachedForEngine += rCached;
                      inputForEngine += rInput;
                      outputForEngine += rOutput;
                    }
                  }
                  continue;
                }
                if ((task.usage?.turns ?? 0) <= 0) continue;
                const fallback = legacyEngine(task.modelSelection?.instanceId ?? botInstanceId, task.modelSelection?.model);
                const legacyEngineId = resolveModelEngine(task.modelSelection?.model, fallback);
                if (legacyEngineId !== id) continue;
                tokensForEngine += task.usage!.input + task.usage!.output;
                cachedForEngine += cachedInput(task.usage!);
                inputForEngine += task.usage!.input;
                outputForEngine += task.usage!.output;
              }
              for (const [roomInstanceId, roomUsage] of Object.entries(bot.roomUsageByInstance ?? {})) {
                if (roomUsage.lastAt < periodStartMs) continue;
                if ((roomUsage.turns ?? 0) <= 0) continue;
                const resolvedRoomEngine = roomUsage.engineId
                  ? bucketEngine(roomInstanceId, roomUsage.engineId)
                  : legacyBucketEngine(roomInstanceId);
                const roomByModelEntries = Object.entries(roomUsage.byModel ?? {});
                if (roomByModelEntries.length > 0) {
                  let modeledTurns = 0;
                  let modeledInput = 0;
                  let modeledOutput = 0;
                  let modeledCached = 0;
                  for (const [modelName, modelUsage] of roomByModelEntries) {
                    modeledTurns += modelUsage.turns ?? 0;
                    modeledInput += modelUsage.input;
                    modeledOutput += modelUsage.output;
                    modeledCached += cachedInput(modelUsage);
                    const modelEngine = resolveModelEngine(modelName, resolvedRoomEngine);
                    if (modelEngine === id) {
                      tokensForEngine += modelUsage.input + modelUsage.output;
                      cachedForEngine += cachedInput(modelUsage);
                      inputForEngine += modelUsage.input;
                      outputForEngine += modelUsage.output;
                    }
                  }
                  const remTurns = (roomUsage.turns ?? 0) - modeledTurns;
                  if (remTurns > 0) {
                    const remInput = Math.max(0, roomUsage.input - modeledInput);
                    const remOutput = Math.max(0, roomUsage.output - modeledOutput);
                    const remCached = Math.max(0, cachedInput(roomUsage) - modeledCached);
                    if (resolvedRoomEngine === id) {
                      tokensForEngine += remInput + remOutput;
                      cachedForEngine += remCached;
                      inputForEngine += remInput;
                      outputForEngine += remOutput;
                    }
                  }
                } else {
                  if (resolvedRoomEngine === id) {
                    tokensForEngine += roomUsage.input + roomUsage.output;
                    cachedForEngine += cachedInput(roomUsage);
                    inputForEngine += roomUsage.input;
                    outputForEngine += roomUsage.output;
                  }
                }
              }
            }
            const configuredPlan = enginePlans[id] ?? configuredEnginePlans?.[id];
            const defaultCost = entry.pricing.kind === "subscription+api"
              ? (entry.pricing.subscription.costPerMonth ?? 0)
              : 0;
            const actualCostUsd = configuredPlan?.costPerMonth !== undefined
              ? (configuredPlan.costPerMonth ?? 0)
              : defaultCost;
            return [{
              engineId: id,
              totalTokens: tokensForEngine,
              inputTokens: inputForEngine,
              outputTokens: outputForEngine,
              cachedTokens: cachedForEngine,
              actualCostUsd,
            }];
          }),
        ]}
      />

      <Card
        title="Usage Monitor & Central Accounting"
        subtitle="An optional, lightweight telemetry stream reporting token consumption classified by model, project, and repository to a usage monitor you run.  Nothing is sent until you set an endpoint and a token."
      >
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`flex size-2 rounded-full ${
                  badge.tone === "error"
                    ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    : badge.tone === "active"
                      ? "bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"
                      : badge.tone === "waiting"
                        ? "bg-warning"
                        : "bg-ink-secondary/40"
                }`}
              />
              <span className="font-medium text-ink">Usage Monitor</span>
              <span className="text-[11.5px] text-ink-secondary font-mono">{host ?? "Not configured"}</span>
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                badge.tone === "error"
                  ? "bg-danger/15 text-danger"
                  : badge.tone === "active"
                    ? "bg-success/15 text-success"
                    : "bg-inset text-ink-secondary"
              }`}
              title={telemetryFetchError || telemetryStatus?.lastError || undefined}
            >
              {badge.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Classification</span>
              <span className="font-medium text-ink">Project & Repo</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Schema</span>
              <span className="font-medium text-ink">Telemetry v2</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Transport</span>
              <span className="font-medium text-ink">Non-blocking HTTP</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Privacy</span>
              <span className="font-medium text-ink">Secret-Safe Metrics</span>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-hairline/30 bg-inset/20 p-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-url">
                  Usage Monitor URL
                </label>
                <SecretSourceBadge source={ingestUrlSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-ingest-url"
                type="url"
                value={ingestUrl}
                onChange={(e) => {
                  setIngestUrl(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={ingestUrlLocked ? "Managed by Infisical." : "https://usage.example.com"}
                autoComplete="off"
                disabled={ingestUrlLocked}
                className={cn(usageInputClass, ingestUrlLocked && "cursor-not-allowed opacity-60")}
              />
              {ingestUrlLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-token">
                  Ingest Token
                </label>
                <SecretSourceBadge source={ingestTokenSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-ingest-token"
                type="password"
                value={ingestToken}
                onChange={(e) => {
                  setIngestToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={
                  ingestTokenLocked
                    ? "Managed by Infisical."
                    : usageConfig?.hasToken
                      ? "••••••••  (paste to replace)"
                      : "Leave blank to keep telemetry off"
                }
                autoComplete="off"
                disabled={ingestTokenLocked}
                className={cn(usageInputClass, ingestTokenLocked && "cursor-not-allowed opacity-60")}
              />
              {ingestTokenLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-read-token">
                  Read Token
                </label>
                <SecretSourceBadge source={readTokenSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-read-token"
                type="password"
                value={readToken}
                onChange={(e) => {
                  setReadToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={
                  readTokenLocked
                    ? "Managed by Infisical."
                    : usageConfig?.hasReadToken
                      ? "••••••••  (paste to replace)"
                      : "USAGE_READ_TOKEN from Usage Monitor"
                }
                autoComplete="off"
                disabled={readTokenLocked}
                className={cn(usageInputClass, readTokenLocked && "cursor-not-allowed opacity-60")}
              />
              {readTokenLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Local subscription caps divert auto-fallback</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  CodeCaps reads each subscription on this Mac and writes what is left to a local file.{'\u00A0'} When it reports a window spent, BotFleet stops routing turns to that engine until the window resets.{'\u00A0'} Only its own verdict counts, never a percentage BotFleet inferred.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={localQuotaRouting}
                aria-label="Local subscription caps divert auto-fallback"
                disabled={routingSaving}
                onClick={() => void toggleLocalQuotaRouting()}
                className={cnSwitch(localQuotaRouting)}
              >
                <span className={cnKnob(localQuotaRouting)} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void saveUsage()}
                disabled={saving}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={saving || testing || !canTest}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={13} className={cn(testing && "animate-spin")} />
                {testing ? "Testing..." : "Test Connection"}
              </button>
              {saveOk && !saveError && (
                <span className="flex items-center gap-1 text-[12.5px] text-success">
                  <CheckCircle size={14} />
                  Saved
                </span>
              )}
              {testResult && (
                <span className={cn("flex items-center gap-1.5 text-[12.5px]", testResult.ok ? "text-success" : "text-danger")}>
                  {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  <span
                    className="max-w-[320px] truncate"
                    title={testResult.ok ? "Usage Monitor accepted the probe" : testResult.error || "Not reachable"}
                  >
                    {testResult.ok ? "Usage Monitor accepted the probe" : testResult.error || "Not reachable"}
                  </span>
                </span>
              )}
            </div>
            {saveError && (
              <div role="alert" className="text-[12px] text-danger" title={saveError}>
                {productErrorHeadline(saveError)}
              </div>
            )}
            <div className="text-[12px] leading-relaxed text-ink-secondary">
              Save stores the URL and tokens on this computer.{'\u00A0'} Test Connection posts a one-token probe to the ingest endpoint so you can see whether Usage Monitor accepted it.{'\u00A0'} Leave a token field blank to keep the stored value.{'\u00A0'} Ingest token sends settled-turn usage.{'\u00A0'} Read token pulls remaining-percent windows so this page can skip exhausted models.{'\u00A0'} Antigravity does not need the read token because it uses the local antigravity-usage CLI.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** One bot's expanded/collapsed usage row.  The header stays visible —
 *  avatar + name + turns + tokens + cost.  Clicking flips the disclosure
 *  and shows a sub-table of every task (session) the bot has accumulated,
 *  with model, tokens in/out, cached, $/turn, and the running cumulative
 *  for both tokens and cost.  The "Pricing-mode pill" lives on each
 *  session row when the engine has a `subscription+api` or `subscription`
 *  pricing mode in the capability registry — exactly the engines where
 *  showing a PAYG number next to the user's plan would mislead. */
function UsageRow({
  bot,
  usage,
  open,
  instances,
  onToggle,
}: {
  bot: { id: string; name: string; color?: BotColor; tasks?: ReadonlyArray<TaskLike>; modelSelection: ModelSelectionLike; roomUsageByInstance?: Record<string, TaskUsage & { lastAt: number; engineId?: string; byModel?: Record<string, TaskUsage> }> };
  usage: TaskUsage;
  open: boolean;
  instances?: Array<{ models?: { options?: Array<{ id: string; label: string }> } }>;
  onToggle: () => void;
}) {
  // Local state for the "expand all" / "collapse all" toggle.  When the
  // parent flips `open` true or false the row expands/collapses — no
  // local override needed.
  // Shared-room turns bank per engine on the speaking bot, not on a task
  // thread — without them the expanded detail disagreed with the header
  // totals, which count the room buckets via botUsage.  Each engine bucket
  // becomes one "Shared rooms" row, slotted into the chronological run by
  // its lastAt.
  const roomRows: TaskLike[] = Object.entries(bot.roomUsageByInstance ?? {})
    .filter(([, u]) => (u.turns ?? 0) > 0 || u.input + u.output > 0)
    .map(([instanceId, u]) => ({
      threadId: `room:${instanceId}`,
      title: "Shared rooms",
      createdAt: u.lastAt,
      lastActivity: u.lastAt,
      usage: u,
      modelSelection: { instanceId, model: Object.keys(u.byModel ?? {}).join(", ") },
    }));
  const tasks: TaskLike[] = [
    ...(bot.tasks ?? []).filter((task) => (task.usage?.turns ?? 0) > 0 || (task.usage?.input ?? 0) + (task.usage?.output ?? 0) > 0),
    ...roomRows,
  ];
  // Sort newest first so the most recent turn sits at the top of the list
  // for the user.  The cumulative-cost and cumulative-tokens columns
  // run oldest-first so the values grow monotonically down the page —
  // a reader scrolling the table sees a running total that ticks up,
  // not a value that shrinks as they read.  Codex flagged the old
  // shape (newest-first accumulation) as misleading.
  tasks.sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt));
  const chronological = [...tasks].sort((a, b) => (a.lastActivity ?? a.createdAt) - (b.lastActivity ?? b.createdAt));
  const cumulativeByThread = new Map<string, { tokens: number; cost: number }>();
  let runTokens = 0;
  let runCost = 0;
  for (const task of chronological) {
    const taskUsage = task.usage ?? { input: 0, output: 0, costUsd: null, turns: 0 };
    runTokens += taskUsage.input + taskUsage.output;
    if (hasFiniteCost(taskUsage.costUsd)) runCost += taskUsage.costUsd ?? 0;
    cumulativeByThread.set(task.threadId, { tokens: runTokens, cost: runCost });
  }
  const modelSet = new Set<string>();
  const cumulative = tasks.map((task) => {
    const taskUsage = task.usage ?? { input: 0, output: 0, costUsd: null, turns: 0 };
    const isRoomRow = task.threadId.startsWith("room:");
    // Show the model that PRODUCED the usage when the per-instance
    // buckets banked one (post-upgrade turns); the configured selection
    // is only the fallback for legacy records — it is the task's current
    // setting, not necessarily what ran.
    const ranModels = isRoomRow
      ? []
      : [...new Set(Object.values(task.usageByInstance ?? {}).flatMap((b) => Object.keys(b.byModel ?? {})))];
    // A session that mostly ran before per-model banking exists has only
    // its newest turns in byModel — labeling it by those alone would hide
    // the model that produced the bulk of the usage, so when the banked
    // turns do not cover the task total, keep the configured model too.
    const bankedTurns = isRoomRow
      ? 0
      : Object.values(task.usageByInstance ?? {}).reduce(
          (n, b) => n + Object.values(b.byModel ?? {}).reduce((m, mu) => m + (mu.turns ?? 0), 0),
          0,
        );
    const configuredModel = task.modelSelection?.model ?? bot.modelSelection.model;
    // Whenever the banked per-model turns do not cover the task total the
    // label is incomplete — even when the configured model is already in
    // the list (many legacy Opus turns + one banked Haiku turn with Haiku
    // configured must not read as plain "Haiku") — so mark it.
    const historyIncomplete = ranModels.length > 0 && bankedTurns < (task.usage?.turns ?? 0);
    const labelModels = ranModels.length > 0
      ? historyIncomplete && configuredModel && !ranModels.includes(configuredModel)
        ? [...ranModels, configuredModel]
        : ranModels
      : [];
    const formattedModels = labelModels.map((m) => modelDisplayName(m, instances));
    const model = isRoomRow
      ? task.modelSelection?.model || task.modelSelection?.instanceId || "room"
      : formattedModels.length > 0
        ? formattedModels.join(", ") + (historyIncomplete ? " + earlier usage" : "")
        : (configuredModel ? modelDisplayName(configuredModel, instances) : configuredModel);
    if (!isRoomRow && labelModels.length > 0) {
      for (const m of labelModels) modelSet.add(m);
    } else if (model && !isRoomRow) {
      modelSet.add(model);
    }
    const running = cumulativeByThread.get(task.threadId) ?? { tokens: 0, cost: 0 };
    return {
      task,
      taskUsage,
      model,
      cumulativeTokens: running.tokens,
      cumulativeCost: running.cost,
    };
  });

  const modelCount = modelSet.size;
  const modelSummaries = botUsageByModel(bot);
  const totalModelTurns = modelSummaries.reduce((sum, m) => sum + (m.usage.turns ?? 0), 0);
  const totalModelInput = modelSummaries.reduce((sum, m) => sum + m.usage.input, 0);
  const totalModelOutput = modelSummaries.reduce((sum, m) => sum + m.usage.output, 0);
  const totalModelCached = modelSummaries.reduce((sum, m) => sum + cachedInput(m.usage), 0);
  const totalModelCost = modelSummaries.reduce<number | null>((sum, m) => {
    if (m.usage.costUsd != null) return (sum ?? 0) + m.usage.costUsd;
    return sum;
  }, null);
  const totalPerTurnCost = hasFiniteCost(totalModelCost) && totalModelTurns > 0
    ? (totalModelCost ?? 0) / totalModelTurns
    : null;

  return (
    <div className="border-b border-hairline/20">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 py-2 text-left text-[13px] hover:bg-control/30"
      >
        <span className="flex min-w-0 items-center gap-2 text-ink">
          <BotMascot color={bot.color ?? "blue"} state="idle" size={22} animated={false} />
          <span className="truncate" title={bot.name}>{bot.name}</span>
          {open && modelCount > 0 && (
            <span
              className="ml-1 shrink-0 rounded-full bg-inset/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
              title={`${modelCount} model${modelCount === 1 ? "" : "s"} across this bot's sessions`}
            >
              {modelCount} model{modelCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
        <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>
          {formatTokens(usage.input + usage.output)}
        </span>
        <span className="text-right tabular-nums text-ink">
          {hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}
        </span>
      </button>
      {open && (modelSummaries.length > 0 || cumulative.length > 0) && (
        <div className="mb-2 ml-9 mr-1 flex flex-col gap-3 rounded-lg border border-hairline/20 bg-inset/25 p-2.5">
          {modelSummaries.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-ink-secondary">
                <span>Usage by Model</span>
                <span>{modelSummaries.length} model{modelSummaries.length === 1 ? "" : "s"}</span>
              </div>
              <div className="grid grid-cols-[1.6fr_0.7fr_0.9fr_0.9fr_0.7fr_0.9fr_0.9fr] gap-x-3 border-b border-hairline/30 pb-1 text-[10.5px] font-medium text-ink-secondary">
                <span>Model</span>
                <span className="text-right">Turns</span>
                <span className="text-right">Tokens In</span>
                <span className="text-right">Cached</span>
                <span className="text-right">Out</span>
                <span className="text-right">Per Turn</span>
                <span className="text-right">Cost</span>
              </div>
              {modelSummaries.map((m) => {
                const cached = cachedInput(m.usage);
                const perTurn = m.perTurnCost;
                return (
                  <div
                    key={m.model}
                    className="grid grid-cols-[1.6fr_0.7fr_0.9fr_0.9fr_0.7fr_0.9fr_0.9fr] items-center gap-x-3 border-b border-hairline/10 py-1.5 text-[12px]"
                  >
                    <span className="min-w-0 truncate text-[11.5px] font-medium text-ink" title={m.model}>
                      {modelDisplayName(m.model, instances)}
                    </span>
                    <span className="text-right tabular-nums text-ink-secondary">{m.usage.turns ?? 0}</span>
                    <span className="text-right tabular-nums text-ink">{formatTokens(m.usage.input)}</span>
                    <span className="text-right tabular-nums text-ink-secondary">{cached > 0 ? formatTokens(cached) : "—"}</span>
                    <span className="text-right tabular-nums text-ink">{formatTokens(m.usage.output)}</span>
                    <span className="text-right tabular-nums text-ink-secondary">
                      {perTurn != null ? formatUsd(perTurn) : "—"}
                    </span>
                    <span className="text-right tabular-nums text-ink">
                      {hasFiniteCost(m.usage.costUsd) ? formatUsd(m.usage.costUsd) : "—"}
                    </span>
                  </div>
                );
              })}
              {modelSummaries.length > 1 && (
                <div className="grid grid-cols-[1.6fr_0.7fr_0.9fr_0.9fr_0.7fr_0.9fr_0.9fr] items-center gap-x-3 pt-1.5 text-[12px] font-medium">
                  <span className="text-ink">Total across models</span>
                  <span className="text-right tabular-nums text-ink-secondary">{totalModelTurns}</span>
                  <span className="text-right tabular-nums text-ink">{formatTokens(totalModelInput)}</span>
                  <span className="text-right tabular-nums text-ink-secondary">
                    {totalModelCached > 0 ? formatTokens(totalModelCached) : "—"}
                  </span>
                  <span className="text-right tabular-nums text-ink">{formatTokens(totalModelOutput)}</span>
                  <span className="text-right tabular-nums text-ink-secondary">
                    {totalPerTurnCost != null ? formatUsd(totalPerTurnCost) : "—"}
                  </span>
                  <span className="text-right tabular-nums text-ink">
                    {hasFiniteCost(totalModelCost) ? formatUsd(totalModelCost) : "—"}
                  </span>
                </div>
              )}
            </div>
          )}

          {cumulative.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-ink-secondary">
                <span>Sessions</span>
                <span>{cumulative.length} session{cumulative.length === 1 ? "" : "s"}</span>
              </div>
              <div className="grid grid-cols-[1.4fr_1fr_0.9fr_0.9fr_0.7fr_0.9fr_0.9fr] gap-x-3 border-b border-hairline/30 pb-1 text-[10.5px] font-medium text-ink-secondary">
                <span>Session</span>
                <span>Model</span>
                <span className="text-right">Tokens In</span>
                <span className="text-right">Cached</span>
                <span className="text-right">Out</span>
                <span className="text-right">Per Turn</span>
                <span className="text-right">Cumulative Cost</span>
              </div>
              {cumulative.map(({ task, taskUsage, model, cumulativeTokens: cumTokens, cumulativeCost: cumCost }, index) => {
                const turnCount = taskUsage.turns || 0;
                const perTurnCost = hasFiniteCost(taskUsage.costUsd) && turnCount > 0
                  ? (taskUsage.costUsd ?? 0) / turnCount
                  : null;
                const cached = cachedInput(taskUsage);
                const last = task.lastActivity ?? task.createdAt;
                const date = new Date(last).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
                return (
                  <div
                    key={`${task.threadId}:${index}`}
                    className="grid grid-cols-[1.4fr_1fr_0.9fr_0.9fr_0.7fr_0.9fr_0.9fr] items-center gap-x-3 border-b border-hairline/10 py-1.5 text-[12px]"
                  >
                    <span className="min-w-0 truncate text-ink" title={task.title || task.threadId}>
                      {task.title || task.threadId.slice(0, 12)}
                      <span className="ml-1 text-ink-secondary/80">{date}</span>
                    </span>
                    <span className="min-w-0 truncate text-[11.5px] text-ink-secondary" title={task.modelSelection?.model ?? model}>
                      {modelDisplayName(model, instances)}
                    </span>
                    <span className="text-right tabular-nums text-ink">{formatTokens(taskUsage.input)}</span>
                    <span className="text-right tabular-nums text-ink-secondary">{cached > 0 ? formatTokens(cached) : "—"}</span>
                    <span className="text-right tabular-nums text-ink">{formatTokens(taskUsage.output)}</span>
                    <span className="text-right tabular-nums text-ink-secondary">
                      {perTurnCost != null ? formatUsd(perTurnCost) : "—"}
                    </span>
                    <span className="text-right tabular-nums text-ink">
                      {hasFiniteCost(taskUsage.costUsd) ? formatUsd(cumCost) : "—"}
                      <span className="block text-[10.5px] text-ink-secondary">{formatTokens(cumTokens)} cumulative</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Lightweight local types — kept inline so UsageSection does not import
// the full store interface just to render this row.  Mirrors
// src/state/store.tsx `Task` / `ModelSelection` / `TaskUsage` shapes.
// Lightweight local types — kept inline so UsageSection does not import
// the full store interface just to render this row.  Mirrors
// src/state/store.tsx `Task` / `ModelSelection` / `TaskUsage` shapes.
interface TaskLike {
  threadId: string;
  title: string;
  createdAt: number;
  lastActivity?: number;
  usage?: TaskUsage;
  /** Per-instance breakdown of `usage`, banked from the selection that
   *  actually ran each turn (post-fallback).  `engineId` is the registry
   *  engine resolved at bank time, so attribution survives deleting the
   *  connection;  `byModel` splits the bucket per model that ran.
   *  Absent on older records. */
  usageByInstance?: Record<string, TaskUsage & { engineId?: string; byModel?: Record<string, TaskUsage> }>;
  modelSelection?: ModelSelectionLike;
}
interface ModelSelectionLike {
  instanceId: string;
  model: string;
}
