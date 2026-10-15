import { z } from "zod";
import {
  COMMAND_CLIENT_ACTIONS,
  type BotCommand,
  type BotCommandGroup,
  type BotCommandsResponse,
  type CommandClientAction,
} from "../../shared/bot-commands.ts";
import type { AutocompleteChoice } from "./composer-autocomplete";

const KNOWN_CLIENT_ACTIONS = new Set<string>(COMMAND_CLIENT_ACTIONS);

function parseClientAction(value: string | null): CommandClientAction | null {
  if (value === null) return null;
  switch (value) {
    case "model-picker":
    case "effort-picker":
    case "tasks":
    case "computer":
      return value;
    default:
      return null;
  }
}
const COMMAND_ID = /^(botfleet|engine):[a-z][a-z0-9-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
const COMMAND_LABEL = /^\/[a-z][a-z0-9-]*$/;

const looseArgsSchema = z
  .object({
    required: z.boolean(),
    hint: z.string(),
    maxLength: z.number().int().min(1).max(500),
  })
  .passthrough();

const looseCommandSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    label: z.string(),
    title: z.string(),
    description: z.string(),
    source: z.string(),
    invoke: z.string(),
    clientAction: z.string().nullable(),
    args: looseArgsSchema.nullable().optional(),
    availability: z.string(),
    enabled: z.boolean(),
    disabledReason: z.string().nullable(),
    runsModelTurn: z.boolean(),
    collidesWith: z.string().nullable(),
  })
  .passthrough();

const looseGroupSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    state: z.string(),
    note: z.string().nullable(),
    commands: z.array(looseCommandSchema),
  })
  .passthrough();

const looseResponseSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    botId: z.string(),
    threadId: z.string(),
    surface: z.string(),
    busy: z.boolean(),
    engine: z
      .object({
        instanceId: z.string(),
        displayName: z.string(),
        model: z.string(),
        modelLabel: z.string(),
        effort: z.string().nullable(),
        commandSupport: z.string(),
      })
      .passthrough(),
    groups: z.array(looseGroupSchema).min(1),
  })
  .passthrough();

function normalizeCommand(raw: z.infer<typeof looseCommandSchema>): BotCommand | null {
  if (raw.source !== "botfleet" && raw.source !== "engine") return null;
  if (raw.invoke !== "server" && raw.invoke !== "client") return null;
  if (raw.availability !== "always" && raw.availability !== "idle") return null;
  if (!COMMAND_ID.test(raw.id) || !COMMAND_NAME.test(raw.name) || !COMMAND_LABEL.test(raw.label)) {
    return null;
  }
  if (raw.description.length > 90) return null;
  if (raw.clientAction !== null && !KNOWN_CLIENT_ACTIONS.has(raw.clientAction)) return null;
  const clientAction = parseClientAction(raw.clientAction);
  if (raw.clientAction !== null && clientAction === null) return null;

  let args: BotCommand["args"] = null;
  if (raw.args) {
    const parsed = looseArgsSchema.safeParse(raw.args);
    if (!parsed.success) return null;
    args = {
      required: parsed.data.required,
      hint: parsed.data.hint,
      maxLength: parsed.data.maxLength,
    };
  }

  return {
    id: raw.id,
    name: raw.name,
    label: raw.label,
    title: raw.title,
    description: raw.description,
    source: raw.source,
    invoke: raw.invoke,
    clientAction,
    args,
    availability: raw.availability,
    enabled: raw.enabled,
    disabledReason: raw.disabledReason,
    runsModelTurn: raw.runsModelTurn,
    collidesWith: raw.collidesWith,
  };
}

function normalizeGroup(raw: z.infer<typeof looseGroupSchema>): BotCommandGroup | null {
  if (raw.id !== "botfleet" && raw.id !== "engine") return null;
  if (raw.state !== "ready" && raw.state !== "pending") return null;
  const commands = raw.commands.map(normalizeCommand).filter((cmd) => cmd !== null);
  if (commands.length === 0) return null;
  return {
    id: raw.id,
    label: raw.label,
    state: raw.state,
    note: raw.note,
    commands,
  };
}

/** Client-side parse: ignore unknown fields and hide items with unknown enums. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- GET /api/bots/:id/commands returns untyped JSON; loose Zod is the client gate.
export function parseBotCommandsResponseForClient(body: unknown): BotCommandsResponse | null {
  const parsed = looseResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.surface !== "desktop" && data.surface !== "ios") return null;
  const surface = data.surface;

  const commandSupport =
    data.engine.commandSupport === "announced" || data.engine.commandSupport === "none"
      ? data.engine.commandSupport
      : "none";

  const groups = data.groups
    .map(normalizeGroup)
    .filter((group): group is BotCommandGroup => group !== null);
  if (groups.length === 0) return null;

  return {
    schemaVersion: 1,
    botId: data.botId,
    threadId: data.threadId,
    surface,
    busy: data.busy,
    engine: {
      instanceId: data.engine.instanceId,
      displayName: data.engine.displayName,
      model: data.engine.model,
      modelLabel: data.engine.modelLabel,
      effort: data.engine.effort,
      commandSupport,
    },
    groups: groups.slice(0, 2),
  };
}

/** Fetch the slash-command menu for one bot thread on desktop. */
export async function fetchBotCommands(
  botId: string,
  threadId: string,
): Promise<BotCommandsResponse | null> {
  const params = new URLSearchParams({ surface: "desktop", threadId });
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/commands?${params}`);
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const menu = parseBotCommandsResponseForClient(body);
  if (!menu || menu.botId !== botId || menu.threadId !== threadId) return null;
  return menu;
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
