// Test harness for tests/e2e/conversation-mode-row.visual.spec.ts.
//
// Mounts the real ConversationModeRow inside a StoreContext.Provider so the
// Projects-subtitle interpolation (the lowercase singular room word the
// owner reads on Settings → Workspace Arrangement) gets screenshot coverage.
// Two pinned room labels cover the two shapes the owner can hit in the
// field: channels (the default) and rooms (a non-default preset).  The
// merge panel is driven by clicking Simple in the spec — the
// pending-simple useState is local so the noop dispatch does not need to
// do anything for it.
//
// URL params read at mount:  ?room=channel|room
// (default "channel" — the workspace default).
import { useMemo, type Dispatch } from "react";
import { z } from "zod";
import { StoreContext, initialState, type Action, type AppState } from "@/state/store";
import type { RoomLabels } from "../../shared/terminology";
import { ConversationModeRow } from "./SettingsModal";

const noopDispatch: Dispatch<Action> = () => {};

// catch, not default:  an empty or unknown ?room= falls back to channel too.
const roomSchema = z.enum(["channel", "room"]).catch("channel");

const ROOM_LABELS = {
  channel: { singular: "Channel", plural: "Channels" },
  room: { singular: "Room", plural: "Rooms" },
} satisfies Record<"channel" | "room", RoomLabels>;

export default function ConversationModeRowVisualFixture() {
  const room = roomSchema.parse(new URLSearchParams(window.location.search).get("room"));
  // Typed as AppState so conversationMode keeps the literal "projects"
  // instead of widening to string.
  const value = useMemo(() => {
    const state: AppState = {
      ...initialState,
      config: {
        ...initialState.config!,
        conversationMode: "projects",
        roomLabels: ROOM_LABELS[room],
      },
    };
    return {
      state,
      dispatch: noopDispatch,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    };
  }, [room]);
  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="conversation-mode-row-fixture"
        data-fixture-room={room}
        className="bg-app p-6 text-ink"
        style={{ width: 520 }}
      >
        <ConversationModeRow />
      </div>
    </StoreContext.Provider>
  );
}
