// The Bot Profile's Review Routine Approvals card.
//
// It used to say "This engine cannot run an isolated review safely" for every
// engine but Claude and grey out Watch and On.  The card now says what review
// actually does on this engine (holds each ask, or can only watch), who
// reviews (the engine itself, or the fleet's fallback reviewer), and how it
// combines with Bypass Permissions.  The words come from
// `lib/bot-settings-gates.ts` `autoReviewGate`, so the panel never re-derives
// them.
import { useState } from "react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { autoReviewGate, type AutoReviewGate } from "@/lib/bot-settings-gates";
import { cn } from "@/lib/cn";
import type { AutoReviewMode } from "../../shared/auto-review";

const MODES: ReadonlyArray<readonly [AutoReviewMode, string]> = [
  ["off", "Off"],
  ["shadow", "Watch"],
  ["enforce", "On"],
];

export interface AutoReviewCardViewProps {
  mode: AutoReviewMode;
  gate: AutoReviewGate;
  fallbackReviewer: string | null;
  onMode: (mode: AutoReviewMode) => void;
  onFallbackReviewer: (instanceId: string) => void;
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
  const showPicker = gate.needsFallback || Boolean(fallbackReviewer);
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Review Routine Approvals</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{gate.summary}</div>
      {gate.reviewer && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          <span className="font-medium text-ink">Reviewer: </span>
          {gate.reviewer.name}
          {gate.reviewer.role === "fallback" ? " (fallback reviewer)" : " (this engine)"}
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
      {showPicker && (
        <label className="mt-3 block">
          <span className="text-[13px] font-medium text-ink">Fallback Reviewer</span>
          <span className="mt-0.5 block text-[12px] text-ink-secondary">
            {"Reviews for every bot whose engine cannot review on its own.  It sees the actions those bots ask to run."}
          </span>
          <select
            aria-label="Fallback Reviewer"
            value={fallbackReviewer ?? ""}
            disabled={saving}
            onChange={(event) => onFallbackReviewer(event.target.value)}
            className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink disabled:opacity-60"
          >
            <option value="">None</option>
            {gate.fallbackOptions.map((option) => (
              <option key={option.instanceId} value={option.instanceId}>
                {option.name}
              </option>
            ))}
            {fallbackReviewer && !gate.fallbackOptions.some((option) => option.instanceId === fallbackReviewer) && (
              <option value={fallbackReviewer}>{`${fallbackReviewer} (unavailable)`}</option>
            )}
          </select>
          {error && <span className="mt-1 block text-[12px] text-danger">{error}</span>}
        </label>
      )}
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
  const gate = autoReviewGate(state.instances, bot, fallbackReviewer);
  const mode: AutoReviewMode = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";

  const chooseFallback = async (instanceId: string) => {
    setSaving(true);
    setError(null);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ autoReview: { fallbackReviewer: instanceId } }),
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
      onFallbackReviewer={(instanceId) => void chooseFallback(instanceId)}
      saving={saving}
      error={error}
    />
  );
}
