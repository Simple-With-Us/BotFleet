// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

// Confinement for a caller that is not the computer itself.
//
// The desktop may point a bot anywhere: the person is at the keyboard and
// the folder picker is theirs.  A paired phone is a bearer token that lives
// in a pocket, so a room folder set from it may only reuse or narrow what
// the computer already handed to a bot or room — never introduce a new one,
// and never the folders that hold keys or BotFleet's own state.

export interface CwdConfinement {
  /** Folders the computer already granted; the caller may pick these or
   * anything under them. */
  roots: readonly string[];
  /** Folders that stay refused even under a granted root. */
  protectedDirs: readonly string[];
}

/** The folders no phone-originated change may reach: credential stores
 * under the home folder plus the harness's own data directory.  The
 * app-owned workspaces live under that data directory and are allowed by
 * listing them as a root — the nearest ancestor decides. */
export function protectedCwdDirs(home = homedir(), dataDir?: string): string[] {
  const relative = [
    ".ssh",
    ".secrets",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".azure",
    join(".config", "gh"),
    join(".config", "gcloud"),
    join("Library", "Keychains"),
  ];
  const dirs = relative.map((rel) => join(home, rel));
  if (dataDir) dirs.push(dataDir);
  return dirs;
}

/** Real path when the folder exists; otherwise the real path of its
 * nearest existing ancestor plus the rest, so a root or protected entry
 * that has not been created yet (or a subfolder of one) still compares
 * against real paths on the other side.  Exported for other confinement
 * checks (e.g. the github tool's workspace-repo confinement) that need the
 * same symlink-safe comparison but a different root/allowlist shape than
 * `CwdConfinement` models. */
export function realOrResolved(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(realOrResolved(parent), basename(resolved));
  }
}

export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Why an already-valid folder may not be used under this confinement, or
 * null when it may.  Decided on real paths, so a symlink inside a granted
 * root that points at ~/.ssh is refused.  The nearest matching ancestor
 * wins; on a tie the protected side does. */
export function cwdConfinementError(cwd: string, confinement: CwdConfinement): string | null {
  const real = realOrResolved(cwd);
  let verdict: "root" | "protected" | null = null;
  let depth = -1;
  for (const root of confinement.roots) {
    const parent = realOrResolved(root);
    if (isInside(real, parent) && parent.length > depth) {
      depth = parent.length;
      verdict = "root";
    }
  }
  for (const guarded of confinement.protectedDirs) {
    const parent = realOrResolved(guarded);
    if (isInside(real, parent) && parent.length >= depth) {
      depth = parent.length;
      verdict = "protected";
    }
  }
  if (verdict === "root") return null;
  if (verdict === "protected") return `that folder holds keys or BotFleet's own state: ${cwd}`;
  return `that folder is not one this computer already shares with a bot: ${cwd}`;
}

/** validateBotCwd, then confinement.  Clearing the folder (null / empty)
 * always passes: narrowing is never a widening. */
export function validateConfinedCwd(input: unknown, confinement: CwdConfinement): CwdValidation {
  const checked = validateBotCwd(input);
  if (!checked.ok || checked.cwd === null) return checked;
  const refused = cwdConfinementError(checked.cwd, confinement);
  return refused ? { ok: false, error: refused } : checked;
}
