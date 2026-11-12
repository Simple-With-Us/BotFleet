import type { Bot, InstanceInfo, ModelSelection } from "@/state/store";

/** The selected model is more specific than the engine-wide fallback.
 * Explicit false must win even when a newer engine advertises images. */
export function selectedModelSupportsImages(
  instances: readonly InstanceInfo[],
  selection: ModelSelection | undefined,
): boolean {
  if (!selection) return false;
  const instance = instances.find((entry) => entry.instanceId === selection.instanceId);
  if (!instance) return false;
  const model = instance.models.options.find((option) => option.id === selection.model);
  return model?.images ?? (instance.capabilities?.images === true);
}

/** A task may override its bot's default model; use the model that will answer. */
export function botSupportsImageAttachments(instances: readonly InstanceInfo[], bot: Bot | undefined): boolean {
  if (!bot) return false;
  const task = bot.tasks?.find((entry) => entry.threadId === bot.threadId);
  return selectedModelSupportsImages(instances, task?.modelSelection ?? bot.modelSelection);
}
