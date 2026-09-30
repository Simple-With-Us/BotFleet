// Every bot's model choices on one screen.
//
// Each bot's own profile can already change its models, but one at a time
// and behind a click, which makes the only question that matters hard to
// answer: what is everything else set to?  Choosing where a bot should run
// is a comparison — you want two on the expensive model and the rest
// somewhere cheaper, or you want to move a whole tier off a provider that
// is rate-limiting you.  This is that comparison, and it edits in place.
//
// Above the per-bot list sits an Apply to All Bots block with the same
// Primary plus fallback pickers.  Set All Bots To Default applies those values
// in one call; nothing is stored as a default afterward.  Each picker owns one
// fixed place (Primary, Fallback 1, 2, 3) and is sent by that place.  An empty
// picker is a deliberate "leave this model alone" — important because users
// frequently want to standardize the primary without flattening their
// hand-curated fallback chain.  A chosen fallback always lands in its own
// place, so a bot that would be left with an empty place before it is skipped
// whole and named under the button, with the empty place in its reason.
//
// Every bot row draws every fallback the bot actually stores, even past the
// cap, so a chain written through the API is never hidden from the page that
// edits it.
//
// Pills wrap instead of sharing a four-column grid, so Primary, fallbacks,
// and Add Fallback never overlap when names are long.
import { useState } from "react";
import { Plus, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus, type ModelSelection } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  applyDefaultsBody,
  emptyFallbackSlots,
  hasDefaults,
  slotFromPick,
  withSlot,
  type DefaultModelSlot,
} from "@/lib/default-model-slots";
import { canAddFallback, fallbackSlotCount } from "../../shared/model-limits";
import { BotAvatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";

/** Shared width so Primary, fallbacks, and Add Fallback wrap as siblings. */
const CHIP = "flex min-w-[16rem] max-w-full flex-[1_1_16rem] flex-col gap-1";

function pickEmptyBot(bots: Bot[]): Bot | null {
  return bots.find((bot) => !bot.hidden) ?? null;
}

function ChipLabel({ children }: { children: string }) {
  return <div className="text-[12px] font-medium text-ink-secondary">{children}</div>;
}

/** One default slot: a Set Default pill, or a picker with a clear control.
 * Tapping Set Default seeds from the stand-in bot so the picker opens on a
 * real model instead of an empty control, floating when that bot floats. */
function DefaultSlot({
  bot,
  value,
  label,
  onChange,
  onClear,
}: {
  bot: Bot;
  value: DefaultModelSlot;
  label: string;
  onChange: (next: ModelSelection) => void;
  onClear: () => void;
}) {
  return (
    <div className={CHIP}>
      <ChipLabel>{label}</ChipLabel>
      {!value ? (
        <button
          type="button"
          onClick={() => onChange(slotFromPick(bot.modelSelection))}
          className="flex w-full items-center justify-center gap-1.5 rounded-full border border-dashed border-hairline/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:border-hairline hover:text-ink"
        >
          <Plus size={13} />
          Set Default
        </button>
      ) : (
        <div className="flex min-w-0 items-start gap-1">
          <div className="min-w-0 flex-1">
            <ModelPicker
              bot={bot}
              contained
              selection={value}
              onChange={onChange}
            />
          </div>
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
            className="mt-1 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised/70 hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function DefaultModelBlock() {
  const { state, dispatch } = useStore();
  // One slot per fixed place: Primary, then Fallback 1..N by index.  A slot
  // is a real selection to write, or null for "leave this place alone".
  const [primary, setPrimary] = useState<DefaultModelSlot>(null);
  const [fallbacks, setFallbacks] = useState<DefaultModelSlot[]>(emptyFallbackSlots);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  // The ModelPicker needs a `bot` to drive its instance list and quota
  // display.  The default is independent of any one bot, so we use the
  // first non-hidden bot as a stand-in for the engine catalog.  The
  // picker's callbacks are still the only state we keep.
  const standIn = pickEmptyBot(state.bots);
  const noneFilled = !hasDefaults(primary, fallbacks);

  const apply = () => {
    if (!standIn) {
      setError("Add a bot first so BotFleet has a model to pick from.");
      return;
    }
    setApplying(true);
    setError(null);
    setSkipped([]);
    api("/api/bots/apply-model-defaults", {
      method: "POST",
      body: JSON.stringify(applyDefaultsBody(primary, fallbacks)),
    })
      .then((response: { applied: number; skipped?: { name: string; reason: string }[]; config?: ConfigStatus }) => {
        if (response.config) dispatch({ type: "configStatus", config: response.config });
        // A bot that was mid-turn keeps its model — swapping an engine out
        // from under a running turn is what the per-bot picker refuses with a
        // 409, and a fleet-wide apply has no business doing it quietly.  Each
        // reason is printed as the server gave it: not every refusal is
        // "busy", and telling someone to stop a turn that is not running
        // sends them looking for something that does not exist.
        setSkipped(response.skipped ?? []);
        // Clear the form on success: the next operator action should
        // start from a clean "no default set" state.
        setPrimary(null);
        setFallbacks(emptyFallbackSlots());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setApplying(false));
  };

  if (!standIn) {
    return (
      <div className="rounded-xl border border-hairline/40 bg-card px-3 py-3 text-[13px] text-ink-secondary">
        Add a bot first to apply models to every bot.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-hairline/40 bg-card px-3 py-3">
      <div className="text-[14px] font-medium text-ink">Apply to All Bots</div>
      <div className="mt-1 text-[12px] text-ink-secondary">
        Choose models and apply them to every bot at once.{"\u00A0 "}This is not a saved default:
        each bot keeps its own list afterward.
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <DefaultSlot
          bot={standIn}
          label="Primary"
          value={primary}
          onChange={(selection) => setPrimary(slotFromPick(selection))}
          onClear={() => setPrimary(null)}
        />
        {fallbacks.map((slot, index) => (
          <DefaultSlot
            key={index}
            bot={standIn}
            label={`Fallback ${index + 1}`}
            value={slot}
            onChange={(selection) =>
              setFallbacks((current) => withSlot(current, index, slotFromPick(selection)))
            }
            onClear={() => setFallbacks((current) => withSlot(current, index, null))}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={applying || noneFilled}
          onClick={() => void apply()}
          title={
            noneFilled
              ? "Pick at least one model to apply."
              : "Apply these defaults to every bot.  Empty fields keep each bot's current model."
          }
          className={cn(
            "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110",
            (applying || noneFilled) && "opacity-50",
          )}
        >
          {applying ? "Applying…" : "Set All Bots To Default"}
        </button>
        <span className="text-[11.5px] text-ink-secondary">
          Empty fields keep each bot's current model.{"\u00A0 "}Fallbacks fill in order: a bot
          that would be left with an empty place before a chosen fallback is skipped and named
          below.
        </span>
      </div>
      {skipped.length > 0 && (
        <div className="mt-2 text-[11.5px] text-ink-secondary">
          Still on their own model:{" "}
          {skipped.map((bot) => `${bot.name} (${bot.reason})`).join(", ")}.
        </div>
      )}
      {error && <div className="mt-2 text-[11.5px] text-danger">{error}</div>}
    </div>
  );
}

function BotModelRow({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const fallbacks = bot.modelSelection.fallbacks ?? [];

  const save = (selection: ModelSelection) =>
    dispatch({ type: "setModel", botId: bot.id, selection });

  // The picker emits instance + model only.  Keep this bot's fallbacks
  // (and any effort the picker preserved) so changing Primary does not
  // wipe the rest of the chain.
  const savePrimary = (selection: ModelSelection) =>
    save({ ...selection, fallbacks: bot.modelSelection.fallbacks });

  const setFallback = (index: number, selection: ModelSelection) => {
    const next = [...fallbacks];
    next[index] = selection;
    save({ ...bot.modelSelection, fallbacks: next });
  };

  const removeFallback = (index: number) => {
    const next = fallbacks.filter((_, i) => i !== index);
    save({ ...bot.modelSelection, fallbacks: next });
  };

  const addFallback = () =>
    save({
      ...bot.modelSelection,
      // Seeded from the primary, because the picker opens on something
      // real rather than on an empty control.
      fallbacks: [
        ...fallbacks,
        { instanceId: bot.modelSelection.instanceId, model: bot.modelSelection.model },
      ],
    });

  return (
    <div className="flex flex-col gap-3 border-t border-hairline/40 py-3 first:border-t-0 sm:flex-row sm:items-start">
      <div className="flex min-w-0 shrink-0 items-center gap-2 sm:w-44">
        <BotAvatar bot={bot} size={28} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink" title={bot.name}>{bot.name}</div>
          {bot.title && (
            <div className="truncate text-[12px] text-ink-secondary" title={bot.title}>{bot.title}</div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
        <div className={CHIP}>
          <ChipLabel>Primary</ChipLabel>
          <ModelPicker bot={bot} contained selection={bot.modelSelection} onChange={savePrimary} />
        </div>

        {/* Never fewer places than the bot stores: a chain longer than the cap
            (written through the API) still shows every entry and can still be
            trimmed from here. */}
        {Array.from({ length: fallbackSlotCount(fallbacks.length) }, (_, index) => {
          const fallback = fallbacks[index];
          if (!fallback) {
            // Only the next empty place offers to fill itself, so the row does
            // not sprout identical buttons — and only while the chain is
            // under the cap.
            const isNext = index === fallbacks.length && canAddFallback(fallbacks.length);
            if (!isNext) return null;
            return (
              <div key={index} className={CHIP}>
                <ChipLabel>{`Fallback ${index + 1}`}</ChipLabel>
                <button
                  type="button"
                  onClick={addFallback}
                  className="flex w-full items-center justify-center gap-1.5 rounded-full border border-dashed border-hairline/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:border-hairline hover:text-ink"
                >
                  <Plus size={13} />
                  Add Fallback
                </button>
              </div>
            );
          }
          return (
            <div key={index} className={CHIP}>
              <ChipLabel>{`Fallback ${index + 1}`}</ChipLabel>
              <div className="flex min-w-0 items-start gap-1">
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    bot={bot}
                    contained
                    selection={fallback}
                    onChange={(selection) => setFallback(index, selection)}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeFallback(index)}
                  aria-label={`Remove Fallback ${index + 1} from ${bot.name}`}
                  title={`Remove Fallback ${index + 1}`}
                  className="mt-1 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised/70 hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FleetModelsSection() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const bots = state.bots
    .filter((bot) => !bot.hidden)
    .filter(
      (bot) =>
        !needle ||
        bot.name.toLowerCase().includes(needle) ||
        (bot.title ?? "").toLowerCase().includes(needle) ||
        bot.modelSelection.model.toLowerCase().includes(needle) ||
        (bot.modelSelection.fallbacks ?? []).some((fallback) =>
          fallback.model.toLowerCase().includes(needle),
        ),
    );

  // How many bots sit on each model, so the shape of the fleet is legible
  // without reading every row.
  const perInstance = new Map<string, number>();
  for (const bot of state.bots.filter((b) => !b.hidden)) {
    const id = bot.modelSelection.instanceId;
    perInstance.set(id, (perInstance.get(id) ?? 0) + 1);
  }
  const spread = [...perInstance.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Models</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Every bot's primary model and its fallbacks, together.{"\u00A0 "}A turn that fails
          because a model is out of capacity moves down this list, so the fallbacks matter most
          when a provider is having a bad day.
        </p>
      </div>

      {spread.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {spread.map(([instanceId, count]) => {
            const instance = state.instances.find((entry) => entry.instanceId === instanceId);
            return (
              <span
                key={instanceId}
                className="rounded-full border border-hairline/50 bg-inset px-2.5 py-1 text-[12px] text-ink-secondary"
              >
                {instance?.displayName ?? instanceId} · {count}
              </span>
            );
          })}
        </div>
      )}

      <DefaultModelBlock />

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by bot or model"
        aria-label="Filter Bots by Name or Model"
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
      />

      <div className="rounded-xl border border-hairline/40 bg-card px-3 py-1">
        {bots.length === 0 ? (
          <div className={cn("px-1 py-6 text-center text-[13px] text-ink-secondary")}>
            {needle ? `Nothing matches “${query}”` : "No bots yet"}
          </div>
        ) : (
          bots.map((bot) => <BotModelRow key={bot.id} bot={bot} />)
        )}
      </div>
    </div>
  );
}
