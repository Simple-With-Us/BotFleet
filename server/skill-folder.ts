// Read ONE skill folder that already sits on this computer.
//
// `skill-fetch.ts` is the network sibling of this file: it turns a GitHub
// URL into a plain {path, content} list.  This turns a folder on this disk
// into the same list, so a skill the person already has — the fleet's own
// `~/.claude/skills/<name>`, a skill they wrote, one a teammate handed them
// on a USB stick — goes through exactly the same door: `installSkill`
// validates it, `scanSkillText` scans it, and it lands DISABLED until a
// person reads the SKILL.md and turns it on.  Nothing here writes anything
// or decides anything about trust; storage and policy stay in `skills.ts`.
//
// Caps mirror `skill-fetch.ts` deliberately, including refusing the whole
// import when a file is over the per-file cap rather than quietly dropping
// it — a skill missing a reference file it names is worse than no skill.
import { isAbsolute, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const MAX_FILES = 30;
/** Same 256KB per-file cap `skill-fetch.ts` and `skills.ts` use. */
const MAX_FILE_BYTES = 256 * 1024;
/** How many non-importable entries are reported back as skipped.  The list
 * is for the review screen, not an inventory, so it does not need to be
 * complete for a folder with hundreds of files in it. */
const MAX_SKIPPED = 50;

export interface SkillFolderEntry {
  name: string;
  isDirectory: boolean;
}

/** The three filesystem operations this file needs, injected so the tests
 * can hand it a folder that never touches a real disk — and so they run the
 * same on macOS, Ubuntu and Windows. */
export interface SkillFolderReader {
  list(dir: string): SkillFolderEntry[];
  byteSize(file: string): number;
  read(file: string): string;
}

export const nodeSkillFolderReader: SkillFolderReader = {
  list: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  byteSize: (file) => statSync(file).size,
  read: (file) => readFileSync(file, "utf8"),
};

export interface ReadSkillFolder {
  source: string;
  files: Array<{ path: string; content: string }>;
}

/** Read a skill folder into the shape `installSkill` takes.
 *
 * Only top-level markdown is read.  Everything else — scripts, binaries,
 * subfolders — is handed on as an empty placeholder entry, because that is
 * how `installSkill` learns to record it under `skippedFiles`: it classifies
 * any sibling that is not markdown as skipped, and the review screen shows
 * that list so a person can see the skill shipped files BotFleet refused to
 * import.  A placeholder is never written; only the markdown is. */
export function readSkillFolder(
  folder: string,
  fs: SkillFolderReader = nodeSkillFolderReader,
): ReadSkillFolder | { error: string } {
  const dir = folder.trim();
  if (!dir) return { error: "choose a skill folder on this computer" };
  if (!isAbsolute(dir)) return { error: "choose a skill folder by its full path on this computer" };

  let entries: SkillFolderEntry[];
  try {
    entries = fs.list(dir);
  } catch {
    return { error: "that folder could not be read — check it still exists and you can open it" };
  }

  const files = entries.filter((entry) => !entry.isDirectory);
  if (!files.some((entry) => entry.name === "SKILL.md")) {
    return { error: "no SKILL.md in that folder — choose the skill's own folder, not the folder above it" };
  }

  const isMarkdown = (entry: SkillFolderEntry) => !entry.isDirectory && /\.md$/i.test(entry.name);
  const markdown = files.filter(isMarkdown);
  if (markdown.length > MAX_FILES) {
    return { error: `that folder has ${markdown.length} markdown files — the import cap is ${MAX_FILES}` };
  }
  // Placeholders carry no content and must never look like markdown to
  // `installSkill`, or it would write an empty file over a real one.
  const skipped = entries
    .filter((entry) => !isMarkdown(entry))
    .slice(0, MAX_SKIPPED)
    .map((entry) => ({ path: entry.name, content: "" }));

  const imported: Array<{ path: string; content: string }> = [];
  for (const entry of markdown) {
    const path = join(dir, entry.name);
    let size: number;
    try {
      size = fs.byteSize(path);
    } catch {
      return { error: `${entry.name} could not be read` };
    }
    if (size > MAX_FILE_BYTES) return { error: `${entry.name} is larger than the 256KB import cap` };
    try {
      imported.push({ path: entry.name, content: fs.read(path) });
    } catch {
      return { error: `${entry.name} could not be read` };
    }
  }

  return { source: dir, files: [...imported, ...skipped] };
}
