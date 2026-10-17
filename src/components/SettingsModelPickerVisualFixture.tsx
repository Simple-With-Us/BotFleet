// Test harness for tests/e2e/settings-model-picker.visual.spec.ts.
//
// Mounts the REAL `ModelPicker` in its contained (Settings) form, inside the
// card the Settings panel actually renders it in.  This is the shape the owner
// screenshotted (2026-10-15): "Primary Model" shared a line with the dropdown,
// so the label wrapped onto two lines and its subtitle broke into a five-word
// ribbon at every desktop width.
//
// The label and the surrounding card are copied from `SettingsPanel.tsx`, not
// re-invented here, so a change to that panel's copy or padding shows up in the
// geometry the spec reads.  The spec measures rendered boxes rather than
// trusting a class name, so it keeps holding if the stack is rebuilt another
// way.
import { useMemo, type Dispatch } from "react";
import { ModelPicker } from "./ModelPicker";
import { initialState, StoreContext, type Action, type Bot, type InstanceInfo } from "@/state/store";

const BOT_ID = "visual-bot";

const bot: Bot = {
  id: BOT_ID,
  threadId: "visual-thread",
  name: "Atlas",
  title: "Operator",
  description: "",
  notifications: false,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "sonnet" },
  messages: [],
};

/** One engine with a quota, so the trigger carries the chip the owner saw
 *  squeezed beside the label rather than a bare name. */
const CLAUDE: InstanceInfo = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available" },
  capabilities: { effortLevels: [] },
  models: {
    default: "sonnet",
    options: [{ id: "sonnet", label: "Claude Sonnet" }],
  },
};

export default function SettingsModelPickerVisualFixture() {
  const value = useMemo(
    () => ({
      state: {
        ...initialState,
        bots: [bot],
        instances: [CLAUDE],
        selectedId: BOT_ID,
      },
      // Nothing in this fixture is clicked; swallowing dispatch keeps a late
      // store response from moving the layout under the spec.
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [],
  );

  const wide = new URLSearchParams(window.location.search).has("wide");
  return (
    <StoreContext.Provider value={value}>
      {/* The Settings panel is narrower than the window, which is why this
          width is pinned rather than left to the viewport. */}
      <div data-testid="settings-model-picker-panel" className={wide ? "ml-auto w-[220px] overflow-hidden bg-app p-4" : "w-[380px] bg-app p-4"}>
        <div data-testid="settings-model-picker-card" className="rounded-xl bg-card p-4 flex flex-col gap-4">
          <ModelPicker
            bot={bot}
            contained
            widePopover={wide}
            label={<div className="text-[15px] font-medium text-ink">Primary Model</div>}
          />
        </div>
      </div>
    </StoreContext.Provider>
  );
}