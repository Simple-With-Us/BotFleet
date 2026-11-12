// "API vs subscription — what your workload would have cost on PAYG."
// Renders a card with one row per engine that has an `api` or
// `subscription+api` pricing mode in the capability registry.  Each row
// shows: actual cost (subscription fee for the period, prorated when
// the user opted into API only), API-equivalent cost (actual token
// usage × pricing.api.rates), saved by plan (subtraction), and saved %.
//
// The MiniMax row is the headline: Token Plan Max is $55/mo flat, the
// API-equivalent is what the user would have paid on the same volume on
// MiniMax's PAYG API.  Other engines with a real subscription fee
// (Claude Max, Codex Pro Lite, etc.) appear in the table so the reader
// can compare them at a glance.
//
// Pure renderer — the parent supplies session-level token usage data so
// the component stays trivially testable.  See `UsageWhatIfProjection.test.tsx`.
import * as React from "react";
import {
  CAPABILITY_LABELS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  type EngineCapabilityEntry,
  type PricingMode,
} from "@/lib/engine-capabilities";
import { formatUsd, hasFiniteCost } from "@/lib/usage";
import { Card } from "./SettingsPrimitives";

export interface EngineUsageAggregate {
  engineId: string;
  /** Input-only tokens over the period.  Used by `apiEquivalentCost` to
   *  apply the real input/output split instead of inventing a ratio. */
  inputTokens?: number;
  /** Output-only tokens over the period. */
  outputTokens?: number;
  /** Total tokens (input + output) over the period.  Used when callers
   *  supply only the aggregate (the legacy UsageSection path). */
  totalTokens: number;
  /** Cached share of input. */
  cachedTokens: number;
  /** Optional cost the engine itself reported (subscription equivalent). */
  actualCostUsd: number;
}

export interface UsageWhatIfProjectionProps {
  /** Pre-aggregated usage per engine.  Order-independent — the component
   *  matches entries against the registry by `engineId`. */
  byEngine: EngineUsageAggregate[];
  /** Subscription period label, e.g. "Sep 2026" or "Last 30 days". */
  periodLabel: string;
  /** Optional override for the period length in days; used to prorate the
   *  monthly subscription fee when the period is shorter.  Defaults to 30. */
  periodDays?: number;
  /** Tokens that ran on connections deleted before per-engine attribution
   *  existed.  Shown as a footnote instead of being guessed onto an
   *  engine row. */
  unattributedTokens?: number;
}

/** Compute the API-equivalent cost for a single engine's usage, given the
 *  pricing mode's API rate block.  Pulled out so the test can pin the
 *  math without rendering React.
 *
 *  Pricing block uses per-1k rates (`inputPer1k`, `outputPer1k`,
 *  `cachedInputPer1k`).  Cost = (tokens / 1000) * per1k — the divide is
 *  essential; multiplying tokens by a per-1k rate directly inflates the
 *  result by 1000x.  Pinned by `UsageWhatIfProjection.test.tsx` with a
 *  1M-token MiniMax M3 fixture ($1.74). */
export function apiEquivalentCost(
  usage: EngineUsageAggregate,
  pricing: Extract<PricingMode, { kind: "subscription+api" | "api" }>,
): number {
  // A long-context tier (Grok: prompts of 200k+ tokens) is decided per
  // request, but this card only has period totals — a sum of many small
  // prompts would wrongly cross the threshold.  No per-request prompt size
  // is recorded, so the projection stays on the base rates and the card
  // shows the tier as a note instead (see `longContextNotes`).
  const tier = pricing.api.longContext;
  const apiRates = pricing.api;
  // Use the real input/output split when the parent supplied it
  // (`inputTokens` / `outputTokens`); fall back to a 70/30 heuristic
  // only when the parent did not.  Codex flagged inventing the ratio
  // — when input vs output is available the engine driver already
  // knows the real split, so we honor it.
  const inputTokens = usage.inputTokens ?? Math.round(usage.totalTokens * 0.7);
  const outputTokens = usage.outputTokens ?? Math.round(usage.totalTokens * 0.3);
  const cached = Math.min(usage.cachedTokens, inputTokens);
  const fresh = Math.max(0, inputTokens - cached);
  const inputCost = apiRates.cachedInputPer1k !== undefined
    ? (cached * apiRates.cachedInputPer1k + fresh * apiRates.inputPer1k) / 1000
    : (inputTokens * apiRates.inputPer1k) / 1000;
  // MiniMax M3 (and only MiniMax M3 today) charges 2x the listed input,
  // cached-read, and output rates when a single prompt exceeds 512K
  // input tokens — per the model's own pricing footnote.  Apply the
  // multiplier to the per-prompt input+output cost when both are
  // known; the legacy 70/30 fallback cannot trigger the tier because
  // we cannot tell whether the workload actually exceeded 512K
  // tokens of input.
  // An engine with its own long-context tier never also takes this 2x.
  const longContextMultiplier =
    tier === undefined && usage.inputTokens !== undefined && usage.inputTokens > 512_000 ? 2 : 1;
  const outputCost = (outputTokens * apiRates.outputPer1k) / 1000;
  return (inputCost + outputCost) * longContextMultiplier;
}

/** Notes for engines whose API has a long-context tier the projection
 *  cannot apply (it needs per-request prompt sizes, which are not
 *  recorded).  One line per engine, built from the registry rates. */
export function longContextNotes(rows: Array<{ entry: EngineCapabilityEntry }>): string[] {
  const perMillion = (per1k: number) => `$${Number((per1k * 1000).toFixed(4))}`;
  const notes: string[] = [];
  for (const { entry } of rows) {
    if (entry.pricing.kind !== "subscription+api" && entry.pricing.kind !== "api") continue;
    const tier = entry.pricing.api.longContext;
    if (!tier) continue;
    const cached = tier.cachedInputPer1k !== undefined ? ` / ${perMillion(tier.cachedInputPer1k)} cached` : "";
    notes.push(
      `${entry.displayName}: API requests with prompts of ${tier.minPromptTokens.toLocaleString("en-US")}+ tokens bill every token at ` +
        `${perMillion(tier.inputPer1k)} input${cached} / ${perMillion(tier.outputPer1k)} output per million.  ` +
        `Per-request prompt sizes are not recorded, so the API-equivalent above uses the base rates and may run low if long prompts were common.`,
    );
  }
  return notes;
}

/** Pick the rows the projection shows.  Engines with no API rate are
 *  skipped (the projection is meaningless for them) — the card below
 *  lists the same engines under "Subscription only" instead. */
export function projectionRows(entries: EngineUsageAggregate[]): Array<{
  entry: EngineCapabilityEntry;
  usage: EngineUsageAggregate;
}> {
  const rows: Array<{ entry: EngineCapabilityEntry; usage: EngineUsageAggregate }> = [];
  const byId = new Map(entries.map((entry) => [entry.engineId, entry]));
  for (const id of ENGINE_DISPLAY_ORDER) {
    const entry = ENGINE_CAPABILITIES[id];
    if (!entry) continue;
    if (entry.pricing.kind !== "subscription+api" && entry.pricing.kind !== "api") continue;
    const usage = byId.get(id);
    if (!usage) continue;
    rows.push({ entry, usage });
  }
  return rows;
}

export function UsageWhatIfProjection(props: UsageWhatIfProjectionProps): React.ReactElement {
  const { byEngine, periodLabel, periodDays = 30, unattributedTokens = 0 } = props;
  const rows = projectionRows(byEngine);
  // Aggregate savings for the headline pill — what the user's subscriptions
  // saved in total over this period vs API-equivalent.  Compute totals
  // by summing raw actualCostUsd and raw apiEquivalentCost separately;
  // the difference is the aggregate saving (positive or negative).  The
  // previous shape clamped each row's saving to Math.max(0, ...) and
  // summed those, which understated the total when any row was a
  // net-negative (subscription cost MORE than PAYG) — Codex flagged it.
  const totalApi = rows.reduce((acc, { entry, usage }) => {
    if (entry.pricing.kind !== "subscription+api" && entry.pricing.kind !== "api") return acc;
    return acc + apiEquivalentCost(usage, entry.pricing);
  }, 0);
  // `periodDays` prorates the monthly subscription fee when the caller
  // reports a window shorter than 30 days.  `actualCostUsd` carries the
  // full monthly fee for the engine; scale it to the requested window
  // before summing so the totals row reflects what was actually billed
  // for the displayed period.  Codex flagged the previous shape — the
  // prop was read but the math never used it.
  const prorationFactor = Math.min(1, Math.max(0, periodDays / 30));
  // Pure pay-as-you-go engines (pricing.kind "api", e.g. DeepSeek
  // Harness) have no plan fee and no recorded spend here, so their
  // actualCostUsd is a placeholder 0.  Counting them would show
  // "$0" and book their whole API-equivalent as "saved", so keep them
  // out of the actual and saved totals.
  const planRows = rows.filter(({ entry }) => entry.pricing.kind !== "api");
  const planApi = planRows.reduce((acc, { entry, usage }) => {
    if (entry.pricing.kind !== "subscription+api") return acc;
    return acc + apiEquivalentCost(usage, entry.pricing);
  }, 0);
  const totalActual = planRows.reduce((acc, { usage }) => acc + usage.actualCostUsd * prorationFactor, 0);
  // The aggregate `saved` can go negative when a subscription costs more
  // than the equivalent PAYG volume (e.g. low-usage Claude Max).  The
  // previous shape clamped it to 0, which misreports a real net loss.
  // Render the signed value with a tone that flips red when negative
  // so the loss is visible — the footer copy explains the math.
  const totalSaved = planApi - totalActual;

  return (
    <Card
      title="API vs Subscription — What Your Workload Would Have Cost on PAYG"
      subtitle={`${periodLabel}.\u00A0 Estimated API-equivalent cost on the same token volume, vs what your subscriptions billed.\u00A0 Numbers use the input/output split reported by the engine driver and the published PAYG rates; cache reads use the cached-input rate when one exists.`}
    >
      {rows.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">
          No engines with a published API rate have recorded usage in {periodLabel}.
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.7fr] gap-x-3 border-b border-hairline/40 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
            <span>Engine</span>
            <span className="text-right">Your cost</span>
            <span className="text-right">API-equivalent</span>
            <span className="text-right">Saved by plan</span>
            <span className="text-right">Saved %</span>
          </div>
          {rows.map(({ entry, usage }) => {
            if (entry.pricing.kind !== "subscription+api" && entry.pricing.kind !== "api") return null;
            const apiCost = apiEquivalentCost(usage, entry.pricing);
            // Saved = apiCost - actualCost, signed.  Negative values
            // mean the subscription cost MORE than PAYG (e.g. a bot
            // Saved = apiCost - actualCostProrated, SIGNED per row.  A
            // negative value means the subscription cost MORE than PAYG
            // for the period (e.g. low usage on Claude Max at
            // $213.20/mo); clamping the row to $0 while the totals row
            // went negative made the card contradict itself, which the
            // review flagged.  Prorating the actual cost keeps the row
            // and the totals in sync for sub-30-day windows.
            const actualCostProrated = usage.actualCostUsd * prorationFactor;
            const isPayg = entry.pricing.kind === "api";
            const saved = apiCost - actualCostProrated;
            const savedPct = apiCost > 0 ? (saved / apiCost) * 100 : 0;
            const displayName = entry.displayName;
            // Pricing kind is already narrowed to subscription+api or
            // api by projectionRows, but TypeScript can't follow the
            // link without an explicit guard.  The `subscription` field
            // is only present on the subscription+api arm.
            const subscriptionTierLabel =
              entry.pricing.kind === "subscription+api" ? entry.pricing.subscription.tierLabel : "API only";
            // "Bundled" engines (costPerMonth is null) render a literal
            // string instead of $0 so the row does not imply the
            // engine is free.  Codex flagged the previous shape.
            const isBundled =
              entry.pricing.kind === "subscription+api" && entry.pricing.subscription.costPerMonth == null;
            const actualCostLabel = isPayg ? "PAYG" : isBundled ? "Bundled" : hasFiniteCost(actualCostProrated) ? formatUsd(actualCostProrated) : "—";
            return (
              <div key={entry.id} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.7fr] items-center gap-x-3 border-b border-hairline/20 py-2 text-[12.5px]">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-ink" title={displayName}>{displayName}</span>
                  <span className="truncate text-[10.5px] text-ink-secondary">{subscriptionTierLabel}</span>
                </div>
                <span className="text-right tabular-nums text-ink" title={isPayg ? "Pay-as-you-go: billed by the provider per token, no plan fee" : isBundled ? "Bundled into another plan" : "What you actually paid this period"}>{actualCostLabel}</span>
                <span className="text-right tabular-nums text-ink" title="Pay-as-you-go equivalent">{formatUsd(apiCost)}</span>
                {isPayg ? (
                  <span className="text-right tabular-nums text-ink-secondary" title="No plan, so nothing is saved vs PAYG">—</span>
                ) : (
                  <span
                    className={saved >= 0
                      ? "text-right tabular-nums text-emerald-700 dark:text-emerald-300"
                      : "text-right tabular-nums text-rose-700 dark:text-rose-300"}
                    title={saved >= 0 ? "Your subscription saved you this much" : "This plan cost more than the equivalent PAYG volume this period"}
                  >
                    {saved >= 0 ? formatUsd(saved) : `−${formatUsd(Math.abs(saved))}`}
                  </span>
                )}
                <span className="text-right tabular-nums text-ink-secondary">{!isPayg && apiCost > 0 ? `${savedPct.toFixed(1)}%` : "—"}</span>
              </div>
            );
          })}
          <div className="mt-3 grid grid-cols-[1.4fr_1fr_1fr_1fr_0.7fr] items-center gap-x-3 border-t border-hairline/40 py-2 text-[13px] font-medium text-ink">
            <span>All engines</span>
            <span className="text-right tabular-nums">{planRows.length > 0 && hasFiniteCost(totalActual) ? formatUsd(totalActual) : "—"}</span>
            <span className="text-right tabular-nums">{formatUsd(totalApi)}</span>
            <span
              className={
                totalSaved >= 0
                  ? "text-right tabular-nums text-emerald-700 dark:text-emerald-300"
                  : "text-right tabular-nums text-rose-700 dark:text-rose-300"
              }
              title={
                totalSaved >= 0
                  ? "Your subscriptions saved you this much overall"
                  : "Your subscriptions cost more than the equivalent PAYG volume this period — a net loss vs PAYG"
              }
            >
              {planRows.length === 0 ? "—" : totalSaved >= 0 ? formatUsd(totalSaved) : `−${formatUsd(Math.abs(totalSaved))}`}
            </span>
            <span className="text-right tabular-nums text-ink-secondary">{planApi > 0 ? `${((totalSaved / planApi) * 100).toFixed(1)}%` : "—"}</span>
          </div>
        </div>
      )}
      {longContextNotes(rows).map((note) => (
        <div key={note} className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
          {note}
        </div>
      ))}
      {unattributedTokens > 0 && (
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
          {unattributedTokens.toLocaleString()} tokens ran on connections deleted before
          per-engine attribution existed and are excluded from the rows above rather than
          guessed onto an engine.
        </div>
      )}
      <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
        Saved by plan reflects what your subscription would have charged vs the equivalent
        volume on PAYG API.{'\u00A0 '}For engines whose pricing is bundled into another plan, the
        row reads <em>Your cost: bundled</em> and saved is the same as the API-equivalent — that is
        honest, not a bug.{'\u00A0 '}Pay-as-you-go engines read <em>PAYG</em>: the API-equivalent
        is roughly what they cost, and they are left out of the cost and saved totals.{'\u00A0 '}{periodDays}-day proration applies to
        monthly fees when the period is shorter than 30 days.
      </div>
    </Card>
  );
}

/** Engine ids that have at least one capability rendered as `yes` or
 *  `limited`.  Exported so the parent can short-circuit building the
 *  usage aggregate for engines the user has never installed. */
export const PROJECTION_CAPABILITIES_HINT: ReadonlyArray<keyof typeof CAPABILITY_LABELS> = [];
