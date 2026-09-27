import { useState } from "react";
import { Gauge, Loader2, Pause, Play, Plus, Trash2, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import {
  METRIC_LABEL,
  RESOURCE_METRICS,
  type ResourceCmp,
  type ResourceMetric,
  type ResourceTrigger,
  type ResourceTriggerInput,
} from "@/lib/resource-triggers";
import type { RoutineRunOn } from "@/lib/routines";
import { api, useStore, type Bot } from "@/state/store";

function relativeTime(at?: number) {
  if (!at) return "Never";
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function Editor({
  trigger,
  bots,
  onClose,
}: {
  trigger?: ResourceTrigger;
  bots: Bot[];
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const [botId, setBotId] = useState(trigger?.botId ?? bots[0]?.id ?? "");
  const [name, setName] = useState(trigger?.name ?? "");
  const [prompt, setPrompt] = useState(trigger?.prompt ?? "");
  const [metric, setMetric] = useState<ResourceMetric>(trigger?.metric ?? "disk_free_gb");
  const [cmp, setCmp] = useState<ResourceCmp>(trigger?.cmp ?? "below");
  const [threshold, setThreshold] = useState(String(trigger?.threshold ?? 80));
  const [cooldownMinutes, setCooldownMinutes] = useState(String(trigger?.cooldownMinutes ?? 45));
  const [runOn, setRunOn] = useState<RoutineRunOn>(trigger?.runOn ?? "bot");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const bot = bots.find((candidate) => candidate.id === botId);
    const input: ResourceTriggerInput = {
      name: name.trim() || `${bot?.name ?? "Bot"} resource watch`,
      prompt: prompt.trim(),
      botId,
      runOn,
      metric,
      cmp,
      threshold: Number(threshold),
      cooldownMinutes: Number(cooldownMinutes),
    };
    if (!input.prompt) {
      setError("Give the bot a prompt");
      return;
    }
    if (!Number.isFinite(input.threshold)) {
      setError("Threshold must be a number");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await api(trigger ? `/api/resource-triggers/${trigger.id}` : "/api/resource-triggers", {
        method: trigger ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      dispatch({ type: "resourceTriggerPatched", trigger: response.trigger });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-raised p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-ink">{trigger ? "Edit Resource Trigger" : "New Resource Trigger"}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-secondary hover:bg-panel hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <label className="mt-4 block text-[12px] font-medium text-ink-secondary">Bot</label>
        <select value={botId} onChange={(event) => setBotId(event.target.value)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[13px] text-ink">
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select>
        <label className="mt-3 block text-[12px] font-medium text-ink-secondary">Name</label>
        <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[13px] text-ink" placeholder="Disk low — Housekeeper" />
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[12px] font-medium text-ink-secondary">Metric</label>
            <select value={metric} onChange={(event) => setMetric(event.target.value as ResourceMetric)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-2 py-2 text-[12px] text-ink">
              {RESOURCE_METRICS.map((item) => <option key={item} value={item}>{METRIC_LABEL[item]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-ink-secondary">When</label>
            <select value={cmp} onChange={(event) => setCmp(event.target.value as ResourceCmp)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-2 py-2 text-[12px] text-ink">
              <option value="below">drops to or below</option>
              <option value="above">rises to or above</option>
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-ink-secondary">Threshold</label>
            <input value={threshold} onChange={(event) => setThreshold(event.target.value)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[13px] text-ink" />
          </div>
        </div>
        <label className="mt-3 block text-[12px] font-medium text-ink-secondary">Cooldown (minutes)</label>
        <input value={cooldownMinutes} onChange={(event) => setCooldownMinutes(event.target.value)} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[13px] text-ink" />
        <label className="mt-3 block text-[12px] font-medium text-ink-secondary">Prompt</label>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} className="mt-1 w-full rounded-xl border border-hairline/50 bg-panel px-3 py-2 text-[13px] text-ink" />
        <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-secondary">
          <input type="checkbox" checked={runOn === "cloud"} onChange={(event) => setRunOn(event.target.checked ? "cloud" : "bot")} />
          Run on ASCII.dev Box
        </label>
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-panel">Cancel</button>
          <button onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResourceTriggersPanel({ bots }: { bots: Bot[] }) {
  const { state, dispatch } = useStore();
  const [editor, setEditor] = useState<ResourceTrigger | "new" | null>(null);

  const toggle = async (trigger: ResourceTrigger) => {
    const response = await api(`/api/resource-triggers/${trigger.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !trigger.enabled }),
    });
    dispatch({ type: "resourceTriggerPatched", trigger: response.trigger });
  };

  const remove = async (trigger: ResourceTrigger) => {
    await api(`/api/resource-triggers/${trigger.id}`, { method: "DELETE" });
    dispatch({ type: "resourceTriggerDeleted", triggerId: trigger.id });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="max-w-[520px] text-[12px] leading-relaxed text-ink-secondary">
          While BotFleet is running it samples this computer every 30 seconds.  When a metric crosses the threshold, it starts a fresh task on the chosen bot — the same queue as webhooks and routines.
        </p>
        <button onClick={() => setEditor("new")} disabled={bots.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-40">
          <Plus size={15} />New Trigger
        </button>
      </div>
      {state.resourceTriggers.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
          <Gauge size={42} className="text-ink-secondary/40" />
          <h2 className="mt-3 text-[16px] font-semibold text-ink">Wake a bot when the machine is in trouble</h2>
          <p className="mt-2 max-w-[420px] text-[13px] text-ink-secondary">Disk filling up, swap climbing, or load stuck high can start Housekeeper automatically instead of waiting for the next scheduled check.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {state.resourceTriggers.map((trigger) => {
            const bot = bots.find((candidate) => candidate.id === trigger.botId);
            return (
              <li key={trigger.id} className="flex items-start gap-3 rounded-2xl border border-hairline/50 bg-panel/80 p-3">
                {bot ? <BotAvatar bot={bot} state={stateForBot(bot)} size={36} /> : <div className="h-9 w-9 rounded-full bg-panel" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setEditor(trigger)} className="truncate text-[14px] font-medium text-ink hover:text-accent" title={trigger.name}>{trigger.name}</button>
                    <span className={cn("h-1.5 w-1.5 rounded-full", trigger.enabled ? "bg-success" : "bg-ink-secondary/50")} />
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-secondary">
                    {METRIC_LABEL[trigger.metric]} {trigger.cmp === "below" ? "≤" : "≥"} {trigger.threshold}
                    {trigger.lastValue != null ? ` · now ${trigger.lastValue}` : ""}
                    {" · "}last fire {relativeTime(trigger.lastFiredAt)}
                  </p>
                </div>
                <button onClick={() => void toggle(trigger)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={trigger.enabled ? "Pause" : "Enable"}>
                  {trigger.enabled ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button onClick={() => void remove(trigger)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-danger" aria-label="Delete">
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editor && (
        <Editor
          trigger={editor === "new" ? undefined : editor}
          bots={bots}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
