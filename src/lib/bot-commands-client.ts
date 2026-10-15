import {
  BOT_COMMANDS_SCHEMA_VERSION,
  COMMAND_CLIENT_ACTIONS,
  botCommandsResponseSchema,
  type BotCommand,
  type BotCommandsResponse,
} from "../../shared/bot-commands.ts";
import type { AutocompleteChoice } from "./composer-autocomplete";

const KNOWN_CLIENT_ACTIONS = new Set<string>(COMMAND_CLIENT_ACTIONS);

/** Fetch the slash-command menu for one bot thread on desktop. */
export async function fetchBotCommands(
  botId: string,
  threadId: string,
): Promise<BotCommandsResponse | null> {
  const params = new URLSearchParams({ surface: "desktop", threadId });
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/commands?${params}`);
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const parsed = botCommandsResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.schemaVersion !== BOT_COMMANDS_SCHEMA_VERSION) return null;
  return parsed.data;
}

function commandVisible(command: BotCommand): boolean {
  if (command.clientAction !== null && !KNOWN_CLIENT_ACTIONS.has(command.clientAction)) {
    return false;
  }
  return true;
}

/** Flatten a commands response into autocomplete rows the composer can show. */
export function botCommandAutocompleteChoices(
  response: BotCommandsResponse,
  query: string,
): AutocompleteChoice[] {
  const q = query.trim().toLowerCase();
  if (query.includes("\n") || query.length > 30) return [];
  if (query.includes(" ") && q.length > 0) return [];

  const pool: AutocompleteChoice[] = [];
  for (const group of response.groups) {
    for (const command of group.commands) {
      if (!commandVisible(command)) continue;
      pool.push({
        id: command.id,
        name: command.name,
        kind: "command",
        badge: group.label,
        description: command.enabled ? command.description : command.disabledReason ?? command.description,
        command,
        disabled: !command.enabled,
      });
    }
  }

  const filtered = pool.filter((row) => {
    if (!q) return true;
    const cmd = row.command;
    if (!cmd) return row.name.toLowerCase().includes(q);
    return (
      cmd.name.toLowerCase().includes(q) ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.title.toLowerCase().includes(q)
    );
  });

  return filtered
    .sort((a, b) => {
      if (!q) return a.name.localeCompare(b.name);
      const aPref = a.name.toLowerCase().startsWith(q) || a.command?.label.toLowerCase().startsWith(`/${q}`);
      const bPref = b.name.toLowerCase().startsWith(q) || b.command?.label.toLowerCase().startsWith(`/${q}`);
      if (aPref && !bPref) return -1;
      if (!aPref && bPref) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 8);
}
