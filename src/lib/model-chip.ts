import type { Bot, InstanceInfo } from "@/state/store";
import { readableModelLabel } from "@/lib/model-label";

/** Driver mark + display name for the bot's current model. */
export function modelChip(bot: Bot | undefined, instances: InstanceInfo[]): { driverKind: string; name: string; model: string } | null {
  const selection = bot?.activeModelSelection ?? bot?.modelSelection;
  if (!selection?.model) return null;
  const engine = instances.find((instance) => instance.instanceId === selection.instanceId);
  const name =
    engine?.models.options.find((option) => option.id === selection.model)?.label ?? readableModelLabel(selection.model);
  let driverKind = engine?.driverKind ?? selection.instanceId;
  const lower = selection.model.toLowerCase();
  if (lower.includes("minimax")) driverKind = "minimax";
  else if (lower.includes("qwen")) driverKind = "qwenAgent";
  else if (lower.includes("hermes")) driverKind = "hermesAgent";
  
  return { driverKind, name, model: selection.model };
}
