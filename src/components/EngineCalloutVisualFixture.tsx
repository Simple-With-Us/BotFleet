// Test harness for tests/e2e/engine-callout.visual.spec.ts.
//
// Mounts the real Why This Engine block in the two shapes it can take, side
// by side.  The block grew a provider-mark row, and both shapes are load
// bearing:  Clutch is the only engine that lists brands (it hosts DeepSeek and
// MiniMax models, which the single "Clutch" name says nothing about), while
// every other engine lists none and its label and headline must sit in normal
// inline flow.  A layout that reads well with marks present can easily push a
// 6px flex gap into the space between "Why This Engine?" and the headline when
// there are none, so both are pinned.
import { EngineCalloutBody } from "@/lib/engine-capabilities";

const CLUTCH = "deepseek-harness";
const MINIMAX = "mcode";

export default function EngineCalloutVisualFixture() {
  return (
    <div
      data-testid="engine-callout-board"
      className="flex flex-col gap-4 bg-inset/30 p-6"
      style={{ background: "#f4f4f5", width: 560 }}
    >
      {/* Two brands:  marks lead, then the label and headline as one inline
          run.  Asserted by the `clutch-callout` testid below. */}
      <div data-testid="clutch-callout">
        <EngineCalloutBody
          entry={{
            id: CLUTCH,
            displayName: "Clutch",
            capabilityBadgeColor: "bg-rose-600 text-white",
            providerKinds: ["deepseekAgent", "minimax"],
            group: "Cloud",
            pricing: { kind: "unknown" },
            capabilities: {},
            whyThisEngine: {
              headline: "DeepSeek models over the Clutch ACP bridge, billed pay-as-you-go.",
              prose: ["Clutch runs DeepSeek models through BotFleet's Clutch ACP bridge."],
            },
            defaultModels: [],
          }}
        />
      </div>

      {/* No brands:  the same block with no mark row at all.  The label and
          headline must still read as one sentence. */}
      <div data-testid="single-brand-callout">
        <EngineCalloutBody
          entry={{
            id: MINIMAX,
            displayName: "MiniMax Code",
            capabilityBadgeColor: "bg-violet-500 text-white",
            group: "Cloud",
            pricing: { kind: "unknown" },
            capabilities: {},
            whyThisEngine: {
              headline: "MiniMax's own coding CLI, driven over the same Token Plan.",
              prose: ["MiniMax Code runs MiniMax's coding CLI inside BotFleet."],
            },
            defaultModels: [],
          }}
        />
      </div>
    </div>
  );
}
