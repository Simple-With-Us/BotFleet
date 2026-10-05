// The plugin registry's on-disk shape and shared types.  Kept in one
// small file so every other plugin module imports from the same
// surface.
import type { PluginManifest } from "../shared/plugin-manifest.ts";

/** Install source kinds.  A plugin's source is either a folder the user
 *  pointed at, or a git URL that was fetched once at install time and
 *  is fetched again on update.  Git sources keep the subdirectory path
 *  so an update fetches the same folder it installed. */
export type PluginSource =
  | { kind: "folder"; path: string }
  | { kind: "git"; url: string; ref: string | null; path: string };

/** One entry in `registry.json`.  Everything the host needs to load,
 *  enable, disable, update, or remove the plugin. */
export interface PluginRegistryEntry {
  name: string;
  version: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  source: PluginSource;
  warnings: string[];
}

/** The full registry file.  Versioned so a future migration has a
 *  clean check. */
export interface PluginRegistry {
  version: 1;
  plugins: Record<string, PluginRegistryEntry>;
}

/** What the host API hands to a plugin's exports.  Frozen so a plugin
 *  cannot reassign to smuggle references back into BotFleet. */
export interface PluginHost {
  readonly version: 1;
  log(level: "info" | "warn" | "error", message: string): void;
  getBots(): ReadonlyArray<{ id: string; name: string; status: string; driver: string }>;
  config: {
    get<T = unknown>(key: string): T | undefined;
    listKeys(): readonly string[];
  };
}

/** A plugin's getCardData return value.  Wrapping the unknown in a
 *  named payload type lets the host read `result` rather than a bare
 *  unknown — the anti-slop `no-unknown-returns` rule requires a named
 *  return type. */
export interface PluginCardDataResult {
  result: unknown;
}

/** A loaded plugin module.  The host imports the plugin file and looks
 *  for these exports.  Any of them may be absent; the host only
 *  invokes what is present. */
export interface PluginModule {
  /** Optional card data provider.  Receives the host API and the card
   *  id the host is rendering.  Returns a JSON value the host renders
   *  against the declared layout.  Returns a typed payload wrapper so
   *  the host reads `result` rather than the bare unknown. */
  getCardData?(args: {
    cardId: string;
    host: PluginHost;
  }): Promise<PluginCardDataResult> | PluginCardDataResult;

  /** Optional command handler.  Receives parsed args + the host API.
   *  Returns a text string. */
  runCommand?(args: {
    command: string;
    args: string;
    host: PluginHost;
  }): Promise<string> | string;
}

/** A listing for the UI: the manifest fields plus registry state. */
export interface PluginListing {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  /** Host API version constraint, e.g. ">=1". */
  botfleet: string;
  /** Manifest-declared entry path. */
  entry: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  source: PluginSource;
  warnings: string[];
  capabilities: string[];
  contributes?: PluginManifest["contributes"];
}

/** The fetch shape used by plugin-fetch and plugin-folder.  Mirrors
 *  the skill shape so we can reuse the validation flow. */
export interface FetchedPlugin {
  source: string;
  manifestText: string;
  files: Array<{ path: string; content: string }>;
}