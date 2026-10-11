// The runtime side of a routine's command allowlist on an ACP engine
// (server/tool-policy.ts decides; this applies the decision).
//
// An allowlist turn is held at four places, so no single engine behaviour is
// trusted on its own (probe evidence:  docs/routine-command-allowlist.md):
//
//  1. The engine's pre-tool hook.  Grok accepts a client-registered
//     `pre_tool_use` hook and asks BotFleet before EVERY tool runs, including
//     MCP tools from the owner's own engine config and subagents, which no
//     permission mode or CLI flag reaches in agent mode.  Only the shell, file
//     write and file read tools are ever allowed, and only with an allowed
//     command or file.
//  2. Permission requests.  Answered by the same policy, never by a person and
//     never with an "always" option (that would write a standing rule into the
//     engine's own config).
//  3. Execution.  The engine is told the client has a terminal and a file
//     system, so a shell command arrives as `terminal/create` and a write as
//     `fs/write_text_file`.  BotFleet checks it again and runs the argv itself
//     with no shell, or writes the one allowed file without following a link.
//  4. A tripwire.  A tool that starts or finishes without the hook having
//     allowed it means the engine bypassed BotFleet;  the caller stops the
//     turn.
//
// Every engine message is decoded with a schema first:  a message of an
// unexpected shape is a refusal, never a guess.
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { chmod, open, readFile } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import { z } from "zod";

import { killCliTree } from "../../procs.ts";
import type { JsonValue } from "../../schema.ts";
import {
  evaluateArgv,
  evaluateCommand,
  evaluateRead,
  evaluateWrite,
  isCleanAbsolutePath,
  isProtectedPath,
  unwrapShellCommand,
  type PolicyDecision,
  type ToolPolicy,
} from "../../tool-policy.ts";

/** The hook callback id BotFleet registers;  a hook call naming any other id
 *  is not ours and is refused. */
export const ALLOWLIST_HOOK_ID = "botfleet-allowlist";

/** `_meta` for session/new and session/load that registers the hook. */
export interface AllowlistHookMeta {
  "x.ai/hooks": { pre_tool_use: Array<{ hookCallbackIds: string[] }> };
}

export function allowlistHookMeta(): AllowlistHookMeta {
  return { "x.ai/hooks": { pre_tool_use: [{ hookCallbackIds: [ALLOWLIST_HOOK_ID] }] } };
}

/** The client capabilities an allowlist turn advertises, so the engine hands
 *  shell commands and file access to BotFleet. */
export const ALLOWLIST_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
} as const;

/** The JSON-RPC methods a held engine may call on the client. */
const TERMINAL_METHODS = new Set(["terminal/create", "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"]);
const FS_METHODS = new Set(["fs/read_text_file", "fs/write_text_file"]);
export const HOOK_METHODS = new Set(["_x.ai/hooks/run", "x.ai/hooks/run"]);

/** The engine tools a routine may use, by the name the hook reports. */
const SHELL_TOOLS = new Set(["run_terminal_command"]);
const WRITE_TOOLS = new Set(["write", "search_replace"]);
const READ_TOOLS = new Set(["read_file"]);
/** Reads the output of a command this turn already ran.  Grok moves a
 *  command that runs past about 30 seconds to the background and reads its
 *  output back with this;  subagents are off, so the only tasks it can reach
 *  are the allowed commands' own. */
const OUTPUT_TOOLS = new Set(["get_command_or_subagent_output"]);

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const MAX_OUTPUT_LIMIT = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A command that outlives this is killed:  no routine command runs this long. */
const MAX_COMMAND_MS = 30 * 60_000;

const ONLY_THESE_TOOLS = "only the shell, file write and file read tools are allowed";

// ---------------------------------------------------------------------------
// Engine messages, decoded

/** The input fields of the three tools a routine may use.  A field of the
 *  wrong type fails the whole decode, which is a refusal. */
const toolInputSchema = z.looseObject({
  command: z.string().optional(),
  is_background: z.boolean().optional(),
  file_path: z.string().optional(),
  path: z.string().optional(),
  target_file: z.string().optional(),
});
type ToolInput = z.output<typeof toolInputSchema>;

const hookParamsSchema = z.looseObject({
  hookCallbackId: z.string().optional(),
  hookEventName: z.string().optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  toolInput: toolInputSchema.optional(),
  toolInputTruncated: z.boolean().optional(),
});

const permissionParamsSchema = z.looseObject({
  toolCall: z
    .looseObject({
      kind: z.string().optional(),
      rawInput: toolInputSchema.optional(),
      locations: z.array(z.looseObject({ path: z.string().optional() })).optional(),
    })
    .optional(),
});

/** Lenient on purpose:  the tripwire must read a status from any update, and
 *  a label it cannot read becomes "tool". */
const toolUpdateSchema = z.looseObject({
  sessionUpdate: z.string().optional().catch(undefined),
  status: z.string().nullish().catch(undefined),
  toolCallId: z.string().optional().catch(undefined),
  title: z.string().nullish().catch(undefined),
  kind: z.string().nullish().catch(undefined),
  _meta: z
    .looseObject({ "x.ai/tool": z.looseObject({ name: z.string().optional().catch(undefined) }).optional().catch(undefined) })
    .nullish()
    .catch(undefined),
});

const terminalCreateSchema = z.looseObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  outputByteLimit: z.number().optional(),
});
const terminalRefSchema = z.looseObject({ terminalId: z.string() });
const readParamsSchema = z.looseObject({ path: z.string(), line: z.number().int().optional(), limit: z.number().int().optional() });
const writeParamsSchema = z.looseObject({ path: z.string(), content: z.string() });

// ---------------------------------------------------------------------------
// Answers

/** A JSON-RPC error answer for a refused client call. */
export interface ClientError {
  code: number;
  message: string;
}

export interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExit;
}

type ClientResult = { terminalId: string } | TerminalOutput | TerminalExit | { content: string } | null;

/** A refused client call. */
export interface ClientRefusal {
  error: ClientError;
}

export type ClientAnswer = { result: ClientResult } | ClientRefusal;

/** What a `pre_tool_use` hook answers:  empty lets the tool run. */
export interface HookAnswer {
  decision?: "deny";
  reason?: string;
}

interface Terminal {
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exit: TerminalExit | null;
  exited: Promise<TerminalExit>;
  timer: ReturnType<typeof setTimeout>;
}

export interface AllowlistGateOptions {
  policy: ToolPolicy;
  /** The environment an allowed command runs with:  the engine child's own,
   *  launch identity included, never the variables the engine passes. */
  env: Record<string, string | undefined>;
  /** The working directory every allowed command runs in:  the turn's own,
   *  whatever directory the engine asks for. */
  cwd: string;
  /** Called once per denial with a line that names the program or tool only. */
  log?: (line: string) => void;
}

/** A tool name safe to log. */
function toolLabel(raw: string | null | undefined): string {
  return raw && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : "tool";
}

/** The configured path's spelling through its resolved parent directory, or
 *  null when the parent does not exist yet, or when that resolution lands
 *  somewhere a routine may never touch (a symlinked parent pointing into
 *  `~/.ssh`, a dot directory, a login directory). */
function canonicalPath(configured: string): string | null {
  let resolved: string;
  try {
    resolved = posix.join(realpathSync(dirname(configured)), basename(configured));
  } catch {
    return null;
  }
  return isCleanAbsolutePath(resolved) && !isProtectedPath(resolved) ? resolved : null;
}

/** How many links one path may pass through before it counts as a loop. */
const MAX_LINK_HOPS = 40;

/** Where `path` really lands, walked one component at a time from the root.
 *  Only links the operating system owns (owner root:  macOS's `/tmp`, `/var`
 *  and `/etc`) are followed.  Once a component does not exist yet, the rest is
 *  appended as it is:  nothing below a missing directory can redirect.  Null
 *  when the path runs through any other link (a user-level process, one of a
 *  routine's own commands or a checked-out repository could have planted it,
 *  so it may point anywhere, protected or not), through a link loop, or
 *  through something it cannot read, and when it names an existing file that
 *  has another hard link (another name for the same file, possibly in a
 *  protected place). */
function resolvedLocation(path: string): string | null {
  const pending = path.split("/").filter(Boolean);
  let current = "/";
  let hops = 0;
  let last: Stats | null = null;
  while (pending.length > 0) {
    const next = posix.join(current, pending.shift()!);
    try {
      last = lstatSync(next);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      return missing ? posix.join(next, ...pending) : null;
    }
    if (last.isSymbolicLink()) {
      if (last.uid !== 0 || ++hops > MAX_LINK_HOPS) return null;
      let target: string;
      try {
        target = readlinkSync(next);
      } catch {
        return null;
      }
      // `current` is a real directory (every link above it was followed), so
      // resolving the target against it lexically is resolving it physically.
      pending.unshift(...posix.resolve(current, target).split("/").filter(Boolean));
      current = "/";
      continue;
    }
    current = next;
  }
  if (last?.isFile() && last.nlink > 1) return null;
  return current;
}

/** Whether `path` may not be used:  it names a protected place itself, it
 *  lands in one, or where it lands cannot be trusted (`resolvedLocation`
 *  returned null:  a link BotFleet does not follow, a loop, a hard-linked
 *  file).  A saved policy never names a protected path (tool-policy.ts
 *  refuses it), so the first check guards a policy that skipped validation.
 *  Checked before anything is created, read, written or run. */
function namesOrReachesProtected(path: string): boolean {
  if (isProtectedPath(path)) return true;
  const real = resolvedLocation(path);
  return real === null || isProtectedPath(real);
}

function rpcRefusal(message: string): ClientRefusal {
  // -32000 is a server-defined error: the engine reports the tool as failed
  // and the model reads the message.
  return { error: { code: -32000, message } };
}

function denied(reason: string, name: string): Extract<PolicyDecision, { ok: false }> {
  return { ok: false, reason, name };
}

export class AllowlistGate {
  readonly denials: string[] = [];
  private readonly policy: ToolPolicy;
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: string;
  private readonly log: (line: string) => void;
  private readonly hookAllowed = new Set<string>();
  private readonly terminals = new Map<string, Terminal>();
  private nextTerminal = 1;
  private disposed = false;

  constructor(options: AllowlistGateOptions) {
    this.policy = options.policy;
    this.env = options.env;
    this.cwd = options.cwd;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  private deny(decision: Extract<PolicyDecision, { ok: false }>): string {
    this.denials.push(`allowlist: ${decision.name}`);
    this.log(`[allowlist] denied ${decision.name}`);
    return `BotFleet's routine allowlist refused this: ${decision.reason}.`;
  }

  /** Decide one engine tool by its name and decoded input (hook and
   *  permission paths share this). */
  private decideTool(toolName: string | undefined, input: ToolInput | undefined): PolicyDecision {
    const name = toolLabel(toolName);
    if (toolName && OUTPUT_TOOLS.has(toolName)) return { ok: true, argv: [toolName] };
    if (!toolName || !input) return denied(ONLY_THESE_TOOLS, name);
    if (SHELL_TOOLS.has(toolName)) {
      if (input.is_background === true) return denied("background commands are not allowed", name);
      return input.command === undefined ? denied("the command is missing", name) : this.checkPaths(evaluateCommand(this.policy, input.command));
    }
    if (WRITE_TOOLS.has(toolName)) {
      const path = input.file_path ?? input.path;
      return path === undefined ? denied("the file is missing", name) : this.checkFile(evaluateWrite(this.policy, path, canonicalPath), "write");
    }
    if (READ_TOOLS.has(toolName)) {
      const path = input.target_file ?? input.file_path ?? input.path;
      return path === undefined ? denied("the file is missing", name) : this.checkFile(evaluateRead(this.policy, path, canonicalPath), "read");
    }
    return denied(ONLY_THESE_TOOLS, name);
  }

  /** Refuse an allowed read or write whose file names a protected place or
   *  runs through a link BotFleet does not follow.  The client file call
   *  checks it again. */
  private checkFile(decision: PolicyDecision, label: "read" | "write"): PolicyDecision {
    if (!decision.ok) return decision;
    return namesOrReachesProtected(decision.argv[0]!) ? denied("the file names a protected place or runs through a link or hard link BotFleet does not follow", label) : decision;
  }

  /** Refuse an allowed command whose path words name a protected place or
   *  run through a link BotFleet does not follow (`resolvedLocation`). */
  private checkPaths(decision: PolicyDecision): PolicyDecision {
    if (!decision.ok) return decision;
    const program = basename(decision.argv[0] ?? "") || "command";
    for (const path of decision.paths ?? []) {
      if (namesOrReachesProtected(path)) return denied("a path names a protected place or runs through a link or hard link BotFleet does not follow", program);
    }
    return decision;
  }

  /** Answer a `pre_tool_use` hook:  `{}` lets the tool run, a `deny`
   *  decision blocks it.  Anything but our own pre-tool hook is refused. */
  hook(params: JsonValue | undefined): HookAnswer {
    const parsed = hookParamsSchema.safeParse(params);
    if (!parsed.success) return { decision: "deny", reason: this.deny(denied("a tool input BotFleet could not read", "tool")) };
    const p = parsed.data;
    if (p.hookCallbackId !== ALLOWLIST_HOOK_ID) return { decision: "deny", reason: this.deny(denied("an unknown hook", "hook")) };
    if (p.hookEventName !== "pre_tool_use") return {};
    if (this.disposed) return { decision: "deny", reason: "The turn has ended." };
    const decision = p.toolInputTruncated === true
      ? denied("the tool input was truncated", toolLabel(p.toolName))
      : this.decideTool(p.toolName, p.toolInput);
    if (!decision.ok) return { decision: "deny", reason: this.deny(decision) };
    if (p.toolUseId) this.hookAllowed.add(p.toolUseId);
    return {};
  }

  /** Decide a `session/request_permission`.  The caller answers with an
   *  `allow_once` option only. */
  permission(params: JsonValue | undefined): boolean {
    if (this.disposed) return false;
    const parsed = permissionParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.deny(denied("a permission request BotFleet could not read", "tool"));
      return false;
    }
    const toolCall = parsed.data.toolCall;
    const raw = toolCall?.rawInput ?? {};
    const kind = toolCall?.kind ?? "";
    const location = toolCall?.locations?.[0]?.path;
    let decision: PolicyDecision;
    if (kind === "execute") {
      decision = this.decideTool("run_terminal_command", raw);
    } else if (kind === "edit" || kind === "write") {
      decision = this.decideTool("write", { file_path: raw.file_path ?? raw.path ?? location });
    } else if (kind === "read") {
      decision = this.decideTool("read_file", { target_file: raw.target_file ?? raw.file_path ?? raw.path ?? location });
    } else {
      decision = denied(ONLY_THESE_TOOLS, toolLabel(kind));
    }
    if (decision.ok) return true;
    this.deny(decision);
    return false;
  }

  /** A tool that started (`in_progress`) or completed without the hook
   *  allowing it:  the engine ran something BotFleet never saw.  Returns the
   *  tool label when that happened.  `failed` is not counted:  it is how a
   *  call the hook denied ends (Grok reports each refusal that way), so
   *  counting it would stop every routine at its first refusal.  The tripwire
   *  is the last of four guards:  the hook, the permission answers and the
   *  client terminal and file checks stand in front of it. */
  bypassed(update: JsonValue | undefined): string | null {
    const parsed = toolUpdateSchema.safeParse(update);
    if (!parsed.success) return null;
    const u = parsed.data;
    if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return null;
    if (u.status !== "in_progress" && u.status !== "completed") return null;
    if (u.toolCallId && this.hookAllowed.has(u.toolCallId)) return null;
    return toolLabel(u._meta?.["x.ai/tool"]?.name ?? u.title ?? u.kind);
  }

  /** Whether `method` is a client call this gate answers. */
  handles(method: string): boolean {
    return TERMINAL_METHODS.has(method) || FS_METHODS.has(method);
  }

  async client(method: string, params: JsonValue | undefined): Promise<ClientAnswer> {
    try {
      switch (method) {
        case "terminal/create":
          return this.createTerminal(params);
        case "terminal/output":
          return this.terminalOutput(params);
        case "terminal/wait_for_exit":
          return await this.waitForExit(params);
        case "terminal/kill":
          return this.killTerminal(params, false);
        case "terminal/release":
          return this.killTerminal(params, true);
        case "fs/read_text_file":
          return await this.readText(params);
        case "fs/write_text_file":
          return await this.writeText(params);
        default:
          return { error: { code: -32601, message: "method not found" } };
      }
    } catch {
      // Never echo an OS error that could carry file content or a path the
      // policy did not name: the method and a generic line are enough.
      return rpcRefusal(`${method} failed`);
    }
  }

  private createTerminal(params: JsonValue | undefined): ClientAnswer {
    if (this.disposed) return rpcRefusal("the turn has ended");
    const parsed = terminalCreateSchema.safeParse(params);
    if (!parsed.success) return rpcRefusal(this.deny(denied("a terminal request BotFleet could not read", "command")));
    const p = parsed.data;
    const unwrapped = unwrapShellCommand(p.command, p.args);
    if (!unwrapped) return rpcRefusal(this.deny(denied("a shell wrapper of an unexpected shape", "command")));
    const decision = this.checkPaths(
      "argv" in unwrapped ? evaluateArgv(this.policy, unwrapped.argv) : evaluateCommand(this.policy, unwrapped.command),
    );
    if (!decision.ok) return rpcRefusal(this.deny(decision));
    const [program, ...rest] = decision.argv;
    // Always the turn's own directory, never one the engine names:  a
    // program can read configuration or act on relative files in its cwd.
    const cwd = this.cwd;
    const requested = p.outputByteLimit;
    const limit = requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_OUTPUT_LIMIT)
      : DEFAULT_OUTPUT_LIMIT;
    const child = spawn(program!, rest, {
      cwd,
      env: this.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // posix: its own process group, so a kill reaches what it starts
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let settleExit: (exit: TerminalExit) => void = () => {};
    const exited = new Promise<TerminalExit>((resolve) => {
      settleExit = resolve;
    });
    const terminal: Terminal = {
      child,
      chunks: [],
      bytes: 0,
      limit,
      truncated: false,
      exit: null,
      exited,
      timer: setTimeout(() => killCliTree(child), MAX_COMMAND_MS),
    };
    terminal.timer.unref?.();
    const take = (chunk: Buffer) => {
      terminal.chunks.push(chunk);
      terminal.bytes += chunk.length;
      // ACP truncates from the beginning: keep the newest output.
      while (terminal.bytes > terminal.limit && terminal.chunks.length > 0) {
        const first = terminal.chunks[0]!;
        const excess = terminal.bytes - terminal.limit;
        if (first.length <= excess) {
          terminal.chunks.shift();
          terminal.bytes -= first.length;
        } else {
          terminal.chunks[0] = first.subarray(excess);
          terminal.bytes -= excess;
        }
        terminal.truncated = true;
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (terminal.exit) return;
      clearTimeout(terminal.timer);
      terminal.exit = { exitCode, signal: signal ?? null };
      settleExit(terminal.exit);
    };
    child.on("close", finish);
    child.on("error", () => finish(127, null));
    const terminalId = `bf-term-${this.nextTerminal++}`;
    this.terminals.set(terminalId, terminal);
    return { result: { terminalId } };
  }

  private terminal(params: JsonValue | undefined): { id: string; terminal: Terminal } | null {
    const parsed = terminalRefSchema.safeParse(params);
    if (!parsed.success) return null;
    const terminal = this.terminals.get(parsed.data.terminalId);
    return terminal ? { id: parsed.data.terminalId, terminal } : null;
  }

  private terminalOutput(params: JsonValue | undefined): ClientAnswer {
    const found = this.terminal(params);
    if (!found) return rpcRefusal("unknown terminal");
    const result: TerminalOutput = {
      output: Buffer.concat(found.terminal.chunks).toString("utf8"),
      truncated: found.terminal.truncated,
    };
    if (found.terminal.exit) result.exitStatus = found.terminal.exit;
    return { result };
  }

  private async waitForExit(params: JsonValue | undefined): Promise<ClientAnswer> {
    const found = this.terminal(params);
    if (!found) return rpcRefusal("unknown terminal");
    return { result: await found.terminal.exited };
  }

  private killTerminal(params: JsonValue | undefined, release: boolean): ClientAnswer {
    const found = this.terminal(params);
    if (!found) return release ? { result: null } : rpcRefusal("unknown terminal");
    if (!found.terminal.exit) killCliTree(found.terminal.child);
    if (release) this.terminals.delete(found.id);
    return { result: null };
  }

  private async readText(params: JsonValue | undefined): Promise<ClientAnswer> {
    const parsed = readParamsSchema.safeParse(params);
    if (!parsed.success) return rpcRefusal(this.deny(denied("a read request BotFleet could not read", "read")));
    const p = parsed.data;
    const decision = evaluateRead(this.policy, p.path, canonicalPath);
    if (!decision.ok) return rpcRefusal(this.deny(decision));
    if (namesOrReachesProtected(decision.argv[0]!)) return rpcRefusal(this.deny(denied("the file names a protected place or runs through a link or hard link BotFleet does not follow", "read")));
    const target = canonicalPath(decision.argv[0]!);
    if (!target) return rpcRefusal("the file is not readable");
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return { error: { code: -32002, message: "file not found" } };
    }
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return rpcRefusal("the file is not a regular file of a readable size");
    let content = await readFile(target, "utf8");
    const fromLine = p.line !== undefined && p.line > 1 ? p.line - 1 : 0;
    const limit = p.limit !== undefined && p.limit > 0 ? p.limit : undefined;
    if (fromLine > 0 || limit !== undefined) {
      const lines = content.split("\n");
      content = lines.slice(fromLine, limit === undefined ? lines.length : fromLine + limit).join("\n");
    }
    return { result: { content } };
  }

  private async writeText(params: JsonValue | undefined): Promise<ClientAnswer> {
    const parsed = writeParamsSchema.safeParse(params);
    if (!parsed.success) return rpcRefusal(this.deny(denied("a write request BotFleet could not read", "write")));
    const p = parsed.data;
    const decision = evaluateWrite(this.policy, p.path, canonicalPath);
    if (!decision.ok) return rpcRefusal(this.deny(decision));
    if (Buffer.byteLength(p.content, "utf8") > MAX_WRITE_BYTES) return rpcRefusal("the content is too large");
    const configured = decision.argv[0]!;
    // Before anything is created:  a link anywhere above the file must not
    // carry it into a protected place.
    if (namesOrReachesProtected(configured)) {
      return rpcRefusal(this.deny(denied("the file names a protected place or runs through a link or hard link BotFleet does not follow", "write")));
    }
    const parent = dirname(configured);
    // A routine's state directory may not exist on its first run.  Create it
    // owner-only;  the resolved parent is then the only directory written in.
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const target = canonicalPath(configured);
    if (!target) return rpcRefusal("the file is not writable");
    try {
      const existing = lstatSync(target);
      if (!existing.isFile()) return rpcRefusal(this.deny(denied("the path is a link or not a regular file", "write")));
    } catch {
      // absent: created below
    }
    // O_NOFOLLOW: a link planted between the check and the open is refused
    // by the kernel instead of followed.
    const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(p.content, "utf8");
    } finally {
      await handle.close();
    }
    // agent-sync --body-file accepts only an owner-only file.
    await chmod(target, 0o600);
    return { result: null };
  }

  /** Kill every command this turn started.  Called when the turn settles. */
  dispose(): void {
    this.disposed = true;
    for (const terminal of this.terminals.values()) {
      clearTimeout(terminal.timer);
      if (!terminal.exit) killCliTree(terminal.child);
    }
    this.terminals.clear();
  }
}

