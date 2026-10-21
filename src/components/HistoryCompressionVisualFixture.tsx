// Test harness for tests/e2e/history-compression.visual.spec.ts.
//
// Pins the History Compression controls in their editable and read-only
// states.  ?state=editable|readonly (default editable).  The card is the
// same module SettingsPanel renders, with the gate passed in directly.
import { z } from "zod";
import { historyTurnsCaption } from "../../shared/bot-profile";
import type { HistorySummaryGate } from "@/lib/bot-settings-gates";
import { HistoryCompressionField } from "./HistoryCompressionField";

/** The fixture's ?state= contract: the runtime schema and its derived type
 *  are the single source of truth for what the harness accepts. */
export const stateSchema = z.enum(["editable", "readonly"]).catch("editable");
export type HistoryCompressionFixtureState = z.infer<typeof stateSchema>;

const noop = () => {};

const editableGate: HistorySummaryGate = {
  visible: true,
  editable: true,
  caption: historyTurnsCaption(),
  note: null,
};

const readonlyGate: HistorySummaryGate = {
  visible: true,
  editable: false,
  caption: historyTurnsCaption(),
  note: "MiniMax keeps its own history, so these settings do not apply to it.  They apply again if a turn lands on an engine that budgets its prompt. Clear them to stop carrying them.",
};

export default function HistoryCompressionVisualFixture() {
  const state: HistoryCompressionFixtureState = stateSchema.parse(new URLSearchParams(window.location.search).get("state"));
  const gate = state === "readonly" ? readonlyGate : editableGate;
  return (
    <div
      data-testid="history-compression-fixture"
      data-fixture-state={state}
      className="min-h-screen bg-app p-6 text-ink"
    >
      <div data-testid="history-compression-card" className="w-[520px]">
        <HistoryCompressionField
          maxHistoryTurns={state === "readonly" ? 50 : 10}
          historySummaryModel={state === "readonly" ? undefined : true}
          onMaxHistoryTurns={noop}
          onHistorySummaryModel={noop}
          gate={gate}
        />
      </div>
    </div>
  );
}
