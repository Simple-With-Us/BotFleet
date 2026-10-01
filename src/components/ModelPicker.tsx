// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
// Local models are not a row under each engine: when any are configured the
// rail grows one "Local Models" entry that lists them all, and when none are
// there is nothing to show.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, splitEngineRail } from "@/lib/engine-rail";
import {
  LOCAL_MODELS_DRIVER_KIND,
  LOCAL_MODELS_RAIL_ID,
  LOCAL_MODELS_TITLE,
  collectLocalModels,
  filterLocalModelGroups,
  isInjectedLocalModel,
  localModelCount,
  opensOnLocalModels,
  type LocalModelGroup,
} from "@/lib/local-models";
import { pickedSelection, selectionEffortLevels, selectionWithEffort } from "@/lib/model-pick";
import { effortLabel } from "@/lib/model-effort";
import type { EffortLevel } from "../../server/contracts.ts";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { isCheckingEngine, isHiddenEngine } from "@/lib/engine-status";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { EngineCallout } from "./EngineCallout";
import { formatDualQuotaBadge } from "@/lib/quota-display";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import {
  latestRows,
  modelOptionLabel,
  offeredOptions,
  savedModelStatus,
  selectionChipLabel,
  type LatestRow,
  type SavedModelStatus,
} from "@/lib/model-lineage-view";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  // A saved selection the latest-only picker no longer lists still gets a
  // readable chip instead of its raw id.
  return modelOptionLabel(instance, model);
}

/** "Latest Sonnet" rows: the choice that keeps a bot on the newest member
 *  of a model class.  Each row names the model it runs right now. */
export function LatestModelRows({
  rows,
  currentClass,
  onPick,
}: {
  rows: LatestRow[];
  /** The class the saved selection floats on for this engine, if any. */
  currentClass?: string | null;
  onPick: (row: LatestRow) => void;
}) {
  if (!rows.length) return null;
  return (
    <>
      <EngineGroupLabel className="px-2 pb-1 pt-0.5">Latest</EngineGroupLabel>
      {rows.map((row) => {
        const current = currentClass === row.classKey;
        return (
          <button
            key={row.classKey}
            type="button"
            onClick={() => onPick(row)}
            title={`${row.label} runs ${row.resolvedLabel} now and moves to each newer version.`}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
              current && "bg-control",
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 break-words">{row.label}</span>
              <span className="min-w-0 truncate text-[11.5px] text-ink-secondary">{row.resolvedLabel}</span>
            </span>
            {current && <Check size={14} className="shrink-0 text-accent" />}
          </button>
        );
      })}
      <div className="mx-2 my-1.5 border-t border-hairline/40" role="separator" />
    </>
  );
}

/** "Effort": how hard the selected model thinks.  Default plus the levels the
 *  model offers, a check on the one the bot has now.  A model with no levels
 *  gets no section at all. */
export function EffortSection({
  levels,
  current,
  onPick,
  className,
}: {
  levels: readonly EffortLevel[];
  /** The bot's saved effort; undefined is Default. */
  current: EffortLevel | undefined;
  onPick: (level: EffortLevel | undefined) => void;
  className?: string;
}) {
  if (!levels.length) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      data-effort-section
      className={cn("shrink-0 border-t border-hairline/40 px-3 pb-3 pt-2", className)}
    >
      <EngineGroupLabel className="px-1 pb-1.5">Effort</EngineGroupLabel>
      <div className="flex flex-wrap gap-1">
        {([undefined, ...levels] as const).map((level) => {
          const checked = current === level;
          return (
            <button
              key={level ?? "default"}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onPick(level)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]",
                checked
                  ? "border-accent/40 bg-control text-ink"
                  : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {checked && <Check size={12} className="shrink-0 text-accent" />}
              {effortLabel(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Badge for a saved model the catalog no longer offers. */
function StatusBadge({ status }: { status: SavedModelStatus }) {
  if (!status.badge) return null;
  return (
    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300">
      {status.badge}
    </span>
  );
}

/** One-click move off a retired or superseded saved model. */
export function SavedModelNotice({
  status,
  modelName,
  onSwitch,
  className,
}: {
  status: SavedModelStatus;
  modelName: string;
  onSwitch: (selection: ModelSelection) => void;
  className?: string;
}) {
  if (!status.badge) return null;
  const what =
    status.kind === "retired"
      ? `${modelName} is retired.`
      : status.kind === "superseded"
        ? `${modelName} has a newer version.`
        : `${modelName} is not in this engine's catalog.`;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-secondary", className)}>
      <StatusBadge status={status} />
      <span>{what}</span>
      {status.successor && status.successorLabel && (
        <button
          type="button"
          onClick={() => onSwitch(status.successor!)}
          className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-control/60"
        >
          {`Switch To ${status.successorLabel}`}
        </button>
      )}
    </div>
  );
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
  "mcodeAgent",
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

export function engineStatus(instance: InstanceInfo): string {
  if (instance.snapshot.quota?.capped) return "Quota Cap";
  const modelCaps = Object.values(instance.snapshot.quota?.models ?? {});
  if (modelCaps.some((row) => row.capped)) return "Partial quota";
  if (instance.snapshot.reason === "Disabled in settings") return "Disabled";
  // The last probe gave no answer: a slow Mac, not a missing CLI or a
  // sign-out.  Never "Not installed" or "Sign-in required" for it.
  if (isCheckingEngine(instance)) return "Checking";
  if (needsCli(instance)) return isCliMissing(instance) ? "Not installed" : "Unavailable";
  if (needsSignIn(instance)) return "Sign-in required";
  return instance.snapshot.version ?? "Ready";
}

/** Whether the picker shows the engine's setup card instead of its models.
 *  An engine whose probe did not answer in time is blocked too: it has no
 *  models to list yet, and EngineSetup draws its "Checking" card rather than
 *  leaving an empty pane. */
export function pickerBlocked(instance: InstanceInfo, pane: "main" | "custom"): boolean {
  if (isCheckingEngine(instance)) return true;
  return pane === "custom" ? needsCli(instance) : needsCli(instance) || needsSignIn(instance);
}

/** Whether an unusable engine's CLI is actually absent.  One that is on this
 *  Mac but cannot run bots yet (too old, missing a flag BotFleet needs, its
 *  own check failed) is unavailable, not "not installed" — the reason says
 *  what to do.  So is an engine that has no CLI at all (MiniMax,
 *  OpenAI-compatible and other API-key engines): a missing key is not a
 *  missing install. */
function isCliMissing(instance: InstanceInfo): boolean {
  if (/CLI not found/i.test(instance.snapshot.reason ?? "")) return true;
  if (instance.cliDefault === undefined && instance.cli === undefined) return false;
  return (instance.cliCandidates?.length ?? 0) === 0;
}

/** The engines the picker's rail offers.  The selected engine always stays
 *  so the picker can explain it; otherwise turned-off engines, uninstalled
 *  custom ones, and optional integrations nobody set up (the ASCII.dev Box engine with no Box
 *  token) are left out. */
export function railEngines(instances: InstanceInfo[], selectedInstanceId: string): InstanceInfo[] {
  return instances.filter((i) => {
    if (i.enabled === false) return false;
    const selected = i.instanceId === selectedInstanceId;
    if (isHiddenEngine(i) && !selected) return false;
    // A configured `cli` override counts: the registry lists only copies of
    // the default command, so an absolute override leaves candidates empty.
    const isInstalledOrSubscription =
      i.access !== "custom" || Boolean(i.cli) || (i.cliCandidates?.length ?? 0) > 0;
    if (i.snapshot.state === "unavailable" && !selected && !isInstalledOrSubscription) {
      return false;
    }
    if (i.instanceId === "kimi" && (!i.snapshot.authenticated || i.snapshot.state !== "available") && !selected) return false;
    return true;
  });
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

/** The Local Models entry's panel: every configured local model in one list,
 * grouped under the engine that runs it.  Picking a row goes through the same
 * `onPick` as any engine's own list. */
export function LocalModelsPanel({
  groups,
  selection,
  query,
  onQueryChange,
  onPick,
}: {
  groups: readonly LocalModelGroup[];
  selection: Pick<ModelSelection, "instanceId" | "model">;
  query: string;
  onQueryChange: (value: string) => void;
  onPick: (instance: InstanceInfo, modelId: string) => void;
}) {
  const total = localModelCount(groups);
  const shown = filterLocalModelGroups(groups, query);
  return (
    <>
      <div className="shrink-0 px-4 pb-2 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-[14px] font-semibold text-ink">{LOCAL_MODELS_TITLE}</div>
          <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success">
            {total} {total === 1 ? "model" : "models"}
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-secondary">
          Run this bot with a model on this computer or at an endpoint you added.
        </div>
      </div>
      {total > COMPACT_MODEL_COUNT && (
        <ModelSearch value={query} local onChange={onQueryChange} onEscape={() => onQueryChange("")} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {shown.map((group) => (
          <div key={group.instance.instanceId} role="group" aria-label={`Runs on ${group.instance.displayName}`}>
            <EngineGroupLabel className="px-2 pb-1 pt-2">Runs On {group.instance.displayName}</EngineGroupLabel>
            {group.options.map((option) => (
              <ModelRow
                key={option.id}
                option={option}
                current={selection.instanceId === group.instance.instanceId && selection.model === option.id}
                defaultId=""
                onPick={() => onPick(group.instance, option.id)}
                quota={group.instance.snapshot.quota?.models?.[option.id]}
                windowsLabel={group.instance.snapshot.quota?.windowsLabel}
              />
            ))}
          </div>
        ))}
        {shown.length === 0 && (
          <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
            Nothing matches “{query.trim()}”
          </div>
        )}
      </div>
    </>
  );
}

export function ModelPicker({
  bot,
  className,
  contained = false,
  label,
  selection: propSelection,
  onChange,
  initialOpen = false,
  initialRailId = null,
}: {
  bot: Bot;
  className?: string;
  /** Expand the menu in-flow under the trigger so it cannot overflow a
   * narrow parent (the Bot profile sidebar). */
  contained?: boolean;
  label?: ReactNode;
  selection?: ModelSelection;
  onChange?: (selection: ModelSelection) => void;
  /** Start with the menu open on this rail entry.  The picker opens from a
   * click in the app; tests have no click, so they start it open. */
  initialOpen?: boolean;
  initialRailId?: string | null;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(initialOpen);
  const [railId, setRailId] = useState<string | null>(initialRailId);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = propSelection || bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  // Every configured local model.  Empty means the rail shows no Local Models
  // entry — there is no setup row standing in for it.
  const localGroups = collectLocalModels(state.instances, selection);
  // With no rail entry chosen yet, a bot already on a local model opens on the
  // Local Models entry — an engine's own list does not show that model.
  const localView =
    localGroups.length > 0 &&
    (railId === LOCAL_MODELS_RAIL_ID || (railId === null && opensOnLocalModels(localGroups, active, selection)));
  const railInstance = localView
    ? undefined
    : state.instances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? state.instances[0];

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
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, query]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    setPane(isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const selectLocalModels = () => {
    setRailId(LOCAL_MODELS_RAIL_ID);
    setPane("main");
    resetList();
  };

  const selectRail = (instance: InstanceInfo) => {
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  /** `latest` picks a "Latest <Class>" row; a pinned pick sends `null` so
   *  the harness does not carry an older float forward onto it. */
  const pick = (instance: InstanceInfo, model: string, latest?: string) => {
    commit(pickedSelection(selection, instance, model, latest));
    setOpen(false);
  };

  function commit(nextSelection: ModelSelection) {
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
  }

  /** "Switch To …": the saved entry's replacement, keeping the chain. */
  const switchSaved = (successor: ModelSelection) => {
    const next: ModelSelection = { ...successor };
    if (selection.fallbacks?.length) next.fallbacks = selection.fallbacks;
    commit(next);
    setOpen(false);
  };

  /** Effort changes only the effort: the rest of the selection rides along, so
   *  a "Latest <Class>" bot keeps floating and its fallbacks stay.  The menu
   *  stays open so the check visibly moves.  Same save as Settings' Reasoning
   *  control (`selectionWithEffort`). */
  const pickEffort = (level: EffortLevel | undefined) => commit(selectionWithEffort(selection, level));

  // Superseded rows are hidden: within a model class only the newest member
  // is offered, beside the "Latest <Class>" rows.
  const official = offeredOptions(railInstance).filter((option) => !option.custom);
  const latest = latestRows(railInstance);
  const savedStatus = savedModelStatus(active, selection);
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(custom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  // Custom rows that are not a local host's model (a cloud provider configured
  // in Codex, an extra from Claude's settings) stay in their own engine's list.
  // The local ones are on the Local Models entry.
  const shownOtherCustom = filterCustomModels(custom.filter((option) => !isInjectedLocalModel(option)), query);
  const blocked = railInstance ? pickerBlocked(railInstance, pane) : false;
  const checking = isCheckingEngine(railInstance);

  // The chat picker's Effort section belongs to the model the bot is on, so
  // it appears only on the panel that lists that model: the bot's own engine,
  // or Local Models when the bot is on one of those.  Browsing another engine
  // never shows the current model's effort under that engine's name.  Settings
  // pickers (`contained`) have the Reasoning control beside them.
  const effortLevels = contained ? [] : selectionEffortLevels(active, selection);
  const effortApplies = localView
    ? opensOnLocalModels(localGroups, active, selection)
    : !blocked && railInstance?.instanceId === selection.instanceId;
  const effortSection =
    effortApplies && effortLevels.length > 0 ? (
      <EffortSection levels={effortLevels} current={selection.effort} onPick={pickEffort} />
    ) : null;
  const chipEffort =
    !contained && selection.effort && effortLevels.includes(selection.effort) ? selection.effort : undefined;

  const windowsLabel =
    railInstance?.snapshot.quota?.windowsLabel ??
    (railInstance?.instanceId === "antigravity" ? "5hr/Week" : undefined);

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id && !selection.latest}
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
        setRailId(null);
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
      title={
        active
          ? `${active.displayName} · ${selectionChipLabel(active, selection, { showLatest: true })} (${selection.model})${chipEffort ? ` · ${effortLabel(chipEffort)} effort` : ""}`
          : selection.model
      }
    >
      {active && <ProviderMark driverKind={activeDriverKind!} model={selection.model} size={14} />}
      <span className={cn("min-w-0 truncate", !contained && "max-w-[160px]", !contained && active && "@max-4xl/chathead:hidden")}>
        {/* The chat header names the model that actually runs; settings
            chips also say when it floats on "Latest <Class>". */}
        {selectionChipLabel(active, selection, { showLatest: contained })}
      </span>
      {savedStatus.badge && (
        <span className={cn(!contained && active && "@max-4xl/chathead:hidden")}>
          <StatusBadge status={savedStatus} />
        </span>
      )}
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
      {contained && !open && (
        <SavedModelNotice
          status={savedStatus}
          modelName={modelLabel(active, selection.model)}
          onSwitch={switchSaved}
          className="mt-1.5"
        />
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
              : "absolute right-0 top-full z-30 mt-2 w-[420px] min-w-[380px] max-w-[min(640px,calc(100vw-2rem))] max-h-[min(560px,calc(100dvh-7rem))] resize shadow-2xl shadow-black/50",
          )}
        >
          <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {(() => {
              const availableInstances = railEngines(state.instances, selection.instanceId);
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
                  {(local.length > 0 || localGroups.length > 0) && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>
                  )}
                  {localGroups.length > 0 && (
                    <button
                      type="button"
                      onClick={selectLocalModels}
                      aria-label={LOCAL_MODELS_TITLE}
                      aria-pressed={localView}
                      title={`${LOCAL_MODELS_TITLE} · ${localModelCount(localGroups)} ${localModelCount(localGroups) === 1 ? "model" : "models"}`}
                      className={cn(
                        "relative flex size-9 items-center justify-center rounded-lg",
                        localView ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60",
                      )}
                    >
                      <ProviderMark driverKind={LOCAL_MODELS_DRIVER_KIND} size={18} />
                    </button>
                  )}
                  {local.map(railButton)}
                </>
              );
            })()}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {localView ? (
              <>
                <LocalModelsPanel
                  groups={localGroups}
                  selection={selection}
                  query={query}
                  onQueryChange={setQuery}
                  onPick={pick}
                />
                {effortSection}
              </>
            ) : railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink" title={railInstance.displayName}>{railInstance.displayName}</div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                        railInstance.snapshot.quota?.capped
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : checking
                          ? "bg-inset text-ink-secondary"
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

                  {railInstance.instanceId === selection.instanceId && (
                    <SavedModelNotice
                      status={savedStatus}
                      modelName={modelLabel(active, selection.model)}
                      onSwitch={switchSaved}
                      className="mt-2"
                    />
                  )}

                  {railInstance.driverKind === "boxAgent" && (
                    <div className="mt-2 rounded bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning-dark border border-warning/20">
                      <strong>Works Alone:</strong>
                      {"  "}This bot runs its turn on box.ascii.dev, so it has no team tools, no peers to ask, no approval cards, no memory, and no skills.
                    </div>
                  )}
                </div>

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <WhyThisEngineCallout instance={railInstance} />
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                      {checking
                        ? "Models will appear as soon as the check finishes."
                        : pane === "main" && official.length > 0
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
                        }}
                      />
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      <div className="px-2">
                        <WhyThisEngineCallout instance={railInstance} />
                      </div>
                      {pane === "main" ? (
                        <>
                          {!query && (
                            <LatestModelRows
                              rows={latest}
                              currentClass={selection.instanceId === railInstance.instanceId ? selection.latest : null}
                              onPick={(row) => pick(railInstance, row.resolvedId, row.classKey)}
                            />
                          )}
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query ? `${filteredOfficial.length} results` : showAll ? `All models · ${official.length}` : "Suggested"}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && shownOtherCustom.length === 0 && (
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
                          {shownOtherCustom.length > 0 && (
                            <>
                              <EngineGroupLabel className="px-2 pb-1 pt-3">Custom</EngineGroupLabel>
                              {shownOtherCustom.map(renderRow)}
                            </>
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
                    {effortSection}
                  </>
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
