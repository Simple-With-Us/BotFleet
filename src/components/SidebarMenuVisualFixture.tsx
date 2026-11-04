// Test harness for tests/e2e/sidebar-menu-hover.visual.spec.ts.
//
// Mounts the real BotContextMenu (src/components/Sidebar.tsx) rather than a
// copy of its rows, so the spec measures the shipped hover fill.  A copy would
// let the real menu regress while the fixture kept passing.
//
// The bot is seeded as a Chief of Staff, which is the state in the report that
// prompted this: the menu then shows "Remove Chief of Staff" and Archive is
// disabled with the "Choose another Chief of Staff first" hint.
import { useEffect } from "react";
import { StoreProvider, useStore, type Bot } from "@/state/store";
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
} as Bot;

function Menu() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "hydrate", bots: [director], groups: [], computerControl: {} });
  }, [dispatch]);

  if (!state.bots.some((bot) => bot.id === director.id)) {
    return <div data-testid="menu-board">Loading menu…</div>;
  }

  return (
    <div data-testid="menu-board" className="min-h-screen bg-app p-6">
      <BotContextMenu
        menu={{ botId: director.id, x: 24, y: 24 }}
        onClose={() => {}}
        onArchive={() => {}}
        onMoveToSection={() => {}}
        onMergeAll={() => {}}
      />
    </div>
  );
}

export default function SidebarMenuVisualFixture() {
  return (
    <StoreProvider>
      <Menu />
    </StoreProvider>
  );
}