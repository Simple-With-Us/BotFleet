// The explicit table of every credential BotFleet knows how to consume, and
// the one place a value from an external secret store is allowed to land.
//
// BotFleet already had three secret conventions that disagreed: `loadConfig()`
// where env beats file for eight names, a newer family where the file value
// beats env per call (`cfg?.usage?.ingestToken || process.env…`), and the
// desktop shell's IPC push.  This module does not add a fourth.  It adds one
// table and one layer above all of them: for a name the vault holds, the vault
// wins; underneath, the existing env-versus-file ordering is untouched.
//
// Three rules keep that layer safe:
//   1. Only a name in this table is ever applied.  A vault row called `PATH`,
//      `NODE_ENV` or `INFISICAL_CLIENT_SECRET` cannot reach this process.
//   2. A resolved value is written into the config object and nowhere else —
//      never into `process.env`, so nothing new rides into a spawned engine
//      CLI through `...process.env`.
//   3. Values are hashed or counted, never returned, logged or rendered.  The
//      only strings that leave this module are ids, labels and vault names.
//
// Pure data plus pure functions.  The `AppConfig` import is `import type` on
// purpose: `config.ts` imports this module for real, and a value import here
// would close the cycle.
import { createHash } from "node:crypto";

import type { AppConfig } from "./config.ts";

/** One credential BotFleet knows how to consume.
 *
 * `path` is the field path *inside* `section`, so `id` is always
 * `section.path.join(".")` and a UI badge, a 409 refusal and a log line can
 * all name the same field with the same string. */
export interface SecretFieldSpec {
  id: string;
  /** Sentence case, for the refusal message and the provenance card. */
  label: string;
  section: keyof AppConfig;
  path: string[];
  /** Env aliases this field already resolves from, highest priority first. */
  env: string[];
  infisicalName: string;
  /** True when the value must never be rendered, logged or returned. */
  secret: boolean;
  /** True when a change to this value has to rebuild the fleet to take effect. */
  reloadProviders: boolean;
}

/** The shape Infisical itself enforces, and the shape this module will apply.
 * Anything else in a vault is reported as unused and ignored. */
export const INFISICAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** The canonical map.  A field that is not here is not managed: it keeps
 * whatever env-and-file behaviour it already had, and the vault cannot touch
 * it.  There is deliberately no `infisical.*` row — BotFleet's own machine
 * identity cannot resolve through the vault it unlocks. */
export const SECRET_FIELDS: readonly SecretFieldSpec[] = [
  {
    id: "xai.key",
    label: "xAI API key",
    section: "xai",
    path: ["key"],
    env: ["XAI_API_KEY"],
    infisicalName: "XAI_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "openaiCompat.key",
    label: "OpenAI-compatible API key",
    section: "openaiCompat",
    path: ["key"],
    env: ["OPENAI_COMPAT_API_KEY"],
    infisicalName: "OPENAI_COMPAT_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "openaiCompat.url",
    label: "OpenAI-compatible URL",
    section: "openaiCompat",
    path: ["url"],
    env: ["OPENAI_COMPAT_URL"],
    infisicalName: "OPENAI_COMPAT_URL",
    secret: false,
    reloadProviders: true,
  },
  {
    id: "minimax.key",
    label: "MiniMax API key",
    section: "minimax",
    path: ["key"],
    env: ["MINIMAX_API_KEY"],
    infisicalName: "MINIMAX_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "minimax.url",
    label: "MiniMax base URL",
    section: "minimax",
    path: ["url"],
    env: ["MINIMAX_BASE_URL"],
    infisicalName: "MINIMAX_BASE_URL",
    secret: false,
    reloadProviders: true,
  },
  {
    id: "composio.apiKey",
    label: "Composio project key",
    section: "composio",
    path: ["apiKey"],
    env: ["COMPOSIO_API_KEY"],
    infisicalName: "COMPOSIO_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "box.token",
    label: "Box API key",
    section: "box",
    path: ["token"],
    env: ["BOX_TOKEN"],
    infisicalName: "BOX_TOKEN",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "opencodeGo.apiKey",
    label: "OpenCode API key",
    section: "opencodeGo",
    path: ["apiKey"],
    env: ["OPENCODE_API_KEY"],
    infisicalName: "OPENCODE_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "tts.key",
    label: "Voice API key",
    section: "tts",
    path: ["key"],
    env: ["OMB_TTS_KEY"],
    infisicalName: "OMB_TTS_KEY",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "imageGen.key",
    label: "Image generation API key",
    section: "imageGen",
    path: ["key"],
    env: ["OMB_OPENAI_IMAGE_KEY"],
    infisicalName: "OMB_OPENAI_IMAGE_KEY",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "deepseek.key",
    label: "DeepSeek API key",
    section: "deepseek",
    path: ["key"],
    env: ["DEEPSEEK_API_KEY"],
    infisicalName: "DEEPSEEK_API_KEY",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "usage.ingestUrl",
    label: "Usage Monitor ingest URL",
    section: "usage",
    path: ["ingestUrl"],
    env: ["USAGE_MONITOR_INGEST_URL"],
    infisicalName: "USAGE_MONITOR_INGEST_URL",
    secret: false,
    reloadProviders: false,
  },
  {
    id: "usage.ingestToken",
    label: "Usage Monitor ingest token",
    section: "usage",
    path: ["ingestToken"],
    env: ["USAGE_MONITOR_INGEST_TOKEN", "USAGE_INGEST_TOKEN"],
    infisicalName: "USAGE_MONITOR_INGEST_TOKEN",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "usage.readToken",
    label: "Usage Monitor read token",
    section: "usage",
    path: ["readToken"],
    env: ["USAGE_READ_TOKEN"],
    infisicalName: "USAGE_READ_TOKEN",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "qdrant.url",
    label: "Bot RAG service URL",
    section: "qdrant",
    path: ["url"],
    env: ["OMB_RECALL_URL", "RECALL_URL", "QDRANT_URL"],
    infisicalName: "OMB_RECALL_URL",
    secret: false,
    reloadProviders: true,
  },
  {
    id: "qdrant.apiKey",
    label: "Bot RAG API key",
    section: "qdrant",
    path: ["apiKey"],
    env: ["OMB_RECALL_API_KEY", "RECALL_API_KEY", "QDRANT_API_KEY"],
    infisicalName: "OMB_RECALL_API_KEY",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "qdrant.collection",
    label: "Bot RAG collection",
    section: "qdrant",
    path: ["collection"],
    env: ["OMB_RECALL_COLLECTION", "RECALL_COLLECTION", "QDRANT_COLLECTION"],
    infisicalName: "OMB_RECALL_COLLECTION",
    secret: false,
    reloadProviders: true,
  },
  {
    id: "qdrant.accessClientId",
    label: "Bot RAG Access client id",
    section: "qdrant",
    path: ["accessClientId"],
    env: ["OMB_RECALL_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID"],
    infisicalName: "OMB_RECALL_ACCESS_CLIENT_ID",
    secret: false,
    reloadProviders: true,
  },
  {
    id: "qdrant.accessClientSecret",
    label: "Bot RAG Access client secret",
    section: "qdrant",
    path: ["accessClientSecret"],
    env: ["OMB_RECALL_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET"],
    infisicalName: "OMB_RECALL_ACCESS_CLIENT_SECRET",
    secret: true,
    reloadProviders: true,
  },
  {
    id: "imessageLinq.apiToken",
    label: "Linq API token",
    section: "imessageLinq",
    path: ["apiToken"],
    env: ["BOTFLEET_LINQAPP_API_KEY", "LINQ_API_TOKEN"],
    infisicalName: "LINQ_API_TOKEN",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "imessageLinq.webhookSecret",
    label: "Linq webhook signing secret",
    section: "imessageLinq",
    path: ["webhookSecret"],
    env: ["LINQ_WEBHOOK_SECRET"],
    infisicalName: "LINQ_WEBHOOK_SECRET",
    secret: true,
    reloadProviders: false,
  },
  {
    id: "observability.sentryDsn",
    label: "Sentry DSN",
    section: "observability",
    path: ["sentryDsn"],
    env: ["SENTRY_DSN", "BOTFLEET_SENTRY_DSN"],
    infisicalName: "SENTRY_DSN",
    secret: true,
    reloadProviders: false,
  },
] as const;

/** Every Infisical name this process will accept, built once from the table. */
const MAPPED_NAMES: ReadonlySet<string> = new Set(SECRET_FIELDS.map((spec) => spec.infisicalName));

export type SecretSource = "infisical" | "env" | "file" | "none";

export interface SecretProvenance {
  id: string;
  source: SecretSource;
  hasValue: boolean;
  /** True when this computer still holds its own copy that the vault overrode. */
  hasLocalCopy: boolean;
}

let snapshot: ReadonlyMap<string, string> | null = null;
let snapshotNames: readonly string[] = [];
let provenance: readonly SecretProvenance[] = [];

/** Publish what the vault holds, synchronously, for the next `loadConfig()`.
 *
 * `values` is filtered down to mapped names before it is stored, so an
 * unexpected row in somebody's project can never be applied no matter what it
 * is called.  `vaultNames` keeps the raw list — including the names BotFleet
 * does not use — because the Secrets card reports those as "In Infisical, not
 * used by BotFleet", and that report is the whole point of keeping them. */
export function setInfisicalSnapshot(
  values: ReadonlyMap<string, string> | null,
  vaultNameList: readonly string[],
): void {
  snapshotNames = [...vaultNameList];
  if (values === null) {
    snapshot = null;
    return;
  }
  const applied = new Map<string, string>();
  for (const [name, value] of values) {
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (!INFISICAL_NAME_PATTERN.test(name)) continue;
    if (!MAPPED_NAMES.has(name)) continue;
    applied.set(name, value);
  }
  snapshot = applied;
}

export function infisicalSnapshot(): ReadonlyMap<string, string> | null {
  return snapshot;
}

/** Every name the vault returned, mapped or not.  Names only, never values. */
export function vaultNames(): readonly string[] {
  return snapshotNames;
}

function readField(cfg: AppConfig, spec: SecretFieldSpec): string | undefined {
  // SAFETY: AppConfig is a plain object literal built by `parseStoredConfig`,
  // and `spec.section` is a `keyof AppConfig` from the table above, so indexing
  // it by string reads a declared section and nothing else.
  let node: unknown = (cfg as Record<string, unknown>)[spec.section];
  for (const key of spec.path) {
    if (!node || typeof node !== "object") return undefined;
    // SAFETY: guarded on the line above — `node` is a non-null object here.
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/** Copy each level on the way down before writing, exactly as the env overlay
 * in `loadConfig()` does: the object handed in may be the one the JSON parser
 * returned, and a caller elsewhere may still be holding the old section. */
function writeField(cfg: AppConfig, spec: SecretFieldSpec, value: string): void {
  // SAFETY: as in `readField` — a plain object indexed by a `keyof AppConfig`
  // that the table above owns, so every key written is a declared section.
  const record = cfg as Record<string, unknown>;
  const existing = record[spec.section];
  const section: Record<string, unknown> =
    // SAFETY: the ternary's own guard proves `existing` is a non-null object.
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  record[spec.section] = section;
  let node = section;
  for (let i = 0; i < spec.path.length - 1; i += 1) {
    const key = spec.path[i];
    const child = node[key];
    const next: Record<string, unknown> =
      // SAFETY: the ternary's own guard proves `child` is a non-null object.
      child && typeof child === "object" ? { ...(child as Record<string, unknown>) } : {};
    node[key] = next;
    node = next;
  }
  node[spec.path[spec.path.length - 1]] = value;
}

/** The first env alias that actually carries a value.  Priority order matters:
 * `OMB_RECALL_API_KEY` beats `QDRANT_API_KEY` here for the same reason it does
 * in `index.ts`. */
function envValueFor(spec: SecretFieldSpec, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of spec.env) {
    const raw = env[name];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

/** Apply the vault on top of an already-loaded config and record where every
 * mapped value came from.
 *
 * This runs at the end of `loadConfig()`, after the hand-written env overlay,
 * and it is the only place a vault value enters the process.  A field the
 * vault does not hold — or holds empty — is left exactly as the existing
 * env-and-file rules resolved it.
 *
 * The recorded source is a read-out of that same resolution: `env` when an
 * alias carries the value the config now holds (or the config holds none),
 * `file` when this computer's own copy is what survives, `infisical` when the
 * vault overrode both, and `none` when nothing has a value at all. */
export function resolveSecretFields(
  cfg: AppConfig,
  env: NodeJS.ProcessEnv,
  snap: ReadonlyMap<string, string> | null,
): SecretProvenance[] {
  const rows: SecretProvenance[] = [];
  for (const spec of SECRET_FIELDS) {
    const local = readField(cfg, spec) ?? "";
    const fromEnv = envValueFor(spec, env);
    const vaultValue = snap?.get(spec.infisicalName);

    let source: SecretSource;
    if (local) source = fromEnv !== undefined && fromEnv === local ? "env" : "file";
    else source = fromEnv !== undefined ? "env" : "none";

    let hasLocalCopy = false;
    let resolved = local || fromEnv || "";
    if (typeof vaultValue === "string" && vaultValue.length > 0) {
      writeField(cfg, spec, vaultValue);
      hasLocalCopy = local.length > 0;
      resolved = vaultValue;
      source = "infisical";
    }
    rows.push({ id: spec.id, source, hasValue: resolved.length > 0, hasLocalCopy });
  }
  provenance = rows;
  return rows;
}

/** Delete one mapped field from a config-shaped object, leaving its section
 * in place.  Only used by `stripVaultManagedValues`, which walks the same
 * table `readField` and `writeField` do. */
function deleteField(cfg: Partial<AppConfig>, spec: SecretFieldSpec): void {
  // SAFETY: as in `readField` — a plain object indexed by a `keyof AppConfig`
  // that the table above owns.
  let node: unknown = (cfg as Record<string, unknown>)[spec.section];
  for (const key of spec.path.slice(0, -1)) {
    if (!node || typeof node !== "object") return;
    // SAFETY: guarded on the line above.
    node = (node as Record<string, unknown>)[key];
  }
  if (!node || typeof node !== "object") return;
  // SAFETY: guarded on the line above.
  delete (node as Record<string, unknown>)[spec.path[spec.path.length - 1]];
}

/** Take every vault-managed credential back out of a config patch bound for
 * disk, and report which ones were dropped.
 *
 * A last line of defence, not the design.  The design is that a route saves
 * the section it owns; this catches the case where one hands `saveConfig` the
 * LIVE config object instead, because that object carries every value
 * `resolveSecretFields` just wrote into it — provider keys, ingest tokens, a
 * Sentry DSN — and persisting them writes the vault's contents to
 * `~/.botfleet/config.json` in cleartext, defeating the whole point of the
 * store being canonical.
 *
 * An EMPTY string is left alone on purpose: that is the tombstone the
 * write-through path writes deliberately, to overwrite an older plaintext
 * copy on disk.  Stripping it would leave the stale value sitting there.
 *
 * Every access goes through the section-and-path table above, so a caller
 * holding a zod-parsed patch (whose literal unions are wider than the
 * interface's) can narrow to this shape at the call site. */
export function stripVaultManagedValues(patch: Partial<AppConfig>): string[] {
  const stripped: string[] = [];
  for (const spec of SECRET_FIELDS) {
    if (secretSource(spec.id) !== "infisical") continue;
    // SAFETY: `readField` walks `spec.section` then `spec.path` and returns
    // undefined at any missing level, so a partial config is a valid input.
    const value = readField(patch as AppConfig, spec);
    if (value === undefined || value.length === 0) continue;
    deleteField(patch, spec);
    stripped.push(spec.id);
  }
  return stripped;
}

/** Where each mapped field came from at the last `loadConfig()`. */
export function secretProvenance(): readonly SecretProvenance[] {
  return provenance;
}

export function secretSource(id: string): SecretSource {
  return provenance.find((row) => row.id === id)?.source ?? "none";
}

/** A stable digest of the credentials whose change has to rebuild the fleet.
 *
 * Values are hashed on the way in and never leave: two configs with the same
 * provider keys produce the same string, a rotated key produces a different
 * one, and the digest itself reveals nothing.  Fields that take effect without
 * a rebuild — the voice key, the usage tokens, the DSN — are deliberately not
 * in it, so a refresh that touches only those never kills an in-flight turn. */
export function credentialFingerprint(cfg: AppConfig): string {
  const digest = createHash("sha256");
  const specs = SECRET_FIELDS.filter((spec) => spec.reloadProviders)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const spec of specs) {
    const value = readField(cfg, spec) ?? "";
    digest.update(`${spec.id}:${createHash("sha256").update(value, "utf8").digest("hex")}\n`);
  }
  return digest.digest("hex");
}
