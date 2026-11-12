// Host-managed secret and settings broker for plugins.
//
// Credentials never enter plugin code, plugin files, logs, event
// payloads, or the sandbox.  Non-secret settings live beside the
// plugin; secret values live in a host-only `.broker` directory the
// sandbox has no read grant for (the child can read only its own
// plugin directory, and 0600 does not help against the same uid), with
// 0o700 dirs and 0o600 files.
// Plugins declare settings in their manifest; the UI writes values
// through host-validated routes; this module persists them.  Secret
// settings are write-only: reads report only which keys hold a value.
//
// Storage mirrors the registry's write safety: mode 0o700 dirs,
// 0o600 files, atomic tmp-plus-rename writes, corrupt files
// quarantined as `<file>.invalid-*` and treated as empty.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { JsonValue } from "../shared/plugin-manifest.ts";

const SETTINGS_FILE = "plugin-settings.json";
export const SECRETS_FILE = "plugin-secrets.json";
const MAX_KEYS = 32;
const MAX_VALUE_CHARS = 4096;

const storedSettingsSchema = z.object({
  version: z.literal(1),
  settingsVersion: z.number().int().min(1).max(1000),
  values: z.record(z.string().min(1).max(64), z.json()),
}).strict();

const secretsFileSchema = z.object({
  version: z.literal(1),
  values: z.record(z.string().min(1).max(64), z.string().max(MAX_VALUE_CHARS)),
}).strict();

/** One declared setting from a manifest.  Kept structural so tests can
 *  pass plain literals without importing the manifest schema. */
export interface PluginSettingSpec {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret";
  required?: boolean;
  default?: JsonValue;
  description?: string;
}

export interface PluginSettingsIssue {
  field: string;
  message: string;
}

function pluginDir(baseDir: string, pluginName: string): string {
  return join(baseDir, pluginName);
}

/** Host-only secrets location.  Deliberately outside the per-plugin
 *  directory: the sandbox child receives `--allow-fs-read` for its own
 *  plugin directory, so anything under `<plugin>/` is readable by
 *  untrusted plugin code.  Secrets must never live there. */
export function pluginSecretsPath(baseDir: string, pluginName: string): string {
  return join(baseDir, ".broker", pluginName, SECRETS_FILE);
}

/** Pre-fix location, inside the plugin directory and therefore
 *  sandbox-readable.  Anything found here moves to the host-only path
 *  on next access so no secret is left where plugin code can read it. */
function legacySecretsPath(baseDir: string, pluginName: string): string {
  return join(pluginDir(baseDir, pluginName), SECRETS_FILE);
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Move a legacy in-plugin secrets file to the host-only store.  When
 *  both exist the legacy copy is stale, so drop it. */
function migrateLegacySecrets(baseDir: string, pluginName: string): void {
  const legacy = legacySecretsPath(baseDir, pluginName);
  if (!pathExists(legacy)) return;
  const next = pluginSecretsPath(baseDir, pluginName);
  if (pathExists(next)) {
    try {
      unlinkSync(legacy);
    } catch {
      // Best effort; a stale readable copy is retried on next access.
    }
    return;
  }
  try {
    mkdirSync(dirname(next), { recursive: true, mode: 0o700 });
    renameSync(legacy, next);
  } catch {
    // Best effort: the legacy file stays until the next access.
  }
}

/** Named owner contracts for broker reads, so lint-checked callers get
 *  concrete shapes instead of anonymous widened objects. */
export interface StoredPluginSettings {
  settingsVersion: number;
  values: Record<string, JsonValue>;
}

export interface PluginSecretsMap {
  [key: string]: string;
}

export interface ValidatedPluginSettings {
  values: Record<string, JsonValue>;
  secrets: PluginSecretsMap;
}

export interface PluginSettingsMigration {
  values: Record<string, JsonValue>;
  added: string[];
  dropped: string[];
}

/** Broker file read: text in, JSON out.  Null when missing or corrupt;
 *  callers quarantine corrupt files via isCorruptFile. */
function readJsonFile(path: string): JsonValue | null {
  try {
    statSync(path);
  } catch {
    return null;
  }
  try {
    // SAFETY: JSON.parse yields plain data; the zod schemas in the readers
    // below are the only thing that narrows it, and corrupt text quarantines.
    return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

function isCorruptFile(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return false;
  } catch {
    return true;
  }
}

function quarantineAndEmpty(path: string): void {
  try {
    renameSync(path, `${path}.invalid-${Date.now()}`);
  } catch {
    // Best effort: a failed quarantine still reads as empty below.
  }
}

function atomicWriteJson(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(tmpdir(), `bf-plugin-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without modes.
  }
}

/** Validate user-supplied settings against the manifest schema.  Unknown
 *  keys fail closed.  Secret values must be non-empty strings; they are
 *  returned in `secrets` for the broker file, never in `values`.
 *
 *  Type checks run through zod schemas (not `typeof`): the values arrive
 *  from HTTP bodies, so every branch is a parse. */
const settingString = z.string();
const settingNumber = z.number().finite();
const settingBoolean = z.boolean();
const settingSecret = z.string().min(1).max(MAX_VALUE_CHARS);

export function validatePluginSettings(
  specs: readonly PluginSettingSpec[],
  provided: Record<string, JsonValue>,
): { ok: true; values: Record<string, JsonValue>; secrets: PluginSecretsMap } | { ok: false; issues: PluginSettingsIssue[] } {
  const issues: PluginSettingsIssue[] = [];
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  for (const key of Object.keys(provided)) {
    if (!byKey.has(key)) {
      issues.push({ field: `settings.${key}`, message: `unknown setting "${key}"` });
    }
  }
  const values: Record<string, JsonValue> = {};
  const secrets: PluginSecretsMap = {};
  for (const spec of specs) {
    const raw = provided[spec.key];
    if (raw === undefined) {
      if (spec.required) issues.push({ field: `settings.${spec.key}`, message: `setting "${spec.key}" is required` });
      continue;
    }
    if (spec.type === "string") {
      const parsed = settingString.safeParse(raw);
      if (!parsed.success) issues.push({ field: `settings.${spec.key}`, message: `expected a string for "${spec.key}"` });
      else values[spec.key] = parsed.data;
    } else if (spec.type === "number") {
      const parsed = settingNumber.safeParse(raw);
      if (!parsed.success) {
        issues.push({ field: `settings.${spec.key}`, message: `expected a number for "${spec.key}"` });
      } else values[spec.key] = parsed.data;
    } else if (spec.type === "boolean") {
      const parsed = settingBoolean.safeParse(raw);
      if (!parsed.success) issues.push({ field: `settings.${spec.key}`, message: `expected a boolean for "${spec.key}"` });
      else values[spec.key] = parsed.data;
    } else {
      const parsed = settingSecret.safeParse(raw);
      if (!parsed.success) {
        issues.push({ field: `settings.${spec.key}`, message: `expected a non-empty secret (max ${MAX_VALUE_CHARS} chars) for "${spec.key}"` });
      } else secrets[spec.key] = parsed.data;
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, values, secrets };
}

/** Read non-secret settings.  Never includes secret values. */
export function readPluginSettings(baseDir: string, pluginName: string): StoredPluginSettings {
  const path = join(pluginDir(baseDir, pluginName), SETTINGS_FILE);
  const raw = readJsonFile(path);
  if (raw === null) {
    if (isCorruptFile(path)) quarantineAndEmpty(path);
    return { settingsVersion: 1, values: {} };
  }
  const parsed = storedSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    quarantineAndEmpty(path);
    return { settingsVersion: 1, values: {} };
  }
  return { settingsVersion: parsed.data.settingsVersion, values: { ...parsed.data.values } };
}

/** Persist validated non-secret settings.  Secret keys must never reach here. */
export function writePluginSettings(
  baseDir: string,
  pluginName: string,
  settingsVersion: number,
  values: Record<string, JsonValue>,
): void {
  if (Object.keys(values).length > MAX_KEYS) throw new Error("too many settings");
  atomicWriteJson(join(pluginDir(baseDir, pluginName), SETTINGS_FILE), {
    version: 1,
    settingsVersion,
    values,
  });
}

/** Read secret values into host memory only.  Callers must never log,
 *  return, or forward these to plugin code. */
export function readPluginSecrets(baseDir: string, pluginName: string): PluginSecretsMap {
  migrateLegacySecrets(baseDir, pluginName);
  const path = pluginSecretsPath(baseDir, pluginName);
  const raw = readJsonFile(path);
  if (raw === null) {
    if (isCorruptFile(path)) quarantineAndEmpty(path);
    return {};
  }
  const parsed = secretsFileSchema.safeParse(raw);
  if (!parsed.success) {
    quarantineAndEmpty(path);
    return {};
  }
  return { ...parsed.data.values };
}

/** Names only.  Safe for listings, logs, and health views. */
export function pluginSecretKeys(baseDir: string, pluginName: string): string[] {
  return Object.keys(readPluginSecrets(baseDir, pluginName)).sort();
}

/** Write (or, with an empty value, delete) one secret. */
export function writePluginSecret(baseDir: string, pluginName: string, key: string, value: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) throw new Error(`invalid secret key "${key}"`);
  const current = readPluginSecrets(baseDir, pluginName);
  if (value === "") delete current[key];
  else {
    if (value.length > MAX_VALUE_CHARS) throw new Error("secret value too large");
    if (Object.keys(current).length >= MAX_KEYS && !(key in current)) throw new Error("too many secrets");
    current[key] = value;
  }
  atomicWriteJson(pluginSecretsPath(baseDir, pluginName), { version: 1, values: current });
}

/** Remove all broker state for a plugin.  Called on remove. */
export function deletePluginBrokerState(baseDir: string, pluginName: string): void {
  try {
    unlinkSync(join(pluginDir(baseDir, pluginName), SETTINGS_FILE));
  } catch {
    // Missing is fine; remove is idempotent.
  }
  for (const path of [pluginSecretsPath(baseDir, pluginName), legacySecretsPath(baseDir, pluginName)]) {
    try {
      unlinkSync(path);
    } catch {
      // Missing is fine; remove is idempotent.
    }
  }
  const sweeps: Array<{ dir: string; prefix: string }> = [
    { dir: pluginDir(baseDir, pluginName), prefix: SETTINGS_FILE },
    { dir: dirname(pluginSecretsPath(baseDir, pluginName)), prefix: SECRETS_FILE },
    { dir: pluginDir(baseDir, pluginName), prefix: SECRETS_FILE },
  ];
  for (const { dir, prefix } of sweeps) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(`${prefix}.invalid-`)) {
          try {
            unlinkSync(join(dir, entry));
          } catch {
            // Best effort.
          }
        }
      }
    } catch {
      // Dir may already be gone.
    }
  }
}

/** Automatic settings migration on upgrade: carry forward keys the new
 *  schema still declares, apply new defaults, drop removed keys, and
 *  report what changed.  Secret values are never carried or returned
 *  here; the broker file keeps them keyed by name across upgrades. */
export function migratePluginSettings(
  specs: readonly PluginSettingSpec[],
  stored: Record<string, JsonValue>,
): PluginSettingsMigration {
  const declared = new Set(specs.map((spec) => spec.key));
  const values: Record<string, JsonValue> = {};
  const added: string[] = [];
  for (const spec of specs) {
    if (spec.type === "secret") continue;
    if (spec.key in stored) values[spec.key] = stored[spec.key];
    else if (spec.default !== undefined) {
      values[spec.key] = spec.default;
      added.push(spec.key);
    }
  }
  const dropped = Object.keys(stored).filter((key) => !declared.has(key)).sort();
  return { values, added, dropped };
}
