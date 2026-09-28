// What a tool step actually DID — the one line a reader needs.
//
// Every engine reports tool calls with a name and a payload, and until now
// BotFleet threw the payload away and kept the name.  A transcript of seven
// `read_file` chips tells the reader nothing: not which files, not whether
// the bot was going in circles, not where the twenty seconds went.  The
// harnesses people compare us to (DeepSeek Harness, Claude Code, Codex) all
// render one dense line per step — a verb, the thing it touched, and how
// long it took — and that line is what makes a long turn skimmable.
//
// This module is the shared vocabulary for that line.  It lives in
// `shared/` because both halves need the same answer: the server classifies
// each step as it streams, and the client picks the icon and the verb from
// the same table, so the chip a user sees can never disagree with the
// narration call mode reads aloud.

import { redactSecretsInText } from "./redact.ts";

/** Coarse class of work a step did.  Drives the icon, the verb, and nothing
 * else — deliberately small, because a reader scanning a hundred rows can
 * hold about this many shapes in their head. */
export type ToolKind =
  | "read"
  | "edit"
  | "execute"
  | "search"
  | "fetch"
  | "think"
  | "task"
  // not a step the model took: the harness itself saying something happened
  // (a quota fallback switched models).  It reads as a sentence, so it gets
  // no verb and no icon of its own beyond the switch glyph.
  | "notice"
  | "other";

export const TOOL_KINDS: readonly ToolKind[] = [
  "read",
  "edit",
  "execute",
  "search",
  "fetch",
  "think",
  "task",
  "notice",
  "other",
];

/** Bounds on what a step carries into the transcript.  These are the whole
 * reason this is cheap: the payload a harness hands us can be a megabyte of
 * file content, and the renderer holds every message of every thread in
 * memory.  We keep a headline, not the evidence — enough to read the row and
 * decide whether to go look at the real thing. */
export const TARGET_LIMIT = 160;
export const DETAIL_LIMIT = 240;

/** Tool names, lowercased and stripped of separators, that each engine uses
 * for the same job.  Claude says `Read`, Cursor says `read_file`, ACP
 * harnesses say `read`, Codex says `view` — one row in the transcript should
 * not depend on which of those spelled it. */
const NAME_KINDS: ReadonlyArray<readonly [RegExp, ToolKind]> = [
  [/^(read|readfile|viewfile|view|cat|opennfile|openfile|filesread|readmanyfiles)$/, "read"],
  [/^(edit|editfile|write|writefile|createfile|applypatch|patch|strreplace|strreplaceeditor|multiedit|notebookedit|update|replace)$/, "edit"],
  [/^(bash|shell|sh|zsh|exec|execute|run|runcommand|runterminalcommand|terminal|command|localshell)$/, "execute"],
  [/^(grep|glob|search|find|ripgrep|codebasesearch|filesearch|grepsearch|listdir|ls|list)$/, "search"],
  [/^(webfetch|fetch|websearch|browser|curl|http|download|url|navigate|open)$/, "fetch"],
  [/^(think|thinking|reason|reasoning|sequentialthinking|plan|todowrite|todoread)$/, "think"],
  [/^(task|agent|subagent|dispatchagent|askbot|delegate|spawn)$/, "task"],
];

/** Substrings that settle a name the exact table missed.  Checked in order,
 * so `read_many_files` lands on read before `files` can drag it elsewhere. */
const SUBSTRING_KINDS: ReadonlyArray<readonly [string, ToolKind]> = [
  ["screenshot", "read"],
  ["read", "read"],
  ["edit", "edit"],
  ["write", "edit"],
  ["patch", "edit"],
  ["replace", "edit"],
  ["bash", "execute"],
  ["shell", "execute"],
  ["command", "execute"],
  ["exec", "execute"],
  ["terminal", "execute"],
  ["search", "search"],
  ["grep", "search"],
  ["glob", "search"],
  ["find", "search"],
  ["list", "search"],
  ["fetch", "fetch"],
  ["browser", "fetch"],
  ["http", "fetch"],
  ["url", "fetch"],
  ["think", "think"],
  ["todo", "think"],
  ["plan", "think"],
  ["agent", "task"],
  ["task", "task"],
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The class of work a tool name describes.  Unknown names land on "other"
 * rather than guessing — a wrong icon is worse than a neutral one. */
export function classifyTool(name: string | undefined, hint?: string): ToolKind {
  // an engine that already tells us the kind (ACP does) beats any guess we
  // could make from the name
  const fromHint = hint ? normalizeName(hint) : "";
  if (fromHint === "read") return "read";
  if (fromHint === "edit" || fromHint === "delete" || fromHint === "move") return "edit";
  if (fromHint === "execute") return "execute";
  if (fromHint === "search") return "search";
  if (fromHint === "fetch") return "fetch";
  if (fromHint === "think") return "think";

  if (!name) return "other";
  const key = normalizeName(name);
  if (!key) return "other";
  for (const [pattern, kind] of NAME_KINDS) {
    if (pattern.test(key)) return kind;
  }
  for (const [needle, kind] of SUBSTRING_KINDS) {
    if (key.includes(needle)) return kind;
  }
  return "other";
}

/** The word the row leads with.  Past tense for finished work reads wrong
 * while a step is still running, so these stay tenseless — "Read", "Edit",
 * "Run" — the way a file listing is tenseless. */
const VERBS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  execute: "Run",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
  task: "Task",
  notice: "",
  other: "Tool",
};

/** The label for a step.  A recognised kind gets its verb; anything else
 * keeps the engine's own name, because "Tool" twice in a row is useless and
 * an unfamiliar name at least identifies the thing. */
export function toolVerb(kind: ToolKind, name?: string): string {
  if (kind === "notice") return "";
  if (kind === "other") return name?.trim() || VERBS.other;
  return VERBS[kind];
}

/** `/home/ada/apps/x` → `~/apps/x`, and a path inside the bot's working
 * folder → the part that is actually about this turn.
 *
 * The working folder comes first, and it is the bigger win: a bot working in
 * `~/apps/thing` that reads `~/apps/thing/server/index.ts` should say
 * `server/index.ts`.  Repeating the folder on every row of a hundred-step
 * turn spends the width that would have shown which file it was.  Home is
 * the fallback for anything outside the folder. */
export function shortenPath(value: string, home?: string, cwd?: string): string {
  const folder = (cwd ?? "").replace(/[/\\]+$/, "");
  if (folder && value !== folder) {
    if (value.startsWith(folder + "/")) return value.slice(folder.length + 1);
    if (value.startsWith(folder + "\\")) return value.slice(folder.length + 1);
  }
  const root = (home ?? "").replace(/[/\\]+$/, "");
  if (!root) return value;
  if (value === root) return "~";
  if (value.startsWith(root + "/")) return "~/" + value.slice(root.length + 1);
  if (value.startsWith(root + "\\")) return "~\\" + value.slice(root.length + 1);
  return value;
}

/** Collapse whitespace and clip to `limit`, marking the clip so a reader
 * knows the row is a headline rather than the whole story. */
export function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}

/** Payload fields, in priority order, that name what a step acted on.  The
 * order matters: a shell tool carries both `command` and sometimes `cwd`,
 * and the command is the thing worth reading. */
const TARGET_FIELDS = [
  "command",
  "CommandLine",
  "commandLine",
  "cmd",
  "file_path",
  "filePath",
  "FilePath",
  "path",
  "Path",
  "AbsolutePath",
  "absolutePath",
  "target_file",
  "TargetFile",
  "targetFile",
  "file",
  "notebook_path",
  "abs_path",
  "pattern",
  "Pattern",
  "query",
  "Query",
  "url",
  "Url",
  "prompt",
  "Prompt",
  "description",
  "Description",
  "old_string",
  "content",
] as const;

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
  }
  return undefined;
}

/** The thing a step acted on, pulled out of whatever the engine handed us.
 *
 * `locations` is the ACP spec's own answer to this question, so it wins when
 * present.  Otherwise we go looking through the raw payload for the field
 * that names the work.  Everything is clipped and home-shortened here, once,
 * so no caller has to remember to do it. */
export function describeTarget(
  rawInput: unknown,
  options: { locations?: unknown; home?: string; cwd?: string; limit?: number } = {},
): string | undefined {
  const limit = options.limit ?? TARGET_LIMIT;

  const locations = options.locations;
  if (Array.isArray(locations) && locations.length > 0) {
    const first = locations[0] as { path?: unknown } | undefined;
    const path = typeof first?.path === "string" ? first.path : undefined;
    if (path) {
      const extra = locations.length > 1 ? ` +${locations.length - 1}` : "";
      return clip(shortenPath(path, options.home, options.cwd) + extra, limit);
    }
  }

  if (typeof rawInput === "string") {
    const flat = clip(rawInput, limit);
    return flat || undefined;
  }
  if (!rawInput || typeof rawInput !== "object") return undefined;

  const record = rawInput as Record<string, unknown>;
  for (const field of TARGET_FIELDS) {
    const found = firstString(record[field]);
    if (found && found.trim()) return clip(shortenPath(found, options.home, options.cwd), limit);
  }

  // Common target names case-insensitively (e.g. commandline, absolutepath, etc.)
  for (const [key, val] of Object.entries(record)) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^(command|cmd|commandline|filepath|path|absolutepath|targetfile|file|query|url|pattern)$/.test(k)) {
      const found = firstString(val);
      if (found && found.trim()) return clip(shortenPath(found, options.home, options.cwd), limit);
    }
  }

  // nothing named — a single scalar argument is still better than silence
  for (const value of Object.values(record)) {
    const found = firstString(value);
    if (found && found.trim()) return clip(shortenPath(found, options.home, options.cwd), limit);
  }
  return undefined;
}

/** ACP `content` blocks, a Claude `tool_result`, or a plain string — one
 * line of what came back.  A failure's message is the whole reason the row
 * is worth reading, so this runs for failures too.
 *
 * This is raw provider output — the stdout, stderr and error text of whatever
 * the bot just ran — so it is the one place in the pipeline where a live
 * credential can arrive by accident: a `curl -v` that echoed its header, a
 * `cat` of a key file, a failed API call that quoted the token it sent.  Every
 * driver funnels its tool result through here, and the line goes on to two
 * places that keep it: the transcript (replayed into every handed-over
 * context) and the Sentry `gen_ai.tool.result.detail` attribute.
 *
 * So redaction happens HERE, before the clip, rather than at either
 * destination.  Order is the whole point: `clip` cuts at 240 characters, and a
 * secret cut in half has lost the closing marker the patterns anchor on — the
 * `END … PRIVATE KEY` trailer, a JWT's third segment, a quoted value's closing
 * quote — so redacting the clipped line finds nothing and passes the first
 * 200 characters, header and key material included, straight through.
 *
 * It stays BOUNDED, though.  This runs on the synchronous event path, and a
 * tool that dumped a log file hands us megabytes; scanning all of it to keep
 * 240 characters would stall turn processing.  So the redaction sees a window
 * — a few kilobytes, far more than the clip can ever emit — and the window
 * only grows if masking compressed the text so much that the clip could not
 * be filled from it.  A secret cut off at the window edge is still caught,
 * because the patterns learned the truncated shapes for exactly this reason. */
export function describeResult(content: unknown, limit: number = DETAIL_LIMIT): string | undefined {
  const text = firstResultText(content);
  if (!text) return undefined;

  const ceiling = Math.max(limit, DETAIL_LIMIT) * 64;
  let window = Math.min(Math.max(limit, DETAIL_LIMIT) * 8, ceiling);
  for (;;) {
    const flat = clip(redactSecretsInText(text.slice(0, window)), limit);
    // a clip that filled the whole limit cannot be changed by more input
    if (flat.length >= limit || window >= text.length || window >= ceiling) return flat || undefined;
    window = Math.min(window * 4, ceiling, text.length);
  }
}

function firstResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      const found = firstResultText(entry);
      if (found) parts.push(found);
      if (parts.join(" ").length > DETAIL_LIMIT * 2) break;
    }
    return parts.join(" ") || undefined;
  }
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  // ACP wraps a block as { type: "content", content: { type: "text", text } }
  for (const field of ["text", "content", "output", "message", "stdout", "result", "value"]) {
    const found = firstResultText(record[field]);
    if (found) return found;
  }
  return undefined;
}

/** Everything a transcript row needs about one step, in one place. */
export interface ToolActivity {
  kind: ToolKind;
  verb: string;
  target?: string;
}

/** The full derivation, for callers that want the row rather than a piece
 * of it. */
export function toolActivity(
  name: string | undefined,
  options: { hint?: string; rawInput?: unknown; locations?: unknown; home?: string; cwd?: string } = {},
): ToolActivity {
  const kind = classifyTool(name, options.hint);
  return {
    kind,
    verb: toolVerb(kind, name),
    target: describeTarget(options.rawInput, {
      locations: options.locations,
      home: options.home,
      cwd: options.cwd,
    }),
  };
}
