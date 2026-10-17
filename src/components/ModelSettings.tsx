// "Model settings": the optional per-model controls (Effort, Context, Max
// Output Tokens) behind one collapsed toggle, like the Kodus "Advanced
// settings" panel.  One component serves the primary model and every fallback
// entry: each is a ModelSelection, so each carries its own values.
import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  selectionContextCaps,
  selectionEffortLevels,
  selectionSupportsMaxOutput,
  selectionWithContextCap,
  selectionWithEffort,
  selectionWithMaxOutput,
} from "@/lib/model-pick";
import { ContextSection, EffortSection, MaxOutputSection } from "./ModelPicker";

export function modelSettingsAvailable(
  instance: InstanceInfo | undefined,
  selection: ModelSelection,
  showEffort = true,
): boolean {
  return (
    (showEffort && selectionEffortLevels(instance, selection).length > 0) ||
    selectionContextCaps(instance, selection).length > 0 ||
    selectionSupportsMaxOutput(instance, selection)
  );
}

export function ModelSettings({
  instance,
  selection,
  onChange,
  disabled = false,
  showEffort = true,
  initialOpen = false,
}: {
  instance: InstanceInfo | undefined;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
  /** The primary model's Reasoning card already has the Effort control. */
  showEffort?: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  if (!modelSettingsAvailable(instance, selection, showEffort)) return null;
  const levels = showEffort ? selectionEffortLevels(instance, selection) : [];
  const caps = selectionContextCaps(instance, selection);
  const windowTokens = instance?.models.options.find((option) => option.id === selection.model)?.contextWindow;
  return (
    <div data-model-settings className="rounded-lg border border-hairline/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-ink"
      >
        <SlidersHorizontal size={14} className="shrink-0 text-ink-secondary" />
        <span className="min-w-0 flex-1">Model Settings</span>
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-hairline/40">
          {levels.length > 0 && (
            <EffortSection
              levels={levels}
              current={selection.effort}
              onPick={(level) => onChange(selectionWithEffort(selection, level))}
              disabled={disabled}
              className="border-t-0"
            />
          )}
          {caps.length > 0 && (
            <ContextSection
              caps={caps}
              windowTokens={windowTokens}
              current={selection.contextCap ?? undefined}
              onPick={(cap) => onChange(selectionWithContextCap(selection, cap))}
              disabled={disabled}
            />
          )}
          {selectionSupportsMaxOutput(instance, selection) && (
            <MaxOutputSection
              current={selection.maxOutputTokens ?? undefined}
              windowTokens={windowTokens}
              onPick={(tokens) => onChange(selectionWithMaxOutput(selection, tokens))}
              disabled={disabled}
            />
          )}
        </div>
      )}
    </div>
  );
}
