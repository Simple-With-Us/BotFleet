import { realpathSync } from "node:fs";

/** Scrub literal roots and the project-directory encoding used in memory_paths. */
export function createPathScrubber(roots) {
  const replacements = new Map();
  for (const [root, label] of roots) {
    if (!root) continue;
    const paths = [root];
    try { paths.push(realpathSync(root)); } catch { /* A removed probe root still needs literal scrubbing. */ }
    for (const path of paths) {
      replacements.set(path, label);
      // Claude replaces every non-alphanumeric character, including / . and _,
      // with a dash in its per-project memory directory name.
      replacements.set(path.replace(/[^a-zA-Z0-9]/g, "-"), label);
    }
  }
  const ordered = [...replacements].sort(([a], [b]) => b.length - a.length);
  return (line) => {
    let text = line;
    for (const [root, label] of ordered) text = text.split(root).join(label);
    return text;
  };
}
