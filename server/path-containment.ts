// Where a Claude Write or Edit would really land.
//
// Auto mode used to approve a file tool for any path at all, so a bot could
// write `~/.zshrc` or a LaunchAgent plist without a card.  The driver now
// carries the raw path of a file-writing ask (`fileWritePaths` in
// auto-approve.ts); this module resolves it against the filesystem and says
// whether it stays inside the folders the bot may work in: its turn folder,
// its own workspace, and the temp folder.
//
// "Where it really lands" is the point.  A string comparison is beaten by a
// symlink in the workspace, by `..` after a symlink (the OS walks out of the
// link's TARGET, not out of the link's folder), and by a dangling symlink
// (a write follows it and creates the target).  So the path is walked one
// component at a time against the real filesystem, the way the OS would, and
// everything that cannot be established counts as outside: a relative path, a
// `~` or `$HOME` spelling, a symlink loop, a dangling link, a permission
// error, a NUL byte.  A file that does not exist yet is judged by its nearest
// existing parent.
//
// Like the rest of the guard this is not a security boundary: a link planted
// between this check and the write is not seen.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { FileWriteCheck } from "./auto-approve.ts";
import { cwdConfinementError, isInside, protectedCwdDirs, realOrResolved } from "./bot-cwd.ts";

export interface WriteCheckOptions {
  /** Folders a write may land in: the turn's folder, the bot's workspace,
   * the temp folders.  A root that is missing, relative, unresolvable, the
   * home folder, or an ancestor of it (the filesystem root included) is
   * ignored, because a root that wide would call `~/.zshrc` inside. */
  roots: ReadonlyArray<string | undefined>;
  /** Defaults to the user's home folder. */
  home?: string;
  /** BotFleet's data directory, protected unless a root sits inside it. */
  dataDir?: string;
}

const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/** The physical location a write to `raw` would land on, following the OS's
 * own rules, or null when that cannot be established. */
function physicalLocation(raw: string): string | null {
  const root = parse(raw).root;
  if (!root) return null;
  const segments = raw.slice(root.length).split(SEPARATORS).filter((segment) => segment !== "" && segment !== ".");
  let current: string;
  try {
    current = realpathSync.native(root);
  } catch {
    return null;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    // `current` is physical, so its parent is what `..` means to the OS
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    try {
      current = realpathSync.native(next);
      continue;
    } catch (error) {
      // ELOOP, EACCES, ENOTDIR: something is there that cannot be followed
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") return null;
    }
    // ENOENT is also what a dangling symlink reports, and a write follows it
    try {
      lstatSync(next);
      return null;
    } catch {
      // really absent
    }
    // below a folder that does not exist, `..` has no meaning to the OS
    const rest = segments.slice(i + 1);
    return rest.includes("..") ? null : join(next, ...rest);
  }
  return current;
}

function usableRoots(roots: WriteCheckOptions["roots"], home: string): string[] {
  const physicalHome = physicalLocation(home) ?? home;
  const usable: string[] = [];
  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;
    const physical = physicalLocation(root);
    if (physical === null || isInside(physicalHome, physical)) continue;
    usable.push(physical);
  }
  return usable;
}

/** Judge one spelling; returns the reason it is not contained, if any. */
function judge(
  raw: string,
  confinement: { roots: string[]; protectedDirs: string[] },
  real: Set<string>,
): string | undefined {
  if (raw.includes("\0")) return "invalid-path";
  // File tools take absolute paths.  Resolving a relative one against a folder
  // here would be a guess about where the CLI thinks it is, and `~`, `$HOME`
  // and `%USERPROFILE%` only mean something to a shell.
  if (!isAbsolute(raw)) return "relative-path";
  // The OS reading of the path, and the plain-string reading of it: they only
  // differ when `..` follows a symlink, and then both must stay inside.
  const readings = new Set<string | null>([physicalLocation(raw)]);
  if (raw.split(SEPARATORS).includes("..")) readings.add(physicalLocation(resolve(raw)));
  if (readings.has(null)) return "unresolvable";
  let why: string | undefined;
  for (const reading of readings) {
    if (reading === null) continue;
    real.add(reading);
    if (cwdConfinementError(reading, confinement) === null) continue;
    why ??= confinement.protectedDirs.some((dir) => isInside(reading, realOrResolved(dir))) ? "protected-dir" : "outside-roots";
  }
  return why;
}

/** Whether every path of a file-writing ask lands inside the roots.  `real`
 * lists where each one would physically land, so the caller can run its
 * sensitive-file patterns on the place the write ends up, not on how the
 * model spelled it. */
export function checkWriteTargets(paths: readonly string[], options: WriteCheckOptions): FileWriteCheck {
  if (paths.length === 0) return { contained: false, why: "no-path", real: [] };
  const home = options.home ?? homedir();
  const confinement = {
    roots: usableRoots(options.roots, home),
    protectedDirs: protectedCwdDirs(home, options.dataDir),
  };
  const real = new Set<string>();
  let why: string | undefined;
  for (const raw of paths) why ??= judge(raw, confinement, real);
  return why === undefined ? { contained: true, real: [...real] } : { contained: false, why, real: [...real] };
}
