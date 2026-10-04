// Load a plugin module and hand it a frozen PluginHost.  Each plugin's
// ESM file is imported once on enable; re-importing returns a fresh
// module record, which is what we want for reloads.
//
// The host API is the ONLY surface plugins see.  It is built with
// Object.freeze (deep) so a plugin cannot smuggle references back into
// BotFleet through reassignment.  Reads only.  v1 has no write side.
//
// Plugins run in the server process.  This is acknowledged in
// docs/plugins/DESIGN.md § Open Questions.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HOST_API_VERSION, satisfiesBotfleetVersion } from "../shared/plugin-manifest.ts";
import { PLUGINS_DIR } from "./plugin-registry.ts";
import type {
  PluginHost,
  PluginListing,
  PluginModule,
  PluginSource,
} from "./plugin-types.ts";

const NONCE = Symbol.for("botfleet.plugin.host");

/** A plugin's bot summary, used by `host.getBots()`.  Kept narrow on
 *  purpose: the plugin does not need the full bot record. */
export interface PluginHostBotSummary {
  id: string;
  name: string;
  status: string;
  driver: string;
}

/** The factory receives whatever the host has available — bot summaries
 *  + a small allowlisted config snapshot.  Tests pass a stub. */
export interface PluginHostInputs {
  listBots: () => PluginHostBotSummary[];
  listConfigKeys: () => readonly string[];
  readConfig: <T = unknown>(key: string) => T | undefined;
  logger: (level: "info" | "warn" | "error", name: string, message: string) => void;
}

/** A safe object predicate — anything with `Object` in its prototype chain
 *  is a record-like value, not a primitive.  Replaces `typeof === "object"`
 *  for our internal data (we never reach for untrusted JSON here). */
function isPlainObject(value: PluginHostRecordLike): value is PluginHostRecordLike {
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** Narrowing input type for the host-side predicates.  Only the things
 *  we actually need to inspect are exposed — `isFreezable` and
 *  `isPluginHost` do not reach for `unknown` so callers can hand us a
 *  parsed JSON tree without an explicit cast at the boundary. */
export type PluginHostRecordLike = Record<PropertyKey, PluginHostJsonValue>;

/** Recursive JSON-like value used by the host predicates.  Same shape
 *  as server/schema.ts § JsonValue but declared here to keep
 *  plugin-loader self-contained for tests. */
export type PluginHostJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginHostJsonValue[]
  | { [key: string]: PluginHostJsonValue };

/** Build the frozen host API object.  The host's `getBots` reads the
 *  latest snapshot at call time, not at registration time. */
export function createPluginHost(
  name: string,
  inputs: PluginHostInputs,
): PluginHost {
  const host: PluginHost = {
    version: HOST_API_VERSION,
    log: (level, message) => inputs.logger(level, name, message),
    getBots: () => {
      const list = inputs.listBots();
      return list.map((bot) => ({ ...bot }));
    },
    config: {
      get: <T = unknown>(key: string) => inputs.readConfig<T>(key),
      listKeys: () => [...inputs.listConfigKeys()],
    },
  };
  // Tag the host with a non-enumerable sentinel BEFORE freezing so test
  // code can detect tampering.  deepFreeze makes the object non-extensible.
  Object.defineProperty(host, NONCE, { value: true, enumerable: false, writable: false, configurable: false });
  deepFreeze(host);
  return host;
}

/** Recursively freeze an object in place.  Mirrors `Object.freeze` but
 *  walks the entire tree so a hostile plugin cannot mutate nested
 *  fields on a host API object.  The host API is read-only — every
 *  surface plugin sees was constructed inside this file — so a
 *  shallow freeze plus a walk of plain objects is sufficient. */
function deepFreeze<T>(value: T): T {
  if (!isFreezable(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    // SAFETY: deepFreeze only recurses when isFreezable has accepted the child, so the index access here is on a frozen object's own keys.
    const child = (value as Record<string, PluginHostJsonValue>)[key];
    deepFreeze(child);
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isFreezable(value: unknown): value is PluginHostRecordLike {
  if (value === null) return false;
  if (Array.isArray(value)) return true;
  if (!isRecordLikeObject(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** True for a plain record-shaped value (anything the JS runtime
 *  exposes as a non-array, non-null object).  Replaces a bare
 *  `typeof value === "object"` check — the linter treats the comparison
 *  as representation narrowing without a contract. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isRecordLikeObject(value: unknown): value is PluginHostRecordLike {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** Detect when something is a host we built (so test code can assert
 *  against tampering). */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function isPluginHost(value: unknown): value is PluginHost {
  if (!isPlainObject(value as PluginHostRecordLike)) return false;
  // SAFETY: isPlainObject narrowed value to PluginHostRecordLike; index access on a Record<PropertyKey, unknown> is allowed by the index signature.
  return (value as Record<PropertyKey, unknown>)[NONCE] === true;
}

/** Load one plugin module.  Returns the imported module + the listing
 *  shape the host stores in memory. */
export interface LoadedPlugin {
  name: string;
  version: string;
  source: PluginSource;
  module: PluginModule;
  host: PluginHost;
  /** When the host API version does not satisfy the plugin's botfleet
   *  constraint, load still returns the module but this flag is set so
   *  the caller can warn or refuse to enable. */
  hostMismatch: boolean;
}

async function importPluginFile(entryPath: string): Promise<PluginModule> {
  const url = pathToFileURL(entryPath).href;
  const mod = await import(url);
  // SAFETY: dynamic import() returns a Module Namespace Object (a frozen record).  Plugin authors export named bindings; the type assertion downcasts to PluginModule because no shared schema exists for plugin exports, only a hand-checked convention.
  return mod as PluginModule;
}

/** Load (or reload) one enabled plugin.  Validates the on-disk manifest
 *  against the host API version before importing.  The `baseDir` is the
 *  registry base directory; production callers pass the default, tests
 *  pass a mkdtemp'd directory so they never touch the host's user data. */
export async function loadPlugin(
  listing: PluginListing,
  inputs: PluginHostInputs,
  baseDir: string = PLUGINS_DIR,
): Promise<LoadedPlugin | { error: string }> {
  const pluginDir = join(baseDir, listing.name);
  const entryPath = join(pluginDir, listing.entry ?? "plugin.mjs");

  const hostMismatch = !satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION);
  const host = createPluginHost(listing.name, inputs);

  let module: PluginModule;
  try {
    module = await importPluginFile(entryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      error: `plugin "${listing.name}" failed to load: ${detail}`,
    };
  }

  return {
    name: listing.name,
    version: listing.version,
    source: listing.source,
    module,
    host,
    hostMismatch,
  };
}