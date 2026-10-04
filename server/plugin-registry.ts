// The on-disk plugin registry.  Lives at <DATA_DIR>/plugins/.
//
// The registry is one file: registry.json.  It records name, version,
// enabled flag, install source, and timestamps.  The on-disk layout
// for one plugin is <DATA_DIR>/plugins/<name>/, containing the
// manifest and the plugin's own files.
//
// The host owns this directory.  Nothing in a plugin path can reach
// into it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { parsePluginManifest } from "../shared/plugin-manifest.ts";
import type { JsonValue } from "./schema.ts";
import type { PluginRegistry, PluginRegistryEntry, PluginSource, PluginListing, FetchedPlugin } from "./plugin-types.ts";

export const PLUGINS_DIR = join(DATA_DIR, "plugins");
export const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");

function registryPathFor(baseDir: string): string {
  return join(baseDir, "registry.json");
}

function pluginDirFor(name: string, baseDir: string): string {
  return join(baseDir, name);
}

/** Production paths used by the host.  Tests pass an explicit baseDir
 *  so they never touch the host data directory. */
export function getPluginDir(name: string): string {
  return pluginDirFor(name, PLUGINS_DIR);
}

/** A safe object predicate — anything with `Object` in its prototype chain
 *  is a record-like value, not a primitive.  Replaces `typeof === "object"`
 *  for our internal data (we never reach for untrusted JSON here). */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** A single source of truth for the registry file.  Returns a
 *  defensive shallow copy so callers cannot mutate the cached object. */
export function readRegistry(baseDir: string = PLUGINS_DIR): PluginRegistry {
  try {
    const raw = readFileSync(registryPathFor(baseDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRegistryDoc(parsed)) return parsed;
  } catch {
    // a missing or corrupt registry is a fresh registry, not an error
  }
  return { version: 1, plugins: {} };
}

/** The on-disk registry shape, narrowed from the loose `unknown` value
 *  JSON.parse yields.  A registry is { version: number, plugins: object }
 *  where `plugins` is a flat object of entries.  Anything else returns
 *  false so the caller treats it as a fresh registry. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isRegistryDoc(value: unknown): value is PluginRegistry {
  if (!isPlainObject(value)) return false;
  // SAFETY: isPlainObject has confirmed the shape is a record; the cast to { version?, plugins? } narrows for the field-by-field checks below.
  const candidate = value as { version?: unknown; plugins?: unknown };
  if (candidate.version !== 1) return false;
  if (!isPlainObject(candidate.plugins)) return false;
  return true;
}

/** Atomically write the registry.  The directory is created with
 *  mode 0o700 because plugin paths contain user code. */
export function writeRegistry(registry: PluginRegistry, baseDir: string = PLUGINS_DIR): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  writeFileSync(registryPathFor(baseDir), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

export function pluginExists(name: string): boolean {
  return existsSync(getPluginDir(name));
}

/** A shallow-merge update to one entry.  Caller is responsible for
 *  having validated any new manifest fields. */
export function setPluginEntry(entry: PluginRegistryEntry, baseDir: string = PLUGINS_DIR): PluginRegistry {
  const registry = readRegistry(baseDir);
  registry.plugins[entry.name] = entry;
  writeRegistry(registry, baseDir);
  return registry;
}

export function removePluginEntry(name: string, baseDir: string = PLUGINS_DIR): PluginRegistry {
  const registry = readRegistry(baseDir);
  if (!registry.plugins[name]) return registry;
  delete registry.plugins[name];
  writeRegistry(registry, baseDir);
  return registry;
}

/** Write a fetched plugin to disk.  Manifest is written last so a
 *  half-written tree is always detectable by the missing manifest. */
export function writePluginTree(
  name: string,
  fetched: FetchedPlugin,
  baseDir: string = PLUGINS_DIR,
): void {
  const dir = pluginDirFor(name, baseDir);
  // remove first so an update never inherits stale files
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const file of fetched.files) {
    if (file.path === "botfleet-plugin.json") continue;
    const relative = file.path;
    if (relative.startsWith("/") || relative.includes("..")) {
      // never write outside the plugin dir, even if the manifest said so
      continue;
    }
    const target = join(dir, relative);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.content, { mode: 0o600 });
  }

  // Manifest goes last.  Anyone listing plugins reads the directory
  // and validates the manifest; a missing manifest means "incomplete
  // install" and we surface that to the user.
  writeFileSync(join(dir, "botfleet-plugin.json"), fetched.manifestText, { mode: 0o600 });
}

/** Build a listing from a registry entry.  Re-reads the manifest from
 *  disk because the registry only carries the version, not the full
 *  manifest. */
export function listingFor(name: string, baseDir: string = PLUGINS_DIR): PluginListing | { error: string } {
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (!entry) return { error: `no plugin named "${name}"` };

  const manifestPath = join(pluginDirFor(name, baseDir), "botfleet-plugin.json");
  if (!existsSync(manifestPath)) return { error: `plugin "${name}" has no manifest on disk` };

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    // SAFETY: JSON.parse only throws SyntaxError with a `message` property; every catch on readFileSync catches an Error or SystemError with `message`.
    const detail = (error as Error).message;
    return { error: `plugin "${name}" manifest is unreadable: ${detail}` };
  }

  // SAFETY: JSON.parse returns a JSON-compatible value (string, number, boolean, null, array, or plain object); JsonValue is the closed union of those shapes, so the cast downcasts to the parser's documented input type.
  const parsed = parsePluginManifest(manifestValue as JsonValue);
  if (!parsed.ok) {
    return {
      error: `plugin "${name}" has an invalid manifest: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
    };
  }

  return {
    name: entry.name,
    version: parsed.manifest.version,
    description: parsed.manifest.description,
    author: parsed.manifest.author,
    license: parsed.manifest.license,
    botfleet: parsed.manifest.botfleet,
    entry: parsed.manifest.entry,
    enabled: entry.enabled,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    source: entry.source,
    warnings: entry.warnings,
    capabilities: parsed.manifest.capabilities,
    contributes: parsed.manifest.contributes,
  };
}

/** Build listings for every plugin in the registry.  Plugins with
 *  unreadable manifests are skipped with a warning logged — never
 *  silently dropped. */
export function listAllPlugins(baseDir: string = PLUGINS_DIR): PluginListing[] {
  const registry = readRegistry(baseDir);
  const listings: PluginListing[] = [];
  for (const name of Object.keys(registry.plugins).sort()) {
    const listing = listingFor(name, baseDir);
    if ("error" in listing) {
      console.warn(`[plugins] skipping ${name}: ${listing.error}`);
      continue;
    }
    listings.push(listing);
  }
  return listings;
}

/** Build a fresh registry entry from an install source.  Used by
 *  plugins.ts when neither an entry nor a directory already exists. */
export function buildEntry(args: {
  name: string;
  version: string;
  source: PluginSource;
  warnings: string[];
}): PluginRegistryEntry {
  const now = new Date().toISOString();
  return {
    name: args.name,
    version: args.version,
    enabled: false,
    installedAt: now,
    updatedAt: now,
    source: args.source,
    warnings: args.warnings,
  };
}

/** When the user clicks update, build a refreshed entry keeping the
 *  installedAt timestamp and the enabled flag. */
export function rebuildEntryForUpdate(args: {
  existing: PluginRegistryEntry;
  version: string;
  source: PluginSource;
}): PluginRegistryEntry {
  return {
    ...args.existing,
    version: args.version,
    updatedAt: new Date().toISOString(),
    source: args.source,
  };
}

/** Used by tests to fully reset a base directory. */
export function clearPluginsDir(baseDir: string = PLUGINS_DIR): void {
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
}

/** List plugin directory names on disk — used to clean up any tree
 *  the registry lost track of. */
export function listPluginDirs(baseDir: string = PLUGINS_DIR): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "lost+found")
    .map((entry) => entry.name)
    .sort();
}