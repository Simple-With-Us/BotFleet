// What a bot's model selection becomes when the picker picks `model` on
// `instance`.  Shared by every picker entry — an engine's own list and the
// Local Models list — so a local model is saved exactly like any other model.
import type { InstanceInfo, ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../server/contracts.ts";
import { modelDefaultEffort, modelEffortLevels } from "./model-effort";

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
  // Same for the context cap and the output limit, but only a value the new
  // model would still send: startTurn drops a cap the row does not offer and
  // either value past the model's window, so carrying one over would save a
  // limit that never runs and shows as invalid in the picker.
  const targetOption = instance.models.options.find((option) => option.id === model);
  if (current.contextCap && targetOption?.contextCaps?.length) {
    const fits = targetOption.contextWindow === undefined
      ? targetOption.contextCaps.includes(current.contextCap)
      : current.contextCap <= targetOption.contextWindow;
    if (fits) next.contextCap = current.contextCap;
  }
  if (current.maxOutputTokens && targetOption?.supportsMaxOutput) {
    if (targetOption.contextWindow === undefined || current.maxOutputTokens <= targetOption.contextWindow) {
      next.maxOutputTokens = current.maxOutputTokens;
    }
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

/** The default reasoning effort level for the selected model on `instance`, if any. */
export function selectionDefaultEffort(
  instance: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "model">,
): EffortLevel | undefined {
  const option = instance?.models.options.find((candidate) => candidate.id === selection.model);
  return modelDefaultEffort(instance, option, selection.model);
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

/** The context caps (tokens) the selected model offers besides its full window,
 *  or none when the model has no such choice. */
export function selectionContextCaps(
  instance: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "model">,
): readonly number[] {
  return instance?.models.options.find((candidate) => candidate.id === selection.model)?.contextCaps ?? [];
}

/** What changing only the context cap saves; `undefined` is the full window.
 *  Clearing sends an explicit `null` rather than dropping the key: the harness
 *  keeps a saved cap for a client that never sends the field (the shipped iOS
 *  app), so a dropped key would not clear it. */
export function selectionWithContextCap(current: ModelSelection, cap: number | undefined): ModelSelection {
  return { ...current, contextCap: cap ?? null };
}

/** "512K", "1M": how a cap or window reads on a button. */
export function contextCapLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  return `${Math.floor(tokens / 1024)}K`;
}

/** Whether the selected model's driver sends a per-bot output limit. */
export function selectionSupportsMaxOutput(
  instance: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "model">,
): boolean {
  return instance?.models.options.find((candidate) => candidate.id === selection.model)?.supportsMaxOutput === true;
}

/** What changing only the output limit saves; `undefined` is the model's own.
 *  Clearing sends an explicit `null`, for the reason `selectionWithContextCap`
 *  gives. */
export function selectionWithMaxOutput(current: ModelSelection, tokens: number | undefined): ModelSelection {
  return { ...current, maxOutputTokens: tokens ?? null };
}

/** Parse the Max Output Tokens field.  Empty is "use the model default"
 *  (undefined); anything that is not a whole number of at least 1, or is past
 *  `windowTokens` when that is known, is invalid (null).  Accepts "8k" and
 *  "64K" as thousands. */
export function parseMaxOutputInput(raw: string, windowTokens?: number): number | undefined | null {
  const text = raw.trim().replace(/,/g, "").toLowerCase();
  if (!text) return undefined;
  const match = /^(\d+)(k)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  if (windowTokens !== undefined && value > windowTokens) return null;
  return value;
}
