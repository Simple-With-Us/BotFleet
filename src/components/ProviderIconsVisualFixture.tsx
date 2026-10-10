// Test harness for tests/e2e/provider-icons.visual.spec.ts.
//
// Renders the changed `ProviderMark` cases through the production switch
// (see `ProviderMark` in src/components/ProviderIcons.tsx), so the snapshot
// pins the actual SVG that ships in the app rather than a leaf mark mounted
// out of context.  The marks changed in the Muse Code / MiniMax fix:
//
//   - `case "muse" | "museAgent"` in `ProviderMark` -> `MuseCodeMark`
//     (the entry used to fall through to the two-letter monogram; now the
//     Meta-loop SVG renders through the production path)
//   - `case "minimax" | "mcode" | "mcodeAgent"` in `ProviderMark` -> `MiniMaxMark`
//     (the path was unchanged; only the navy-to-blue palette was wrong, and
//     `ProviderMark` is what the engine rail calls)
//   - `EngineQuotasPanel` in the picker header (ModelPicker.tsx:851-854)
//
// Three mounted rows: a `ProviderMark` for the new muse case, one for the
// minimax case, and a labelled `EngineQuotasPanel` so the picker-header
// surface is pinned alongside them.  One monogram fallback for contrast,
// because the spec also asserts that the unchanged path still produces text.
import { ProviderMark } from "./ProviderIcons";
import { EngineQuotasPanel } from "./EngineQuotasPanel";
import type { QuotaEngineInfo } from "./EngineQuotasPanel";

const MUSECODE: QuotaEngineInfo = {
  instanceId: "muse",
  displayName: "Muse Code",
  driverKind: "museAgent",
  snapshot: {
    quota: {
      capped: false,
      windowsLabel: "5hr/week",
      models: {
        "muse-code/opus": {
          capped: false,
          remainingPercent: 93,
          secondaryRemainingPercent: 3,
          // Fixed, not relative:  the spec freezes the page clock to this
          // instant, so the rendered countdown is stable across runs.
          resetsAt: Date.parse('2026-10-10T19:00:00Z'),
          windowsLabel: "5hr/week",
        },
      },
    },
  },
};

const MINIMAX: QuotaEngineInfo = {
  instanceId: "mcode",
  displayName: "MiniMax Code",
  driverKind: "mcodeAgent",
  snapshot: {
    quota: {
      capped: false,
      windowsLabel: "hour/week",
      models: {
        "minimax/M2.7": {
          capped: false,
          remainingPercent: 71,
          secondaryRemainingPercent: 84,
          windowsLabel: "hour/week",
        },
      },
    },
  },
};

export default function ProviderIconsVisualFixture() {
  return (
    <div
      data-testid="provider-icons-board"
      className="flex flex-col gap-6 bg-inset/30 p-6"
      style={{ background: "#f4f4f5", width: 560 }}
    >
      <div data-testid="provider-icons-rail" className="flex items-center gap-4">
        <span className="flex flex-col items-center gap-1" data-testid="provider-mark-muse">
          <ProviderMark driverKind="museAgent" size={32} />
          <span className="text-[10px] text-ink-secondary">museAgent</span>
        </span>
        <span className="flex flex-col items-center gap-1" data-testid="provider-mark-mcode">
          <ProviderMark driverKind="mcodeAgent" size={32} />
          <span className="text-[10px] text-ink-secondary">mcodeAgent</span>
        </span>
        <span className="flex flex-col items-center gap-1" data-testid="provider-mark-monogram">
          <ProviderMark driverKind="totallyUnknownEngine" size={32} />
          <span className="text-[10px] text-ink-secondary">monogram fallback</span>
        </span>
      </div>

      {/* The panel collapsed is one line of text, so a snapshot of it alone
          pins almost none of what this fix actually changed.  Mounted with the
          detail panel forced open so the named windows, the bars, and the
          "nearly spent" callout are all in the image.  Only one copy: the
          panel scrolls past its own max-height, so two of them would push the
          interesting half out of frame. */}
      <div data-testid="provider-icons-quotas-panel">
        <EngineQuotasPanel engines={[MUSECODE, MINIMAX]} activeInstanceId="muse" defaultOpen />
      </div>
    </div>
  );
}