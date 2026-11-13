// Local Models: one picker entry that gathers every model running on this
// computer or at an endpoint the operator added, instead of a "Use a Local
// Model" row repeated (and mostly greyed out) under every engine.
//
// Two kinds of row count as local:
//   - an injected `host::model` row.  The harness probes oMLX, Ollama, EXO,
//     LM Studio and Unsloth and lists whatever they serve under every engine
//     that can be pointed at them, so the same model arrives on ten engines.
//     It is listed once, under the engine that will run it.
//   - a `custom` row on a Local-group engine (openai-compat, pi, hermes,
//     qwen, ...): the models the operator configured in Engine settings.
// Nothing else is local.  A Codex or Claude `custom` row that is not an
// injected host model is a cloud provider the operator configured, and stays
// in its own engine's list.
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { decodeInjectId } from "../../shared/local-hosts";
import { filterCustomModels, partitionCustomModels } from "./custom-models";
import { isCustomOnly } from "./engine-rail";

type ModelOption = InstanceInfo["models"]["options"][number];

/** The picker rail's id for the aggregate entry.  Not an engine instance, and
 * not a string an instance id can take (ids are slugs). */
export const LOCAL_MODELS_RAIL_ID = "__local-models__";

/** `ProviderMark` key for the entry's monitor icon. */
export const LOCAL_MODELS_DRIVER_KIND = "localModels";

export const LOCAL_MODELS_TITLE = "Local Models";

export interface LocalModelGroup {
  /** The engine that runs these models when one is picked. */
  instance: InstanceInfo;
  options: ModelOption[];
}

/** True for a `host::model` row from a local host the harness probes. */
export function isInjectedLocalModel(option: { id: string }): boolean {
  return decodeInjectId(option.id) !== null;
}

/** An engine can run a local model only when it is switched on and its CLI is
 * present.  Its cloud sign-in is irrelevant: injection replaces it. */
function canRunLocalModels(instance: InstanceInfo): boolean {
  return instance.enabled !== false && instance.snapshot.state === "available";
}

// Who runs an injected model that several engines offer.  Local-group engines
// are built for it (pi lists injected rows first), then the two mainstream
// coding agents, then whatever is left in registry order.
const PREFERRED_RUNNER_KINDS = ["claudeAgent", "claude", "codex"];

function runnerRank(instance: InstanceInfo): number {
  if (isCustomOnly(instance)) return 0;
  const preferred = PREFERRED_RUNNER_KINDS.indexOf(instance.driverKind);
  return preferred === -1 ? PREFERRED_RUNNER_KINDS.length + 1 : preferred + 1;
}

/** Every configured local model, grouped by the engine that would run it.
 * Empty when nothing is configured — which is when the picker shows no Local
 * Models entry at all.
 *
 * `current` keeps a bot that is already on an injected model visible on the
 * engine it is actually using, even when a more preferred engine offers the
 * same model. */
export function collectLocalModels(
  instances: readonly InstanceInfo[],
  current?: Pick<ModelSelection, "instanceId" | "model">,
): LocalModelGroup[] {
  const eligible = instances
    .map((instance, index) => ({ instance, index }))
    .filter(({ instance }) => canRunLocalModels(instance))
    .sort((a, b) => runnerRank(a.instance) - runnerRank(b.instance) || a.index - b.index)
    .map(({ instance }) => instance);

  const claimed = new Map<string, string>();
  if (current && isInjectedLocalModel({ id: current.model })) {
    const holder = eligible.find(
      (instance) =>
        instance.instanceId === current.instanceId &&
        instance.models.options.some((option) => option.id === current.model),
    );
    if (holder) claimed.set(current.model, holder.instanceId);
  }

  const groups: LocalModelGroup[] = [];
  for (const instance of eligible) {
    const options: ModelOption[] = [];
    for (const option of instance.models.options) {
      if (isInjectedLocalModel(option)) {
        const owner = claimed.get(option.id);
        if (owner === undefined) claimed.set(option.id, instance.instanceId);
        else if (owner !== instance.instanceId) continue;
        options.push(option);
      } else if (option.custom && isCustomOnly(instance)) {
        options.push(option);
      }
    }
    if (options.length === 0) continue;
    // Models the host already has in memory first, the way the old Custom pane
    // pinned them.
    const { pinned, rest } = partitionCustomModels(options);
    groups.push({ instance, options: [...pinned, ...rest] });
  }
  return groups;
}

export function localModelCount(groups: readonly LocalModelGroup[]): number {
  return groups.reduce((total, group) => total + group.options.length, 0);
}

/** Keep the rows matching `query`; drop a group once nothing in it matches. */
export function filterLocalModelGroups(
  groups: readonly LocalModelGroup[],
  query: string,
): LocalModelGroup[] {
  if (!query.trim()) return [...groups];
  const out: LocalModelGroup[] = [];
  for (const group of groups) {
    const options = filterCustomModels(group.options, query);
    if (options.length > 0) out.push({ instance: group.instance, options });
  }
  return out;
}

/** Should the picker open on the Local Models entry?  Yes when the bot is on an
 * injected model of an engine whose own list would not show it — every engine
 * except a Local-group one, which keeps opening on itself. */
export function opensOnLocalModels(
  groups: readonly LocalModelGroup[],
  selected: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  if (groups.length === 0 || !isInjectedLocalModel({ id: selection.model })) return false;
  if (selected && isCustomOnly(selected)) return false;
  return groups.some(
    (group) =>
      group.instance.instanceId === selection.instanceId &&
      group.options.some((option) => option.id === selection.model),
  );
}
