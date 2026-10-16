// Which of an engine's own slash commands BotFleet may advertise or send.
//
// Every engine headless here (the Claude CLI under `-p --output-format
// stream-json`, the ACP agents) can announce a catalog of slash commands, and
// some of them are not safe to forward.  A leading "/advisor opus" that reached
// the Claude CLI bare rewrote `advisorModel` in the owner's global
// ~/.claude/settings.json, so the rule is: nothing reaches an engine as a
// command unless it is on a short, versioned allowlist that a recorded probe
// has proven, and nothing on the denylist ever does, whatever the allowlist
// says.  Everything else a person types is ordinary text, and a leading slash
// is neutralized so the engine cannot read it as a command.
//
// The announced catalog only decides which allowlist entries are shown right
// now.  Titles, descriptions and argument hints come from the entries below,
// never from the engine, so untrusted engine text does not reach the UI.

import type { TurnCommand } from "../contracts.ts";

export interface EngineCommandSpec {
  /** lowercase, no slash */
  name: string;
  /** Title Case, shown in the menu */
  title: string;
  /** one sentence, at most 90 characters */
  description: string;
  /** null when the command takes no argument */
  args: { required: boolean; hint: string; maxLength: number } | null;
  /** `local`: the CLI answers by itself (a report or a summary), and the row it
   *  produces is not conversation.  `model`: the reply is an ordinary model
   *  answer. */
  output: "local" | "model";
  /** the task must already have a native session for this engine */
  requiresSession: boolean;
  /** true when the command costs a model call */
  runsModelTurn: boolean;
  /** the CLI version a recorded probe fixture proved this entry on */
  provenOn: { cliVersion: string; date: string };
}

/** Commands that must never be offered or sent, whatever an engine announces
 *  and whatever the allowlist says.  Each one persists a setting, signs in or
 *  out, changes what the CLI is allowed to do, makes the CLI session drift
 *  away from BotFleet's transcript, writes a file into the project, or sends
 *  data off the machine. */
const DENIED_ENGINE_COMMANDS: ReadonlySet<string> = new Set([
  "advisor",
  "model",
  "models",
  "effort",
  "fast",
  "config",
  "settings",
  "permissions",
  "allowed-tools",
  "approval-mode",
  "login",
  "logout",
  "auth",
  "status",
  "help",
  "clear",
  "reset",
  "new",
  "resume",
  "continue",
  "rewind",
  "exit",
  "quit",
  "output-style",
  "theme",
  "vim",
  "statusline",
  "terminal-setup",
  "memory",
  "mcp",
  "hooks",
  "agents",
  "plugin",
  "plugins",
  "skills",
  "init",
  "add-dir",
  "export",
  "ide",
  "install-github-app",
  "install-slack-app",
  "upgrade",
  "update",
  "privacy-settings",
  "usage",
  "extra-usage",
  "doctor",
  "bug",
  "feedback",
  "sandbox",
  "mode",
]);

/** A name containing any of these words is refused even when it is not in the
 *  list above: a command that sounds like it touches an account, a key, a
 *  setting or a model is not one to forward by name alone. */
const DENIED_ENGINE_COMMAND_WORDS =
  /(login|logout|auth|token|key|secret|config|setting|permission|privacy|install|upgrade|update|model|advisor|account|billing|plan|theme|telemetry)/i;

/** The shape of a name BotFleet will ever consider: lowercase words joined by
 *  dashes.  A plugin-scoped or project-scoped name (anything with ":" or "/")
 *  has no match. */
const ENGINE_COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

/** A command name as BotFleet keeps it: no leading slash, lowercase, trimmed.
 *  Null for anything that is not a plain built-in name. */
export function normalizeEngineCommandName(raw: string): string | null {
  const name = raw.trim().replace(/^\/+/, "").toLowerCase();
  return ENGINE_COMMAND_NAME.test(name) ? name : null;
}

/** An engine's announced names, normalized and deduped in first-seen order.
 *  Names that are not plain built-ins are dropped here. */
export function normalizeAnnouncedCommands(raw: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = normalizeEngineCommandName(entry);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** True for a command that must never be offered or sent. */
export function isDeniedEngineCommand(name: string): boolean {
  const lower = name.trim().replace(/^\/+/, "").toLowerCase();
  if (lower.includes(":") || lower.includes("/")) return true;
  return DENIED_ENGINE_COMMANDS.has(lower) || DENIED_ENGINE_COMMAND_WORDS.test(lower);
}

/** Per driver kind, in menu order.  Empty until a recorded probe fixture
 *  proves an entry: docs/verification/slash-commands.md lists what was probed
 *  and what happened, and `scripts/probe-engine-commands.sh` records the
 *  frames under server/drivers/__fixtures__/engine-commands/. */
export const ENGINE_COMMAND_ALLOWLIST: Readonly<Record<string, readonly EngineCommandSpec[]>> = {};

/** `major.minor.patch` out of a CLI's version banner ("2.1.284 (Claude Code)"),
 *  or null when it has none. */
function versionParts(version: string | null): [number, number, number] | null {
  if (version === null) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** An entry applies while the running CLI has the major version it was proven
 *  on, or a later release of that same major.  A different major hides it
 *  until it is probed again; so does a CLI that reports no version. */
function provenFor(spec: EngineCommandSpec, cliVersion: string | null): boolean {
  const proven = versionParts(spec.provenOn.cliVersion);
  const running = versionParts(cliVersion);
  if (proven === null || running === null) return false;
  if (running[0] !== proven[0]) return false;
  if (running[1] !== proven[1]) return running[1] > proven[1];
  return running[2] >= proven[2];
}

/** The allowlist for `driverKind`, narrowed to the names this engine announced
 *  and the CLI versions each entry was proven on, in allowlist order.  The
 *  denylist wins over an allowlist entry. */
export function offeredEngineCommands(
  driverKind: string,
  announced: readonly string[],
  cliVersion: string | null,
  allowlist: Readonly<Record<string, readonly EngineCommandSpec[]>> = ENGINE_COMMAND_ALLOWLIST,
): EngineCommandSpec[] {
  const entries = Object.hasOwn(allowlist, driverKind) ? allowlist[driverKind] : [];
  if (entries.length === 0) return [];
  const names = new Set(normalizeAnnouncedCommands(announced));
  return entries.filter(
    (spec) => names.has(spec.name) && !isDeniedEngineCommand(spec.name) && provenFor(spec, cliVersion),
  );
}

/** True when `driverKind` has any allowlist entry at all, which is what makes a
 *  menu group worth showing as "pending" before the engine has announced. */
export function hasEngineCommandAllowlist(
  driverKind: string,
  allowlist: Readonly<Record<string, readonly EngineCommandSpec[]>> = ENGINE_COMMAND_ALLOWLIST,
): boolean {
  return Object.hasOwn(allowlist, driverKind) && allowlist[driverKind].length > 0;
}

/** The invisible character put in front of a user message whose first
 *  non-blank character is a slash.  JS, Python and Rust `trim()` leave it
 *  alone, so the engine's command parser no longer sees a leading "/". */
export const SLASH_NEUTRALIZER = "\u200B";

/** Text meant as a prompt, safe to hand to an engine that parses slash
 *  commands.  A leading slash would run a command there, so it is shielded.
 *  Anything else is returned unchanged. */
export function neutralizeLeadingSlash(text: string): string {
  return text.trimStart().startsWith("/") ? `${SLASH_NEUTRALIZER}${text}` : text;
}

/** Longest argument line a command may carry. */
export const ENGINE_COMMAND_ARGS_MAX = 500;

/** True when `text` holds a control character or a line separator, which is
 *  what would turn one stdin line into two. */
export function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** The one stdin line an engine reads for a command: "/name" plus an optional
 *  single-line argument.  Throws on a name or argument that is not safe to send,
 *  so a caller that skipped validation cannot smuggle a second line or a second
 *  command in. */
export function engineCommandText(command: TurnCommand): string {
  const name = normalizeEngineCommandName(command.name);
  if (name === null || name !== command.name || isDeniedEngineCommand(name)) {
    throw new Error(`"${command.name}" is not a command BotFleet can send`);
  }
  const args = command.args?.trim() ?? "";
  if (args === "") return `/${name}`;
  if (args.length > ENGINE_COMMAND_ARGS_MAX || args.startsWith("/") || hasControlCharacter(args)) {
    throw new Error(`the arguments for /${name} must be one line of at most ${ENGINE_COMMAND_ARGS_MAX} characters that does not start with a slash`);
  }
  return `/${name} ${args}`;
}
