// Static slash-command discovery from on-disk command definitions.
//
// Some engines never announce a catalog on the wire but still honor /name
// turns when a markdown file exists under a well-known commands directory.
// This module scans those trees without spawning a CLI.  Names are merged
// with runtime announcements (Claude init, ACP available_commands_update)
// before the allowlist filter runs.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { normalizeAnnouncedCommands, normalizeEngineCommandName } from "./engine-commands.ts";

export interface EngineCommandDiscoveryContext {
  /** Bot task working directory, when known. */
  cwd?: string | null;
  /** Owner home for user-scoped command dirs. */
  home?: string;
  /** Process environment for engine-specific *_HOME / *_CONFIG_DIR overrides. */
  env?: Record<string, string | undefined>;
}

type Scanner = (ctx: EngineCommandDiscoveryContext) => readonly string[];

function homeDir(ctx: EngineCommandDiscoveryContext): string {
  return ctx.home ?? ctx.env?.HOME ?? ctx.env?.USERPROFILE ?? homedir();
}

function commandNameFromMarkdown(fileName: string): string | null {
  if (!fileName.endsWith(".md")) return null;
  const stem = fileName.slice(0, -3);
  return normalizeEngineCommandName(stem);
}

/** Walk `root` and every immediate subdirectory for `*.md` command files. */
function scanCommandsTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const names: string[] = [];
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
      if (!stat.isFile()) continue;
      const name = commandNameFromMarkdown(basename(path));
      if (name) names.push(name);
    }
  };
  visit(root);
  return names;
}

const scanClaude: Scanner = (ctx) => {
  const env = ctx.env ?? {};
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homeDir(ctx), ".claude");
  const names: string[] = [];
  if (ctx.cwd) names.push(...scanCommandsTree(join(ctx.cwd, ".claude", "commands")));
  names.push(...scanCommandsTree(join(configDir, "commands")));
  return names;
};

const scanCodex: Scanner = (ctx) => {
  const env = ctx.env ?? {};
  const codexHome = env.CODEX_HOME ?? join(homeDir(ctx), ".codex");
  const names: string[] = [];
  if (ctx.cwd) names.push(...scanCommandsTree(join(ctx.cwd, ".codex", "prompts")));
  names.push(...scanCommandsTree(join(codexHome, "prompts")));
  return names;
};

const scanGemini: Scanner = (ctx) => {
  const geminiHome = join(homeDir(ctx), ".gemini");
  const names: string[] = [];
  if (ctx.cwd) names.push(...scanCommandsTree(join(ctx.cwd, ".gemini", "commands")));
  names.push(...scanCommandsTree(join(geminiHome, "commands")));
  return names;
};

function scanCursorSkills(root: string): string[] {
  if (!existsSync(root)) return [];
  const names: string[] = [];
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
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    const name = normalizeEngineCommandName(entry);
    if (name) names.push(name);
  }
  return names;
}

const scanCursor: Scanner = (ctx) => {
  const names: string[] = [];
  if (ctx.cwd) {
    names.push(...scanCommandsTree(join(ctx.cwd, ".cursor", "commands")));
    names.push(...scanCursorSkills(join(ctx.cwd, ".cursor", "skills")));
  }
  const home = homeDir(ctx);
  names.push(...scanCommandsTree(join(home, ".cursor", "commands")));
  names.push(...scanCursorSkills(join(home, ".cursor", "skills")));
  return names;
};

const scanGrokWorkflows: Scanner = (ctx) => {
  const grokHome = ctx.env?.GROK_HOME ?? join(homeDir(ctx), ".grok");
  const names: string[] = [];
  if (ctx.cwd) names.push(...scanCommandsTree(join(ctx.cwd, ".grok", "workflows")));
  names.push(...scanCommandsTree(join(grokHome, "workflows")));
  return names;
};

/** Which drivers consult static discovery before the allowlist filter. */
export const STATIC_ENGINE_COMMAND_SCANNERS: Readonly<Record<string, readonly Scanner[]>> = {
  claudeAgent: [scanClaude],
  grokAgent: [scanGrokWorkflows],
  cursorAgent: [scanCursor],
  antigravityAgent: [scanGemini],
  codex: [scanCodex],
  opencodeGo: [scanCursor],
};

/** Names found on disk for this driver, normalized and deduped. */
export function discoverStaticEngineCommands(
  driverKind: string,
  ctx: EngineCommandDiscoveryContext = {},
): readonly string[] {
  const scanners = STATIC_ENGINE_COMMAND_SCANNERS[driverKind];
  if (!scanners || scanners.length === 0) return [];
  const raw: string[] = [];
  for (const scan of scanners) raw.push(...scan(ctx));
  return normalizeAnnouncedCommands(raw);
}

/** Runtime cache plus static discovery, or null when both are empty. */
export function mergeAnnouncedEngineCommands(
  cached: readonly string[] | null,
  discovered: readonly string[],
): readonly string[] | null {
  if (cached === null && discovered.length === 0) return null;
  return normalizeAnnouncedCommands([...(cached ?? []), ...discovered]);
}
