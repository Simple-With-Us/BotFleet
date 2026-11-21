// Rewrite retired / excluded model ids that still sit in saved bot chains.
// A picker drop (DSH_EXCLUDED_MODEL_IDS, MINIMAX_RETIRED_MODEL_IDS) only
// hides the row — bots.json keeps naming the old id, and every failover
// that reaches it burns a spawn on "unknown model option" before the
// rejection registry can learn.  Map those ids onto the live replacement
// the product already ships so resolveModel / selectTurnFallback / store
// load never hand a dead spelling to an engine.  The same map is the
// authority for the paths that meet an id outside saved chains: catalog
// discovery drops rows it names (a provider's live list keeps serving a
// retired model after the picker drops it), and per-model usage stats
// fold its banked rows onto the live replacement.
import type { ModelSelection } from "./contracts.ts";

/** Exact retired picker ids → the live catalog id that replaced them.
 *  Applies across dsh, the native minimax driver and mcode: all three
 *  dropped the same rows for the same product reasons.  DeepSeek's
 *  retired wire/display id folds onto the V4.1 Flash picker id (wire
 *  translation to deepseek-flash lives in Clutch / dshModelOptionValue).
 *  `DeepSeek-V4.1-Pro` is a different retirement: DeepSeek never published a
 *  4.1 Pro (its catalog is `DeepSeek-V4.1-Flash` plus `DeepSeek-V4-Pro-0813`),
 *  so the picker row was simply misnamed and every bot saved against it needs
 *  the rewrite or it would send an id no engine accepts.
 *
 *  The MiniMax M3.1 Flash rows were renamed, not retired: MiniMax dropped
 *  the `-Preview` suffix, and every engine that serves M3.1 now answers to
 *  `MiniMax-M3.1-Flash`.  Both former spellings are listed so a bot saved
 *  against one is migrated onto the live id instead of sending a spelling no
 *  engine accepts.  The mcode thinking rows carry the same suffix, so they
 *  get their own entries: an exact-match index cannot fold one into another. */
const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "MiniMax-M3": "MiniMax-M3.1-Flash",
  "MiniMax-M3.1-Flash-Preview": "MiniMax-M3.1-Flash",
  "MiniMax-M3.1-Flash-Preview-1M": "MiniMax-M3.1-Flash-1M",
  "MiniMax-M3.1-Flash-Preview-thinking": "MiniMax-M3.1-Flash-thinking",
  "MiniMax-M3.1-Flash-Preview-thinking-1M": "MiniMax-M3.1-Flash-thinking-1M",
  "MiniMax-M2.7": "MiniMax-M2.7-highspeed",
  "deepseek-v4-flash": "DeepSeek-V4.1-Flash",
  "DeepSeek-V4.1-Pro": "DeepSeek-V4-Pro",
};

/** Live replacement for a retired model id, or the input when it is still
 *  current.  The bare id must match exactly — MiniMax-M3.1-Flash and
 *  MiniMax-M2.7-highspeed must not match the retired stems.  A
 *  provider-qualified spelling (`minimax-coding-plan/MiniMax-M3`, as a
 *  discovered catalog spells the models it routes) names the bare id
 *  after its last `/`: the retired model is the same product whichever
 *  route serves it, so the match runs on that bare id and the
 *  replacement keeps the qualifier, landing on the same route's live
 *  row (`minimax-coding-plan/MiniMax-M3.1-Flash`). */
export function rewriteRetiredModelId(model: string): string {
  const bare = retiredBareId(model);
  if (bare === null) return model;
  return model.slice(0, model.length - bare.length) + RETIRED_MODEL_REPLACEMENTS[bare]!;
}

/** True when the model id is one the product has already retired from
 *  every catalog that used to advertise it — bare, or provider-qualified
 *  with a retired bare id after the last `/`. */
export function isRetiredModelId(model: string): boolean {
  return retiredBareId(model) !== null;
}

/** The retired bare id a model id names, or null when it names none:
 *  the id itself, or the segment after its last `/` for a
 *  provider-qualified spelling. */
function retiredBareId(model: string): string | null {
  const bare = model.slice(model.lastIndexOf("/") + 1);
  return Object.prototype.hasOwnProperty.call(RETIRED_MODEL_REPLACEMENTS, bare) ? bare : null;
}

/** Rewrite primary + nested fallbacks.  Effort and instanceId stay put —
 *  only the model spelling changes.  Returns whether anything changed so
 *  a store migration can persist once. */
export function rewriteModelSelection(
  selection: ModelSelection,
  skip?: (entry: ModelSelection) => boolean,
): {
  selection: ModelSelection;
  changed: boolean;
} {
  let changed = false;
  const model = skip?.(selection) ? selection.model : rewriteRetiredModelId(selection.model);
  if (model !== selection.model) changed = true;
  let fallbacks = selection.fallbacks;
  if (fallbacks && fallbacks.length > 0) {
    const next: ModelSelection[] = [];
    for (const entry of fallbacks) {
      const rewritten = rewriteModelSelection(entry, skip);
      if (rewritten.changed) changed = true;
      next.push(rewritten.selection);
    }
    fallbacks = next;
  }
  if (!changed) return { selection, changed: false };
  const out: ModelSelection = {
    ...selection,
    model,
  };
  if (fallbacks && fallbacks.length > 0) out.fallbacks = fallbacks;
  else delete out.fallbacks;
  return { selection: out, changed: true };
}
