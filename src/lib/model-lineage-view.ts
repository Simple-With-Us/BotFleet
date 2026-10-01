// What the model picker shows for model lineage (shared/model-lineage.ts):
// the "Latest <Class>" rows, the catalog with superseded rows hidden, the
// chip text for a floating selection, and the badge plus one-click switch
// for a saved id the catalog no longer offers.  Pure, so it is tested
// without rendering the picker.
import {
  classLabel,
  latestOptions,
  lineageStatus,
  presentCatalog,
  type LineageStatusKind,
} from "../../shared/model-lineage";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { readableModelLabel } from "@/lib/model-label";
import { modelEffortLevels } from "@/lib/model-effort";

type ModelOption = InstanceInfo["models"]["options"][number];

/** Catalog label for a model, else a readable one built from its id. */
export function modelOptionLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? readableModelLabel(model);
}

/** Official rows a picker may offer: the harness already hides superseded
 *  rows, and this repeats it so an older harness cannot re-offer them. */
export function offeredOptions(instance: InstanceInfo | undefined): ModelOption[] {
  if (!instance) return [];
  return presentCatalog(instance.driverKind, instance.models).options;
}

export interface LatestRow {
  classKey: string;
  /** "Latest Sonnet" */
  label: string;
  resolvedId: string;
  /** "Claude Sonnet 5.5" */
  resolvedLabel: string;
}

export function latestRows(instance: InstanceInfo | undefined): LatestRow[] {
  if (!instance) return [];
  const options = offeredOptions(instance);
  return latestOptions(instance.driverKind, options).map((row) => ({
    ...row,
    resolvedLabel: modelOptionLabel(instance, row.resolvedId),
  }));
}

/** "Latest Sonnet" for a floating selection, or null when it is pinned. */
export function latestLabel(instance: InstanceInfo | undefined, selection: Pick<ModelSelection, "latest">): string | null {
  if (!selection.latest) return null;
  const noun = classLabel(instance?.driverKind, selection.latest);
  return noun ? `Latest ${noun}` : null;
}

/** Chip text.  The chat header shows the model that actually runs; the
 *  settings chips also say it is floating ("Latest Sonnet · Claude Sonnet
 *  5.5"). */
export function selectionChipLabel(
  instance: InstanceInfo | undefined,
  selection: Pick<ModelSelection, "model" | "latest">,
  opts: { showLatest: boolean },
): string {
  const actual = modelOptionLabel(instance, selection.model);
  const latest = opts.showLatest ? latestLabel(instance, selection) : null;
  return latest ? `${latest} · ${actual}` : actual;
}

export interface SavedModelStatus {
  kind: LineageStatusKind;
  /** Badge text, sentence case, or null when the saved id is fine. */
  badge: string | null;
  /** What "Switch To …" would save, when something can replace it. */
  successor?: ModelSelection;
  /** "Latest Sonnet" or "Claude Sonnet 5.5" */
  successorLabel?: string;
}

const BADGES: Record<LineageStatusKind, string | null> = {
  ok: null,
  retired: "Retired",
  superseded: "Superseded",
  "not-in-catalog": "Not in catalog",
};

/** How the saved selection stands against the instance's catalog.  Nothing
 *  is flagged for an engine that is missing, disabled, or has no official
 *  rows, or for a local (`provider::model`) or custom row: a provider that
 *  is merely down must not badge every chip. */
export function savedModelStatus(
  instance: InstanceInfo | undefined,
  selection: ModelSelection,
): SavedModelStatus {
  const ok: SavedModelStatus = { kind: "ok", badge: null };
  if (!instance || instance.enabled === false || !selection.model) return ok;
  const options = offeredOptions(instance);
  if (!options.some((option) => !option.custom)) return ok;
  const status = lineageStatus(instance.driverKind, selection.model, options, instance.models.live === true);
  if (status.kind === "ok") return ok;
  const result: SavedModelStatus = { kind: status.kind, badge: BADGES[status.kind] };
  if (status.successor) {
    const successor: ModelSelection = {
      instanceId: selection.instanceId,
      model: status.successor.model,
      ...(status.successor.latest ? { latest: status.successor.latest } : {}),
    };
    if (selection.effort) {
      const option = instance.models.options.find((candidate) => candidate.id === successor.model);
      if (modelEffortLevels(instance, option, successor.model).includes(selection.effort)) {
        successor.effort = selection.effort;
      }
    }
    result.successor = successor;
    result.successorLabel = latestLabel(instance, successor) ?? modelOptionLabel(instance, successor.model);
  }
  return result;
}
