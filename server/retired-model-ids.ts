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
 *  translation to deepseek-flash lives in Clutch / dshModelOptionValue).
 *  `DeepSeek-V4.1-Pro` is a different retirement: DeepSeek never published a
 *  4.1 Pro (its catalog is `DeepSeek-V4.1-Flash` plus `DeepSeek-V4-Pro-0813`),
 *  so the picker row was simply misnamed and every bot saved against it needs
 *  the rewrite or it would send an id no engine accepts. */
const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "MiniMax-M3": "MiniMax-M3.1-Flash-Preview",
  "MiniMax-M2.7": "MiniMax-M2.7-highspeed",
  "deepseek-v4-flash": "DeepSeek-V4.1-Flash",
  "DeepSeek-V4.1-Pro": "DeepSeek-V4-Pro",
};

/** Retirements that apply to one engine instance only, keyed by instance id.
 *
 *  The installed dsh engine renamed `MiniMax-M3.1-Flash-Preview` to
 *  `MiniMax-M3.1-Flash` (see `DSH_MINIMAX_M31_FLASH_MODEL` in
 *  `drivers/acp/dsh.ts`), and Clutch has no MiniMax alias family, so a dsh
 *  turn sent with the old id fails "unknown model".  mcode and the native
 *  `minimax` driver still serve the Preview id, so this cannot sit in the
 *  global map above: it would move their bots onto an id they do not offer. */
const INSTANCE_RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  dsh: {
    "MiniMax-M3.1-Flash-Preview": "MiniMax-M3.1-Flash",
  },
};

function instanceReplacement(model: string, instanceId: string | undefined): string | undefined {
  if (instanceId === undefined) return undefined;
  const scoped = INSTANCE_RETIRED_MODEL_REPLACEMENTS[instanceId];
  if (!scoped || !Object.prototype.hasOwnProperty.call(scoped, model)) return undefined;
  return scoped[model];
}

/** Live replacement for a retired model id, or the input when it is still
 *  current.  Exact match only — MiniMax-M3.1-Flash-Preview and
 *  MiniMax-M2.7-highspeed must not match the retired stems.
 *
 *  Pass `instanceId` to also apply that instance's own retirements; the
 *  global rewrite runs first, so dsh's `MiniMax-M3` lands on the dsh M3.1
 *  Flash id rather than the Preview spelling dsh no longer offers. */
export function rewriteRetiredModelId(model: string, instanceId?: string): string {
  const global = RETIRED_MODEL_REPLACEMENTS[model] ?? model;
  return instanceReplacement(global, instanceId) ?? global;
}

/** True when the model id is one the product has already retired from
 *  every catalog that used to advertise it, or (with `instanceId`) from that
 *  instance's catalog. */
export function isRetiredModelId(model: string, instanceId?: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(RETIRED_MODEL_REPLACEMENTS, model) ||
    instanceReplacement(model, instanceId) !== undefined
  );
}

/** Rewrite primary + nested fallbacks.  Effort and instanceId stay put —
 *  only the model spelling changes.  Returns whether anything changed so
 *  a store migration can persist once. */
export function rewriteModelSelection(selection: ModelSelection): {
  selection: ModelSelection;
  changed: boolean;
} {
  let changed = false;
  const model = rewriteRetiredModelId(selection.model, selection.instanceId);
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
