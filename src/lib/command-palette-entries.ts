import { partitionSidebarGroups } from "@/lib/sidebar-preferences";
import {
  compareBotsByRecentActivity,
  compareGroupsByRecentActivity,
  type Bot,
  type Group,
} from "@/state/store";

/** Bots for ⌘K switcher mode — same recency order as the sidebar roster. */
export function preparePaletteBots(bots: readonly Bot[]): Bot[] {
  return [...bots].filter((bot) => !bot.hidden).sort(compareBotsByRecentActivity);
}

/** Split user rooms from bot-to-bot chats, each sorted by recent activity. */
export function preparePaletteGroups(groups: readonly Group[]) {
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups([...groups]);
  const byRecent = compareGroupsByRecentActivity;
  return {
    rooms: [...sectionedRooms, ...unsectionedRooms].sort(byRecent),
    botChats: [...botChats].sort(byRecent),
  };
}
