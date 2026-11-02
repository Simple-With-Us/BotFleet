/** The shared Mac-only command table (native server mode plan, slice 8a).
 *
 *  A command whose first word is in this table needs the `macos` capability,
 *  so placement never considers a Linux server for it.  The table is small
 *  and deliberate: a wrong entry in either direction is visible because the
 *  placer records "needs <command>" as the placement reason, and an explicit
 *  pin overrides the derivation.  Mirrored in Swift the way `BotComputers`
 *  is; the two copies must name the same commands. */
import type { Capability } from "./placement.ts";

/** Commands that only exist, or only act on this Mac, under macOS. */
export const MAC_ONLY_COMMANDS: readonly string[] = [
  "xcodebuild",
  "xcrun",
  "simctl",
  "codesign",
  "notarytool",
  "osascript",
  "open",
];

/** Why a command needs a capability, in the words the placer records. */
export interface DerivedCapability {
  capability: Capability;
  /** The first word that derived it, e.g. `xcodebuild`. */
  command: string;
  /** The placement reason, e.g. "needs xcodebuild". */
  reason: string;
}

function firstTwoWords(command: string): string[] {
  const head = command.split(/[;&|]/, 1)[0] ?? "";
  const words: string[] = [];
  for (const token of head.trim().split(/\s+/).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    words.push((token.split("/").filter(Boolean).pop() ?? token).replace(/^['"]|['"]$/g, ""));
    if (words.length === 2) break;
  }
  return words;
}

/** Every shell segment of a command: the runner executes the string under
 *  `/bin/sh -c`, so a Mac-only tool after `;`, `&`, `|` (`&&`, `||`, pipes
 *  included) or inside a wrapper runs exactly like one up front.  Quoted
 *  separators over-split and derive toward `macos`; that is the fail-safe
 *  direction (a Linux-able job pinned to the Mac still runs). */
function splitSegments(command: string): string[] {
  return command.split(/[;&|\n]+/).map((segment) => segment.trim()).filter(Boolean);
}

/** One segment's words with quoting resolved, so `sh -c 'xcodebuild …'`
 *  yields its script as a single word. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The word past a path prefix (`/usr/bin/xcodebuild` counts). */
function headWord(token: string): string {
  return token.split("/").filter(Boolean).pop() ?? token;
}

const SUDO_LIKE = new Set(["sudo", "doas"]);
/** `sudo` flags that consume the following word (`sudo -u worker …`). */
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-U", "-h", "-p", "-r", "-t", "-C", "-D"]);
const SHELL_LIKE = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

/** Resolve a segment to the words the shell actually executes: past leading
 *  `VAR=value` assignments and `sudo`/`env` wrappers, and into a shell's
 *  `-c` inline script (returned as `script` for the caller to re-derive).
 *  `sh file.sh` is opaque to static analysis and resolves to null. */
function resolveSegment(tokens: string[]): { words: string[] } | { script: string } | null {
  let rest = tokens;
  for (let depth = 0; depth < 4; depth++) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1);
    if (rest.length === 0) return null;
    const head = headWord(rest[0]!);
    if (SUDO_LIKE.has(head)) {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0]!.startsWith("-") && rest[0]!.length > 1 && rest[0] !== "--") {
        const flag = rest[0]!;
        rest = rest.slice(1);
        if (SUDO_VALUE_FLAGS.has(flag)) rest = rest.slice(1);
      }
      if (rest[0] === "--") rest = rest.slice(1);
      continue;
    }
    if (head === "env") {
      rest = rest.slice(1);
      while (rest.length > 0 && (rest[0] === "--" || rest[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!))) {
        const flag = rest[0]!;
        rest = rest.slice(1);
        if (flag === "-u" || flag === "--unset") rest = rest.slice(1);
        if (flag === "--") break;
      }
      continue;
    }
    if (SHELL_LIKE.has(head)) {
      rest = rest.slice(1);
      while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1);
      const flag = rest[0];
      if (flag !== undefined && flag.startsWith("-") && flag.includes("c") && rest[1] !== undefined) {
        return { script: rest[1]! };
      }
      return null;
    }
    return { words: rest.slice(0, 2).map(headWord) };
  }
  return null;
}

/** The first command word of a shell command: past leading `VAR=value`
 *  assignments and any directory part (`/usr/bin/xcodebuild` counts). */
export function firstCommandWord(command: string): string | null {
  return firstTwoWords(command)[0] ?? null;
}

/** A path that only exists on a Mac: a home folder under `/Users/`. */
export function isMacPath(path: string | undefined): boolean {
  return path !== undefined && (path === "/Users" || path.startsWith("/Users/"));
}

/** The capability a command needs by derivation, or null when it is
 *  automatic.  `swift build` counts only under a Mac path, because the same
 *  words build a Linux package on the server. */
export function derivedCapability(command: string, options: { cwd?: string } = {}): DerivedCapability | null {
  return deriveFromCommand(command, options, 0);
}

/** Derive over every shell segment (not just the first) and into `-c`
 *  inline scripts, so a wrapped or chained Mac-only tool still pins the job
 *  to a Mac.  `depth` bounds nested `sh -c 'sh -c …'` unwrapping. */
function deriveFromCommand(command: string, options: { cwd?: string }, depth: number): DerivedCapability | null {
  if (depth > 4) return null;
  for (const segment of splitSegments(command)) {
    const resolved = resolveSegment(tokenize(segment));
    if (resolved === null) continue;
    if ("script" in resolved) {
      const hit = deriveFromCommand(resolved.script, options, depth + 1);
      if (hit) return hit;
      continue;
    }
    const [first, second] = resolved.words;
    if (!first) continue;
    if (MAC_ONLY_COMMANDS.includes(first)) {
      return { capability: "macos", command: first, reason: `needs ${first}` };
    }
    if (first === "swift" && second === "build" && isMacPath(options.cwd)) {
      return { capability: "macos", command: "swift build", reason: "needs swift build" };
    }
  }
  return null;
}

/** Whether a host reporting `capabilities` may run this command at all. */
export function hostCanRunCommand(
  capabilities: readonly Capability[],
  command: string,
  options: { cwd?: string } = {},
): boolean {
  const derived = derivedCapability(command, options);
  return derived === null || capabilities.includes(derived.capability);
}
