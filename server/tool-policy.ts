// A routine's command allowlist: the fixed commands an unattended routine turn
// may run, and the exact files it may write.  Pure: no I/O, no process state.
//
// Why it exists.  Every BotFleet bot runs with auto-approve, and a routine
// reads untrusted text (public PRs, Linear issues, Zulip) while holding the
// owner's credentials.  A routine that only needs `agent-sync whoami` and one
// report command must not be talked into anything else, so the routine names
// what it may run and the driver refuses the rest.
//
// What is enforced where.  This module decides; the ACP driver applies the
// decision at every place an engine can act (server/drivers/acp/allowlist.ts):
// the engine's own pre-tool hook, its permission requests, and the client
// terminal and file calls BotFleet then executes itself, with no shell.  An
// engine that cannot be held to that is refused for allowlist turns.
//
// The command grammar is deliberately smaller than a shell's.  A command is
// split into words shell-style (single and double quotes group a word, so a
// topic name with spaces is one word), and anything a shell would treat
// specially outside quotes is refused rather than interpreted:  `;` `&` `|`
// `$` backtick `(` `)` `<` `>` newline, globs, `~`, `#`, `\`, `!`, braces.
// Inside double quotes `$`, backtick, `\` and `!` are refused too, because a
// shell would still expand them there.  Then argv[0] must equal an entry's
// absolute path exactly, the entry's fixed sub-words must follow, and every
// remaining word must be an allowed flag (with a value of the declared shape)
// or a positional word of its declared shape.  A word that names a file must be
// declared as a `path`:  a `text` word naming a file would let the model point
// the program at any file it can reach.

import { posix } from "node:path";

import { z } from "zod";

import { schemaIssue, type JsonValue } from "./schema.ts";

export type PolicyDecision =
  | {
      ok: true;
      argv: string[];
      /** The words a `path` spec matched (flag values and positionals), so
       *  the caller can check where each really lands before running. */
      paths?: string[];
    }
  | { ok: false; reason: string; /** safe to log:  a program name or tool name, never an argument */ name: string };

const MAX_COMMANDS = 32;
const MAX_SUB = 8;
const MAX_FLAGS = 48;
const MAX_POSITIONALS = 8;
const MAX_PATHS = 32;
const MAX_ENUM = 32;
const MAX_COMMAND_LENGTH = 16_384;
const MAX_TOKENS = 128;
const DEFAULT_TEXT_MAX = 4_000;
const MAX_TEXT_MAX = 16_000;
const MAX_PATH_LENGTH = 1_024;

/** Characters a word may carry outside quotes.  Everything else either means
 *  something to a shell or has no business in a fixed routine command. */
const SAFE_UNQUOTED = /^[A-Za-z0-9_./:=,@%+-]$/;
/** Characters a configured path, program or fixed sub-word may use. */
const SAFE_CONFIG_WORD = /^[A-Za-z0-9_./:=,@%+-]+$/;
const FLAG_NAME = /^(?:-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9_-]*)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INTEGER = /^(?:0|[1-9][0-9]{0,8})$/;

/** agent-sync flags no routine may pass, whatever its policy says:  each one
 *  changes who the post is from or who it wakes.  A word that is a prefix of
 *  one of these is refused too, because Python's argparse expands an
 *  unambiguous abbreviation (`--fl` becomes `--fleet`). */
export const AGENT_SYNC_FORBIDDEN_FLAGS = [
  "--as",
  "--default-seat",
  "--rc",
  "--session",
  "--no-tag",
  "--fleet",
  "--to",
  "--to-owner",
] as const;

/** Directories and files a routine may never be allowed to write, even when
 *  its policy names them:  credentials, shell start-up files, and anything
 *  that runs at login. */
const PROTECTED_WRITE_PARTS = ["/.ssh/", "/.secrets/", "/.gnupg/", "/.aws/", "/.config/gh/", "/Library/LaunchAgents/", "/Library/LaunchDaemons/"];

function controlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** True when `path` is absolute, already normal (no `.`, `..`, `//` or
 *  trailing slash), and made only of safe characters. */
export function isCleanAbsolutePath(path: string): boolean {
  if (path.length < 2 || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith("/") || path.endsWith("/")) return false;
  if (!SAFE_CONFIG_WORD.test(path)) return false;
  return posix.normalize(path) === path && !path.split("/").some((part) => part === "." || part === "..");
}

/** True for a dotfile, a file in a dot directory, or anything under a
 *  credential or login directory.  Checked on every configured path (write,
 *  read, and `path` flag and positional values) when a policy is saved, and
 *  again at run time on the path itself and on where it resolves to, so
 *  neither a policy that skipped validation nor a symlinked parent can carry
 *  an allowed name into `~/.ssh`. */
export function isProtectedPath(path: string): boolean {
  if (path.split("/").some((part) => part.startsWith("."))) return true;
// macOS default volumes are case-insensitive, so `/library/launchagents`
  // is the same directory as `/Library/LaunchAgents`.  Compare folded.
  const folded = `${path}/`.toLowerCase();
  return PROTECTED_WRITE_PARTS.some((part) => folded.includes(part.toLowerCase()));
}

/** Whether a program or script path names agent-sync, in any letter case:  an
 *  `AGENT-SYNC` spelling on a case-insensitive volume is the same binary, and
 *  the forbidden-flag checks must still apply.  This is a basename, so the ACP
 *  gate also resolves links — an alias of another name is caught at run time
 *  from the word that turns out to be agent-sync. */
export function namesAgentSync(word: string): boolean {
  return posix.basename(word).toLowerCase() === "agent-sync";
}

/** The agent-sync flag a word spells or abbreviates, if it is a forbidden one. */
function forbiddenAgentSyncFlag(word: string): string | null {
  if (!word.startsWith("--") || word.length < 3) return null;
  const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
  return AGENT_SYNC_FORBIDDEN_FLAGS.find((flag) => flag.startsWith(name)) ?? null;
}

// ---------------------------------------------------------------------------
// Validation of a stored or submitted policy

const flagCommon = { repeat: z.boolean().optional(), required: z.boolean().optional() };
const cleanAbsolutePath = z.string().refine(isCleanAbsolutePath, "must be a clean absolute path");
/** A file a routine may name:  a write or read path, or the value of a `path`
 *  flag or positional.  Never a dotfile or anything under a credential or login
 *  directory, whatever the policy says. */
const routinePath = cleanAbsolutePath.refine(
  (path) => !isProtectedPath(path),
  "may not name a dotfile or a credential or login directory",
);
const configWord = z
  .string()
  .min(1)
  .max(512)
  .regex(SAFE_CONFIG_WORD, "has a character a routine command may not use")
  .refine((word) => !word.startsWith("-"), "may not start with -");

const flagSpecSchema = z.discriminatedUnion("value", [
  z.strictObject({ value: z.literal("none"), ...flagCommon }),
  z.strictObject({ value: z.literal("text"), maxLength: z.number().int().min(1).max(MAX_TEXT_MAX).optional(), ...flagCommon }),
  z.strictObject({ value: z.literal("int"), min: z.number().int().optional(), max: z.number().int().optional(), ...flagCommon }),
  z.strictObject({ value: z.literal("oneOf"), values: z.array(configWord.max(256)).min(1).max(MAX_ENUM), ...flagCommon }),
  z.strictObject({ value: z.literal("path"), paths: z.array(routinePath).min(1).max(MAX_PATHS), ...flagCommon }),
]);

/** One flag a command entry allows.  `none` is a switch; every other kind
 *  takes exactly one following word. */
export type ToolPolicyFlagSpec = z.output<typeof flagSpecSchema>;

/** One positional word, matched by its place among the entry's positional
 *  words.  The same value kinds as a flag, minus the switch. */
const argSpecSchema = z.discriminatedUnion("value", [
  z.strictObject({ value: z.literal("text"), maxLength: z.number().int().min(1).max(MAX_TEXT_MAX).optional() }),
  z.strictObject({ value: z.literal("int"), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.strictObject({ value: z.literal("oneOf"), values: z.array(configWord.max(256)).min(1).max(MAX_ENUM) }),
  z.strictObject({ value: z.literal("path"), paths: z.array(routinePath).min(1).max(MAX_PATHS) }),
]);

export type ToolPolicyArgSpec = z.output<typeof argSpecSchema>;

const commandSchema = z
  .strictObject({
    /** Absolute path of the program, compared as a string:  no PATH lookup,
     *  no `..`, no symlink resolution. */
    argv0: cleanAbsolutePath,
    /** Fixed words that must follow argv0 in order (a verb, a script path). */
    sub: z.array(configWord).max(MAX_SUB).default([]),
    /** Allowed flags, by exact spelling (`--json`, `-n`). */
    flags: z.record(z.string().regex(FLAG_NAME, "is not a flag name"), flagSpecSchema).default({}),
    /** Positional words (not starting with `-`), anywhere among the flags,
     *  each of its declared shape, in order.  All of them must be present. */
    args: z.array(argSpecSchema).max(MAX_POSITIONALS).default([]),
    /** How many more positional words may follow the declared `args`, as
     *  free text.  Never use one for a word that names a file. */
    positionals: z.number().int().min(0).max(MAX_POSITIONALS).default(0),
  })
  .superRefine((command, ctx) => {
    const names = Object.keys(command.flags);
    if (names.length > MAX_FLAGS) ctx.addIssue({ code: "custom", message: `has more than ${MAX_FLAGS} flags` });
    // agent-sync as the program, or as the script an interpreter runs
    const fixed = [command.argv0, ...command.sub];
    const agentSyncAt = fixed.findIndex(namesAgentSync);
    for (const [name, spec] of Object.entries(command.flags)) {
      if (spec.value === "int" && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
        ctx.addIssue({ code: "custom", message: `flag ${name} has min above max` });
      }
      if (agentSyncAt >= 0 && forbiddenAgentSyncFlag(name)) {
        ctx.addIssue({ code: "custom", message: `agent-sync may never take ${name}` });
      }
    }
    if (agentSyncAt >= 0 && fixed[agentSyncAt + 1] === "dm" && command.flags["--owner"]?.required !== true) {
      ctx.addIssue({ code: "custom", message: "agent-sync dm is allowed only with a required --owner flag" });
    }
  });

export type ToolPolicyCommand = z.output<typeof commandSchema>;

const unique = (paths: string[]) => [...new Set(paths)];

const toolPolicySchema = z.strictObject({
  mode: z.literal("allowlist"),
  commands: z.array(commandSchema).max(MAX_COMMANDS).default([]),
  /** Exact absolute files the turn may write.  No directories, no globs. */
  writePaths: z.array(routinePath).max(MAX_PATHS).default([]).transform(unique),
  /** Exact absolute files the turn may read, beyond `writePaths`. */
  readPaths: z.array(routinePath).max(MAX_PATHS).default([]).transform(unique),
});

export type ToolPolicy = z.output<typeof toolPolicySchema>;

/** Validate a submitted or stored policy and return a clean copy, or throw
 *  with a message the routine editor can show.  `undefined` and `null` mean
 *  "no allowlist" and return `undefined`. */
export function sanitizeToolPolicy(raw: JsonValue | ToolPolicy | undefined): ToolPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = toolPolicySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Command allowlist:  ${schemaIssue(parsed.error, "is not valid")}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Splitting a command into words

export type TokenizeResult = { ok: true; words: string[] } | { ok: false; reason: string };

/** Split `command` into words the way a POSIX shell would for the narrow
 *  grammar above, or refuse it.  Never interprets anything:  a character that
 *  would make a shell do more than split words is a refusal. */
export function tokenizeCommand(command: string): TokenizeResult {
  if (command.length > MAX_COMMAND_LENGTH) return { ok: false, reason: "the command is too long" };
  if (command.includes("\n") || command.includes("\r")) return { ok: false, reason: "the command spans more than one line" };
  if (controlChar(command.replaceAll("\t", " "))) return { ok: false, reason: "the command carries a control character" };
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return { ok: false, reason: "an unterminated single quote" };
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let segment = "";
      for (; j < command.length; j++) {
        const inner = command[j]!;
        if (inner === '"') break;
        if (inner === "$" || inner === "`" || inner === "\\" || inner === "!") {
          return { ok: false, reason: `a shell metacharacter (${inner}) inside double quotes` };
        }
        segment += inner;
      }
      if (j >= command.length) return { ok: false, reason: "an unterminated double quote" };
      word += segment;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (!SAFE_UNQUOTED.test(ch)) {
      // Name the character for the log, but only from a fixed set: anything
      // else is reported generically so no argument text reaches a log.
      const shown = ";&|$`()<>*?[]{}~#!\\^\"'".includes(ch) ? ch : "an unsafe character";
      return { ok: false, reason: `an unquoted shell metacharacter (${shown})` };
    }
    word += ch;
    inWord = true;
    i++;
  }
  if (inWord) words.push(word);
  if (words.length === 0) return { ok: false, reason: "the command is empty" };
  if (words.length > MAX_TOKENS) return { ok: false, reason: "the command has too many words" };
  if (words.some((w) => w.length === 0)) return { ok: false, reason: "the command has an empty word" };
  return { ok: true, words };
}

// ---------------------------------------------------------------------------
// Matching

function programName(argv0: string): string {
  const base = posix.basename(argv0);
  return base && SAFE_CONFIG_WORD.test(base) && base.length <= 64 ? base : "command";
}

function valueProblem(spec: ToolPolicyFlagSpec | ToolPolicyArgSpec, value: string): string | null {
  if (value.startsWith("-")) return "a flag value may not start with -";
  if (value.startsWith("@")) return "a flag value may not start with @";
  switch (spec.value) {
    case "none":
      return null;
    case "text":
      return value.length > (spec.maxLength ?? DEFAULT_TEXT_MAX) ? "a flag value is too long" : null;
    case "int": {
      if (!INTEGER.test(value)) return "a flag value is not a whole number";
      const n = Number(value);
      if (spec.min !== undefined && n < spec.min) return "a flag value is below its minimum";
      if (spec.max !== undefined && n > spec.max) return "a flag value is above its maximum";
      return null;
    }
    case "oneOf":
      return spec.values.includes(value) ? null : "a flag value is not one of the allowed values";
    case "path":
      return spec.paths.includes(value) ? null : "a path flag names a file outside the allowlist";
  }
}

/** Match argv (already split) against one entry. */
function matchEntry(entry: ToolPolicyCommand, argv: string[], paths: string[]): string | null {
  if (argv.length < 1 + entry.sub.length) return "missing its fixed words";
  for (let k = 0; k < entry.sub.length; k++) {
    if (argv[1 + k] !== entry.sub[k]) return "its fixed words differ";
  }
  const seen = new Map<string, number>();
  let positionals = 0;
  for (let k = 1 + entry.sub.length; k < argv.length; k++) {
    const word = argv[k]!;
    if (word === "--") return "an end-of-options marker";
    if (word.startsWith("-") && word.length > 1) {
      if (word.startsWith("--") && word.includes("=")) return "a --flag=value word (pass the value as its own word)";
      const spec = Object.hasOwn(entry.flags, word) ? entry.flags[word] : undefined;
      if (!spec) return "a flag that is not allowed";
      const count = (seen.get(word) ?? 0) + 1;
      if (count > 1 && spec.repeat !== true) return "a repeated flag";
      seen.set(word, count);
      if (spec.value !== "none") {
        const value = argv[k + 1];
        if (value === undefined) return "a flag missing its value";
        const problem = valueProblem(spec, value);
        if (problem) return problem;
        if (spec.value === "path") paths.push(value);
        k++;
      }
      continue;
    }
    if (word.startsWith("@")) return "a free word starting with @";
    const declared = entry.args[positionals];
    positionals++;
    if (declared) {
      const problem = valueProblem(declared, word);
      if (problem) return problem.replace("flag value", "positional word").replace("path flag", "path word");
      if (declared.value === "path") paths.push(word);
      continue;
    }
    if (positionals > entry.args.length + entry.positionals) return "an extra free word";
    if (word.length > DEFAULT_TEXT_MAX) return "a free word that is too long";
  }
  if (positionals < entry.args.length) return "a positional word is missing";
  for (const [name, spec] of Object.entries(entry.flags)) {
    if (spec.required === true && !seen.has(name)) return "a required flag is missing";
  }
  return null;
}

/** The rules every agent-sync call keeps whatever the policy says.  `argv`
 *  starts at the word that runs agent-sync (the program, or the script an
 *  interpreter runs). */
export function agentSyncProblem(argv: string[]): string | null {
  for (const word of argv.slice(1)) {
    const forbidden = forbiddenAgentSyncFlag(word);
    if (forbidden) return `agent-sync may never take ${forbidden}`;
  }
  const verb = argv.slice(1).find((word) => !word.startsWith("-"));
  if (verb === "dm" && !argv.includes("--owner")) return "agent-sync dm is allowed only with --owner";
  return null;
}

/** Decide one argv (already split into words). */
export function evaluateArgv(policy: ToolPolicy, argv: string[]): PolicyDecision {
  const argv0 = argv[0] ?? "";
  const name = programName(argv0);
  if (!argv0) return { ok: false, reason: "the command is empty", name };
  if (ENV_ASSIGNMENT.test(argv0)) return { ok: false, reason: "an environment-variable prefix", name: "env-prefix" };
  if (!argv0.startsWith("/")) return { ok: false, reason: "the program is not an absolute path", name };
  if (argv.some((word) => controlChar(word))) return { ok: false, reason: "a control character", name };
  // agent-sync as the program or as a script among the fixed words:  only
  // ever more refusals, so a free word that happens to say agent-sync costs
  // nothing.
  const agentSyncAt = argv.slice(0, 1 + MAX_SUB).findIndex(namesAgentSync);
  if (agentSyncAt >= 0) {
    const problem = agentSyncProblem(argv.slice(agentSyncAt));
    if (problem) return { ok: false, reason: problem, name };
  }
  const candidates = policy.commands.filter((entry) => entry.argv0 === argv0);
  if (candidates.length === 0) return { ok: false, reason: "the program is not on the allowlist", name };
  let lastProblem = "it matches no allowlist entry";
  for (const entry of candidates) {
    const paths: string[] = [];
    const problem = matchEntry(entry, argv, paths);
    if (problem === null) return { ok: true, argv: [...argv], paths };
    lastProblem = problem;
  }
  return { ok: false, reason: `the arguments do not match the allowlist (${lastProblem})`, name };
}

/** Decide one shell command string. */
export function evaluateCommand(policy: ToolPolicy, command: string): PolicyDecision {
  const split = tokenizeCommand(command);
  if (!split.ok) {
    const first = command.trimStart().split(/[\s;&|<>()`$]/, 1)[0] ?? "";
    return { ok: false, reason: split.reason, name: first.startsWith("/") ? programName(first) : "command" };
  }
  return evaluateArgv(policy, split.words);
}

/** The shells an engine wraps a command in (`bash -lc '<command>'`), by
 *  absolute path only. */
const WRAPPER_SHELLS = new Set(["bash", "sh", "zsh"]);

/** An engine that runs commands through the client terminal hands BotFleet a
 *  wrapper such as `/opt/homebrew/bin/bash -lc 'agent-sync whoami'`.  Return
 *  the inner command when `command` is exactly such a wrapper, the command
 *  itself when it is not a wrapper, or null when it is a wrapper of any other
 *  shape. */
export function unwrapShellCommand(command: string, args?: string[]): { command: string } | { argv: string[] } | null {
  const outer = args && args.length > 0 ? null : tokenizeWrapper(command);
  const words = args && args.length > 0 ? [command, ...args] : outer;
  if (!words) return null;
  const head = words[0] ?? "";
  if (head.startsWith("/") && WRAPPER_SHELLS.has(posix.basename(head))) {
    if (words.length === 3 && (words[1] === "-c" || words[1] === "-lc")) return { command: words[2]! };
    if (words.length === 4 && words[1] === "-l" && words[2] === "-c") return { command: words[3]! };
    return null;
  }
  return args && args.length > 0 ? { argv: words } : { command };
}

/** Split an engine-built wrapper string.  Unlike `tokenizeCommand` this
 *  accepts the quoting an engine uses to embed a command (single quotes,
 *  double quotes with backslash escapes, and the `'"'"'` idiom), but still
 *  refuses anything a shell would expand at this outer level. */
export function tokenizeWrapper(command: string): string[] | null {
  if (command.length > MAX_COMMAND_LENGTH * 2) return null;
  if (command.includes("\n") || command.includes("\r")) return null;
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length; j++) {
        const inner = command[j]!;
        if (inner === '"') break;
        if (inner === "\\") {
          const next = command[j + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            word += next;
            j++;
            continue;
          }
          word += inner;
          continue;
        }
        if (inner === "$" || inner === "`") return null;
        word += inner;
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (!SAFE_UNQUOTED.test(ch)) return null;
    word += ch;
    inWord = true;
    i++;
  }
  if (inWord) words.push(word);
  return words.length > 0 ? words : null;
}

// ---------------------------------------------------------------------------
// Files

/** Whether `path` (as an engine sent it) is one of `allowed`, literally or as
 *  the same file reached through a resolved parent directory.  `canonical`
 *  maps a configured path to its resolved spelling when the caller could
 *  resolve it (an engine canonicalises `/tmp` to `/private/tmp`). */
export function pathAllowed(path: string, allowed: readonly string[], canonical?: (configured: string) => string | null): string | null {
  if (!isCleanAbsolutePath(path)) return null;
  for (const configured of allowed) {
    if (configured === path) return configured;
    const resolved = canonical?.(configured);
    if (resolved && resolved === path) return configured;
  }
  return null;
}

export function evaluateWrite(policy: ToolPolicy, path: string, canonical?: (configured: string) => string | null): PolicyDecision {
  const hit = pathAllowed(path, policy.writePaths, canonical);
  return hit ? { ok: true, argv: [hit] } : { ok: false, reason: "the file is not on the write allowlist", name: "write" };
}

export function evaluateRead(policy: ToolPolicy, path: string, canonical?: (configured: string) => string | null): PolicyDecision {
  const hit = pathAllowed(path, [...policy.writePaths, ...policy.readPaths], canonical);
  return hit ? { ok: true, argv: [hit] } : { ok: false, reason: "the file is not on the read allowlist", name: "read" };
}
