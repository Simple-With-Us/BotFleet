// The Maximum Tool Rounds control, on its own.
//
// Split out of SettingsPanel.tsx so it can be rendered in a test without
// mounting the store, the way SidebarThreadRow.tsx splits the pieces Sidebar
// delegates to.  It takes its whole decision — visible, editable, and the line
// of copy — as a `ToolRoundsGate` prop, so nothing here re-derives whether this
// engine honors the setting.  That derivation lives in
// `@/lib/bot-settings-gates` and is tested there.
//
// The value is NOT hidden when the engine in force ignores it: it renders
// read-only, with the reason, so a ceiling saved while the bot was on a
// tool-loop engine can still be seen and cleared.
import { cn } from "@/lib/cn";
import { DEFAULT_MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS } from "../../shared/bot-profile";
import type { ToolRoundsGate } from "@/lib/bot-settings-gates";

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

export function MaxToolRoundsField({
  value,
  onChange,
  gate,
}: {
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  gate: ToolRoundsGate;
}) {
  const shown = value == null ? "" : String(value);
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Maximum Tool Rounds</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{gate.caption}</div>
      {gate.note && <div className="mt-2 text-[12.5px] text-ink-secondary">{gate.note}</div>}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={String(MAX_TOOL_ROUNDS).length}
        aria-label="Maximum Tool Rounds"
        placeholder={String(DEFAULT_MAX_TOOL_ROUNDS)}
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
            if (value != null) onChange(null);
            else revert();
            return;
          }
          if (!/^\d+$/.test(raw)) {
            revert();
            return;
          }
          const next = Number(raw);
          if (next < 1 || next > MAX_TOOL_ROUNDS) {
            revert();
            return;
          }
          if (next === value) {
            revert();
            return;
          }
          onChange(next);
        }}
        className={cn(inputCls, "mt-3 w-28 tabular-nums", !gate.editable && "opacity-60")}
      />
    </div>
  );
}
