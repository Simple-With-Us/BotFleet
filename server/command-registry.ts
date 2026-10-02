// The one registry of slash commands.  GET /api/bots/:id/commands answers with
// what `buildBotCommands` returns, POST /api/bots/:id/commands looks its target
// up in the same answer, and the desktop and iOS composers draw their menus
// from it, so a command exists in exactly one place.
//
// Two groups.  BotFleet's own commands run on the server (/stop, /new, /status,
// /help) or open a control the client already has (/model, /effort, /tasks,
// /computer).  The engine's own commands are the allowlisted ones the engine has
// announced (server/drivers/engine-commands.ts), under the engine's display name.
// Nothing here spawns an engine, probes a CLI or reads a file: it is a pure
// function of what the server already knows.

import {
  BOT_COMMANDS_SCHEMA_VERSION,
  type BotCommand,
  type BotCommandGroup,
  type BotCommandsResponse,
  type CommandArgs,
  type CommandClientAction,
  type CommandSurface,
} from "../shared/bot-commands.ts";
import {
  ENGINE_COMMAND_ALLOWLIST,
  hasEngineCommandAllowlist,
  offeredEngineCommands,
  type EngineCommandSpec,
} from "./drivers/engine-commands.ts";

/** Shown on an engine group that has an allowlist but has not announced yet. */
export const ENGINE_COMMANDS_PENDING_NOTE = "Commands appear after this engine's first reply.";

/** Shown on an engine command that needs a native session the task lacks. */
export const NO_SESSION_REASON = "Available after the first reply.";

/** Shown on an idle-only command while the bot is busy.  The client applies it
 *  against the live busy flag; the server uses the same words for its 409. */
export const BUSY_REASON = "Available when the bot is idle.";

/** The BotFleet group's label.  The engine group's label is the engine's own
 *  display name. */
export const BOTFLEET_GROUP_LABEL = "BotFleet";

/** The engine group's label when the engine has no display name. */
export const ENGINE_GROUP_FALLBACK_LABEL = "Engine";

/** What the registry needs to know about the bot's engine. */
export interface CommandEngine {
  /** Opaque to every client. */
  instanceId: string;
  driverKind: string;
  /** DescribedInstance.displayName, read from the provider registry; never a literal here. */
  displayName: string;
  model: string;
  modelLabel: string;
  effort: string | null;
  /** how many models the engine's catalog offers */
  modelOptionCount: number;
  /** the effort levels this model lists; empty when it lists none */
  effortLevels: readonly string[];
  /** `adapter.capabilities.engineCommands === true` */
  supportsCommands: boolean;
  /** the engine can take a turn now: available and not cooling down */
  available: boolean;
  /** the CLI's version banner, for the allowlist's version gate */
  cliVersion: string | null;
}

export interface BotCommandsInput {
  botId: string;
  threadId: string;
  surface: CommandSurface;
  busy: boolean;
  engine: CommandEngine;
  /** `allowsMultipleBotThreads(conversationMode)`: Projects mode */
  allowsMultipleThreads: boolean;
  /** the task has a native session on this engine to continue */
  hasSession: boolean;
  /** the names the engine last announced; null when nothing is cached yet */
  announced: readonly string[] | null;
  /** tests inject their own entries */
  allowlist?: Readonly<Record<string, readonly EngineCommandSpec[]>>;
}

interface BotfleetDefinition {
  name: string;
  title: string;
  description: string;
  invoke: "server" | "client";
  clientAction: CommandClientAction | null;
  args: CommandArgs | null;
  availability: "always" | "idle";
}

const FILTER_ARGS_MAX = 60;

/** In menu order.  Whether each applies is decided by `botfleetApplies`. */
const BOTFLEET_COMMANDS: readonly BotfleetDefinition[] = [
  {
    name: "stop",
    title: "Stop",
    description: "Stop the running turn and clear queued messages.",
    invoke: "server",
    clientAction: null,
    args: null,
    availability: "always",
  },
  {
    name: "new",
    title: "New Conversation",
    description: "Start a fresh conversation; this one stays saved.",
    invoke: "server",
    clientAction: null,
    args: null,
    availability: "idle",
  },
  {
    name: "status",
    title: "Status",
    description: "Engine, model, effort, context and spend.",
    invoke: "server",
    clientAction: null,
    args: null,
    availability: "always",
  },
  {
    name: "model",
    title: "Model",
    description: "Pick a model this engine offers.",
    invoke: "client",
    clientAction: "model-picker",
    args: { required: false, hint: "Filter models", maxLength: FILTER_ARGS_MAX },
    availability: "always",
  },
  {
    name: "effort",
    title: "Effort",
    description: "Pick an effort level this model supports.",
    invoke: "client",
    clientAction: "effort-picker",
    args: null,
    availability: "always",
  },
  {
    name: "tasks",
    title: "Tasks",
    description: "Switch, rename or remove a conversation.",
    invoke: "client",
    clientAction: "tasks",
    args: { required: false, hint: "Filter conversations", maxLength: FILTER_ARGS_MAX },
    availability: "always",
  },
  {
    name: "computer",
    title: "Computer",
    description: "Watch this bot's computer live.",
    invoke: "client",
    clientAction: "computer",
    args: null,
    availability: "always",
  },
  {
    name: "help",
    title: "Help",
    description: "List the commands this bot accepts here.",
    invoke: "server",
    clientAction: null,
    args: null,
    availability: "always",
  },
];

/** The BotFleet command names, which no engine command may take. */
export const RESERVED_COMMAND_NAMES: readonly string[] = BOTFLEET_COMMANDS.map((definition) => definition.name);

function botfleetApplies(definition: BotfleetDefinition, input: BotCommandsInput): boolean {
  switch (definition.name) {
    case "model":
      // a picker with one choice is not a choice
      return input.engine.modelOptionCount >= 2;
    case "effort":
      return input.engine.effortLevels.length > 0;
    case "tasks":
    case "computer":
      return input.allowsMultipleThreads;
    default:
      return true;
  }
}

function botfleetCommand(definition: BotfleetDefinition): BotCommand {
  return {
    id: `botfleet:${definition.name}`,
    name: definition.name,
    label: `/${definition.name}`,
    title: definition.title,
    description: definition.description,
    source: "botfleet",
    invoke: definition.invoke,
    clientAction: definition.clientAction,
    args: definition.args,
    availability: definition.availability,
    enabled: true,
    disabledReason: null,
    runsModelTurn: false,
    collidesWith: null,
  };
}

function engineCommand(spec: EngineCommandSpec, input: BotCommandsInput): BotCommand {
  const label = input.engine.displayName.trim() || ENGINE_GROUP_FALLBACK_LABEL;
  let disabledReason: string | null = null;
  if (!input.engine.available) disabledReason = `${label} is unavailable right now.`;
  else if (spec.requiresSession && !input.hasSession) disabledReason = NO_SESSION_REASON;
  return {
    id: `engine:${spec.name}`,
    name: spec.name,
    label: `/${spec.name}`,
    title: spec.title,
    description: spec.description,
    source: "engine",
    invoke: "server",
    clientAction: null,
    args: spec.args,
    // an engine command is never steered or queued into a running turn
    availability: "idle",
    enabled: disabledReason === null,
    disabledReason,
    runsModelTurn: spec.runsModelTurn,
    collidesWith: null,
  };
}

/** The engine group, or null when the engine has none to show. */
function engineGroup(input: BotCommandsInput): BotCommandGroup | null {
  if (!input.engine.supportsCommands) return null;
  const allowlist = input.allowlist ?? ENGINE_COMMAND_ALLOWLIST;
  const label = input.engine.displayName.trim() || ENGINE_GROUP_FALLBACK_LABEL;
  if (input.announced === null) {
    if (!hasEngineCommandAllowlist(input.engine.driverKind, allowlist)) return null;
    return { id: "engine", label, state: "pending", note: ENGINE_COMMANDS_PENDING_NOTE, commands: [] };
  }
  const offered = offeredEngineCommands(input.engine.driverKind, input.announced, input.engine.cliVersion, allowlist);
  if (offered.length === 0) return null;
  return {
    id: "engine",
    label,
    state: "ready",
    note: null,
    commands: offered.map((spec) => engineCommand(spec, input)),
  };
}

/** The whole answer for one bot on one surface. */
export function buildBotCommands(input: BotCommandsInput): BotCommandsResponse {
  const botfleetCommands = BOTFLEET_COMMANDS.filter((definition) => botfleetApplies(definition, input)).map(botfleetCommand);
  const groups: BotCommandGroup[] = [
    { id: "botfleet", label: BOTFLEET_GROUP_LABEL, state: "ready", note: null, commands: botfleetCommands },
  ];
  const engine = engineGroup(input);
  if (engine) groups.push(engine);

  // When both groups hold a command of one name, each points at the other and
  // the menu lists both; the engine's is always reachable through its own id.
  if (engine) {
    for (const own of engine.commands) {
      const reserved = botfleetCommands.find((command) => command.name === own.name);
      if (!reserved) continue;
      own.collidesWith = reserved.id;
      reserved.collidesWith = own.id;
    }
  }

  return {
    schemaVersion: BOT_COMMANDS_SCHEMA_VERSION,
    botId: input.botId,
    threadId: input.threadId,
    surface: input.surface,
    busy: input.busy,
    engine: {
      instanceId: input.engine.instanceId,
      displayName: input.engine.displayName,
      model: input.engine.model,
      modelLabel: input.engine.modelLabel,
      effort: input.engine.effort,
      commandSupport: input.engine.supportsCommands ? "announced" : "none",
    },
    groups,
  };
}

/** The command with this id in a built answer, or null when it is not offered
 *  right now. */
export function findBotCommand(response: BotCommandsResponse, id: string): BotCommand | null {
  for (const group of response.groups) {
    const found = group.commands.find((command) => command.id === id);
    if (found) return found;
  }
  return null;
}

/** The lines /help prints on the composers: the label and one-line description
 *  of each command the bot accepts here, BotFleet's first and then the engine's
 *  under its own name. */
export function composerHelpLines(response: BotCommandsResponse): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [];
  for (const group of response.groups) {
    for (const command of group.commands) {
      lines.push({ label: command.label, value: command.description });
    }
  }
  return lines;
}
