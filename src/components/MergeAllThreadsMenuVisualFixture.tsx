// Test harness for the bot context menu's "Merge All Threads…" action.
//
// The action is the only way a person reaches the merge picker, so the
// menu entry itself is worth a screenshot: a label that moved, lost its
// icon or changed state would ship unnoticed otherwise.
//
// The store's dispatch is a noop.  The spec reads the menu; it never
// presses the item.
//
// URL params read at mount:  none; the shape is fixed so the screenshot is
// stable.
import { useMemo, type Dispatch } from "react";
import { StoreContext, initialState, type Action, type AppState, type Bot } from "@/state/store";
import { BotContextMenu } from "./Sidebar";

// Fixed instants so the rendered clock does not move between runs.  The
// spec pins the timezone to UTC, so these read as fixed times of day.
const HISTORY = Date.UTC(2026, 9, 12, 9, 15);
const RECENT = Date.UTC(2026, 9, 21, 16, 42);

const noopDispatch: Dispatch<Action> = () => {};

const BOT: Bot = {
  id: "bot-juniper",
  threadId: "thread-history",
  name: "Juniper",
  title: "Juniper",
  description: "A bot with a long history and some recent work.",
  notifications: false,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet" },
  messages: [],
  tasks: [
    { threadId: "thread-history", title: "Fleet coordination", createdAt: HISTORY, messageCount: 4_211 },
    { threadId: "thread-recent", title: "Release pipeline", createdAt: RECENT, messageCount: 312 },
  ],
};

export default function MergeAllThreadsMenuVisualFixture() {
  const value = useMemo(() => {
    const state: AppState = { ...initialState, bots: [BOT] };
    return {
      state,
      dispatch: noopDispatch,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);
  return (
    <StoreContext.Provider value={value}>
      <div data-testid="merge-all-threads-menu-fixture" className="bg-app min-h-[600px]">
        <BotContextMenu
          menu={{ botId: BOT.id, x: 40, y: 40 }}
          onClose={() => {}}
          onArchive={() => {}}
          onMoveToSection={() => {}}
          onMergeAll={() => {}}
        />
      </div>
    </StoreContext.Provider>
  );
}
