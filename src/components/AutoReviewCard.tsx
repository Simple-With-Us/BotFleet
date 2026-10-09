// The Bot Profile's Review Routine Approvals card.
//
// It used to say "This engine cannot run an isolated review safely" for every
// engine but Claude and grey out Watch and On.  The card now says what review
// actually does on this engine (holds each ask, or can only watch), who
// reviews (the engine itself, or the fleet's fallback reviewer, which is
// picked automatically unless the owner chooses one), how it combines with
// Auto and Bypass Permissions, and the per-turn review limit.  The words come from
// `lib/bot-settings-gates.ts` `autoReviewGate`, so the panel never re-derives
// them.
import { useState } from "react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { autoReviewGate, type AutoReviewGate } from "@/lib/bot-settings-gates";
import { cn } from "@/lib/cn";
import { FALLBACK_REVIEWER_NONE, type AutoReviewMode } from "../../shared/auto-review";

const MODES: ReadonlyArray<readonly [AutoReviewMode, string]> = [
  ["off", "Off"],
  ["shadow", "Watch"],
  ["enforce", "On"],
];

export interface AutoReviewCardViewProps {
  mode: AutoReviewMode;
  gate: AutoReviewGate;
  /** The stored setting: null for Automatic, "none", or an instance id. */
  fallbackReviewer: string | null;
  onMode: (mode: AutoReviewMode) => void;
  onFallbackReviewer: (setting: string) => void;
  saving?: boolean;
  error?: string | null;
}

/** The card itself, with no store: what it shows is decided by `gate`. */
export function AutoReviewCardView({
  mode,
  gate,
  fallbackReviewer,
  onMode,
  onFallbackReviewer,
  saving = false,
  error = null,
}: AutoReviewCardViewProps) {
  const chosen = gate.fallbackMode === "chosen" ? fallbackReviewer : null;
  const selectValue = gate.fallbackMode === "auto" ? "" : gate.fallbackMode === "none" ? FALLBACK_REVIEWER_NONE : (chosen ?? "");
  const roleLabel =
    gate.reviewer?.role === "own"
      ? " (this engine)"
      : gate.fallbackMode === "auto"
        ? " (fallback reviewer, picked automatically)"
        : " (fallback reviewer)";
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Review Routine Approvals</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{gate.summary}</div>
      {gate.reviewer && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          <span className="font-medium text-ink">Reviewer: </span>
          {gate.reviewer.name}
          {roleLabel}
        </div>
      )}
      <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
        {MODES.map(([value, label]) => {
          const disabled =
            value === "shadow" ? !gate.canWatch : value === "enforce" ? !gate.canEnforce : false;
          return (
            <button
              key={value}
              title={disabled ? gate.disabledReason ?? undefined : gate.hints[value]}
              disabled={disabled}
              aria-pressed={mode === value}
              onClick={() => onMode(value)}
              className={cn(
                "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                mode === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {gate.bypassNote && <div className="mt-2 text-[12px] text-ink-secondary">{gate.bypassNote}</div>}
      {mode !== "off" && <div className="mt-2 text-[12px] text-ink-secondary">{gate.capNote}</div>}
      <label className="mt-3 block">
        <span className="text-[13px] font-medium text-ink">Fallback Reviewer</span>
        <span className="mt-0.5 block text-[12px] text-ink-secondary">
          {"Reviews for every bot whose engine cannot review on its own, reviews an API engine's own actions first, and stands in when an engine's own review fails.  It sees the actions it checks.  Automatic picks the best engine that is working right now."}
        </span>
        <select
          aria-label="Fallback Reviewer"
          value={selectValue}
          disabled={saving}
          onChange={(event) => onFallbackReviewer(event.target.value)}
          className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink disabled:opacity-60"
        >
          <option value="">{gate.automatic ? `Automatic (${gate.automatic.name})` : "Automatic (none available)"}</option>
          {gate.fallbackOptions.map((option) => (
            <option key={option.instanceId} value={option.instanceId}>
              {option.name}
            </option>
          ))}
          {chosen && !gate.fallbackOptions.some((option) => option.instanceId === chosen) && (
            <option value={chosen}>{`${chosen} (unavailable)`}</option>
          )}
          <option value={FALLBACK_REVIEWER_NONE}>None</option>
        </select>
        {error && <span className="mt-1 block text-[12px] text-danger">{error}</span>}
      </label>
    </div>
  );
}

/** The card wired to the store: the bot's mode, the engine list and the
 *  fleet's fallback reviewer. */
export function AutoReviewCard({
  bot,
  onMode,
}: {
  bot: Bot;
  onMode: (mode: AutoReviewMode) => void;
}) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallbackReviewer = state.config?.autoReview?.fallbackReviewer ?? null;
  const gate = autoReviewGate(state.instances, bot, fallbackReviewer, state.config?.autoReview?.maxReviewsPerTurn);
  const mode: AutoReviewMode = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";

  const chooseFallback = async (setting: string) => {
    setSaving(true);
    setError(null);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ autoReview: { fallbackReviewer: setting } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AutoReviewCardView
      mode={mode}
      gate={gate}
      fallbackReviewer={fallbackReviewer}
      onMode={onMode}
      onFallbackReviewer={(setting) => void chooseFallback(setting)}
      saving={saving}
      error={error}
    />
  );
}
