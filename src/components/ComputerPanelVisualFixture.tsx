// Test harness for tests/e2e/computer-panel.visual.spec.ts.
//
// Mounts the real ComputerPanel. StoreProvider is not used: it hydrates from
// the bot server and would replace this fixed bot. The spec fulfills
// GET /api/bots/visual-bot/computer because that route is the bot server,
// which this lane does not run.
//
// warning=unconfigured: computers is cloud + VPS, status.configured is false,
// so the "Configure the VPS SSH alias" card renders.
// warning=vps-incompatible: cloud computer selected, managed VPS container
// image is stale, so the replacement error and button render.
// Any other value: computers is unset and cloudBackend is vps, so the
// "Start VPS automatically" sentence and the Off-computer schedule warning
// both render. An empty computers array hides that auto-start row.
import { useMemo, type Dispatch } from "react";
import { ComputerPanel } from "./ComputerPanel";
import {
  initialState,
  StoreContext,
  type Action,
  type Bot,
  type InstanceInfo,
} from "@/state/store";

const BOT_ID = "visual-bot";

const claude: InstanceInfo = {
  instanceId: "claude",
  driverKind: "claude",
  displayName: "Claude",
  snapshot: { state: "available" },
  models: { default: "claude-sonnet", options: [] },
  capabilities: { computerMcp: true },
};

function visualBot(mode: "default" | "unconfigured" | "vps-incompatible"): Bot {
  return {
    id: BOT_ID,
    threadId: "visual-thread",
    name: "Atlas",
    title: "Operator",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet" },
    // Unset computers is the Auto/Off state that shows the auto-start sentence.
    // ["cloud"] is what lets the panel ask for VPS status and reach
    // vps-unconfigured. [] would skip that fetch and also hide the sentence.
    ...(mode === "unconfigured" || mode === "vps-incompatible" ? { computers: ["cloud" as const] } : {}),
    cloudBackend: "vps",
    autoStartVps: mode === "vps-incompatible",
    messages: [],
  };
}

export default function ComputerPanelVisualFixture() {
  const value = useMemo(() => {
    const warning = new URLSearchParams(window.location.search).get("warning");
    const mode =
      warning === "unconfigured" ? "unconfigured"
        : warning === "vps-incompatible" ? "vps-incompatible"
          : "default";
    const bot = visualBot(mode);
    return {
      state: {
        ...initialState,
        bots: [bot],
        instances: [claude],
        selectedId: BOT_ID,
        computerControl: { [BOT_ID]: { held: false, helpReason: null } },
      },
      // Clicks are not part of this shot. Swallowing dispatch keeps a late
      // control-status response from moving the panel under the screenshot.
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);
  const bot = value.state.bots[0]!;

  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="computer-panel-board"
        style={{ height: 960, width: 440, position: "relative", background: "#f4f4f5" }}
      >
        <ComputerPanel bot={bot} />
      </div>
    </StoreContext.Provider>
  );
}
