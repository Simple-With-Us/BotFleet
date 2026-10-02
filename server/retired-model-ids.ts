// Rewrite retired / excluded model ids that still sit in saved bot chains.
// A picker drop (DSH_EXCLUDED_MODEL_IDS, MINIMAX_RETIRED_MODEL_IDS) only
// hides the row — bots.json keeps naming the old id, and every failover
// that reaches it burns a spawn on "unknown model option" before the
// rejection registry can learn.  Map those ids onto the live replacement
// the product already ships so resolveModel / selectTurnFallback / store
// load never hand a dead spelling to an engine.
import type { ModelSelection } from "./contracts.ts";

/** Exact retired picker ids → the live catalog id that replaced them.
 *  Applies across dsh and the native minimax driver: both dropped the
 *  same M3 / plain M2.7 rows for the same product reason.  DeepSeek's
 *  retired wire/display id folds onto the V4.1 Flash picker id (wire
 *  translation to deepseek-flash lives in Clutch / dshModelOptionValue). */
const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "MiniMax-M3": "MiniMax-M3.1-Flash-Preview",
  "MiniMax-M2.7": "MiniMax-M2.7-highspeed",
  "deepseek-v4-flash": "DeepSeek-V4.1-Flash",
};

/** Live replacement for a retired model id, or the input when it is still
 *  current.  Exact match only — MiniMax-M3.1-Flash-Preview and
 *  MiniMax-M2.7-highspeed must not match the retired stems. */
export function rewriteRetiredModelId(model: string): string {
  return RETIRED_MODEL_REPLACEMENTS[model] ?? model;
}

/** True when the model id is one the product has already retired from
 *  every catalog that used to advertise it. */
export function isRetiredModelId(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_MODEL_REPLACEMENTS, model);
}

/** Rewrite primary + nested fallbacks.  Effort and instanceId stay put —
 *  only the model spelling changes.  Returns whether anything changed so
 *  a store migration can persist once. */
export function rewriteModelSelection(selection: ModelSelection): {
  selection: ModelSelection;
  changed: boolean;
} {
  let changed = false;
  const model = rewriteRetiredModelId(selection.model);
  if (model !== selection.model) changed = true;
  let fallbacks = selection.fallbacks;
  if (fallbacks && fallbacks.length > 0) {
    const next: ModelSelection[] = [];
    for (const entry of fallbacks) {
      const rewritten = rewriteModelSelection(entry);
      if (rewritten.changed) changed = true;
      next.push(rewritten.selection);
    }
    fallbacks = next;
  }
  if (!changed) return { selection, changed: false };
  const out: ModelSelection = {
    instanceId: selection.instanceId,
    model,
  };
  if (selection.effort !== undefined) out.effort = selection.effort;
  if (fallbacks && fallbacks.length > 0) out.fallbacks = fallbacks;
  return { selection: out, changed: true };
}
