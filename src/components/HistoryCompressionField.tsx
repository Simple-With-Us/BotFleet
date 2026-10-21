// The History Compression controls, on their own.
//
// Split out of SettingsPanel.tsx so it can be rendered in a test without
// mounting the store, the way MaxToolRoundsField is.  It takes its whole
// decision — visible, editable, and the line of copy — as a
// `HistorySummaryGate` prop, so nothing here re-derives whether this engine
// honors the settings.  That derivation lives in `@/lib/bot-settings-gates`
// and is tested there.
//
// The values are NOT hidden when the engine in force ignores them: the card
// renders read-only, with the reason, so settings saved while the bot was on
// an engine that budgets its prompt can still be seen and cleared.
import { cn } from "@/lib/cn";
import { MAX_HISTORY_TURNS } from "../../shared/bot-profile";
import type { HistorySummaryGate } from "@/lib/bot-settings-gates";

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

export function HistoryCompressionField({
  maxHistoryTurns,
  historySummaryModel,
  onMaxHistoryTurns,
  onHistorySummaryModel,
  gate,
}: {
  maxHistoryTurns: number | null | undefined;
  historySummaryModel: boolean | undefined;
  onMaxHistoryTurns: (next: number | null) => void;
  onHistorySummaryModel: (next: boolean) => void;
  gate: HistorySummaryGate;
}) {
  const shown = maxHistoryTurns == null ? "" : String(maxHistoryTurns);
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">History Compression</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{gate.caption}</div>
      {gate.note && <div className="mt-2 text-[12.5px] text-ink-secondary">{gate.note}</div>}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={String(MAX_HISTORY_TURNS).length}
        aria-label="Maximum History Turns"
        placeholder="All"
        value={shown}
        disabled={!gate.editable}
        onChange={(event) => {
          const raw = event.target.value.trim();
          // A controlled input React will not re-render (nothing changed), so
          // an unaccepted keystroke has to be undone by hand.
          const revert = () => {
            event.target.value = shown;
          };
          if (raw === "") {
            if (maxHistoryTurns != null) onMaxHistoryTurns(null);
            else revert();
            return;
          }
          if (!/^\d+$/.test(raw)) {
            revert();
            return;
          }
          const next = Number(raw);
          // 0 is a real value: keep no replayed turns.
          if (next < 0 || next > MAX_HISTORY_TURNS) {
            revert();
            return;
          }
          if (next === maxHistoryTurns) {
            revert();
            return;
          }
          onMaxHistoryTurns(next);
        }}
        className={cn(inputCls, "mt-3 w-28 tabular-nums", !gate.editable && "opacity-60")}
      />
      <label className={cn("mt-4 flex items-start gap-2.5", !gate.editable && "opacity-60")}>
        <input
          type="checkbox"
          aria-label="Model-Written Summary"
          checked={historySummaryModel === true}
          disabled={!gate.editable}
          onChange={(event) => onHistorySummaryModel(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="text-[13px] font-medium text-ink">Model-Written Summary</span>
          <span className="mt-0.5 block text-[12.5px] text-ink-secondary">
            When older turns are dropped, the bot's model writes a short brief of them instead of one excerpt line
            each.{"\u00A0 "}The summary is cached and rolls forward as more turns drop, and falls back to excerpts if the
            model cannot write one.
          </span>
        </span>
      </label>
    </div>
  );
}
