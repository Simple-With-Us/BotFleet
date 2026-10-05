// The plugin lifecycle.  install / enable / disable / update / remove
// / list / get / reload / runCommand / getCardData.
//
// Each method is idempotent and returns the same PluginListing shape so
// the UI can render the result without a second fetch.  Errors are
// objects with an `error` string.  Manifest failures also carry `issues`
// so the UI can render one row per field.  Nothing is thrown across the
// API boundary because that policy is meaningless at HTTP edges and slow
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

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  HOST_API_VERSION,
  parsePluginManifestJson,
  satisfiesBotfleetVersion,
  type PluginManifestIssue,
} from "../shared/plugin-manifest.ts";

import {
  buildEntry,
  listingFor,
  listAllPlugins,
  PLUGINS_DIR,
  readRegistry,
  rebuildEntryForUpdate,
  removeDirSafe,
  removePluginEntry,
  setPluginEntry,
  writePluginTree,
} from "./plugin-registry.ts";

import { readPluginFolder } from "./plugin-folder.ts";
import { fetchPluginFromGit, parseGitPluginSource, PluginFetchError } from "./plugin-fetch.ts";
import {
  invokePlugin,
  loadPlugin,
  pluginLogId,
  type LoadedPlugin,
  type PluginHostBotSummary,
  type PluginHostInputs,
  type PluginLogEvent,
} from "./plugin-loader.ts";
import { PluginCardResultSchema, PluginCommandResultSchema } from "./plugin-sandbox-protocol.ts";

import type {
  FetchedPlugin,
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
  /** Receives allow-listed structured events only.  No event carries
   *  plugin-supplied text; see PluginLogEvent. */
  logger(event: PluginLogEvent): void;
}

let runtimeInputs: PluginRuntimeInputs | null = null;
const loaded = new Map<string, LoadedPlugin>();
const loading = new Map<string, Promise<LoadedPlugin | { error: string }>>();

const PluginActionSchema = z.enum(["enable", "disable", "update", "reload"]);
export type PluginAction = z.infer<typeof PluginActionSchema>;
const PluginActionRouteSchema = z.tuple([z.string().min(1).max(64), PluginActionSchema]);

/** Pure route matcher for plugin action endpoints.  Lives in server/
 *  plugins.ts so server/index.ts can dispatch through it without taking
 *  on the path-parsing responsibility itself.  Returns the plugin name
 *  and the action when the path matches `/api/plugins/<name>/<action>`
 *  exactly; every other shape returns null.  Anchored with `$` so a
 *  path like `/api/plugins/foo/enable/extra` does not match. */
export function matchPluginActionRoute(path: string): { name: string; action: PluginAction } | null {
  const parsed = PluginActionRouteSchema.safeParse(
    path.match(/^\/api\/plugins\/([\w][\w-]*)\/(enable|disable|update|reload)$/)?.slice(1),
  );
  if (!parsed.success) return null;
  const [name, action] = parsed.data;
  return { name, action };
}

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
    logger: (event) => runtimeInputs!.logger(event),
  };
}

/** Stop a plugin's sandbox process and forget it.  Every path that drops
 *  a plugin from the cache goes through here so no child is orphaned.
 *  Awaits process exit so Windows releases directory handles before the
 *  caller deletes the on-disk tree. */
async function dropLoaded(name: string): Promise<void> {
  const plugin = loaded.get(name);
  if (!plugin) return;
  loaded.delete(name);
  await plugin.sandbox.dispose();
}

/** The cached sandbox for an enabled plugin, respawned when the previous
 *  child exited (crash, timeout kill, or protocol violation).  Concurrent
 *  callers share one in-flight load so a crash cannot spawn orphaned
 *  children that `loaded.set` would overwrite. */
async function liveSandbox(listing: PluginListing, baseDir: string): Promise<LoadedPlugin | { error: string }> {
  const cached = loaded.get(listing.name);
  if (cached?.sandbox.isAlive()) return cached;
  const inflight = loading.get(listing.name);
  if (inflight) return inflight;
  const attempt = (async () => {
    await dropLoaded(listing.name);
    const result = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in result) return result;
    loaded.set(listing.name, result);
    return result;
  })();
  loading.set(listing.name, attempt);
  try {
    return await attempt;
  } finally {
    loading.delete(listing.name);
  }
}

/** One structured boot/listing warning.  `reason` is a stable code. */
function warnPluginEvent(event: string, name: string, reason: string): void {
  console.warn(JSON.stringify({ event, reason, pluginId: pluginLogId(name) }));
}

/** User-facing text for a network-level fetch failure.  PluginFetchError
 *  messages are written by plugin-fetch.ts and carry no upstream payload;
 *  anything else gets this fixed message. */
const FETCH_FAILED = "the plugin could not be downloaded";

/** Manifest and other lifecycle failures.  `issues` is set only when
 *  zod rejected the manifest, one row per field. */
export interface PluginError {
  error: string;
  issues?: PluginManifestIssue[];
}

function missingEntryFile(
  entry: string,
  files: Array<{ path: string }>,
): PluginError | null {
  if (files.some((file) => file.path === entry)) return null;
  return { error: `entry: "${entry}" is not one of the installed plugin files` };
}

/** Compare two strict MAJOR.MINOR.PATCH strings.  Returns <0 when `a` is
 *  older than `b`, 0 when equal, >0 when `a` is newer.  Manifest versions
 *  are already schema-checked as SEMVER, so this stays numeric. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Map a filesystem failure into the plugins API error shape. */
function fsErrorMessage(action: string, name: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `plugin "${name}" ${action}: ${detail}`;
}

/** Persist a registry entry; map filesystem errors into `{ error }` so
 *  route handlers never leak a bare 500 for ENOSPC/EACCES/EROFS. */
function trySetPluginEntry(entry: Parameters<typeof setPluginEntry>[0], baseDir: string): PluginError | null {
  try {
    setPluginEntry(entry, baseDir);
    return null;
  } catch (error) {
    return { error: fsErrorMessage("registry could not be written", entry.name, error) };
  }
}

/** Expand a leading ~ to this computer's home directory.  `~user` is not
 *  expanded; only `~` and `~/...` are folder installs. */
function folderInputPath(trimmed: string): string | null {
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const rest = trimmed === "~" ? "" : trimmed.slice(2);
    return rest ? join(homedir(), rest) : homedir();
  }
  if (isAbsolute(trimmed)) return trimmed;
  return null;
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
  warnings: string[] = [],
): Promise<{ entry: PluginRegistryEntry } | PluginError> {
  const parsed = parsePluginManifestJson(fetched.manifestText);
  if (!parsed.ok) {
    return { error: "invalid manifest", issues: parsed.issues };
  }

  const manifest = parsed.manifest;
  // The manifest's `entry` is regex-legal as long as it points at any
  // relative .mjs/.js path, but the path has to actually exist among the
  // fetched files — a manifest claiming entry: "sub/dir/plugin.mjs" with
  // only top-level files in the tree would install cleanly and then fail
  // at enable with "failed to load".  v1 keeps installs top-level-only,
  // so verify the entry is one of the files we are about to write.
  const missing = missingEntryFile(manifest.entry, fetched.files);
  if (missing) return missing;

  const registry = readRegistry(baseDir);
  if (registry.plugins[manifest.name]) {
    return { error: `a plugin named "${manifest.name}" is already installed — remove it first` };
  }

  // Write the tree, then record the registry.  Order matters: a tree
  // without a registry entry is "incomplete install", which the user
  // can retry; a registry entry without a tree is a worse failure.
  try {
    await writePluginTree(manifest.name, {
      source,
      manifestText: fetched.manifestText,
      files: fetched.files,
    }, baseDir);
  } catch (error) {
    return { error: fsErrorMessage("directory could not be written", manifest.name, error) };
  }

  const entry = buildEntry({
    name: manifest.name,
    version: manifest.version,
    source: pluginSource,
    warnings,
  });
  const writeError = trySetPluginEntry(entry, baseDir);
  if (writeError) return writeError;
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
  fetcher: typeof fetch = fetch,
): Promise<PluginListing | PluginError> {
  const trimmed = sourceInput.trim();
  if (!trimmed) return { error: "paste a folder path or a GitHub URL" };

  const folder = folderInputPath(trimmed);
  if (folder) {
    const parsedFolder = z.string().min(1).max(4096).safeParse(folder);
    if (!parsedFolder.success) return { error: "invalid folder path" };
    return installFromFolder(parsedFolder.data, baseDir);
  }

  const parsed = parseGitPluginSource(trimmed);
  if (!parsed.ok) return { error: parsed.error };

  let fetched: FetchedPlugin;
  try {
    fetched = await fetchPluginFromGit(parsed.source, fetcher);
  } catch (error) {
    return { error: error instanceof PluginFetchError ? error.message : FETCH_FAILED };
  }

  const pluginSource: PluginSource = {
    kind: "git",
    url: parsed.source.url,
    ref: parsed.source.ref,
    path: parsed.source.path,
  };
  const result = await installFromFetched(fetched.source, fetched, pluginSource, baseDir);
  if ("error" in result) return result;
  return listingOrError(result.entry.name, baseDir);
}

async function installFromFolder(
  folder: string,
  baseDir: string,
): Promise<PluginListing | PluginError> {
  const read = readPluginFolder(folder);
  if ("error" in read) return { error: read.error };
  const pluginSource: PluginSource = { kind: "folder", path: folder };
  const warnings = read.skipped.map((name) => `skipped ${name}`);
  const result = await installFromFetched(read.source, read.fetched, pluginSource, baseDir, warnings);
  if ("error" in result) return result;
  return listingOrError(result.entry.name, baseDir);
}

/** Enable a plugin: validate, import its module, hand it the host.
 *  Refuses to enable plugins whose host API version is incompatible —
 *  that is the design promise in docs/plugins/DESIGN.md § Version gate,
 *  and enablePlugin must honour it the same way bootPluginRuntime does. */
export async function enablePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;

  // Gate on the host API version.  Refuse before loading the module so a
  // mismatch never reaches the loaded cache.
  if (!satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) {
    return {
      error: `plugin "${name}" requires botfleet "${listing.botfleet}" but the host API is ${HOST_API_VERSION}`,
    };
  }

  if (!loaded.has(name)) {
    const loaded_ = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in loaded_) return { error: loaded_.error };
    loaded.set(name, loaded_);
  }

  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (entry) {
    const writeError = trySetPluginEntry({ ...entry, enabled: true }, baseDir);
    if (writeError) return writeError;
  }
  return listingOrError(name, baseDir);
}

/** Disable a plugin: drop the loaded module, flip the flag. */
export async function disablePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;

  await dropLoaded(name);
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (entry) {
    const writeError = trySetPluginEntry({ ...entry, enabled: false }, baseDir);
    if (writeError) return writeError;
  }
  return listingOrError(name, baseDir);
}

/** Update a plugin to the latest source.  Re-fetches, validates, and
 *  reloads the module.  Returns the new listing. */
export async function updatePlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
  fetcher: typeof fetch = fetch,
): Promise<PluginListing | PluginError> {
  const registry = readRegistry(baseDir);
  const entry = registry.plugins[name];
  if (!entry) return { error: `no plugin named "${name}"` };

  let fetched: FetchedPlugin;
  let sourceWarnings: string[] = [];
  try {
    if (entry.source.kind === "folder") {
      const read = readPluginFolder(entry.source.path);
      if ("error" in read) return { error: read.error };
      fetched = read.fetched;
      sourceWarnings = read.skipped.map((skipped) => `skipped ${skipped}`);
    } else {
      const parsed = parseGitPluginSource(`https://${entry.source.url}`);
      if (!parsed.ok) return { error: parsed.error };
      const source = {
        ...parsed.source,
        ref: entry.source.ref ?? parsed.source.ref,
        path: entry.source.path || parsed.source.path,
      };
      fetched = await fetchPluginFromGit(source, fetcher);
    }
  } catch (error) {
    return { error: error instanceof PluginFetchError ? error.message : FETCH_FAILED };
  }

  const parsed = parsePluginManifestJson(fetched.manifestText);
  if (!parsed.ok) {
    return { error: "invalid manifest", issues: parsed.issues };
  }

  if (parsed.manifest.name !== name) {
    return { error: `updated manifest claims a different name "${parsed.manifest.name}"` };
  }

  const missing = missingEntryFile(parsed.manifest.entry, fetched.files);
  if (missing) return missing;

  if (entry.enabled && !satisfiesBotfleetVersion(parsed.manifest.botfleet, HOST_API_VERSION)) {
    return {
      error: `plugin "${name}" requires botfleet "${parsed.manifest.botfleet}" but the host API is ${HOST_API_VERSION}`,
    };
  }

  // Refuse downgrades before unload/overwrite.  UI does not surface
  // warnings, and continuing past detect left the install half-replaced.
  // Roll back deliberately with remove + reinstall.
  if (compareSemver(parsed.manifest.version, entry.version) < 0) {
    return {
      error:
        `update would downgrade ${name} from ${entry.version} to ${parsed.manifest.version} — remove and reinstall to roll back`,
    };
  }

  const warnings = [...sourceWarnings];

  // Dispose before rewriting the tree.  On Windows the child holds open
  // handles under the plugin dir; rmSync fails with EPERM until exit.
  const wasEnabled = entry.enabled;
  await dropLoaded(name);

  try {
    await writePluginTree(name, {
      source: fetched.source,
      manifestText: fetched.manifestText,
      files: fetched.files,
    }, baseDir);
  } catch (error) {
    return { error: fsErrorMessage("directory could not be written", name, error) };
  }

  const next = rebuildEntryForUpdate({
    existing: entry,
    version: parsed.manifest.version,
    source: entry.source,
    warnings,
  });
  const writeError = trySetPluginEntry(next, baseDir);
  if (writeError) return writeError;

  // Reload the module if it was enabled.  Mirror bootPluginRuntime: a
  // load failure persists enabled=false and surfaces the error instead
  // of leaving the UI showing Enabled with no sandbox.
  if (wasEnabled) {
    const refreshed = listingOrError(name, baseDir);
    if (!("error" in refreshed)) {
      const loaded_ = await loadPlugin(refreshed, inputsOrThrow(), baseDir);
      if ("error" in loaded_) {
        warnPluginEvent("plugins.update.disabled", name, "reload_failed");
        const current = readRegistry(baseDir).plugins[name];
        if (current) {
          const disableError = trySetPluginEntry({ ...current, enabled: false }, baseDir);
          if (disableError) return disableError;
        }
        return { error: loaded_.error };
      }
      loaded.set(name, loaded_);
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

  await dropLoaded(name);
  // Tree first, entry second: a failed rm must leave a still-listed plugin
  // the user can retry, never an orphaned directory with no registry record.
  try {
    await removeDirSafe(join(baseDir, name));
  } catch (error) {
    return { error: fsErrorMessage("could not be removed", name, error) };
  }
  removePluginEntry(name, baseDir);
  return { removed: true };
}

/** Reload a plugin's module without changing enable state. */
export async function reloadPlugin(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | { error: string }> {
  const listing = listingOrError(name, baseDir);
  if ("error" in listing) return listing;
  await dropLoaded(name);
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

function hostVersionError(listing: PluginListing): PluginError | null {
  if (satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) return null;
  return {
    error: `plugin "${listing.name}" requires botfleet "${listing.botfleet}" but the host API is ${HOST_API_VERSION}`,
  };
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
  const mismatch = hostVersionError(listing);
  if (mismatch) {
    await dropLoaded(name);
    // Mirror bootPluginRuntime: persist enabled=false so the UI stops
    // showing "Enabled" while every subsequent call would 409.
    const current = readRegistry(baseDir).plugins[name];
    if (current) {
      const writeError = trySetPluginEntry({ ...current, enabled: false }, baseDir);
      if (writeError) return writeError;
    }
    return mismatch;
  }

  const plugin = await liveSandbox(listing, baseDir);
  if ("error" in plugin) return { error: plugin.error };
  if (!plugin.sandbox.exports.runCommand) return { error: `plugin "${name}" does not implement runCommand` };
  const result = await invokePlugin(plugin, { handler: "runCommand", command, args }, inputsOrThrow());
  if (!result.ok) return { error: `plugin "${name}" command failed (${result.reason})` };
  // The child is untrusted: its reply must be text, not whatever it sent.
  const text = PluginCommandResultSchema.safeParse(result.value);
  if (!text.success) return { error: `plugin "${name}" command failed (invalid_result)` };
  return { text: text.data };
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
  const mismatch = hostVersionError(listing);
  if (mismatch) {
    await dropLoaded(name);
    const current = readRegistry(baseDir).plugins[name];
    if (current) {
      const writeError = trySetPluginEntry({ ...current, enabled: false }, baseDir);
      if (writeError) return writeError;
    }
    return mismatch;
  }

  const plugin = await liveSandbox(listing, baseDir);
  if ("error" in plugin) return { error: plugin.error };
  if (!plugin.sandbox.exports.getCardData) return { error: `plugin "${name}" has no card data handler` };
  const result = await invokePlugin(plugin, { handler: "getCardData", cardId }, inputsOrThrow());
  if (!result.ok) return { error: `plugin "${name}" card failed (${result.reason})` };
  // The child is untrusted: the reply must be `{ result: <JSON> }`.
  const data = PluginCardResultSchema.safeParse(result.value);
  if (!data.success) return { error: `plugin "${name}" card failed (invalid_result)` };
  return { data: data.data };
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
      warnPluginEvent("plugins.boot.skipped", name, listing.reason);
      continue;
    }
    if (!satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) {
      warnPluginEvent("plugins.boot.disabled", name, "host_version_mismatch");
      trySetPluginEntry({ ...entry, enabled: false }, baseDir);
      continue;
    }
    const result = await loadPlugin(listing, inputsOrThrow(), baseDir);
    if ("error" in result) {
      // loadPlugin already logged the sandbox's stable reason code.
      warnPluginEvent("plugins.boot.disabled", name, "load_failed");
      trySetPluginEntry({ ...entry, enabled: false }, baseDir);
      continue;
    }
    loaded.set(name, result);
  }
}

/** Test-only: drop all loaded modules and the runtime inputs.  Awaits
 *  every sandbox exit so test teardown can delete temp plugin dirs on
 *  Windows without racing open handles. */
export async function _resetForTests(): Promise<void> {
  const names = [...loaded.keys()];
  await Promise.all(names.map((name) => dropLoaded(name)));
  loading.clear();
  runtimeInputs = null;
}

/** Test-only: a snapshot of loaded modules. */
export function _loadedNames(): string[] {
  return [...loaded.keys()].sort();
}