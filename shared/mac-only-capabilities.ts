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
  const [first, second] = firstTwoWords(command);
  if (!first) return null;
  if (MAC_ONLY_COMMANDS.includes(first)) {
    return { capability: "macos", command: first, reason: `needs ${first}` };
  }
  if (first === "swift" && second === "build" && isMacPath(options.cwd)) {
    return { capability: "macos", command: "swift build", reason: "needs swift build" };
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
