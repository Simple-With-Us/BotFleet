// Test harness for tests/e2e/model-rows.visual.spec.ts.
//
// Mounts the REAL `ModelRow` — the same component the picker builds its model
// list from — at the pane widths the owner reported the defect at.  It is a
// fixture of the component, not a copy of its markup: a replica would keep
// passing while the picker broke, which is exactly what happened when the row
// was `flex-1` beside `shrink-0` chips and every slug collapsed to a vertical
// column of characters (2026-10-11).
//
// The widths are the ones that actually occurred.  420px is the picker's own
// width (`w-[420px]`) minus the 56px engine rail; 260px is the Bot profile
// sidebar, where the owner saw "Highspeed" and "DeepSeek-V" render one letter
// per line because a packed quota chip claimed the row beside them.
//
// Every slug below is a real id from a real catalog, including the two the
// owner screenshotted, so the widths that break are the widths that will break.
import { ModelRow } from "./ModelPicker";
import { EngineQuotasPanel, type QuotaEngineInfo } from "./EngineQuotasPanel";
import type { ModelCatalog } from "../../server/contracts.ts";

type Option = ModelCatalog["options"][number];

/** The rows that failed in the field: a long hyphenated slug with a default
 *  tag and a context chip, a "Highspeed" variant beside it, and the DeepSeek
 *  row whose chips used to squeeze it to a single character of width.  The
 *  short names are here on purpose: a pane with room for them is the case
 *  where the tags belong BESIDE the slug rather than on a line of their own. */
const ROWS: Option[] = [
  {
    id: "MiniMax-M3.1-Flash",
    label: "MiniMax M3.1 Flash · thinking",
    contextWindow: 1_000_000,
    badge: "Preview",
    badgeTitle: "Preview build — expect churn.",
  },
  {
    id: "MiniMax-M2.7-Highspeed-thinking",
    label: "MiniMax M2.7 Highspeed · thinking",
    contextWindow: 204_800,
  },
  {
    id: "deepseek-v4-default",
    label: "DeepSeek-V4 Default",
    contextWindow: 1_000_000,
  },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 200_000 },
  { id: "minimax-m2.5-highspeed", label: "Highspeed", loaded: true },
  { id: "minimax-m2.5", label: "MiniMax-M2.5" },
];

const ENGINE: QuotaEngineInfo = {
  instanceId: "minimax",
  displayName: "MiniMax",
  driverKind: "minimax",
  snapshot: {
    quota: {
      capped: false,
      windowsLabel: "5hr/Week",
      models: {
        "MiniMax-M3.1-Flash": {
          capped: false,
          remainingPercent: 67,
          secondaryRemainingPercent: 96,
          resetsAt: Date.now() + 3 * 60 * 60 * 1000,
        },
      },
    },
  },
};

/** One column of the real rows, wrapped the way the picker wraps them. */
function Column({
  testid,
  width,
  defaultId,
}: {
  testid: string;
  width: number;
  defaultId: string;
}) {
  return (
    <div
      data-testid={testid}
      data-width={width}
      style={{ width }}
      className="flex flex-col rounded-2xl border border-hairline/50 bg-card px-2 py-2"
    >
      {ROWS.map((option) => (
        <ModelRow
          key={`${testid}-${option.id}-${option.label}`}
          option={option}
          current={option.id === defaultId}
          defaultId={defaultId}
          onPick={() => {}}
        />
      ))}
    </div>
  );
}

export default function ModelRowsVisualFixture() {
  return (
    <div data-testid="model-rows-board" className="flex gap-6 bg-app p-6">
      {/* The picker's own width.  Tags fit beside the slug here, so this is
          the layout that must stay compact. */}
      <Column
        testid="model-rows-wide"
        width={364}
        defaultId="MiniMax-M3.1-Flash"
      />
      {/* The sidebar width, where every slug in the field report collapsed. */}
      <Column testid="model-rows-narrow" width={260} defaultId="minimax-m2.5" />
      {/* Usage, where it now lives: above the list, once per engine. */}
      <div className="w-[300px] rounded-2xl border border-hairline/50 bg-card px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-[14px] font-semibold leading-snug break-words text-ink">
            MiniMax
          </div>
          <span className="max-w-[45%] shrink-0 truncate rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success">
            2026.09.26-dd393fe
          </span>
        </div>
        <EngineQuotasPanel engines={[ENGINE]} activeInstanceId="minimax" />
      </div>
    </div>
  );
}
