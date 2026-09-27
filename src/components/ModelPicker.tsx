// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, splitEngineRail } from "@/lib/engine-rail";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { EngineCallout } from "./EngineCallout";
import { formatDualQuotaBadge } from "@/lib/quota-display";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { modelEffortLevels } from "@/lib/model-effort";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

const CALLOUT_DRIVER_KINDS = new Set([
  "minimax",
  "claude",
  "grok",
  "codex",
  "antigravity",
  "cursorAgent",
  "deepseekAgent",
  "dshAgent",
  "antigravityAgent",
  "grokAgent",
  "claudeAgent",
]);

function WhyThisEngineCallout({ instance }: { instance: InstanceInfo }): ReactNode {
  if (!CALLOUT_DRIVER_KINDS.has(instance.driverKind)) return null;
  return (
    <EngineCallout
      key={instance.instanceId}
      driverKind={instance.driverKind}
      instanceId={instance.instanceId}
    />
  );
}

function engineStatus(instance: InstanceInfo): string {
  if (instance.snapshot.quota?.capped) return "Quota Cap";
  const modelCaps = Object.values(instance.snapshot.quota?.models ?? {});
  if (modelCaps.some((row) => row.capped)) return "Partial quota";
  if (instance.snapshot.reason === "Disabled in settings") return "Disabled";
  if (needsCli(instance)) return "Not installed";
  if (needsSignIn(instance)) return "Sign-in required";
  return instance.snapshot.version ?? "Ready";
}

function ModelRow({
  option,
  current,
  defaultId,
  onPick,
  quota,
  windowsLabel,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  onPick: () => void;
  quota?: {
    capped: boolean;
    remainingPercent?: number | null;
    secondaryRemainingPercent?: number | null;
    windowsLabel?: string;
  };
  windowsLabel?: string;
}) {
  const badge = formatDualQuotaBadge(
    quota?.remainingPercent,
    quota?.secondaryRemainingPercent,
    { windowsLabel: quota?.windowsLabel ?? windowsLabel },
  );
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
        current && "bg-control",
        quota?.capped && "opacity-60",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 break-words" title={option.label}>{option.label}</span>
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">Default</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">Loaded</span>
        )}
        {option.badge && (
          <span
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300"
            title={option.badgeTitle ?? option.badge}
            aria-label={option.badgeTitle ?? option.badge}
          >
            {option.badge}
          </span>
        )}
        {quota?.capped && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300">Exhausted</span>
        )}
        {!quota?.capped && badge && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">{badge}</span>
        )}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

function ModelSearch({
  value,
  onChange,
  onEscape,
  local,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  local: boolean;
}) {
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
        <Search size={13} className="shrink-0 text-ink-secondary" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onEscape();
          }}
          placeholder="Search models"
          aria-label={local ? "Search Local Models" : "Search Models"}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

export function ModelPicker({
  bot,
  className,
  contained = false,
  label,
  selection: propSelection,
  onChange,
}: {
  bot: Bot;
  className?: string;
  /** Expand the menu in-flow under the trigger so it cannot overflow a
   * narrow parent (the Bot profile sidebar). */
  contained?: boolean;
  label?: ReactNode;
  selection?: ModelSelection;
  onChange?: (selection: ModelSelection) => void;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = propSelection || bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? state.instances[0];

  useEffect(() => {
    if (open) void refreshInstances();
  }, [open, refreshInstances]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const clickedNode = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(clickedNode)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else if (pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(selectedIsCustom || isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const selectRail = (instance: InstanceInfo) => {
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const pick = (instance: InstanceInfo, model: string) => {
    const nextSelection: ModelSelection = {
      instanceId: instance.instanceId,
      model,
    };
    if (selection.effort) {
      const targetOption = instance.models.options.find((o) => o.id === model);
      const allowed = modelEffortLevels(instance, targetOption, model);
      if (allowed.includes(selection.effort)) {
        nextSelection.effort = selection.effort;
      }
    }
    // Fleet Models passes onChange for the primary pill.  Keep that bot's
    // fallbacks so picking a new primary does not wipe the chain.
    if (selection.fallbacks?.length) nextSelection.fallbacks = selection.fallbacks;

    if (onChange) {
       onChange(nextSelection);
    } else {
       nextSelection.fallbacks = bot.modelSelection.fallbacks;
       dispatch({
         type: "updateBot",
         botId: bot.id,
         patch: { modelSelection: nextSelection },
       });
    }
    setOpen(false);
  };

  const official = railInstance?.models.options.filter((option) => !option.custom) ?? [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(custom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  const blocked = railInstance
    ? pane === "custom"
      ? needsCli(railInstance)
      : needsCli(railInstance) || needsSignIn(railInstance)
    : false;
  const canOpenCustom = Boolean(railInstance && !needsCli(railInstance));
  const canReturnToOfficial = official.length > 0 && !isCustomOnly(railInstance);

  const windowsLabel =
    railInstance?.snapshot.quota?.windowsLabel ??
    (railInstance?.instanceId === "antigravity" ? "5hr/Week" : undefined);

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id}
      defaultId={railInstance?.models.default ?? ""}
      onPick={() => railInstance && pick(railInstance, option.id)}
      quota={railInstance?.snapshot.quota?.models?.[option.id]}
      windowsLabel={windowsLabel}
    />
  );

  let activeDriverKind = active?.driverKind;
  if (activeDriverKind) {
    const id = selection.model.toLowerCase();
    if (id.includes("minimax")) activeDriverKind = "minimax";
    else if (id.includes("qwen")) activeDriverKind = "qwenAgent";
    else if (id.includes("hermes")) activeDriverKind = "hermesAgent";
  }

  const trigger = (
    <button
      type="button"
      onClick={() => {
        setRailId(selection.instanceId);
        setOpen((wasOpen) => {
          const next = !wasOpen;
          if (next) openFor(state.instances.find((instance) => instance.instanceId === selection.instanceId));
          return next;
        });
      }}
      aria-expanded={open}
      aria-haspopup="dialog"
      className={cn(
        "flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover",
        // Settings Models chips (no side label) fill their wrap column so
        // long names truncate inside the pill instead of overlapping the next.
        contained && !label && "w-full min-w-0 justify-between",
        // in a narrow chat header fold to a rounded square with just the
        // provider mark; the model name rides the tooltip (a bot with no
        // resolved engine keeps its label — the mark is what would hide it)
        !contained && active && COMPACT_SQUARE,
      )}
      title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selection.model}
    >
      {active && <ProviderMark driverKind={activeDriverKind!} model={selection.model} size={14} />}
      <span className={cn("min-w-0 truncate", !contained && "max-w-[160px]", !contained && active && "@max-4xl/chathead:hidden")}>
        {modelLabel(active, selection.model)}
      </span>
      <ChevronDown
        size={14}
        className={cn(
          "text-ink-secondary transition-transform",
          open && "rotate-180",
          !contained && active && "@max-4xl/chathead:hidden",
        )}
      />
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        <div className="flex items-center justify-between gap-4">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {open && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label="Choose Model"
          className={cn(
            "flex overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 w-[420px] max-h-[min(480px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
          )}
        >
          <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {(() => {
              const availableInstances = state.instances.filter((i) => {
                if (i.enabled === false) return false;
                if (i.snapshot.state === "unavailable" && i.instanceId !== selection.instanceId) return false;
                if (i.instanceId === "kimi" && (!i.snapshot.authenticated || i.snapshot.state !== "available") && i.instanceId !== selection.instanceId) return false;
                return true;
              });
              const { subscription, custom: local } = splitEngineRail(availableInstances);
              const railButton = (instance: InstanceInfo) => {
                const selected = instance.instanceId === railInstance?.instanceId;
                const attention = needsCli(instance) || needsSignIn(instance) || Boolean(instance.snapshot.quota?.capped);
                return (
                  <button
                    type="button"
                    key={instance.instanceId}
                    onClick={() => selectRail(instance)}
                    aria-label={instance.displayName}
                    aria-pressed={selected}
                    title={`${instance.displayName} · ${engineStatus(instance)}`}
                    className={cn(
                      "relative flex size-9 items-center justify-center rounded-lg",
                      selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60",
                    )}
                  >
                    <ProviderMark driverKind={instance.driverKind} size={18} />
                    {attention && (
                      <span
                        className={cn(
                          "absolute bottom-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-panel",
                          instance.snapshot.quota?.capped ? "bg-amber-500" : "bg-warning",
                        )}
                      />
                    )}
                  </button>
                );
              };
              return (
                <>
                  {subscription.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</EngineGroupLabel>
                  )}
                  {subscription.map(railButton)}
                  {local.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>
                  )}
                  {local.map(railButton)}
                </>
              );
            })()}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink" title={railInstance.displayName}>{railInstance.displayName}</div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                        railInstance.snapshot.quota?.capped
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : blocked
                          ? "bg-warning/10 text-warning"
                          : "bg-success/10 text-success",
                      )}
                    >
                      {pane === "custom" && !blocked ? "Local models" : engineStatus(railInstance)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {pane === "custom"
                      ? "Run this bot with a model already on your machine."
                      : "Choose a model for this bot."}
                  </div>
                  {railInstance.snapshot.quota?.capped && (
                    <div className="mt-2 rounded bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300 border border-amber-500/20">
                      <strong>Usage cap in effect:</strong> {railInstance.snapshot.quota?.error ?? "Session limit or quota reached."} Turns automatically fail over to configured fallbacks until reset.
                    </div>
                  )}

                  {railInstance.driverKind === "boxAgent" && (
                    <div className="mt-2 rounded bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning-dark border border-warning/20">
                      <strong>Works Alone:</strong>
                      {"  "}This bot runs its turn on box.ascii.dev, so it has no team tools, no peers to ask, no approval cards, no memory, and no skills.
                    </div>
                  )}
                </div>

                {pane === "custom" && canReturnToOfficial && (
                  <button
                    type="button"
                    onClick={() => {
                      setPane("main");
                      resetList();
                    }}
                    className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-control/60"
                  >
                    <ChevronLeft size={13} /> Back to {railInstance.displayName} models
                  </button>
                )}

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <WhyThisEngineCallout instance={railInstance} />
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                      {pane === "main" && official.length > 0
                        ? `${official.length} ${official.length === 1 ? "model" : "models"} will appear after setup.`
                        : "Local models will appear as soon as the engine is installed."}
                    </p>
                  </div>
                ) : (
                  <>
                    {((pane === "main" && official.length > COMPACT_MODEL_COUNT) ||
                      (pane === "custom" && custom.length > COMPACT_MODEL_COUNT)) && (
                      <ModelSearch
                        value={query}
                        local={pane === "custom"}
                        onChange={(value) => {
                          setQuery(value);
                          if (value) setShowAll(true);
                        }}
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      <div className="px-2">
                        <WhyThisEngineCallout instance={railInstance} />
                      </div>
                      {pane === "main" ? (
                        <>
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query ? `${filteredOfficial.length} results` : showAll ? `All models · ${official.length}` : "Suggested"}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show all {official.length} models{windowsLabel ? ` (${windowsLabel})` : ""} <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show suggested only
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">Loaded now</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {custom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              <div className="text-[12.5px] font-medium text-ink">No local models found</div>
                              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                Start oMLX, Ollama, Unsloth, LM Studio, or EXO, then reopen this picker.
                              </div>
                            </div>
                          )}
                          {custom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {pane === "main" && (
                  <button
                    type="button"
                    aria-label={
                      custom.length > 0 ? `Use a Local Model (${custom.length} available)` : "Use a Local Model"
                    }
                    disabled={!canOpenCustom}
                    onClick={() => {
                      setPane("custom");
                      resetList();
                    }}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>Use a Local Model</span>
                    <span className="flex items-center gap-2">
                      {custom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {custom.length} available
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">No model providers are available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
