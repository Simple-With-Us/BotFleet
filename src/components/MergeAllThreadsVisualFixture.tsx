// Test harness for tests/e2e/merge-all-threads.visual.spec.ts.
//
// Mounts the real Merge All Threads dialog inside a StoreContext.Provider so
// the picker, the oldest-conversation default and the destination summary get
// screenshot coverage.  Three conversations stand in for the shape the owner
// hits in the field: one long history, one recent, one from today.
//
// The store's dispatch is a noop.  The dialog only calls it when a person
// presses Merge, and the spec never does — it picks a destination and reads
// the summary line.
//
// URL params read at mount:  none; the shape is fixed so the screenshot is
// stable.
import { useMemo, type Dispatch } from "react";
import { StoreContext, initialState, type Action, type AppState, type Bot } from "@/state/store";
import { MergeAllThreadsDialog } from "./MergeAllThreadsDialog";

const noopDispatch: Dispatch<Action> = () => {};

// Fixed instants so the rendered clock does not move between runs.  The spec
// pins the timezone to UTC, so these read as fixed times of day.
const HISTORY = Date.UTC(2026, 9, 12, 9, 15);
const RECENT = Date.UTC(2026, 9, 21, 16, 42);
const TODAY = Date.UTC(2026, 9, 24, 11, 5);

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
    { threadId: "thread-today", title: "Usage Monitor heartbeat", createdAt: TODAY, messageCount: 18 },
  ],
};

export default function MergeAllThreadsVisualFixture() {
  const value = useMemo(() => {
    const state: AppState = { ...initialState };
    return {
      state,
      dispatch: noopDispatch,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, []);
  return (
    <StoreContext.Provider value={value}>
      <div data-testid="merge-all-threads-fixture" className="bg-app min-h-[600px]">
        <MergeAllThreadsDialog bot={BOT} onClose={() => {}} />
      </div>
    </StoreContext.Provider>
  );
}
