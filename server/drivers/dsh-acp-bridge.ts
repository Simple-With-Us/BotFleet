#!/usr/bin/env node
// Stdio shim in front of stock `dsh --profile acp`.
//
// `@deepseek-ai/dsh-acp` throws "mcpServers is not supported" on a non-empty
// session/new list. BotFleet still sends the same stdio mounts every other
// ACP engine gets. This process:
//   1. spawns the real `dsh` argv after `--`
//   2. zeros mcpServers on session/new, session/resume, and session/load
//   3. leaves the mounts on disk as the `--patch` overlay wrapSpawn wrote
//
// stdout is the ACP channel — never console.log here.
import { spawn } from "node:child_process";
import { rmdir, unlink } from "node:fs";
import { basename, dirname } from "node:path";
import readline from "node:readline";

const MCP_METHODS = new Set(["session/new", "session/resume", "session/load"]);
const PATCH_PREFIX = "botfleet-dsh-mcp-";

export function rewriteAcpNdjsonLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object") return line;
  const body = parsed as { method?: unknown; params?: unknown };
  if (typeof body.method !== "string" || !MCP_METHODS.has(body.method)) return line;
  if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) return line;
  const params = body.params as { mcpServers?: unknown };
  if (!Array.isArray(params.mcpServers) || params.mcpServers.length === 0) return line;
  return JSON.stringify({ ...body, params: { ...params, mcpServers: [] } });
}

export function dshMcpPatchPaths(argv: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--patch" && argv[index + 1]) {
      index += 1;
      const path = argv[index]!;
      if (basename(path).startsWith(PATCH_PREFIX)) paths.push(path);
    }
  }
  return paths;
}

function parseCommand(argv: string[]): { command: string; args: string[] } | null {
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) return null;
  const command = argv[sep + 1];
  if (!command) return null;
  return { command, args: argv.slice(sep + 2) };
}

/** Remove the overlay, and the private directory `writeDshMcpPatch` made for
 * it.  The directory removal is non-recursive and only ever runs on a name
 * carrying BotFleet's own prefix, so this can never take a directory BotFleet
 * did not mint, and one that somehow still holds a file simply stays.  An
 * overlay written straight into the temp root by an older build has no
 * directory of its own and is deleted exactly as before. */
export function createPatchCleanup(
  paths: string[],
  remove: (path: string, cb: (err: NodeJS.ErrnoException | null) => void) => void = unlink,
  removeDirectory: (path: string, cb: (err: NodeJS.ErrnoException | null) => void) => void = rmdir,
): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const path of paths) {
      const directory = dirname(path);
      const owned = basename(directory).startsWith(PATCH_PREFIX);
      // rmdir only after the unlink reports back, or the directory is not yet
      // empty and the call is a guaranteed ENOTEMPTY.
      remove(path, () => {
        if (owned) removeDirectory(directory, () => {});
      });
    }
  };
}

function main(): void {
  const parsed = parseCommand(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write("dsh-acp-bridge: missing command after --\n");
    process.exit(2);
    return;
  }
  const patchPaths = dshMcpPatchPaths(parsed.args);
  const cleanup = createPatchCleanup(patchPaths);
  const child = spawn(parsed.command, parsed.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let inbound: readline.Interface | null = null;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup();
    inbound?.close();
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  };
  child.on("error", (error) => {
    cleanup();
    inbound?.close();
    process.stderr.write(`dsh-acp-bridge: failed to spawn ${parsed.command}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", finish);

  inbound = readline.createInterface({ input: process.stdin });
  inbound.on("line", (line) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${rewriteAcpNdjsonLine(line)}\n`);
  });
  inbound.on("close", () => {
    child.stdin.end();
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const stop = (signal: NodeJS.Signals) => {
    if (child.killed || child.exitCode !== null) {
      cleanup();
      inbound?.close();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    child.kill(signal);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

const entry = process.argv[1] ?? "";
if (/(^|[\\/])dsh-acp-bridge\.(ts|js|mjs)$/.test(entry)) {
  main();
}
