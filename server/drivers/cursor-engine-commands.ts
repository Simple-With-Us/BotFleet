// Cursor Agent CLI slash commands: built-ins, on-disk custom commands, and skills.
//
// Built-in names come from https://cursor.com/docs/cli/reference/slash-commands.
// Custom commands live under `.cursor/commands` (project and user).  Skills under
// `.cursor/skills/<name>/SKILL.md` register the same `/name` when no command
// file overrides them.  Discovered names merge into the announced catalog; this
// module extends the static allowlist so custom entries can run as command turns.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EngineCommandDiscoveryContext } from "./engine-command-discovery.ts";
import { discoverStaticEngineCommands } from "./engine-command-discovery.ts";
import {
  isDeniedEngineCommand,
  normalizeEngineCommandName,
  type EngineCommandSpec,
} from "./engine-commands.ts";

const CURSOR_PROBE = { cliVersion: "1.0.0", date: "2026-10-15" } satisfies EngineCommandSpec["provenOn"];

/** Built-ins BotFleet may forward; session/settings mutators stay on the denylist. */
const CURSOR_BUILTIN_SPECS: readonly Omit<EngineCommandSpec, "provenOn">[] = [
  {
    name: "compress",
    title: "Compress",
    description: "Summarize the conversation to reduce context usage.",
    args: { required: false, hint: "Optional focus for the summary", maxLength: 500 },
    output: "model",
    requiresSession: true,
    runsModelTurn: true,
  },
  {
    name: "summarize",
    title: "Summarize",
    description: "Summarize the conversation to reduce context usage.",
    args: { required: false, hint: "Optional focus for the summary", maxLength: 500 },
    output: "model",
    requiresSession: true,
    runsModelTurn: true,
  },
  {
    name: "about",
    title: "About",
    description: "Show Cursor CLI version and environment details.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
  {
    name: "ask",
    title: "Ask",
    description: "Toggle Ask mode for read-only questions.",
    args: null,
    output: "model",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "debug",
    title: "Debug",
    description: "Toggle Debug mode or send a prompt in Debug mode.",
    args: { required: false, hint: "Optional debug prompt", maxLength: 500 },
    output: "model",
    requiresSession: true,
    runsModelTurn: true,
  },
  {
    name: "goal",
    title: "Goal",
    description: "Give the agent a long-lived objective to work toward.",
    args: { required: false, hint: "Objective text", maxLength: 500 },
    output: "model",
    requiresSession: true,
    runsModelTurn: true,
  },
  {
    name: "fork",
    title: "Fork",
    description: "Fork the current chat into a new session.",
    args: null,
    output: "local",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "rename",
    title: "Rename",
    description: "Rename the current chat session.",
    args: { required: false, hint: "New chat title", maxLength: 500 },
    output: "local",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "open",
    title: "Open",
    description: "Open the repository root in the Cursor app.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
  {
    name: "copy",
    title: "Copy",
    description: "Copy a previous user message to the clipboard.",
    args: { required: false, hint: "Message selector", maxLength: 500 },
    output: "local",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "copy-request-id",
    title: "Copy Request Id",
    description: "Copy the last request ID to the clipboard.",
    args: null,
    output: "local",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "copy-conversation-id",
    title: "Copy Conversation Id",
    description: "Copy the current conversation ID to the clipboard.",
    args: null,
    output: "local",
    requiresSession: true,
    runsModelTurn: false,
  },
  {
    name: "line-numbers",
    title: "Line Numbers",
    description: "Toggle line numbers in code blocks.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
  {
    name: "show-thinking",
    title: "Show Thinking",
    description: "Toggle thinking block display.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
  {
    name: "status-indicators",
    title: "Status Indicators",
    description: "Toggle terminal title status indicators.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
];

/** Probe-gated Cursor built-ins (fixture: cursorAgent/1.0.0/builtins.json). */
export const CURSOR_AGENT_BUILTIN_COMMANDS: readonly EngineCommandSpec[] = CURSOR_BUILTIN_SPECS.map((entry) => ({
  ...entry,
  provenOn: CURSOR_PROBE,
}));

/** Names always merged into the announced catalog so the menu can offer built-ins. */
export const CURSOR_BUILTIN_COMMAND_NAMES: readonly string[] = CURSOR_BUILTIN_SPECS.map((entry) => entry.name);

export interface CursorDiscoveredCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

function homeDir(ctx: EngineCommandDiscoveryContext): string {
  return ctx.home ?? ctx.env?.HOME ?? ctx.env?.USERPROFILE ?? homedir();
}

function commandTitle(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function trimQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** YAML-style frontmatter at the top of a command or skill file. */
export type CursorCommandFrontmatter = Readonly<Record<string, string>>;

export function parseCursorCommandFrontmatter(content: string) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    fields[match[1].toLowerCase()] = trimQuotes(match[2]);
  }
  return fields;
}

function readDiscoveredFile(path: string, fallbackName: string): CursorDiscoveredCommand | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fields = parseCursorCommandFrontmatter(content);
  const rawName = fields.name ?? fallbackName;
  const name = normalizeEngineCommandName(rawName);
  if (name === null || isDeniedEngineCommand(name)) return null;
  return {
    name,
    description: fields.description,
    argumentHint: fields["argument-hint"] ?? fields.argument_hint,
  };
}

function scanSkillCommands(root: string): CursorDiscoveredCommand[] {
  if (!existsSync(root)) return [];
  const out: CursorDiscoveredCommand[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const skillDir = join(root, entry);
    let stat;
    try {
      stat = statSync(skillDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const discovered = readDiscoveredFile(skillFile, entry);
    if (discovered) out.push(discovered);
  }
  return out;
}

function scanMarkdownCommands(root: string): CursorDiscoveredCommand[] {
  if (!existsSync(root)) return [];
  const out: CursorDiscoveredCommand[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile() || !entry.endsWith(".md")) continue;
      const stem = entry.slice(0, -3);
      const discovered = readDiscoveredFile(path, stem);
      if (discovered) out.push(discovered);
    }
  };
  visit(root);
  return out;
}

export interface CursorCommandCatalog {
  names: readonly string[];
  byName: ReadonlyMap<string, CursorDiscoveredCommand>;
}

/** Project, user, and skill command definitions with optional frontmatter copy. */
export function discoverCursorCommandCatalog(ctx: EngineCommandDiscoveryContext = {}): CursorCommandCatalog {
  const home = homeDir(ctx);
  const collected: CursorDiscoveredCommand[] = [];
  if (ctx.cwd) {
    collected.push(...scanMarkdownCommands(join(ctx.cwd, ".cursor", "commands")));
    collected.push(...scanSkillCommands(join(ctx.cwd, ".cursor", "skills")));
  }
  collected.push(...scanMarkdownCommands(join(home, ".cursor", "commands")));
  collected.push(...scanSkillCommands(join(home, ".cursor", "skills")));

  const byName = new Map<string, CursorDiscoveredCommand>();
  for (const entry of collected) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  const staticNames = discoverStaticEngineCommands("cursorAgent", ctx);
  for (const name of staticNames) {
    if (!byName.has(name)) byName.set(name, { name });
  }
  return { names: [...byName.keys()], byName };
}

function customCursorSpec(name: string, meta: CursorDiscoveredCommand | undefined): EngineCommandSpec {
  const description =
    meta?.description?.trim() ||
    `Run the ${name} slash command from your Cursor command or skill definitions.`;
  const hint = meta?.argumentHint?.trim() || "Optional arguments";
  return {
    name,
    title: commandTitle(name),
    description: description.length > 90 ? `${description.slice(0, 87)}...` : description,
    args: { required: false, hint, maxLength: 500 },
    output: "model",
    requiresSession: false,
    runsModelTurn: true,
    provenOn: CURSOR_PROBE,
  };
}

/** Static Cursor built-ins plus one allowlist row per announced custom name. */
export function buildCursorAgentAllowlist(
  announced: readonly string[],
  catalog: { byName: ReadonlyMap<string, CursorDiscoveredCommand> },
): readonly EngineCommandSpec[] {
  const builtins = new Set(CURSOR_BUILTIN_COMMAND_NAMES);
  const entries: EngineCommandSpec[] = [...CURSOR_AGENT_BUILTIN_COMMANDS];
  const seen = new Set(entries.map((entry) => entry.name));
  for (const name of announced) {
    if (seen.has(name) || builtins.has(name) || isDeniedEngineCommand(name)) continue;
    entries.push(customCursorSpec(name, catalog.byName.get(name)));
    seen.add(name);
  }
  return entries;
}
