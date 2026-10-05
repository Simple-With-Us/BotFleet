// The on-disk plugin registry.  Lives at <DATA_DIR>/plugins/.
//
// The registry is one file: registry.json.  It records name, version,
// enabled flag, install source, and timestamps.  The on-disk layout
// for one plugin is <DATA_DIR>/plugins/<name>/, containing the
// manifest and the plugin's own files.
//
// The host owns this directory.  Nothing in a plugin path can reach
// into it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { parsePluginManifest } from "../shared/plugin-manifest.ts";
import {
  PluginRegistrySchema,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSource,
  type PluginListing,
  type FetchedPlugin,
} from "./plugin-types.ts";

export const PLUGINS_DIR = join(DATA_DIR, "plugins");
export const REGISTRY_PATH = join(PLUGINS_DIR, "registry.json");

function registryPathFor(baseDir: string): string {
  return join(baseDir, "registry.json");
}

function pluginDirFor(name: string, baseDir: string): string {
  return join(baseDir, name);
}

const TRANSIENT_RM_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errnoCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/** Windows-safe recursive remove for plugin trees.  A just-killed sandbox
 *  child can still hold directory handles on win32, so bare rmSync fails
 *  with EPERM.  Retries with backoff on EPERM/EBUSY/ENOTEMPTY.  Midway on
 *  win32, renames the tree aside so a caller can recreate the original
 *  path while the aside delete keeps retrying.  Never swallows a permanent
 *  error, and never returns success while the original path still exists
 *  after exhausting retries. */
export function removeDirSafe(target: string, options: { attempts?: number } = {}): void {
  const attempts = options.attempts ?? 10;
  let path = target;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (!existsSync(path)) return;
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = errnoCode(error);
      if (!TRANSIENT_RM_CODES.has(code)) throw error;
      if (
        process.platform === "win32" &&
        path === target &&
        i >= Math.floor(attempts / 2) &&
        existsSync(target)
      ) {
        const aside = `${target}.removing-${process.pid}-${Date.now()}-${i}`;
        try {
          renameSync(target, aside);
          path = aside;
        } catch {
          // rename failed; keep retrying the original path
        }
      }
      sleepSyncMs(20 + i * 10);
    }
  }
  // Rename-aside freed the original path even if the aside is still locked.
  if (path !== target && !existsSync(target)) return;
  throw lastError;
}

/** Production paths used by the host.  Tests pass an explicit baseDir
 *  so they never touch the host data directory. */
export function getPluginDir(name: string): string {
  return pluginDirFor(name, PLUGINS_DIR);
}

/** Short correlation id for a plugin in logs.  Mirrors pluginLogId in
 *  plugin-loader.ts; duplicated here so the registry does not import the
 *  loader. */
function logId(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

/** Move an unparseable registry aside so the next write cannot silently
 *  overwrite the user's installed-plugin records.  Best effort: if the
 *  rename fails, the caller still treats the registry as empty. */
function quarantineRegistry(path: string): void {
  try {
    renameSync(path, `${path}.invalid-${Date.now()}`);
  } catch {
    // leave it in place; the structured warning below still fires
  }
}

/** A single source of truth for the registry file.  Persisted JSON is a
 *  runtime boundary: the file is accepted only when PluginRegistrySchema
 *  parses every entry.  A missing file is a fresh registry.  A corrupt or
 *  malformed file is quarantined, logged with a stable reason code, and
 *  treated as a fresh registry, so malformed records never reach the
 *  lifecycle code. */
export function readRegistry(baseDir: string = PLUGINS_DIR): PluginRegistry {
  const path = registryPathFor(baseDir);
  if (!existsSync(path)) return { version: 1, plugins: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(JSON.stringify({ event: "plugins.registry.invalid", reason: "unreadable" }));
    quarantineRegistry(path);
    return { version: 1, plugins: {} };
  }
  const result = PluginRegistrySchema.safeParse(parsed);
  if (!result.success) {
    console.warn(JSON.stringify({ event: "plugins.registry.invalid", reason: "schema_mismatch" }));
    quarantineRegistry(path);
    return { version: 1, plugins: {} };
  }
  return result.data;
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
  // Remove first so an update never inherits stale files.  Callers must
  // dispose any live sandbox for this plugin before reaching here.
  removeDirSafe(dir);
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
/** Stable reason codes for a listing failure.  Logs carry the code; the
 *  human-readable `error` goes to the API caller only. */
export type PluginListingFailure = "not_installed" | "manifest_missing" | "manifest_unreadable" | "manifest_invalid";

export function listingFor(
  name: string,
  baseDir: string = PLUGINS_DIR,
): PluginListing | { error: string; reason: PluginListingFailure } {
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (!entry) return { error: `no plugin named "${name}"`, reason: "not_installed" };

  const manifestPath = join(pluginDirFor(name, baseDir), "botfleet-plugin.json");
  if (!existsSync(manifestPath)) {
    return { error: `plugin "${name}" has no manifest on disk`, reason: "manifest_missing" };
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { error: `plugin "${name}" manifest is unreadable`, reason: "manifest_unreadable" };
  }

  const parsed = parsePluginManifest(manifestValue);
  if (!parsed.ok) {
    return {
      error: `plugin "${name}" has an invalid manifest: ${parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      reason: "manifest_invalid",
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
 *  unreadable manifests are skipped with a structured warning logged,
 *  never silently dropped.  The warning carries an allow-listed event,
 *  a stable reason code, and a hashed plugin id: no plugin name, no
 *  manifest content, no parser detail. */
export function listAllPlugins(baseDir: string = PLUGINS_DIR): PluginListing[] {
  const registry = readRegistry(baseDir);
  const listings: PluginListing[] = [];
  for (const name of Object.keys(registry.plugins).sort()) {
    const listing = listingFor(name, baseDir);
    if ("error" in listing) {
      console.warn(JSON.stringify({ event: "plugins.listing.skipped", reason: listing.reason, pluginId: logId(name) }));
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
  removeDirSafe(baseDir);
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