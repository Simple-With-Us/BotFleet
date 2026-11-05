// Test harness for tests/e2e/sidebar-menu-hover.visual.spec.ts.
//
// Mounts the real BotContextMenu (src/components/Sidebar.tsx) rather than a
// copy of its rows, so the spec measures the shipped hover fill.  A copy would
// let the real menu regress while the fixture kept passing.
//
// The bot is seeded as a Chief of Staff, which is the state in the report that
// prompted this: the menu then shows "Remove Chief of Staff" and Archive is
// disabled with the "Choose another Chief of Staff first" hint.
//
// StoreProvider is not used: it hydrates from the bot server and can replace
// the seeded bot (the same reason BotOffVisualFixture avoids it).  The store
// value is fixed here and nothing talks to a server.
import { useMemo, type Dispatch } from "react";
import { initialState, StoreContext, type Action, type Bot } from "@/state/store";
import { BotContextMenu } from "./Sidebar";

const director: Bot = {
  id: "bot-menu-fixture",
  threadId: "thread-menu-fixture",
  name: "Director",
  title: "Keeps the fleet pointed at the roadmap",
  description: "Fixture bot for the sidebar context menu.",
  notifications: false,
  color: "green",
  unread: false,
  chiefOfStaff: true,
  modelSelection: { instanceId: "fixture-instance", model: "fixture-model" },
  messages: [],
  createdAt: 1_781_526_600_000,
};

const noop = () => {};

export default function SidebarMenuVisualFixture() {
  const value = useMemo(
    () => ({
      state: { ...initialState, bots: [director], selectedId: director.id },
      // SAFETY: the spec only hovers; a throwaway dispatch keeps the store
      // contract satisfied without a server.
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [],
  );

  return (
    <StoreContext.Provider value={value}>
      <div data-testid="menu-board" className="min-h-screen bg-app p-6">
        <BotContextMenu
          menu={{ botId: director.id, x: 24, y: 24 }}
          onClose={noop}
          onArchive={noop}
          onMoveToSection={noop}
          onMergeAll={noop}
        />
      </div>
    </StoreContext.Provider>
  );
}
