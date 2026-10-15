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
  type JsonValue,
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
  invokePluginEvent,
  fetchPluginHealth,
  loadPlugin,
  pluginLogId,
  type LoadedPlugin,
  type PluginHostBotSummary,
  type PluginHostInputs,
  type PluginLogEvent,
} from "./plugin-loader.ts";
import {
  PluginCardResultSchema,
  PluginCommandResultSchema,
  PluginHealthResultSchema,
} from "./plugin-sandbox-protocol.ts";
import {
  PluginEventBus,
  type PluginEventTransport,
} from "./plugin-events.ts";
import {
  pluginEventEnvelopeSchema,
  subscriptionMatchesEvent,
  type PluginChatSummary,
  type PluginDeliveryOutcome,
  type PluginEventEnvelope,
  type PluginRoutingDecision,
} from "../shared/plugin-events.ts";
import {
  migratePluginSettings,
  readPluginSettings,
  validatePluginSettings,
  writePluginSecret,
  writePluginSettings,
  type PluginSettingSpec,
} from "./plugin-secrets.ts";
import { parsePluginManifest } from "../shared/plugin-manifest.ts";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

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
  readConfig(key: string): JsonValue | undefined;
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
    readConfig: (key: string) => runtimeInputs!.readConfig(key),
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-clause error is unknown at the fs boundary
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
    if (writeError) {
      // The entry stayed disabled, so do not leave its sandbox running.
      await dropLoaded(name);
      return writeError;
    }
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

  // Broker files (settings, secrets, event ledger) live beside the plugin
  // tree but are host state, not plugin code: the tree rewrite below
  // replaces the whole directory, so stash them and restore after.  A
  // fetched file with the same name wins — the plugin owns its tree.
  const brokerStash = stashBrokerFiles(name, fetched.files.map((file) => file.path), baseDir);

  // Dispose before rewriting the tree.  On Windows the child holds open
  // handles under the plugin dir; rmSync fails with EPERM until exit.
  const wasEnabled = entry.enabled;
  const storedSettings = readPluginSettings(baseDir, name);
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
  restoreBrokerFiles(name, brokerStash, baseDir);

  // Settings migration: when the new manifest bumped settingsVersion,
  // carry declared keys forward, apply new defaults, and drop removed
  // keys.  Secrets stay keyed in the broker file across upgrades.
  if (parsed.manifest.settingsVersion > storedSettings.settingsVersion) {
    const specs = parsed.manifest.settings.map((setting): PluginSettingSpec => ({
      key: setting.key,
      label: setting.label,
      type: setting.type,
      required: setting.required,
      description: setting.description,
    }));
    try {
      const { added, dropped } = migratePluginSettingsOnUpdate(specs, baseDir, name, parsed.manifest.settingsVersion);
      if (added.length) warnings.push(`settings migrated: added ${added.join(", ")}`);
      if (dropped.length) warnings.push(`settings migrated: dropped ${dropped.join(", ")}`);
    } catch (error) {
      warnings.push(`settings migration failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
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
  pluginEventBus(baseDir).clear(name);
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

const PLUGIN_COMMAND_ARGS = z.string().max(8192);

/** Run a plugin's slash command. */
export async function runPluginCommand(
  name: string,
  command: string,
  args: string,
  baseDir: string = PLUGINS_DIR,
): Promise<{ text: string } | { error: string }> {
  const parsedArgs = PLUGIN_COMMAND_ARGS.safeParse(args);
  if (!parsedArgs.success) return { error: "command args are too long" };
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
  const result = await invokePlugin(
    plugin,
    { handler: "runCommand", command, args: parsedArgs.data },
    inputsOrThrow(),
  );
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

// ---------------------------------------------------------------------------
// Event-driven integration platform (host API v2).
//
// The trusted host owns every transport: listeners, credential checks,
// dedup, budgets, canonical fetches, retries, and wake execution.
// Plugins subscribe to typed envelopes and return routing decisions;
// they never bind ports, see tokens, or keep event state.  A plugin
// process staying alive retains nothing: the ledger below is the state.

/** Scoped conversation summaries for dispatcher routing.  Wired at boot
 *  to the thread store; tests pass a stub. */
export interface PluginChatInputs {
  listChatSummaries(limit: number): PluginChatSummary[];
}

let chatInputs: PluginChatInputs | null = null;

/** Register the chat-summary provider.  Called once at server boot. */
export function initPluginChats(inputs: PluginChatInputs): void {
  chatInputs = inputs;
}

/** Valid routing decisions arrive here from the bus (first attempt or a
 *  background retry).  The integrator (server/index.ts) registers the
 *  executor that validates the target and performs the wake. */
export type PluginDecisionHandler = (
  pluginName: string,
  event: PluginEventEnvelope,
  decision: PluginRoutingDecision,
) => void;

let decisionHandler: PluginDecisionHandler | null = null;

/** Register the wake executor.  Called once at server boot. */
export function initPluginDecisionHandler(handler: PluginDecisionHandler): void {
  decisionHandler = handler;
}

const eventBuses = new Map<string, PluginEventBus>();

function readManifestForEvents(name: string, baseDir: string): {
  capabilities: string[];
  subscriptions: Array<{ id: string; source: "zulip"; kinds: Array<"message">; includeContent: boolean; includeChats: boolean; maxChats: number }>;
} | null {
  const path = joinPath(baseDir, name, "botfleet-plugin.json");
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const parsed = parsePluginManifest(value);
  if (!parsed.ok) return null;
  return {
    capabilities: [...parsed.manifest.capabilities],
    subscriptions: (parsed.manifest.contributes?.eventSubscriptions ?? []).map((sub) => ({ ...sub })),
  };
}

function busTransport(baseDir: string): PluginEventTransport {
  return {
    subscribers: (event) => {
      const registry = readRegistry(baseDir);
      const out: string[] = [];
      for (const name of Object.keys(registry.plugins).sort()) {
        if (!registry.plugins[name]?.enabled) continue;
        const manifest = readManifestForEvents(name, baseDir);
        if (!manifest) continue;
        if (!manifest.capabilities.includes("events.subscribe")) continue;
        if (manifest.subscriptions.some((sub) => subscriptionMatchesEvent(sub, event))) out.push(name);
      }
      return out;
    },
    capabilities: (pluginName) => readManifestForEvents(pluginName, baseDir)?.capabilities ?? null,
    subscriptions: (pluginName) => readManifestForEvents(pluginName, baseDir)?.subscriptions ?? [],
    scope: (pluginName, subscription, event) => {
      const capabilities = readManifestForEvents(pluginName, baseDir)?.capabilities ?? [];
      const scoped: PluginEventEnvelope = { ...event, refs: { ...event.refs }, source: { ...event.source } };
      if (!subscription.includeContent) delete scoped.content;
      if (subscription.includeChats && capabilities.includes("chat.read") && chatInputs) {
        const summaries = chatInputs.listChatSummaries(Math.min(subscription.maxChats, 20));
        scoped.context = { ...scoped.context, chatSummaries: summaries.slice(0, 20) };
      } else if (scoped.context.chatSummaries) {
        const { chatSummaries: _dropped, ...context } = scoped.context;
        void _dropped;
        scoped.context = context;
      }
      return scoped;
    },
    deliver: async (pluginName, event) => {
      const listing = listingFor(pluginName, baseDir);
      if ("error" in listing) return { ok: false, reason: "sandbox_exited" };
      const registry = readRegistry(baseDir);
      if (!registry.plugins[pluginName]?.enabled) return { ok: false, reason: "bad_request" };
      const plugin = await liveSandbox(listing, baseDir);
      if ("error" in plugin) return { ok: false, reason: "sandbox_exited" };
      if (!plugin.sandbox.exports.onEvent) return { ok: false, reason: "not_implemented" };
      // The plugin's own non-secret settings ride along; secrets never do.
      const settings = readPluginSettings(baseDir, pluginName).values;
      return invokePluginEvent(plugin, event, inputsOrThrow(), settings);
    },
    onDecision: (pluginName, event, decision) => {
      try {
        decisionHandler?.(pluginName, event, decision);
      } catch {
        // The executor is host code; a throw here must not break delivery.
      }
    },
  };
}

/** The event bus for one registry dir.  Production uses PLUGINS_DIR;
 *  tests pass a mkdtemp'd dir. */
export function pluginEventBus(baseDir: string = PLUGINS_DIR): PluginEventBus {
  const existing = eventBuses.get(baseDir);
  if (existing) return existing;
  const bus = new PluginEventBus(busTransport(baseDir), { baseDir });
  eventBuses.set(baseDir, bus);
  return bus;
}

/** Emit one envelope to every enabled subscriber.  Invalid envelopes
 *  are dropped (no subscriber, no outcome). */
export async function emitPluginEvent(
  rawEvent: unknown,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginDeliveryOutcome[]> {
  return pluginEventBus(baseDir).emit(rawEvent);
}

/** Health for one plugin: ledger depths plus recent outcomes (reason
 *  codes only, never event text) plus the plugin's own report when it
 *  implements getHealth. */
export async function getPluginHealth(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<{ ledger: { pending: number; deadLetter: number; recent: PluginDeliveryOutcome[] }; plugin: { status: string; detail: string } } | { error: string }> {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  const ledger = pluginEventBus(baseDir).health(name);
  let plugin = { status: "unknown", detail: "no health handler" };
  const registry = readRegistry(baseDir);
  if (registry.plugins[name]?.enabled) {
    const loaded_ = await liveSandbox(listing, baseDir);
    if (!("error" in loaded_) && loaded_.sandbox.exports.getHealth) {
      try {
        const result = await fetchPluginHealth(loaded_, inputsOrThrow());
        if (result.ok) {
          const parsed = PluginHealthResultSchema.safeParse(result.value);
          if (parsed.success) plugin = { ...parsed.data };
        }
      } catch {
        // Best effort: ledger health below still answers.
      }
    }
  }
  return { ledger, plugin };
}

/** Build a synthetic test event and run it through matching
 *  subscriptions.  Exercises validate → scope → deliver → decide
 *  without touching any real transport. */
export async function emitPluginTestEvent(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginDeliveryOutcome[] | { error: string }> {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  const registry = readRegistry(baseDir);
  if (!registry.plugins[name]?.enabled) return { error: `plugin "${name}" is disabled` };
  const stamp = new Date().toISOString();
  const messageId = (Date.now() % 2_147_483_647) + 1;
  const raw = {
    eventId: `test:${name}:${messageId}`,
    type: "zulip.message",
    source: { platform: "zulip", accountId: "test" },
    occurredAt: stamp,
    receivedAt: stamp,
    refs: { messageId, conversationKey: "test" },
    mentions: [],
    content: { text: "synthetic test event", format: "text" },
    context: { botId: name, wakeReason: "mention", senderKind: "peer" },
  };
  const parsed = pluginEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { error: "test event failed to validate" };
  return pluginEventBus(baseDir).emit(parsed.data);
}

/** Validate and persist user settings.  Secret values go to the broker
 *  file and are never echoed back; the reply carries names only. */
export async function setPluginSettings(
  name: string,
  provided: Record<string, JsonValue>,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginListing | PluginError> {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  if (!Array.isArray(listing.settings)) return { error: `plugin "${name}" declares no settings` };
  const specs = listing.settings.map((setting): PluginSettingSpec => ({
    key: setting.key,
    label: setting.label,
    type: setting.type === "secret" ? "secret" : setting.type === "number" ? "number" : setting.type === "boolean" ? "boolean" : "string",
    required: setting.required,
    description: setting.description,
  }));
  const validated = validatePluginSettings(specs, provided);
  if (!validated.ok) return { error: "invalid settings", issues: validated.issues.map((issue) => ({ field: issue.field, message: issue.message })) };
  try {
    const stored = readPluginSettings(baseDir, name);
    writePluginSettings(baseDir, name, stored.settingsVersion, { ...stored.values, ...validated.values });
    for (const [key, value] of Object.entries(validated.secrets)) {
      writePluginSecret(baseDir, name, key, value);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : `plugin "${name}" settings could not be written` };
  }
  return listingOrError(name, baseDir);
}

/** Read non-secret settings values for editing.  Secret keys appear in
 *  the listing's configuredKeys, never with values. */
export function getPluginSettings(
  name: string,
  baseDir: string = PLUGINS_DIR,
): { values: Record<string, JsonValue>; settingsVersion: number } | { error: string } {
  const listing = listingFor(name, baseDir);
  if ("error" in listing) return listing;
  return readPluginSettings(baseDir, name);
}

/** Migrate stored settings after an upgrade whose manifest bumped
 *  settingsVersion: carry declared keys, apply new defaults, drop
 *  removed keys, and report the diff for the caller to surface. */
export function migratePluginSettingsOnUpdate(
  specs: readonly PluginSettingSpec[],
  baseDir: string,
  name: string,
  nextSettingsVersion: number,
): { added: string[]; dropped: string[] } {
  const stored = readPluginSettings(baseDir, name);
  if (stored.settingsVersion >= nextSettingsVersion) return { added: [], dropped: [] };
  const { values, added, dropped } = migratePluginSettings(specs, stored.values);
  writePluginSettings(baseDir, name, nextSettingsVersion, values);
  return { added, dropped };
}

/** Drain due pending retries for one plugin on the host tick. */
export async function drainPluginRetries(
  name: string,
  baseDir: string = PLUGINS_DIR,
): Promise<PluginDeliveryOutcome[]> {
  return pluginEventBus(baseDir).drainPending(name);
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
  eventBuses.clear();
  runtimeInputs = null;
  chatInputs = null;
  decisionHandler = null;
}

/** Host-side broker files that survive tree rewrites.  Anything else in
 *  the plugin dir belongs to the plugin's fetched tree. */
const BROKER_KEEP_FILES = new Set(["plugin-settings.json", "plugin-secrets.json", "plugin-events.json"]);

/** Stash broker files before a tree rewrite.  Files the fetched tree
 *  also ships are left alone: the plugin owns its tree. */
function stashBrokerFiles(
  name: string,
  fetchedPaths: string[],
  baseDir: string,
): Map<string, string> {
  const stash = new Map<string, string>();
  const fetched = new Set(fetchedPaths);
  const dir = join(baseDir, name);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return stash;
  }
  for (const entry of entries) {
    if (!BROKER_KEEP_FILES.has(entry) && !entry.endsWith(".invalid-")) continue;
    if (fetched.has(entry)) continue;
    try {
      stash.set(entry, readFileSync(join(dir, entry), "utf8"));
    } catch {
      // Unreadable broker state is dropped, never blocks an update.
    }
  }
  return stash;
}

function restoreBrokerFiles(name: string, stash: Map<string, string>, baseDir: string): void {
  const dir = join(baseDir, name);
  for (const [entry, content] of stash) {
    try {
      writeFileSync(join(dir, entry), content, { mode: 0o600 });
    } catch {
      // Best effort: settings can be re-entered from the UI.
    }
  }
}

/** Test-only: a snapshot of loaded modules. */
export function _loadedNames(): string[] {
  return [...loaded.keys()].sort();
}
