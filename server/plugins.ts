// The plugin lifecycle.  install / enable / disable / update / remove
// / list / get / reload / runCommand / getCardData.
//
// Each method is idempotent and returns the same PluginListing shape so
// the UI can render the result without a second fetch.  Errors are
// objects with a single `error` field — never thrown across the API
// boundary because that policy is meaningless at HTTP edges and slow
// elsewhere.
//
// The in-memory cache of loaded plugins is one module-level Map.  It
// survives until the server restarts; explicit `reload` invalidates
// the entry.  Disabled plugins are dropped from the cache so they
// cannot be invoked until re-enabled.
//
// Every API takes an optional `baseDir` for tests.  Production code
// uses the default; tests pass a mkdtemp'd directory so they never
// touch the host's user data.

import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  HOST_API_VERSION,
  parsePluginManifestJson,
  satisfiesBotfleetVersion,
} from "../shared/plugin-manifest.ts";

import {
  buildEntry,
  listingFor,
  listAllPlugins,
  PLUGINS_DIR,
  readRegistry,
  rebuildEntryForUpdate,
  removePluginEntry,
  setPluginEntry,
  writePluginTree,
} from "./plugin-registry.ts";

import { readPluginFolder } from "./plugin-folder.ts";
import { fetchPluginFromGit, parseGitPluginSource } from "./plugin-fetch.ts";
import {
  loadPlugin,
  type LoadedPlugin,
  type PluginHostBotSummary,
  type PluginHostInputs,
} from "./plugin-loader.ts";

import type {
  PluginListing,
  PluginRegistryEntry,
  PluginSource,
} from "./plugin-types.ts";

/** Inputs the host injects so plugins see the live snapshot.  Wired
 *  to server bootstrap with a real bot store and config snapshot. */
export interface PluginRuntimeInputs {
  listBots(): PluginHostBotSummary[];
  listConfigKeys(): readonly string[];
  readConfig<T = unknown>(key: string): T | undefined;
  logger(level: "info" | "warn" | "error", name: string, message: string): void;
}

let runtimeInputs: PluginRuntimeInputs | null = null;
const loaded = new Map<string, LoadedPlugin>();

/** Bootstrap the plugin runtime with host-side inputs.  Called once at
 *  server boot from server/index.ts. */
export function initPluginRuntime(inputs: PluginRuntimeInputs): void {
  runtimeInputs = inputs;
}

function inputsOrThrow(): PluginHostInputs {
  if (!runtimeInputs) throw new Error("plugin runtime not initialized — call initPluginRuntime()");
  return {
    listBots: () => runtimeInputs!.listBots(),
    listConfigKeys: () => runtimeInputs!.listConfigKeys(),
    readConfig: <T>(key: string) => runtimeInputs!.readConfig<T>(key),
    logger: (level, name, message) => runtimeInputs!.logger(level, name, message),
  };
}

/** Validate a fetched plugin and write its tree to disk.  Returns the
 *  parsed manifest so the caller can read fields like `name` and
 *  `version` before recording the registry entry. */
async function installFromFetched(
  source: string,
  fetched: {
    manifestText: string;
    files: Array<{ path: string; content: string }>;
  },
  pluginSource: PluginSource,
  baseDir: string,
): Promise<{ entry: PluginRegistryEntry } | { error: string }> {
  const parsed = parsePluginManifestJson(fetched.manifestText);
  if (!parsed.ok) {
    return {
      error: `manifest validation failed: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
    };
  }

  const manifest = parsed.manifest;
  const registry = readRegistry(baseDir);
  if (registry.plugins[manifest.name]) {
    return { error: `a plugin named "${manifest.name}" is already installed — remove it first` };
  }

  // Write the tree, then record the registry.  Order matters: a tree
  // without a registry entry is "incomplete install", which the user
  // can retry; a registry entry without a tree is a worse failure.
  writePluginTree(manifest.name, {
    source,
    manifestText: fetched.manifestText,
    files: fetched.files,
  }, baseDir);

  const entry = buildEntry({
    name: manifest.name,
    version: manifest.version,
    source: pluginSource,
    warnings: [],
  });
  setPluginEntry(entry, baseDir);
  return { entry };
}

/** Resolve a plugin listing or return its error shape to the caller. */
function listingOrError(name: string, baseDir: string): PluginListing | { error: string } {
  return listingFor(name, baseDir);
}

/** Install a plugin from a local folder or a git source. */
export async function installPlugin(
  sourceInput: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const trimmed = sourceInput.trim();
  if (!trimmed) return { error: "paste a folder path or a GitHub URL" };

  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return installFromFolder(trimmed, baseDir);
  }

  const parsed = parseGitPluginSource(trimmed);
  if (!parsed.ok) return { error: parsed.error };

  let fetched;
  try {
    fetched = await fetchPluginFromGit(parsed.source);
  } catch (error) {
    // SAFETY: fetchPluginFromGit throws plain `Error` instances; the catch clause here only sees that shape.
    const detail = (error as Error).message;
    return { error: detail };
  }

  const pluginSource: PluginSource = {
    kind: "git",
    url: parsed.source.url,
    ref: parsed.source.ref,
  };
  const result = await installFromFetched(fetched.source, fetched, pluginSource, baseDir);
  if ("error" in result) return result;
  return listingOrError(result.entry.name, baseDir);
}

async function installFromFolder(
  folder: string,
  baseDir: string,
): Promise<PluginListing | { error: string }> {
  const read = readPluginFolder(folder);
  if ("error" in read) return { error: read.error };
  const pluginSource: PluginSource = { kind: "folder", path: folder };
  const result = await installFromFetched(read.source, read.fetched, pluginSource, baseDir);
  if ("error" in result) return result;
  return listingOrError(result.entry.name, baseDir);
}

/** Enable a plugin: validate, import its module, hand it the host. */
export async function enablePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;

  if (!loaded.has(name)) {
    const loaded_ = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in loaded_) return { error: loaded_.error };
    loaded.set(name, loaded_);
  }

  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (entry) setPluginEntry({ ...entry, enabled: true }, baseDir);
  return listingOrError(name, baseDir);
}

/** Disable a plugin: drop the loaded module, flip the flag. */
export async function disablePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;

  loaded.delete(name);
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (entry) setPluginEntry({ ...entry, enabled: false }, baseDir);
  return listingOrError(name, baseDir);
}

/** Update a plugin to the latest source.  Re-fetches, validates, and
 *  reloads the module.  Returns the new listing. */
export async function updatePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (!entry) return { error: `no plugin named "${name}"` };

  let fetched;
  try {
    if (entry.source.kind === "folder") {
      const read = readPluginFolder(entry.source.path);
      if ("error" in read) return { error: read.error };
      fetched = read.fetched;
    } else {
      const parsed = parseGitPluginSource(`https://${entry.source.url}`);
      if (!parsed.ok) return { error: parsed.error };
      const source = {
        ...parsed.source,
        ref: entry.source.ref ?? parsed.source.ref,
      };
      fetched = await fetchPluginFromGit(source);
    }
  } catch (error) {
    // SAFETY: the read/fetch paths only throw `Error` instances; the catch here sees that shape.
    const detail = (error as Error).message;
    return { error: detail };
  }

  const parsed = parsePluginManifestJson(fetched.manifestText);
  if (!parsed.ok) {
    return { error: `updated manifest is invalid: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}` };
  }

  if (parsed.manifest.name !== name) {
    return { error: `updated manifest claims a different name "${parsed.manifest.name}"` };
  }

  writePluginTree(name, {
    source: fetched.source,
    manifestText: fetched.manifestText,
    files: fetched.files,
  }, baseDir);

  const next = rebuildEntryForUpdate({
    existing: entry,
    version: parsed.manifest.version,
    source: entry.source,
  });
  setPluginEntry(next, baseDir);

  // Reload the module if it was enabled.
  if (loaded.has(name)) {
    loaded.delete(name);
    if (entry.enabled) {
      const refreshed = listingOrError(name, baseDir);
      if (!("error" in refreshed)) {
        const loaded_ = await loadPlugin(refreshed, inputsOrThrow(), baseDir);
        if (!("error" in loaded_)) loaded.set(name, loaded_);
      }
    }
  }

  return listingOrError(name, baseDir);
}

/** Remove a plugin entirely.  Drops from cache, deletes tree, removes
 *  registry entry. */
export async function removePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<{ removed: true } | { error: string }> {
  const registry = readRegistry(baseDir);
  if (!registry.plugins[name]) return { error: `no plugin named "${name}"` };

  loaded.delete(name);
  removePluginEntry(name, baseDir);
  rmSync(join(baseDir, name), { recursive: true, force: true });
  return { removed: true };
}

/** Reload a plugin's module without changing enable state. */
export async function reloadPlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;
  loaded.delete(name);
  const registry = readRegistry(baseDir);
  if (registry.plugins[name]?.enabled) {
    const loaded_ = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in loaded_) return { error: loaded_.error };
    loaded.set(name, loaded_);
  }
  return listing;
}

/** List all installed plugins. */
export function listPlugins(baseDir: string = PLUGINS_DIR): PluginListing[] {
  return listAllPlugins(baseDir);
}

/** Fetch one plugin's listing. */
export function getPlugin(name: string, baseDir: string = PLUGINS_DIR): PluginListing | { error: string } {
  return listingFor(name, baseDir);
}

/** Run a plugin's slash command. */
export async function runPluginCommand(
  name: string,
  command: string,
  args: string,
  baseDir: string = PLUGINS_DIR,
): Promise<{ text: string } | { error: string }> {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  const registry = readRegistry(baseDir);
  if (!registry.plugins[name]?.enabled) return { error: `plugin "${name}" is disabled` };

  let plugin = loaded.get(name);
  if (!plugin) {
    const result = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in result) return { error: result.error };
    loaded.set(name, result);
    plugin = result;
  }
  if (!plugin.module.runCommand) return { error: `plugin "${name}" does not implement runCommand` };
  try {
    const text = await plugin.module.runCommand({ command, args, host: plugin.host });
    return { text: String(text ?? "") };
  } catch (error) {
    // SAFETY: plugin authors throw plain `Error` objects; the host has no other handler to consult.
    const detail = (error as Error).message;
    return { error: `plugin "${name}" command failed: ${detail}` };
  }
}

/** Fetch a plugin's card data. */
export async function getPluginCardData(
  name: string,
  cardId: string,
  baseDir: string = PLUGINS_DIR,
): Promise<{ data: unknown } | { error: string }> {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  const registry = readRegistry(baseDir);
  if (!registry.plugins[name]?.enabled) return { error: `plugin "${name}" is disabled` };

  let plugin = loaded.get(name);
  if (!plugin) {
    const result = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in result) return { error: result.error };
    loaded.set(name, result);
    plugin = result;
  }
  if (!plugin.module.getCardData) return { error: `plugin "${name}" has no card data handler` };
  try {
    const data = await plugin.module.getCardData({ cardId, host: plugin.host });
    return { data };
  } catch (error) {
    // SAFETY: plugin authors throw plain `Error` objects; the host has no other handler to consult.
    const detail = (error as Error).message;
    return { error: `plugin "${name}" card failed: ${detail}` };
  }
}

/** Boot-time loader: walk every enabled plugin and import its module.
 *  Errors are logged and the plugin is left disabled, never thrown. */
export async function bootPluginRuntime(baseDir: string = PLUGINS_DIR): Promise<void> {
  if (!runtimeInputs) return;
  const registry = readRegistry(baseDir);
  for (const name of Object.keys(registry.plugins)) {
    const entry = registry.plugins[name];
    if (!entry?.enabled) continue;
    const listing = listingFor(name, baseDir);
    if ("error" in listing) {
      console.warn(`[plugins] boot: ${listing.error}`);
      continue;
    }
    if (!satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) {
      console.warn(
        `[plugins] boot: ${name} requires botfleet ${listing.botfleet}, host is ${HOST_API_VERSION} — leaving disabled`,
      );
      setPluginEntry({ ...entry, enabled: false }, baseDir);
      continue;
    }
    const result = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in result) {
      console.warn(`[plugins] boot: ${result.error}`);
      setPluginEntry({ ...entry, enabled: false }, baseDir);
      continue;
    }
    loaded.set(name, result);
  }
}

/** Test-only: drop all loaded modules and the runtime inputs. */
export function _resetForTests(): void {
  loaded.clear();
  runtimeInputs = null;
}

/** Test-only: a snapshot of loaded modules. */
export function _loadedNames(): string[] {
  return [...loaded.keys()].sort();
}