// Probe-gated slash-command allowlists per engine driver kind.
//
// Entries land here only after a recorded fixture under
// server/drivers/__fixtures__/engine-commands/ proves the command is safe
// to forward.  Titles and descriptions are BotFleet copy, never engine text.

import { CURSOR_AGENT_BUILTIN_COMMANDS } from "./cursor-engine-commands.ts";
import type { EngineCommandSpec } from "./engine-commands.ts";

type ProvenOn = EngineCommandSpec["provenOn"];

const CLAUDE_PROBE = { cliVersion: "2.1.287", date: "2026-10-02" } satisfies ProvenOn;

function cloneCommands(
  provenOn: ProvenOn,
  entries: readonly Omit<EngineCommandSpec, "provenOn">[],
): readonly EngineCommandSpec[] {
  return entries.map((entry) => ({ ...entry, provenOn }));
}

const CLAUDE_BUILTIN_SPECS: readonly Omit<EngineCommandSpec, "provenOn">[] = [
  {
    name: "compact",
    title: "Compact",
    description: "Summarize the conversation to free context.",
    args: { required: false, hint: "Optional focus for the summary", maxLength: 500 },
    output: "model",
    requiresSession: true,
    runsModelTurn: true,
  },
  {
    name: "context",
    title: "Context",
    description: "Show what fills this conversation's context.",
    args: null,
    output: "local",
    requiresSession: false,
    runsModelTurn: false,
  },
];

/** Shared by Claude Code and ACP agents that expose the same built-ins. */
export const CLAUDE_BUILTIN_COMMANDS = cloneCommands(CLAUDE_PROBE, CLAUDE_BUILTIN_SPECS);

const GROK_PROBE = { cliVersion: "1.0.0", date: "2026-10-15" } satisfies ProvenOn;

/** Grok Build CLI (`grokAgent`): /compact is documented upstream; fake ACP fixture proves forwarding. */
export const GROK_AGENT_COMMANDS = cloneCommands(GROK_PROBE, [CLAUDE_BUILTIN_SPECS[0]!]);

const ACP_CLAUDE_LIKE = (provenOn: ProvenOn) => cloneCommands(provenOn, CLAUDE_BUILTIN_SPECS);

/** Per driverKind allowlist merged into ENGINE_COMMAND_ALLOWLIST. */
export const ENGINE_COMMAND_ALLOWLIST_BY_DRIVER = {
  claudeAgent: CLAUDE_BUILTIN_COMMANDS,
  grokAgent: GROK_AGENT_COMMANDS,
  cursorAgent: CURSOR_AGENT_BUILTIN_COMMANDS,
  opencodeGo: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
  kimiAgent: ACP_CLAUDE_LIKE({ cliVersion: "0.29.1", date: "2026-10-15" }),
  deepseekAgent: ACP_CLAUDE_LIKE({ cliVersion: "0.29.1", date: "2026-10-15" }),
  droidAgent: ACP_CLAUDE_LIKE({ cliVersion: "0.196.0", date: "2026-10-15" }),
  qwenAgent: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
  mcodeAgent: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
  dshAgent: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
  hermesAgent: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
  museAgent: ACP_CLAUDE_LIKE({ cliVersion: "1.0.0", date: "2026-10-15" }),
} as const satisfies Readonly<Record<string, readonly EngineCommandSpec[]>>;
