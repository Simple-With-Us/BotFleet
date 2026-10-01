// What a bot's model selection becomes when the picker picks `model` on
// `instance`.  Shared by every picker entry — an engine's own list and the
// Local Models list — so a local model is saved exactly like any other model.
import type { InstanceInfo, ModelSelection } from "@/state/store";
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
