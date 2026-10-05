// Load a plugin module and hand it a frozen PluginHost.  Node caches
// ESM modules by URL, so a second import of the same file:// path would
// return the first evaluation.  Reloads append a nonce query so the
// loader reads the file again.
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

const SECRET_CONFIG_KEY = /key|token|secret|credential/i;

/** Same filter `listConfigKeys` uses.  A plugin must not read a value
 *  whose key looks like a credential, even if it guesses the name. */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEY.test(key);
}

function isRedactableRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy a config value with secret-looking keys removed at every level.
 *  The copy is the point: the plugin must not hold the live config object. */
export function redactPluginConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactPluginConfig(entry));
  if (!isRedactableRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isSecretConfigKey(key)) continue;
    out[key] = redactPluginConfig(value[key]);
  }
  return out;
}


/** Build the frozen host API object.  The host's `getBots` reads the
 *  latest snapshot at call time, not at registration time.  Capabilities
 *  the manifest did not declare return an empty result and one warning. */
export function createPluginHost(
  name: string,
  inputs: PluginHostInputs,
  capabilities: readonly string[] = [],
): PluginHost {
  const allowed = new Set(capabilities);
  const warned = new Set<string>();
  const warnOnce = (code: string, message: string) => {
    if (warned.has(code)) return;
    warned.add(code);
    inputs.logger("warn", name, message);
  };
  const host: PluginHost = {
    version: HOST_API_VERSION,
    log: (level, message) => inputs.logger(level, name, message),
    getBots: () => {
      if (!allowed.has("read.bots")) {
        warnOnce("read.bots", "getBots refused: capability read.bots was not declared");
        return [];
      }
      const list = inputs.listBots();
      if (!allowed.has("read.status")) {
        warnOnce("read.status", "bot status omitted: capability read.status was not declared");
        return list.map((bot) => ({ id: bot.id, name: bot.name, status: "", driver: bot.driver }));
      }
      return list.map((bot) => ({ ...bot }));
    },
    config: {
      get: <T = unknown>(key: string): T | undefined => {
        if (!allowed.has("read.config")) {
          warnOnce("read.config", "config.get refused: capability read.config was not declared");
          return undefined;
        }
        if (!inputs.listConfigKeys().includes(key) || isSecretConfigKey(key)) {
          warnOnce("config.allowlist", "config.get refused: key is not on the non-secret allowlist");
          return undefined;
        }
        // SAFETY: redactPluginConfig returns a copy of the allow-listed value.  The caller names T and accepts that the host does not validate the value against T.
        return redactPluginConfig(inputs.readConfig<T>(key)) as T | undefined;
      },
      listKeys: () => {
        if (!allowed.has("read.config")) {
          warnOnce("read.config.keys", "config.listKeys refused: capability read.config was not declared");
          return [];
        }
        return [...inputs.listConfigKeys()];
      },
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
  // SAFETY: isPlainObject accepts a PluginHostRecordLike and returns true only when the input is a plain record; the cast gives TypeScript that input shape so the predicate can compile.
  if (!isPlainObject(value as PluginHostRecordLike)) return false;
  // SAFETY: isPlainObject narrowed value to PluginHostRecordLike; NONCE is a known symbol key on that Record<PropertyKey, PluginHostJsonValue>, so the index access is well-typed.
  return (value as PluginHostRecordLike)[NONCE] === true;
}

function isCallable(value: unknown): boolean {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Function]" || tag === "[object AsyncFunction]";
}

function isCardHandler(value: unknown): value is NonNullable<PluginModule["getCardData"]> {
  return isCallable(value);
}

function isCommandHandler(value: unknown): value is NonNullable<PluginModule["runCommand"]> {
  return isCallable(value);
}

/** Named exports only.  A module namespace has a null prototype, so a
 *  plain-object check would reject a real import.  Optional handlers must
 *  be functions; anything else is a contract failure, not a cast. */
function pluginModuleFromNamespace(value: unknown): { module: PluginModule } | { error: string } {
  if (!isRedactableRecord(value)) return { error: "plugin entry did not export a module" };
  const card = value.getCardData;
  const command = value.runCommand;
  if (card !== undefined && !isCardHandler(card)) {
    return { error: "plugin getCardData export is not a function" };
  }
  if (command !== undefined && !isCommandHandler(command)) {
    return { error: "plugin runCommand export is not a function" };
  }
  const module: PluginModule = {};
  if (isCardHandler(card)) module.getCardData = card;
  if (isCommandHandler(command)) module.runCommand = command;
  return { module };
}

/** A loaded plugin module.  A host-version mismatch is an error from
 *  `loadPlugin`, not a flag the caller can ignore. */
export interface LoadedPlugin {
  name: string;
  version: string;
  source: PluginSource;
  module: PluginModule;
  host: PluginHost;
}

let reloadNonce = 0;

async function importPluginFile(entryPath: string): Promise<PluginModule | { error: string }> {
  reloadNonce += 1;
  const url = `${pathToFileURL(entryPath).href}?botfleetReload=${reloadNonce}`;
  const imported: unknown = await import(url);
  const parsed = pluginModuleFromNamespace(imported);
  if ("error" in parsed) return parsed;
  return parsed.module;
}

/** Load (or reload) one enabled plugin.  Refuses a host-version mismatch
 *  before importing, and only hands the plugin the capabilities it declared.
 *  The `baseDir` is the registry base directory; production callers pass the
 *  default, tests pass a mkdtemp'd directory so they never touch the host's
 *  user data. */
export async function loadPlugin(
  listing: PluginListing,
  inputs: PluginHostInputs,
  baseDir: string = PLUGINS_DIR,
): Promise<LoadedPlugin | { error: string }> {
  if (!satisfiesBotfleetVersion(listing.botfleet, HOST_API_VERSION)) {
    return {
      error: `plugin "${listing.name}" requires botfleet "${listing.botfleet}" but the host API is ${HOST_API_VERSION}`,
    };
  }

  const pluginDir = join(baseDir, listing.name);
  const entryPath = join(pluginDir, listing.entry ?? "plugin.mjs");
  const host = createPluginHost(listing.name, inputs, listing.capabilities);

  let module: PluginModule;
  try {
    const imported = await importPluginFile(entryPath);
    if ("error" in imported) return imported;
    module = imported;
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
  };
}
