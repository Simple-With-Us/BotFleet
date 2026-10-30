import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Follow only OS-owned aliases, as in the command allowlist's path walker. */
export function rootOwnedPathSync(configured: string): string | null {
  const absolute = resolve(configured);
  let current = parse(absolute).root;
  const pending = relative(current, absolute).split(sep).filter(Boolean);
  let links = 0;
  while (pending.length) {
    const next = join(current, pending.shift()!);
    let listed: Stats;
    try { listed = lstatSync(next); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? join(next, ...pending) : null;
    }
    if (listed.isSymbolicLink()) {
      if (process.platform === "win32" || listed.uid !== 0 || ++links > 40) return null;
      let target: string;
      try { target = readlinkSync(next); } catch { return null; }
      const destination = isAbsolute(target) ? target : resolve(current, target);
      current = parse(destination).root;
      pending.unshift(...relative(current, destination).split(sep).filter(Boolean));
    } else current = next;
  }
  return current;
}

/** Verify the handle before using it; no tool-policy protected-path rules apply. */
export function openedFileIsListedSync(opened: Stats, configured: string): boolean {
  if (!opened.isFile() || opened.nlink !== 1) return false;
  const real = rootOwnedPathSync(configured);
  if (real === null) return false;
  try {
    const listed = lstatSync(real);
    return listed.isFile() && !listed.isSymbolicLink() && listed.nlink === 1 && listed.dev === opened.dev && listed.ino === opened.ino;
  } catch { return false; }
}
