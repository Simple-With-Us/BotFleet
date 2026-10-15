// Autocomplete logic for @ (Bots) and # (Apps, Channels, Routines) in Composer.

import type { Bot, Group } from "@/state/store";
import type { Routine } from "./routines";
import { getAvailableApps } from "./apps-catalog";

import type { BotCommand } from "../../shared/bot-commands.ts";

export interface AutocompleteTrigger {
  trigger: "@" | "#" | "/";
  start: number;
  query: string;
}

export interface AutocompleteChoice {
  id: string;
  name: string;
  kind: "bot" | "channel" | "app" | "routine" | "command";
  badge: string;
  description?: string;
  bot?: Bot;
  connected?: boolean;
  command?: BotCommand;
  disabled?: boolean;
}

function findLastValidTrigger(upto: string, char: "@" | "#" | "/"): number {
  let idx = upto.lastIndexOf(char);
  while (idx !== -1) {
    if (idx === 0 || /\s|[(\["'“‘]/.test(upto[idx - 1])) {
      return idx;
    }
    idx = upto.lastIndexOf(char, idx - 1);
  }
  return -1;
}

/**
 * Detects whether the caret is positioned within an active `@` or `#` query.
 * Returns null if no trigger is active or if the trigger is part of an email,
 * URL, or hex code.
 */
export function autocompleteQueryAt(text: string, caret: number): AutocompleteTrigger | null {
  const upto = text.slice(0, caret);
  const validAt = findLastValidTrigger(upto, "@");
  const validHash = findLastValidTrigger(upto, "#");
  const validSlash = findLastValidTrigger(upto, "/");
  const start = Math.max(validAt, validHash, validSlash);
  if (start === -1) return null;

  const trigger = upto[start] as "@" | "#" | "/";
  const query = upto.slice(start + 1);

  // Stop if query contains line breaks or is excessively long
  if (query.length > 30 || query.includes("\n")) {
    return null;
  }

  return { trigger, start, query };
}

export interface AutocompleteContext {
  bots: Bot[];
  groups: Group[];
  routines?: Routine[];
  connectedApps?: Record<string, { connected: boolean }>;
  currentBotId?: string;
  group?: Group;
  members?: Bot[];
  terminologySingular?: string;
}

/**
 * Computes autocomplete suggestions for the given trigger and query.
 */
export function getAutocompleteCandidates(
  triggerInfo: AutocompleteTrigger,
  ctx: AutocompleteContext,
): AutocompleteChoice[] {
  const { trigger, query } = triggerInfo;
  const q = query.trim().toLowerCase();

  if (trigger === "@") {
    const pool: AutocompleteChoice[] = [];

    if (ctx.group) {
      pool.push({
        id: "__everyone__",
        name: "everyone",
        kind: "bot",
        badge: "All",
        description: "All room members",
      });

      const memberIds = new Set<string>();
      for (const member of ctx.members ?? []) {
        if (!member.hidden) {
          memberIds.add(member.id);
          pool.push({
            id: member.id,
            name: member.name,
            kind: "bot",
            badge: "Member",
            description: member.title || member.description || "Room Member",
            bot: member,
          });
        }
      }

      for (const bot of ctx.bots) {
        if (!bot.hidden && !memberIds.has(bot.id)) {
          pool.push({
            id: bot.id,
            name: bot.name,
            kind: "bot",
            badge: "Bot",
            description: bot.title || bot.description || "Fleet Bot",
            bot,
          });
        }
      }
    } else {
      // Direct chat: prioritize the current bot, followed by the rest of the fleet
      const sortedBots = [...ctx.bots.filter((b) => !b.hidden)].sort((a, b) => {
        if (a.id === ctx.currentBotId) return -1;
        if (b.id === ctx.currentBotId) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const bot of sortedBots) {
        pool.push({
          id: bot.id,
          name: bot.name,
          kind: "bot",
          badge: bot.id === ctx.currentBotId ? "Current Bot" : "Bot",
          description: bot.title || bot.description || "Fleet Bot",
          bot,
        });
      }
    }

    // If query ends with a space and matches an exact name, user finished typing it
    if (query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) {
      return [];
    }

    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 8);
  }

  if (trigger === "#") {
    const pool: AutocompleteChoice[] = [];

    // 1. Channels / Rooms
    for (const group of ctx.groups) {
      if (!group.dm && group.name) {
        pool.push({
          id: `channel:${group.id}`,
          name: group.name,
          kind: "channel",
          badge: ctx.terminologySingular || "Channel",
          description: group.bulletin?.split("\n")[0] || "Channel",
        });
      }
    }

    // 2. Apps (connected and popular integrations)
    const apps = getAvailableApps(ctx.connectedApps);
    for (const app of apps) {
      pool.push({
        id: `app:${app.slug}`,
        name: app.name,
        kind: "app",
        badge: app.connected ? "Connected" : "App",
        description: app.description,
        connected: app.connected,
      });
    }

    // 3. Routines
    for (const routine of ctx.routines ?? []) {
      if (routine.name) {
        pool.push({
          id: `routine:${routine.id}`,
          name: routine.name,
          kind: "routine",
          badge: "Routine",
          description: routine.prompt || "Automated Routine",
        });
      }
    }

    // Completed tag check
    if (query.endsWith(" ") && pool.some((c) => c.name.toLowerCase() === q)) {
      return [];
    }

    // Rank matching candidates: prefix match on name first, then substring in name, then description
    return pool
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!q) return 0;
        const aPref = a.name.toLowerCase().startsWith(q);
        const bPref = b.name.toLowerCase().startsWith(q);
        if (aPref && !bPref) return -1;
        if (!aPref && bPref) return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }

  return [];
}

/**
 * Replaces the query at the trigger with the selected choice name and returns
 * the new text and caret position.
 */
export function applyAutocomplete(
  text: string,
  caret: number,
  triggerInfo: AutocompleteTrigger,
  choice: AutocompleteChoice,
): { text: string; caret: number } {
  const prefix = triggerInfo.trigger;
  const replacement =
    triggerInfo.trigger === "/" && choice.command
      ? `${choice.command.label} `
      : `${prefix}${choice.name} `;
  const after = text.slice(caret);
  const cleanAfter = after.startsWith(" ") ? after.slice(1) : after;
  const nextText = `${text.slice(0, triggerInfo.start)}${replacement}${cleanAfter}`;
  const newCaret = triggerInfo.start + replacement.length;
  return { text: nextText, caret: newCaret };
}
