// What a bot's model selection becomes when the picker picks `model` on
// `instance`.  Shared by every picker entry — an engine's own list and the
// Local Models list — so a local model is saved exactly like any other model.
import type { InstanceInfo, ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../server/contracts.ts";
import { modelEffortLevels } from "./model-effort";

export function selectionForPick(
  current: ModelSelection,
  instance: InstanceInfo,
  model: string,
): ModelSelection {
  const next: ModelSelection = { instanceId: instance.instanceId, model };
  // Keep the effort the bot already had when the new model still offers it.
  if (current.effort) {
    const targetOption = instance.models.options.find((option) => option.id === model);
    const allowed = modelEffortLevels(instance, targetOption, model);
    if (allowed.includes(current.effort)) next.effort = current.effort;
  }
  // Fleet Models passes onChange for the primary pill.  Keep that bot's
  // fallbacks so picking a new primary does not wipe the chain.
  if (current.fallbacks?.length) next.fallbacks = current.fallbacks;
  return next;
}

/** What a picker click commits.  `latest` is set when the person picked a
 *  "Latest <Class>" row.  A pinned pick sends an explicit `null`: the harness
 *  carries a saved float forward for clients that never send the field (the
 *  shipped iOS app), and `null` is how a person says "pin this one" instead. */
export function pickedSelection(
  current: ModelSelection,
  instance: InstanceInfo,
  model: string,
  latest?: string,
): ModelSelection {
  return { ...selectionForPick(current, instance, model), latest: latest ?? null };
}

/** The effort levels the selected model offers on `instance`: none for a model
 *  that takes no reasoning effort.  The one lookup behind both Settings'
 *  Reasoning control and the chat picker's Effort section.  It reads the raw
 *  catalog row, so a saved model the picker no longer lists still answers the
 *  same in both places. */
export function selectionEffortLevels(
  instance: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "model">,
): readonly EffortLevel[] {
  const option = instance?.models.options.find((candidate) => candidate.id === selection.model);
  return modelEffortLevels(instance, option, selection.model);
}

/** What changing only the effort saves.  The rest of the selection rides along
 *  untouched, `latest` and `fallbacks` included: unlike a model pick, choosing
 *  an effort must not un-float a "Latest <Class>" bot or drop its fallback
 *  chain.  `undefined` is Default: the bot sends no effort. */
export function selectionWithEffort(
  current: ModelSelection,
  effort: EffortLevel | undefined,
): ModelSelection {
  return { ...current, effort };
}
