// The plugin registry's on-disk shape and shared types.  Kept in one
// small file so every other plugin module imports from the same
// surface.
//
// registry.json is persisted JSON, so it is a runtime trust boundary.
// The registry types below are inferred from strict zod schemas and
// readRegistry() accepts a file only when PluginRegistrySchema parses
// every entry.  No hand-written predicate stands in for the schema.
import { z } from "zod";

import { PLUGIN_NAME, PLUGIN_NAME_MAX, SEMVER, type PluginManifest } from "../shared/plugin-manifest.ts";

const PLUGIN_NAME_FIELD = z.string().min(1).max(PLUGIN_NAME_MAX).regex(PLUGIN_NAME);
const ISO_TIMESTAMP = z.string().min(1).max(64).refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "expected an ISO-8601 timestamp",
});

/** Install source kinds.  A plugin's source is either a folder the user
 *  pointed at, or a git URL that was fetched once at install time and
 *  is fetched again on update.  Git sources keep the subdirectory path
 *  so an update fetches the same folder it installed. */
export const PluginSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(4096) }).strict(),
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1).max(2048),
    ref: z.string().min(1).max(256).nullable(),
    path: z.string().max(4096),
  }).strict(),
]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/** One entry in `registry.json`.  Everything the host needs to load,
 *  enable, disable, update, or remove the plugin. */
export const PluginRegistryEntrySchema = z.object({
  name: PLUGIN_NAME_FIELD,
  version: z.string().min(1).max(32).regex(SEMVER),
  enabled: z.boolean(),
  installedAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
  source: PluginSourceSchema,
  warnings: z.array(z.string().max(1024)).max(64),
}).strict();
export type PluginRegistryEntry = z.infer<typeof PluginRegistryEntrySchema>;

/** The full registry file.  Versioned so a future migration has a
 *  clean check.  Every record key must be a plugin slug and must match
 *  the `name` of the entry it holds, so a hand-edited file cannot alias
 *  one plugin directory under another name. */
export const PluginRegistrySchema = z.object({
  version: z.literal(1),
  plugins: z.record(PLUGIN_NAME_FIELD, PluginRegistryEntrySchema),
}).strict().superRefine((value, ctx) => {
  for (const [key, entry] of Object.entries(value.plugins)) {
    if (entry.name !== key) {
      ctx.addIssue({ code: "custom", path: ["plugins", key, "name"], message: "entry name does not match its registry key" });
    }
  }
});
export type PluginRegistry = z.infer<typeof PluginRegistrySchema>;

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

/** What a plugin module exports, as reported by the sandbox child after
 *  it imports the entry file.  The module namespace itself never crosses
 *  into the trusted server process: the child reports which handlers
 *  exist, and the parent accepts that report only when this strict
 *  schema parses it.  See server/plugin-sandbox-protocol.ts. */
export const PluginExportsSchema = z.object({
  getCardData: z.boolean(),
  runCommand: z.boolean(),
}).strict();
export type PluginExports = z.infer<typeof PluginExportsSchema>;

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