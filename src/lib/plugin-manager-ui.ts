import type { PluginListingSource } from "../../server/plugin-types";

/** Public docs for drop-in plugins (linked from the manager drawer). */
export const PLUGINS_HELP_URL =
  "https://github.com/Simple-With-Us/BotFleet/blob/main/docs/plugins/DESIGN.md";

/** Turn a git install source into a browser URL for Open. */
export function gitPluginBrowseUrl(source: Extract<PluginListingSource, { kind: "git" }>): string {
  const raw = source.url.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const slug = raw.replace(/^\/+/, "");
  const base = `https://github.com/${slug}`;
  if (source.ref) return `${base}/tree/${source.ref}`;
  return base;
}

/** Folder path to reveal when the user taps Open on a folder-sourced plugin. */
export function folderPluginRevealPath(source: Extract<PluginListingSource, { kind: "folder" }>): string {
  return source.path;
}

/** Resolve a dropped file or folder into an install source string, when the shell exposes a disk path. */
export function installSourceFromDrop(
  files: FileList | readonly File[],
  getPath: (file: File) => string,
): string | null {
  const file = files[0];
  if (!file) return null;
  const path = getPath(file).trim();
  return path || null;
}
