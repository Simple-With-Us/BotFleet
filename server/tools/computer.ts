// Host computer tools for the HTTP driver lane.
//
// These tools give an HTTP-driven bot (MiniMax, OpenAI-compatible) direct
// file and shell capabilities on the host computer when granted "This Computer".
// Like `agents.ts`, this module is completely free of dependencies on `server/index.ts`.
// Destructive operations (bash, write_file, edit_file) require approval via the
// permission broker before execution, which is enforced by `host.ts`.
//
// CONFINEMENT — `read_file`/`write_file`/`edit_file` are offered to a bot
// that has only a workspace (no This Computer grant), which is a much weaker
// trust posture: the model may be less reliable, and untrusted text it
// ingested can steer it.  When `confinement` is set, every path argument is
// resolved through `realOrResolved`/`isInside` (server/bot-cwd.ts) and
// refused if it does not sit inside the bot's workspace realpath.  Same
// pattern server/tools/github.ts uses for its repo directory; bash is gated
// on `hostComputer` only, so a workspace-only bot never gets bash and
// therefore never gets to `cd` out either.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { isInside, realOrResolved } from "../bot-cwd.ts";
import type { TurnToolCall, TurnToolOutcome, TurnToolRuntime } from "../contracts.ts";
import type { AgentToolCallContext } from "./agents.ts";

// DR5 — `read_file` results are embedded verbatim in the transcript, and the
// HTTP-lane chat-completions engines (MiniMax, OpenAI-compatible, Grok API)
// replay that whole transcript on every later round of a turn AND on every
// later turn of the conversation.  An unbounded read of a large file is
// therefore not a one-time cost: it is paid again, in full, on every
// remaining round and turn until the conversation ends.  These two constants
// bound a single `read_file` call so that cannot happen: `limit` defaults to
// READ_FILE_DEFAULT_LINE_LIMIT lines when the model omits it (or passes
// something invalid), and the rendered result is separately capped at
// READ_FILE_MAX_BYTES regardless of `limit` — a run of unusually long lines
// (minified JS, a single-line data file) could otherwise blow the transcript
// up even within the line limit.  A model that wants more of the file just
// pages with `offset`; see the truncation notice appended below.
export const READ_FILE_DEFAULT_LINE_LIMIT = 400;
export const READ_FILE_MAX_BYTES = 64 * 1024;

export type ComputerToolExecutor = (
  call: TurnToolCall,
  ctx: AgentToolCallContext,
  runtime: TurnToolRuntime,
) => Promise<TurnToolOutcome>;

export interface ComputerToolsOptions {
  cwd?: string;
  /** When set, file tools refuse any path whose realpath escapes this
   *  workspace root.  The same realpath-safe check server/tools/github.ts
   *  applies to its repo directory.  Optional so existing callers (no
   *  confinement wanted) keep today's behavior. */
  confinement?: {
    /** The precomputed realpath of the bot's workspace root. */
    workspaceRealpath: string;
  };
}

function resolvePath(target: string, cwd?: string): string {
  if (isAbsolute(target)) return target;
  return cwd ? resolve(cwd, target) : resolve(target);
}

/** Resolve the path the model asked for (supporting a relative path
 *  against `cwd` the same way every existing file tool does) and require
 *  its realpath to live inside the bot's workspace.  Returns either a
 *  `{ok, real}` for the executor to use, or a finished `error` outcome
 *  the executor should return verbatim — a single source of truth for the
 *  same check across all three file tools. */
function confineOrReject(
  rawPath: string,
  cwd: string,
  confinement: { workspaceRealpath: string } | undefined,
): { ok: true; fullPath: string } | { ok: false; outcome: TurnToolOutcome } {
  const candidate = resolvePath(rawPath, cwd);
  // No confinement requested: behave exactly as before so a This Computer
  // bot (which opts out of confinement by design) keeps its whole-host view.
  if (!confinement) return { ok: true, fullPath: candidate };
  // realOrResolved gives a symlink-safe comparison even when the workspace
  // or any of its sub-folders are themselves symlinks, the way
  // bot-cwd.test.ts already exercises for the phone-originated cwd path.
  // Return the resolved realpath so the executor's read/write opens the
  // canonical file, not the unresolved candidate — closes the (theoretical,
  // unexploitable-in-Node-JS) TOCTOU window between this check and the
  // syscall, and also makes the executor insensitive to caller-supplied
  // case / NFD-vs-NFC mismatches that would otherwise false-negative reject
  // legitimate in-workspace reads on macOS / Windows.
  const real = realOrResolved(candidate);
  if (isInside(real, confinement.workspaceRealpath)) return { ok: true, fullPath: real };
  return {
    ok: false,
    outcome: {
      kind: "error",
      content:
        `Path "${rawPath}" is outside this bot's workspace. ` +
        "File tools without a This Computer grant only reach files inside the bot's own workspace directory. " +
        `Grant This Computer to read or write anywhere on the host.`,
      detail: "outside_workspace",
    },
  };
}

export function createComputerTools(options: ComputerToolsOptions = {}): Record<string, ComputerToolExecutor> {
  const workingDir = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd();

  const bash: ComputerToolExecutor = async (call) => {
    const rawCmd = call.arguments.command;
    if (typeof rawCmd !== "string" || !rawCmd.trim()) {
      return { kind: "error", content: "command argument must be a non-empty string", detail: "invalid_argument" };
    }
    const command = rawCmd.trim();

    const shell = process.platform === "win32" ? "cmd.exe" : (process.env.SHELL || "/bin/zsh");
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    return new Promise<TurnToolOutcome>((resolvePromise) => {
      execFile(
        shell,
        shellArgs,
        {
          cwd: workingDir,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (error && (error as unknown as { killed?: boolean }).killed) {
            return resolvePromise({
              kind: "error",
              content: "Command timed out after 60 seconds",
              detail: "timeout",
            });
          }

          const outText = String(stdout || "").trim();
          const errText = String(stderr || "").trim();
          const parts: string[] = [];

          if (outText) parts.push(outText);
          if (errText) parts.push(`STDERR:\n${errText}`);

          if (error) {
            const exitCode = (error as unknown as { code?: number | string }).code ?? 1;
            parts.push(`Process exited with code ${exitCode}`);
            return resolvePromise({
              kind: "error",
              content: parts.join("\n\n") || `Command exited with code ${exitCode}`,
              detail: `exit ${exitCode}`,
            });
          }

          return resolvePromise({
            kind: "result",
            content: parts.join("\n\n") || "(command completed with no output)",
          });
        },
      );
    });
  };

  const readFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }

    const confined = confineOrReject(rawPath.trim(), workingDir, options.confinement);
    if (!confined.ok) return confined.outcome;
    const fullPath = confined.fullPath;
    if (!existsSync(fullPath)) {
      return { kind: "error", content: `File not found: ${rawPath}`, detail: "not_found" };
    }

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        return { kind: "error", content: `Path is a directory, not a file: ${rawPath}`, detail: "is_directory" };
      }

      const raw = readFileSync(fullPath, "utf8");
      const lines = raw.split("\n");
      const total = lines.length;

      const offsetArg = call.arguments.offset;
      const limitArg = call.arguments.limit;

      const offset = typeof offsetArg === "number" && Number.isInteger(offsetArg) && offsetArg > 0 ? offsetArg : 1;
      // An omitted (or invalid: non-integer, non-positive) `limit` defaults to
      // READ_FILE_DEFAULT_LINE_LIMIT rather than "the rest of the file" — see
      // the DR5 comment on that constant above.  A `limit` the model DOES
      // pass is honored exactly as given (never silently clamped down): the
      // byte cap just below is what bounds the worst case instead, so a
      // deliberately large page request still works.
      const limit =
        typeof limitArg === "number" && Number.isInteger(limitArg) && limitArg > 0
          ? limitArg
          : READ_FILE_DEFAULT_LINE_LIMIT;

      const startIdx = Math.max(0, offset - 1);
      const lineEndIdx = Math.min(total, startIdx + limit);
      const sliced = lines.slice(startIdx, lineEndIdx);
      const renderedLines = sliced.map((line, idx) => `${startIdx + idx + 1}: ${line}`);

      let numbered = renderedLines.join("\n");
      let returnedCount = renderedLines.length;

      // Byte cap: even within the line limit above, a file of long lines can
      // still render a huge blob.  Walk forward accumulating whole rendered
      // lines and stop before the one that would push the total over the
      // cap — trimming on whole-line boundaries means we never split a line
      // mid-way, which also means we never split a multi-byte UTF-8
      // character.
      if (Buffer.byteLength(numbered, "utf8") > READ_FILE_MAX_BYTES) {
        let kept = 0;
        let bytes = 0;
        for (const rendered of renderedLines) {
          const addBytes = Buffer.byteLength(rendered, "utf8") + (kept > 0 ? 1 : 0); // +1 for the joining "\n"
          if (bytes + addBytes > READ_FILE_MAX_BYTES) break;
          bytes += addBytes;
          kept++;
        }
        // Always return at least one line rather than an empty result, even
        // in the pathological case where a single line alone exceeds the
        // cap — the model still learns the true line count and where to
        // resume, which an empty result would not tell it.
        returnedCount = kept > 0 ? kept : Math.min(1, renderedLines.length);
        numbered = renderedLines.slice(0, returnedCount).join("\n");
      }

      const endIdx = startIdx + returnedCount;
      const byteCapped = returnedCount < renderedLines.length;
      const truncated = endIdx < total;

      // Whenever the slice does not reach the end of the file — whether the
      // line limit stopped it or the byte cap did — tell the model exactly
      // how to page rather than let it assume it saw everything.
      if (truncated) {
        const reason = byteCapped ? `${READ_FILE_MAX_BYTES}-byte cap` : `limit=${limit} lines`;
        numbered +=
          `\n\n[truncated: showed lines ${startIdx + 1}-${endIdx} of ${total} (${reason}).  ` +
          `Call read_file again with offset=${endIdx + 1} to continue, and limit to control how much comes back.]`;
      }

      return {
        kind: "result",
        content: numbered,
        detail: truncated
          ? `lines ${startIdx + 1}-${endIdx} of ${total} (truncated)`
          : `lines ${startIdx + 1}-${endIdx} of ${total}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to read file ${rawPath}: ${message}`, detail: "read_error" };
    }
  };

  const writeFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    const content = call.arguments.content;

    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof content !== "string") {
      return { kind: "error", content: "content argument must be a string", detail: "invalid_argument" };
    }

    const confined = confineOrReject(rawPath.trim(), workingDir, options.confinement);
    if (!confined.ok) return confined.outcome;
    const fullPath = confined.fullPath;
    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        kind: "result",
        content: `Successfully wrote ${bytes} bytes to ${rawPath}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to write file ${rawPath}: ${message}`, detail: "write_error" };
    }
  };

  const editFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    const oldStr = call.arguments.old_string;
    const newStr = call.arguments.new_string;

    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof oldStr !== "string" || !oldStr) {
      return { kind: "error", content: "old_string argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof newStr !== "string") {
      return { kind: "error", content: "new_string argument must be a string", detail: "invalid_argument" };
    }

    const confined = confineOrReject(rawPath.trim(), workingDir, options.confinement);
    if (!confined.ok) return confined.outcome;
    const fullPath = confined.fullPath;
    if (!existsSync(fullPath)) {
      return { kind: "error", content: `File not found: ${rawPath}`, detail: "not_found" };
    }

    try {
      const existing = readFileSync(fullPath, "utf8");
      if (!existing.includes(oldStr)) {
        return {
          kind: "error",
          content: `Target content old_string not found in ${rawPath}. Ensure exact character match.`,
          detail: "no_match",
        };
      }

      const occurrences = existing.split(oldStr).length - 1;
      if (occurrences > 1) {
        return {
          kind: "error",
          content: `Target content matched ${occurrences} times in ${rawPath}. Specify more unique context so only one match is replaced.`,
          detail: "multiple_matches",
        };
      }

      // Use a function replacement so `$` sequences in the model-supplied
      // new_string (e.g. `$&`, `$1`, `$$`) are written literally instead of
      // being interpreted as special replacement patterns.
      const replaced = existing.replace(oldStr, () => newStr);
      writeFileSync(fullPath, replaced, "utf8");
      return {
        kind: "result",
        content: `Successfully edited ${rawPath}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to edit file ${rawPath}: ${message}`, detail: "edit_error" };
    }
  };

  return {
    bash,
    read_file: readFile,
    write_file: writeFile,
    edit_file: editFile,
  };
}
