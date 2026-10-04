// Read a plugin folder that already sits on this computer.
//
// Mirrors `skill-folder.ts` exactly so the install path is the same on
// every platform.  Caps match `skill-fetch.ts` — refusing the whole
// import when a file is over the per-file cap, never silently dropping.
//
// No network.  No host state.  This file owns exactly one concern: turn
// a folder on disk into the {manifestText, files} shape the rest of the
// plugin pipeline consumes.
import { isAbsolute, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

import type { FetchedPlugin } from "./plugin-types.ts";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SKIPPED = 50;
const MANIFEST_NAME = "botfleet-plugin.json";

export interface PluginFolderReader {
  list(dir: string): Array<{ name: string; isDirectory: boolean }>;
  byteSize(file: string): number;
  read(file: string): string;
}

export const nodePluginFolderReader: PluginFolderReader = {
  list: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  byteSize: (file) => statSync(file).size,
  read: (file) => readFileSync(file, "utf8"),
};

export interface ReadPluginFolder {
  source: string;
  fetched: FetchedPlugin;
}

/** Walk one folder, returning a manifest text + a file list.  Only
 *  top-level files are read; nested folders are recorded as skipped so
 *  the install review screen shows what was refused. */
export function readPluginFolder(
  folder: string,
  fs: PluginFolderReader = nodePluginFolderReader,
): ReadPluginFolder | { error: string } {
  const dir = folder.trim();
  if (!dir) return { error: "choose a plugin folder on this computer" };
  if (!isAbsolute(dir)) return { error: "choose a plugin folder by its full path on this computer" };

  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    entries = fs.list(dir);
  } catch {
    return { error: "that folder could not be read — check it still exists and you can open it" };
  }

  const manifestEntry = entries.find((entry) => !entry.isDirectory && entry.name === MANIFEST_NAME);
  if (!manifestEntry) {
    return { error: `no ${MANIFEST_NAME} in that folder — choose the plugin's own folder, not the folder above it` };
  }

  const manifestPath = join(dir, manifestEntry.name);
  let manifestSize: number;
  try {
    manifestSize = fs.byteSize(manifestPath);
  } catch {
    return { error: `${MANIFEST_NAME} could not be read` };
  }
  if (manifestSize > MAX_FILE_BYTES) {
    return { error: `${MANIFEST_NAME} is larger than the 256KB import cap` };
  }

  let manifestText: string;
  try {
    manifestText = fs.read(manifestPath);
  } catch {
    return { error: `${MANIFEST_NAME} could not be read` };
  }

  const files: Array<{ path: string; content: string }> = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) {
      skipped.push(entry.name);
      continue;
    }
    if (entry.name === MANIFEST_NAME) continue;

    // Refuse anything that isn't a same-level js/json/mjs/cjs file.  v1 is
    // conservative on purpose: no shell scripts, no binaries, no surprise
    // file types — the same posture skills take.
    if (!/\.(?:mjs|cjs|js|json)$/i.test(entry.name)) {
      if (skipped.length < MAX_SKIPPED) skipped.push(entry.name);
      continue;
    }

    const filePath = join(dir, entry.name);
    let size: number;
    try {
      size = fs.byteSize(filePath);
    } catch {
      return { error: `${entry.name} could not be read` };
    }
    if (size > MAX_FILE_BYTES) return { error: `${entry.name} is larger than the 256KB import cap` };

    try {
      files.push({ path: entry.name, content: fs.read(filePath) });
    } catch {
      return { error: `${entry.name} could not be read` };
    }
  }

  if (files.length > MAX_FILES) {
    return { error: `that folder has ${files.length} plugin files — the import cap is ${MAX_FILES}` };
  }

  return {
    source: dir,
    fetched: {
      source: dir,
      manifestText,
      files,
    },
  };
}