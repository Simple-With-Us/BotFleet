// Workspace credentials the desktop shell keeps OS-encrypted (credentials.bin
// via safeStorage) instead of leaving in plaintext config.json — the same
// treatment the Composio project key already gets in main.mjs. Pure functions:
// main.mjs owns the fs and safeStorage plumbing, so the migration decisions
// stay testable without an Electron runtime.
//
// One row per secret: the config.json home it migrates OUT of, the
// credentials.bin field it lives in, and the env var the spawned server
// prefers over the file (server/config.ts loadConfig).
export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  // Google Gemini backs the second speech-to-speech call provider.  Same
  // treatment as the xAI key: encrypted at rest, env var preferred on spawn.
  { section: "gemini", field: "key", name: "geminiApiKey", env: "GEMINI_API_KEY" },
  // The two engines configured with an endpoint and a key rather than a CLI
  // login.  Only the key migrates; each one's `url` is configuration and
  // stays readable in config.json.
  { section: "openaiCompat", field: "key", name: "openaiCompatApiKey", env: "OPENAI_COMPAT_API_KEY" },
  { section: "minimax", field: "key", name: "minimaxApiKey", env: "MINIMAX_API_KEY" },
  { section: "deepseek", field: "key", name: "deepseekApiKey", env: "DEEPSEEK_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "OMB_TTS_KEY" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "OMB_OPENAI_IMAGE_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
  { section: "infisical", field: "clientSecret", name: "infisicalClientSecret", env: "INFISICAL_CLIENT_SECRET" },
];

/** The per-instance environment variable each driver that can carry more than
 * one instance reads its API key from.  Lives here, in JS, because both sides
 * need it: server/config.ts re-exports it for the instance routes, and the
 * desktop shell's boot-time marker repair cannot import TypeScript.  A driver
 * absent from this table has no per-instance key. */
export const INSTANCE_API_KEY_ENV = new Map([
  ["openai-compat", "OPENAI_COMPAT_API_KEY"],
  ["minimax", "MINIMAX_API_KEY"],
]);

/** True when this instance entry belongs to a driver that keeps a key of its
 * own — the entries the encrypted store can hold a credential for. */
export function instanceKeyedDriver(entry) {
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) &&
    INSTANCE_API_KEY_ENV.has(entry.driver));
}

/** Every fixed credential held in credentials.bin.  Composio has its own
 * legacy migration, but it needs the same durable external-storage marker. */
export const EXTERNAL_WORKSPACE_CREDENTIALS = [
  ...WORKSPACE_CREDENTIALS,
  { section: "composio", field: "apiKey", name: "composioApiKey", env: "COMPOSIO_API_KEY" },
];

/** Persist only which fixed credentials the desktop must replay.  Values
 * stay in the OS-encrypted document; the marker is safe in config.json. */
export function markExternalWorkspaceCredentials(config, credentials) {
  const next = structuredClone(config ?? {});
  let changed = false;
  for (const { section, name } of EXTERNAL_WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value !== "string" || !value.trim()) continue;
    const current = next[section] && typeof next[section] === "object" && !Array.isArray(next[section])
      ? next[section]
      : {};
    if (current.credentialStorage === "external") continue;
    next[section] = { ...current, credentialStorage: "external" };
    changed = true;
  }
  return { config: next, changed };
}

/** Prove that every encrypted fixed credential has a durable nonsecret
 * marker in config.json.  A preparation receipt must never omit a missing
 * marker and still claim the migration completed. */
export function assertExternalWorkspaceCredentialMarkers(config, credentials) {
  const markerNames = [];
  for (const { section, name } of EXTERNAL_WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value !== "string" || !value.trim()) continue;
    if (config?.[section]?.credentialStorage !== "external") {
      throw new Error(`Workspace credential marker was not durably written for ${name}`);
    }
    markerNames.push(name);
  }
  return markerNames;
}

/** A marker without a resolved value means the encrypted desktop replay has
 * not reached this harness yet. */
export function workspaceCredentialPending(config, name) {
  const field = EXTERNAL_WORKSPACE_CREDENTIALS.find((candidate) => candidate.name === name);
  if (!field) return false;
  const section = config?.[field.section];
  return section?.credentialStorage === "external" &&
    (typeof section[field.field] !== "string" || !section[field.field].trim());
}

/** Apply the marker for one explicit settings save.  A non-empty encrypted
 * value adds it; an explicit clear removes it so anonymous operation remains
 * valid.  The secret itself is never copied into the returned config. */
export function setWorkspaceCredentialMarker(config, name, present) {
  const field = EXTERNAL_WORKSPACE_CREDENTIALS.find((candidate) => candidate.name === name);
  if (!field) throw new Error("Unsupported workspace credential marker");
  const next = structuredClone(config ?? {});
  const current = next[field.section] && typeof next[field.section] === "object" && !Array.isArray(next[field.section])
    ? next[field.section]
    : {};
  if (present) next[field.section] = { ...current, credentialStorage: "external" };
  else if (current.credentialStorage === "external") {
    const updated = { ...current };
    delete updated.credentialStorage;
    next[field.section] = updated;
  }
  return next;
}

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps the meaning of what remains unambiguous:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - "" or absent     → no plaintext information; the store stays authoritative
 *
 * "" must never drop a stored secret. The packaged app's external-secret
 * save path writes an empty tombstone into config.json on EVERY credential
 * commit (the real value goes to credentials.bin first), so reading "" as
 * "the user cleared this" deleted freshly saved keys at the next boot.
 * Clearing runs through the desktop shell's credential:set handler, which
 * removes the entry from the store directly before persisting the same
 * tombstone — so there is no "" case in which the store should lose data.
 * Running twice is a no-op, and nothing is lost if a boot dies between the
 * two writes — the caller persists credentials BEFORE rewriting config, so
 * the worst case re-runs the same overwrite.
 *
 * Inputs are treated as immutable; the changed flags tell the caller which
 * file(s) actually need rewriting. Non-string junk in a field is left for
 * the server's schema to reject rather than silently destroyed here. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
