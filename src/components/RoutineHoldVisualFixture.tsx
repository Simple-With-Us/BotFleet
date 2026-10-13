// Test harness for tests/e2e/routine-hold.visual.spec.ts.
//
// Mounts the real RoutineDetails panel with a run that is QUEUED and carrying a
// holdReason — the state this change set exists for.  Before it, a queued run
// with nothing to explain it looked identical to a stuck scheduler, so the
// panel's copy and spacing need a baseline that can catch a regression.
//
// StoreProvider is not used: it hydrates from the bot server and would replace
// this fixed bot and run.  Nothing here talks to the server — the panel reads
// its run from the CalendarItem it is handed — so the spec needs no route
// mocking, unlike the computer-panel fixture.
//
// The spec pins the clock (page.clock) because the header's date is derived
// from Date.now(): without that, the year the header omits would change with
// the calendar and the baseline would expire on its own.
import { useMemo, type Dispatch } from "react";
import { RoutineDetails } from "./RoutinesPage";
import type { CalendarItem } from "@/lib/routine-calendar";
import type { Routine, RoutineRun } from "@/lib/routines";
import {
  initialState,
  StoreContext,
  type Action,
  type Bot,
} from "@/state/store";

const BOT_ID = "visual-bot";
const ROUTINE_ID = "visual-routine";

const bot: Bot = {
  id: BOT_ID,
  threadId: "visual-thread",
  name: "Atlas",
  title: "Operator",
  description: "",
  notifications: false,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "dsh", model: "deepseek-v4" },
  messages: [],
};

// Fixed instants, not `Date.now()`.  The spec sets the page clock to
// 2026-06-15T13:00:00Z, and this run came due half an hour before that — still
// queued, and inside the panel's "Last 7 Days" window so the block below reads
// as a run that has not settled rather than as an empty calendar.
const SCHEDULED_FOR = 1_781_526_600_000;

const routine: Routine = {
  id: ROUTINE_ID,
  name: "Morning Inbox Sweep",
  prompt: "Summarize anything new in the shared inbox.",
  botId: BOT_ID,
  runOn: "bot",
  enabled: true,
  schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
  durationMinutes: 10,
  nextRunAt: SCHEDULED_FOR + 86_400_000,
  createdAt: SCHEDULED_FOR - 86_400_000,
  updatedAt: SCHEDULED_FOR - 86_400_000,
};

/** A run the dispatcher refused to start, with the reason it refused. */
const heldRun: RoutineRun = {
  id: "visual-run",
  routineId: ROUTINE_ID,
  routineName: routine.name,
  botId: BOT_ID,
  runOn: "bot",
  scheduledFor: SCHEDULED_FOR,
  status: "queued",
  manual: false,
  createdAt: SCHEDULED_FOR,
  engineId: "dsh",
  model: "deepseek-v4",
  holdReason: "DeepSeek Harness could not start 3 times in a row",
};

const heldItem: CalendarItem = {
  id: "visual-item",
  at: SCHEDULED_FOR,
  routine,
  run: heldRun,
};

export default function RoutineHoldVisualFixture() {
  const value = useMemo(
    () => ({
      state: {
        ...initialState,
        bots: [bot],
        routines: [routine],
        // No finished history, so the "Last 7 Days" block reads as a run that
        // has not settled yet rather than counting rows whose times would have
        // to be pinned too.
        routineRuns: [heldRun],
        selectedId: BOT_ID,
      },
      // Nothing in this shot is clicked.  Swallowing dispatch keeps a late
      // response from moving the panel under the screenshot.
      // SAFETY: the panel dispatches nothing in this state, and a throwaway
      // dispatch is what keeps the store contract satisfied without a server.
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [],
  );

  return (
    <StoreContext.Provider value={value}>
      <RoutineDetails item={heldItem} bot={bot} onClose={() => {}} onEdit={() => {}} />
    </StoreContext.Provider>
  );
}
