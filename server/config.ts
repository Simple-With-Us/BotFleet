// Config + data dirs. One file, ~/.botfleet/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { updateConfigFile } from "../electron/config-file-lock.mjs";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import { infisicalSnapshot, resolveSecretFields, stripVaultManagedValues } from "./secret-map.ts";
import { describeDsn } from "./sentry.ts";
import {
  parseConversationMode,
  STORED_CONVERSATION_MODES,
  type ConversationMode,
} from "../shared/conversation-mode.ts";
import {
  ROOM_LABEL_MAX_LENGTH,
  type CustomRoomLabels,
  type RoomTerminology,
} from "../shared/terminology.ts";

const optionalText = z.string().optional();
const externalCredentialStorage = z.literal("external").optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

/** Custom webhook ingress must be a real origin, not a scheme-less host. */
export function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** A secret store is reached over TLS or not at all: the machine identity's
 * client secret rides in the request body on every login, so `http://` is not
 * a lesser configuration, it is a leak. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Both of these land in the query string of every secret-store call. */
const INFISICAL_ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,64}$/;
const INFISICAL_PROJECT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** A Sentry DSN, which is more than an https URL: the public key rides in
 * the username and the project id is the last path segment.
 * `isAbsoluteHttpUrl` accepts `http://` and rejects a username outright, so
 * it cannot stand in here.  A DSN missing either half is silently inert
 * inside the SDK, which is exactly the failure this rejects at the door.
 *
 * The rule itself lives in `describeDsn` rather than here, because the door
 * check and the runtime check drifting apart is what lets a DSN the SDK
 * refuses reach `Sentry.init`, where the SDK prints the whole thing —
 * public key included — through its own `console.error`.  One grammar, one
 * place, no drift. */
export function isSentryDsn(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  return describeDsn(raw) !== null;
}

/** Sentry truncates an environment past 80 characters, and so does the
 * usage-telemetry v2 schema.  Reject rather than silently store a name the
 * operator will never see again. */
export const MAX_OBSERVABILITY_ENVIRONMENT_LENGTH = 80;

/** Per-desktop budget on a VPS.  Unlike the Local VM — the only desktop on
 * the person's own workstation — a VPS runs one desktop per bot on a single
 * shared machine, so the default is a fraction of that host rather than a
 * whole workstation's worth.  3 GiB and 2 CPUs leaves an idle XFCE desktop
 * several times its observed footprint while letting a modest box carry four
 * to six bots at once.  Operators with a bigger or smaller VPS override it. */
export const VPS_DEFAULT_MEMORY_GIB = 3;
export const VPS_DEFAULT_CPUS = 2;

/** Bounds, not preferences: below these a desktop cannot boot, and above them
 * the value is far more likely a typo than an intent. */
const VPS_MEMORY_GIB_RANGE = { min: 2, max: 64 } as const;
const VPS_CPUS_RANGE = { min: 1, max: 32 } as const;

function normalizeVpsNumber(
  value: unknown,
  field: string,
  range: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`vps.${field} must be a whole number between ${range.min} and ${range.max}`);
  }
  return value;
}

/** Keep the persisted VPS shape deliberately smaller than an SSH connection. */
export function normalizeVpsConfig(raw: unknown): { sshAlias?: string; memoryGib?: number; cpus?: number } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const record = raw as Record<string, unknown>;
  const memoryGib = normalizeVpsNumber(record.memoryGib, "memoryGib", VPS_MEMORY_GIB_RANGE);
  const cpus = normalizeVpsNumber(record.cpus, "cpus", VPS_CPUS_RANGE);
  const sizing = { ...(memoryGib === undefined ? {} : { memoryGib }), ...(cpus === undefined ? {} : { cpus }) };
  const alias = record.sshAlias;
  // Sizing is meaningful on its own: an operator may set the budget before
  // naming the host, and dropping it here would silently lose the setting.
  if (alias === undefined || alias === "") return sizing;
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias, ...sizing };
}

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
  memoryGib: z.number().int().min(VPS_MEMORY_GIB_RANGE.min).max(VPS_MEMORY_GIB_RANGE.max).optional(),
  cpus: z.number().int().min(VPS_CPUS_RANGE.min).max(VPS_CPUS_RANGE.max).optional(),
});
/** What a bot that has never been configured is given.
 *
 * This fills in for `computers: undefined` only.  A bot whose computers were
 * explicitly emptied stays off, and a bot with its own destinations keeps
 * them — the workspace default is the answer to "nobody has said", not an
 * override of anyone who has.
 *
 * Unset ships as unset, so a fresh install still behaves exactly as before:
 * reuse whatever already exists, provision nothing, and on macOS fall back to
 * host control.  Nobody gets a server they did not ask for.
 *
 * `allowedComputers` is the operator-level allowlist: every granted set is
 * filtered through it before it is mounted, so disabling "This Computer" at the
 * top of the settings page is enough to keep any bot from running on the
 * host.  Absent means "every destination is allowed", preserving the shipped
 * behavior for every existing install. */
const botDefaultsSchema = z.object({
  computers: z.array(z.enum(["cloud", "vm", "local"])).max(3).optional(),
  cloudBackend: z.enum(["box", "vps"]).optional(),
  // `null` is the wire spelling of "no allowlist — every destination is
  // allowed", and it has to be accepted, not merely tolerated: the settings
  // panel carries the whole botDefaults block on every save, so a fresh
  // install (which has no allowlist) sent `null` with each unrelated change
  // and got a 400 back for it.  Omitting the key is not a substitute, either
  // -- the patch merges section by section, so an omitted key preserves
  // whatever is on disk, and re-enabling the last destination would silently
  // fail to clear the stored array.  null CLEARS; absent means "leave it".
  allowedComputers: z.array(z.enum(["cloud", "vm", "local"])).max(3).nullable().optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
});
const featureConfigSchema = z.object({
  /** Experimental desktop workflow recorder. Hidden unless explicitly enabled. */
  skillRecorder: z.boolean().optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Summarize consecutive tool actions into an expandable live summary card. On by default. */
  summarizeToolCalls: z.boolean().optional(),
});
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const appConfigSchema = z.object({
  deleteInstance: optionalText,
  xai: z.object({ key: optionalText, url: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  openaiCompat: z.object({ key: optionalText, url: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  /** MiniMax API key and base URL.  Same shape as `openaiCompat` above and
   * for the same reason: the driver speaks the OpenAI wire protocol against
   * an endpoint the operator may repoint (global, China, a gateway), so the
   * key and the URL travel together.  The driver itself reads
   * `MINIMAX_API_KEY` and its per-instance `config.url`; this section is the
   * workspace default those resolve from when no per-instance value is set. */
  minimax: z.object({ key: optionalText, url: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  // brokerUrl is read by the desktop shell only: the HTTPS origin of a
  // connected-apps broker the operator runs. There is no built-in default.
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText, brokerUrl: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  box: z.object({ token: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  /** Optional DeepSeek API key — used only to display the user's account
   * balance under the engine row, never injected into the engine's process
   * environment. The user can run a deepseek CLI without this set; the
   * engine does not need the key to function. "for my user" — workspace
   * scope, not per-bot. */
  deepseek: z.object({ key: optionalText, url: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  /** Voice credentials and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs a key) or "system" (the Mac's
   * built-in voices, no key). */
  tts: z.object({ key: optionalText, voice: optionalText, provider: z.enum(["elevenlabs", "system"]).optional(), credentialStorage: externalCredentialStorage }).optional(),
  /** OpenAI key used only by the in-process avatar image generator. */
  imageGen: z.object({ key: optionalText, credentialStorage: externalCredentialStorage }).optional(),
  autoUpdate: z
    .object({
      enabled: z.boolean().optional(),
      /** Wall-clock ms of the last successful automatic check.  Used by the
       * desktop shell to enforce the 6-hour throttle without consulting the
       * harness on every tick. */
      lastCheckMs: z.number().int().nonnegative().optional(),
      /** Fingerprint of the BotFleet.app bundle at the last check, so a
       * reinstall that landed an out-of-band build between checks still
       * shows up as "different from last known" on the next cycle. */
      lastAppFingerprint: z.string().optional(),
    })
    .optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  rooms: roomConfigSchema.optional(),
  botDefaults: botDefaultsSchema.optional(),
  ingress: z.object({
    publicUrl: z
      .string()
      .optional()
      .refine((value) => value === undefined || value === "" || isAbsoluteHttpUrl(value), {
        message: "must be an absolute http(s) URL",
      }),
    /** Whether the public URL is applied at all. Off keeps the stored URL
     * for the next time the toggle is flipped on, but the webhook receiver
     * does not advertise it. */
    enabled: z.boolean().optional(),
  }).optional(),
  localVm: localVmConfigSchema.optional(),
  qdrant: z.object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    collection: z.string().optional(),
    // Cloudflare Access service token, for a recall service published
    // behind Access.  Access ignores a bearer credential and wants this
    // header pair instead, so it is a separate field, not another API key.
    accessClientId: z.string().optional(),
    accessClientSecret: z.string().optional(),
  }).optional(),
  // Usage telemetry has no built-in endpoint: whoever runs BotFleet points
  // it at their own usage monitor. Unconfigured means the stream is off.
  usage: z.object({
    ingestUrl: optionalText,
    ingestToken: optionalText,
    readToken: optionalText,
    projects: z
      .array(z.object({ slug: z.string(), match: z.array(z.string()).optional() }))
      .optional(),
  }).optional(),
  // Error and performance reporting.  The kill switch is explicit: a DSN
  // with no `enabled` flag reports.  Only a stored `false` stops it, so an
  // upgraded install never goes quiet without saying why.
  observability: z.object({
    sentryDsn: optionalText,
    enabled: z.boolean().optional(),
    environment: optionalText,
    tracesSampleRate: z.number().min(0).max(1).optional(),
    logsEnabled: z.boolean().optional(),
  }).optional(),
  // An optional external secret store.  Unconfigured is inert: with no
  // project id and machine identity, BotFleet resolves exactly as it always
  // has.  The kill switch is explicit the same way `ingress` and
  // `observability` are — absent means on once it is configured.
  infisical: z.object({
    enabled: z.boolean().optional(),
    writeThrough: z.boolean().optional(),
    siteUrl: optionalText,
    projectId: optionalText,
    environment: optionalText,
    secretPath: optionalText,
    clientId: optionalText,
    clientSecret: optionalText,
    credentialStorage: externalCredentialStorage,
    refreshMinutes: z.number().int().min(5).max(1440).optional(),
  }).optional(),
  features: featureConfigSchema.optional(),
  conversationMode: z.enum(STORED_CONVERSATION_MODES).optional(),
  terminology: z
    .enum(["channels", "groups", "projects", "apps", "topics", "repos", "custom"])
    .optional(),
  // Only read when terminology is "custom".  Both forms are stored because
  // English plurals are not reliably "add an s" — Category/Categories.
  terminologyCustom: z
    .object({
      singular: z.string().max(ROOM_LABEL_MAX_LENGTH).optional(),
      plural: z.string().max(ROOM_LABEL_MAX_LENGTH).optional(),
    })
    .optional(),
  instances: instanceConfigMapSchema.optional(),
});
// `deleteInstance` also lives on the base schema (saveConfig's internal
// callers use appConfigSchema.partial() directly, not this schema) but must
// never be reachable from the general PATCH /api/config body: that route has
// none of the DELETE /api/instances/:id route's protections (protected-engine
// check, busy-bot check, atomic reassignment), so accepting it here would let
// `PATCH /api/config {"deleteInstance":"claude"}` bypass all of them and
// strand bots on a protected engine that no longer exists.
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, deleteInstance: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  deleteInstance?: string;
  xai?: { key?: string; url?: string; credentialStorage?: "external" };
  openaiCompat?: { key?: string; url?: string; credentialStorage?: "external" };
  minimax?: { key?: string; url?: string; credentialStorage?: "external" };
  composio?: { apiKey?: string; userId?: string; sessionId?: string; brokerUrl?: string; credentialStorage?: "external" };
  box?: { token?: string; credentialStorage?: "external" };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string; memoryGib?: number; cpus?: number };
  opencodeGo?: { apiKey?: string; credentialStorage?: "external" };
  deepseek?: { key?: string; url?: string; credentialStorage?: "external" };
  tts?: { key?: string; voice?: string; provider?: "elevenlabs" | "system"; credentialStorage?: "external" };
  imageGen?: { key?: string; credentialStorage?: "external" };
  autoUpdate?: {
    enabled?: boolean;
    lastCheckMs?: number;
    lastAppFingerprint?: string;
  };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  botDefaults?: {
    computers?: Array<"cloud" | "vm" | "local">;
    cloudBackend?: "box" | "vps";
    /** Operator-level allowlist; an absent entry means the destination is
     * allowed.  `null` is the same thing said out loud, and is what a client
     * sends to clear a narrowed allowlist back to "everything". */
    allowedComputers?: Array<"cloud" | "vm" | "local"> | null;
  };
  ingress?: { publicUrl?: string; enabled?: boolean };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number };
  /** Shared Qdrant Agent RAG vector database settings.  `accessClientId` /
   * `accessClientSecret` are a Cloudflare Access service token: a pair of
   * headers, needed when the recall service sits behind Access, where a
   * bearer credential is ignored. */
  qdrant?: {
    enabled?: boolean;
    url?: string;
    apiKey?: string;
    collection?: string;
    accessClientId?: string;
    accessClientSecret?: string;
  };
  /** Usage-monitor telemetry. `ingestUrl` is the operator's own endpoint —
   * BotFleet ships none — and `projects` classifies a turn's working
   * directory, bot name, or task title into a project slug. */
  usage?: {
    ingestUrl?: string;
    ingestToken?: string;
    readToken?: string;
    projects?: Array<{ slug: string; match?: string[] }>;
  };
  /** Error and performance reporting.  `sentryDsn` is the operator's own
   * Sentry project — BotFleet ships none.  `enabled` is the explicit kill
   * switch: absent means on, so a stored DSN reports until somebody turns
   * it off on purpose. */
  observability?: {
    sentryDsn?: string;
    enabled?: boolean;
    environment?: string;
    tracesSampleRate?: number;
    logsEnabled?: boolean;
  };
  /** The optional external secret store.  When it holds one of the names in
   * `server/secret-map.ts`, that value wins over both the environment and
   * this file; every other field keeps the ordering it always had.
   *
   * `clientId` and `clientSecret` are the machine identity that unlocks the
   * store, so they are the one pair of credentials in this file that never
   * resolves through the vault — a lock cannot hold its own key.  They are
   * read from this section or from `INFISICAL_CLIENT_ID` /
   * `INFISICAL_CLIENT_SECRET`, and nowhere else. */
  infisical?: {
    enabled?: boolean;
    writeThrough?: boolean;
    siteUrl?: string;
    projectId?: string;
    environment?: string;
    secretPath?: string;
    clientId?: string;
    clientSecret?: string;
    credentialStorage?: "external";
    refreshMinutes?: number;
  };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; summarizeToolCalls?: boolean };
  /** How the roster and threads are laid out.  Absent means simple. */
  conversationMode?: ConversationMode;
  /** What this person calls a room: one of the presets, or "custom" with a
   * word of their own in `terminologyCustom`.  Absent means channels. */
  terminology?: RoomTerminology;
  /** The custom room word, singular and plural.  Read only when
   * `terminology` is "custom"; resolved for clients by `resolveRoomLabels`. */
  terminologyCustom?: CustomRoomLabels;
  instances?: InstanceConfigMap;
}
export type ConfigPatch = Omit<z.output<typeof appConfigPatchSchema>, "conversationMode"> & {
  conversationMode?: ConversationMode;
};

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return {
    ...parsed.data,
    conversationMode: parsed.data.conversationMode === undefined
      ? undefined
      : parseConversationMode(parsed.data.conversationMode),
  };
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const section of ["xai", "openaiCompat", "minimax", "composio", "box", "opencodeGo", "deepseek", "tts", "imageGen", "infisical"]) {
      const candidate = value[section];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
          Object.hasOwn(candidate, "credentialStorage")) {
        throw Object.assign(new Error(`${section}.credentialStorage is managed by the desktop credential store`), { status: 400 });
      }
    }
  }
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  const { conversationMode: rawMode, ...rest } = parsed.data;
  const ingestUrl = rest.usage?.ingestUrl;
  if (ingestUrl !== undefined && ingestUrl.trim() && !isAbsoluteHttpUrl(ingestUrl)) {
    throw Object.assign(new Error("usage.ingestUrl must be an absolute http(s) URL"), { status: 400 });
  }
  // An empty or whitespace DSN is the documented "clear the stored key"
  // path, so it passes; anything else has to be a real DSN.
  const sentryDsn = rest.observability?.sentryDsn;
  if (sentryDsn !== undefined && sentryDsn.trim() && !isSentryDsn(sentryDsn)) {
    throw Object.assign(new Error("observability.sentryDsn must be a Sentry https:// DSN"), { status: 400 });
  }
  const sentryEnvironment = rest.observability?.environment;
  if (
    sentryEnvironment !== undefined &&
    sentryEnvironment.trim().length > MAX_OBSERVABILITY_ENVIRONMENT_LENGTH
  ) {
    throw Object.assign(
      new Error(
        `observability.environment must be ${MAX_OBSERVABILITY_ENVIRONMENT_LENGTH} characters or fewer`,
      ),
      { status: 400 },
    );
  }
  // The site URL, the project id, the environment and the secret path all end
  // up in the URL of every call to the secret store, so they are validated at
  // the door rather than escaped at each use.  An empty string is the
  // documented "clear this field" path for all four.
  const siteUrl = rest.infisical?.siteUrl;
  if (siteUrl !== undefined && siteUrl.trim() && !isHttpsUrl(siteUrl)) {
    throw Object.assign(new Error("infisical.siteUrl must be an absolute https:// URL"), { status: 400 });
  }
  const secretPath = rest.infisical?.secretPath;
  if (secretPath !== undefined && secretPath.trim() && !secretPath.trim().startsWith("/")) {
    throw Object.assign(new Error("infisical.secretPath must start with /"), { status: 400 });
  }
  const infisicalEnvironment = rest.infisical?.environment;
  if (
    infisicalEnvironment !== undefined &&
    infisicalEnvironment.trim() &&
    !INFISICAL_ENVIRONMENT_PATTERN.test(infisicalEnvironment.trim())
  ) {
    throw Object.assign(
      new Error("infisical.environment must be 1 to 64 lowercase letters, numbers, or dashes"),
      { status: 400 },
    );
  }
  const projectId = rest.infisical?.projectId;
  if (projectId !== undefined && projectId.trim() && !INFISICAL_PROJECT_ID_PATTERN.test(projectId.trim())) {
    throw Object.assign(
      new Error("infisical.projectId must be 1 to 64 letters, numbers, or dashes"),
      { status: 400 },
    );
  }
  return rawMode === undefined
    ? rest
    : { ...rest, conversationMode: parseConversationMode(rawMode) };
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

/** The per-desktop budget on this operator's VPS.  Both accessors fall back
 * to the shared-host default, so an unconfigured VPS still gets a size that
 * lets several bots coexist on one machine. */
export function vpsMemoryGib(cfg: AppConfig): number {
  return cfg.vps?.memoryGib ?? VPS_DEFAULT_MEMORY_GIB;
}

export function vpsCpus(cfg: AppConfig): number {
  return cfg.vps?.cpus ?? VPS_DEFAULT_CPUS;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export const AUTO_UPDATE_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** True when an automatic check is allowed to run right now.  The toggle
 * gates the throttle: an off setting means no auto check ever, regardless
 * of how long it has been since the last one.  Manual "Check for Updates"
 * always bypasses this helper. */
export function autoUpdateDue(cfg: AppConfig, nowMs: number = Date.now()): boolean {
  if (cfg.autoUpdate?.enabled !== true) return false;
  const last = cfg.autoUpdate?.lastCheckMs;
  if (typeof last !== "number" || !Number.isFinite(last) || last < 0) return true;
  return nowMs - last >= AUTO_UPDATE_THROTTLE_MS;
}

export function publicIngressUrl(cfg: AppConfig): string | null {
  const raw = cfg.ingress?.publicUrl?.trim();
  return raw && isAbsoluteHttpUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

/** The public URL that should actually be advertised.  Disabled
 * (`ingress.enabled === false`) keeps the stored value on disk for the next
 * time the user flips the switch, but the harness behaves as if the URL
 * were empty.  An absent flag defaults to on, so a config without the field
 * keeps working as it did before the toggle existed. */
export function publicIngressUrlEffective(cfg: AppConfig): string | null {
  if (cfg.ingress?.enabled === false) return null;
  return publicIngressUrl(cfg);
}


/** The operator's usage-monitor origin, or null when they have not set one.
 * There is deliberately no fallback endpoint — an unconfigured install sends
 * telemetry nowhere. */
export function usageIngestUrl(cfg: AppConfig): string | null {
  const raw = cfg.usage?.ingestUrl?.trim();
  return raw && isAbsoluteHttpUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

/** Project classification rules, in the order they should be consulted.
 * Rules with no usable slug or no match terms are dropped. */
export function usageProjectRules(cfg: AppConfig): Array<{ slug: string; match: string[] }> {
  const rules = cfg.usage?.projects ?? [];
  return rules
    .map((rule) => ({
      slug: (rule.slug || "").trim(),
      match: (rule.match ?? []).map((term) => term.trim()).filter(Boolean),
    }))
    .filter((rule) => rule.slug.length > 0 && rule.match.length > 0);
}

/** Sentry's own default is 1.0, which is far too much traffic for a
 * long-running harness.  A fifth of turns is enough to see a latency
 * regression without paying for every span. */
export const DEFAULT_SENTRY_TRACES_SAMPLE_RATE = 0.2;

/** Everything the Sentry runtime reads out of app config, already
 * defaulted.  `dsn` is null when nothing usable is stored — the operator's
 * own project or nothing, because BotFleet ships no DSN. */
export interface ObservabilitySettings {
  dsn: string | null;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  logsEnabled: boolean;
}

/** The stored DSN string, or null when none is present.  Shape checks live
 * in the runtime so a vault-injected malformed value stays visible on the
 * status card instead of disappearing as "not configured". */
export function sentryDsnConfigured(cfg: AppConfig): string | null {
  const raw = cfg.observability?.sentryDsn?.trim();
  return raw || null;
}

/** The explicit kill switch.  Absent means on, matching `ingress.enabled`:
 * an install that has never seen this setting keeps reporting, and only a
 * stored `false` stops it. */
export function observabilityEnabled(cfg: AppConfig): boolean {
  return cfg.observability?.enabled !== false;
}

/** Resolve the stored settings against their defaults.  `environment` and
 * `tracesSampleRate` fall back to the long-standing `SENTRY_ENV` and
 * `SENTRY_TRACES_SAMPLE_RATE` env names so an operator who pinned those
 * before this section existed keeps what they had; a value saved in
 * Settings wins over both.  The DSN resolves the other way round — env
 * beats config — and that ordering lives in the observability manager. */
export function observabilitySettings(cfg: AppConfig): ObservabilitySettings {
  const envRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  const rate =
    cfg.observability?.tracesSampleRate ??
    (Number.isFinite(envRate) ? envRate : DEFAULT_SENTRY_TRACES_SAMPLE_RATE);
  const environment =
    cfg.observability?.environment?.trim() ||
    (process.env.SENTRY_ENV || process.env.NODE_ENV || "production").trim() ||
    "production";
  return {
    dsn: sentryDsnConfigured(cfg),
    enabled: observabilityEnabled(cfg),
    environment: environment.slice(0, MAX_OBSERVABILITY_ENVIRONMENT_LENGTH),
    tracesSampleRate: Math.min(Math.max(rate, 0), 1),
    logsEnabled: cfg.observability?.logsEnabled !== false,
  };
}

/** Infisical's own hosted site, the environment BotFleet's fleet uses, and a
 * cadence low enough that a rotated key is picked up within a coffee break
 * without the store seeing meaningful traffic. */
export const DEFAULT_INFISICAL_SITE_URL = "https://app.infisical.com";
export const DEFAULT_INFISICAL_ENVIRONMENT = "prod";
export const DEFAULT_INFISICAL_SECRET_PATH = "/";
export const DEFAULT_INFISICAL_REFRESH_MINUTES = 15;

/** Everything the secret-store runtime reads out of app config, already
 * defaulted.  Values are used, never rendered: the only fields here a status
 * view may repeat are the site URL, the project id, the environment and the
 * path. */
export interface InfisicalSettings {
  enabled: boolean;
  writeThrough: boolean;
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId: string;
  clientSecret: string;
  refreshMinutes: number;
}

/** True when this install has actually been pointed at a secret store.  All
 * three parts are required: a project with no identity cannot be read, and an
 * identity with no project has nothing to read.  Unconfigured is inert — no
 * request is ever made, and nothing about resolution changes. */
export function infisicalConfigured(cfg: AppConfig): boolean {
  return Boolean(
    cfg.infisical?.projectId?.trim() && cfg.infisical?.clientId?.trim() && cfg.infisical?.clientSecret?.trim(),
  );
}

/** The explicit kill switch.  Absent means on once configured, matching
 * `ingress.enabled` and `observability.enabled`: connecting a store is the
 * deliberate act, and only a stored `false` undoes it. */
export function infisicalEnabled(cfg: AppConfig): boolean {
  return cfg.infisical?.enabled !== false;
}

/** Resolve the stored settings against their defaults.  Write-through
 * defaults to off: with it off a Settings save of a name the store manages is
 * refused outright, which is honest, rather than accepted and then reverted by
 * the next refresh, which is not. */
export function infisicalSettings(cfg: AppConfig): InfisicalSettings {
  const stored = cfg.infisical ?? {};
  const refresh = stored.refreshMinutes;
  return {
    enabled: infisicalEnabled(cfg),
    writeThrough: stored.writeThrough === true,
    siteUrl: (stored.siteUrl?.trim() || DEFAULT_INFISICAL_SITE_URL).replace(/\/+$/, ""),
    projectId: stored.projectId?.trim() ?? "",
    environment: stored.environment?.trim() || DEFAULT_INFISICAL_ENVIRONMENT,
    secretPath: stored.secretPath?.trim() || DEFAULT_INFISICAL_SECRET_PATH,
    clientId: stored.clientId?.trim() ?? "",
    clientSecret: stored.clientSecret ?? "",
    refreshMinutes:
      refresh !== undefined && Number.isFinite(refresh)
        ? Math.min(Math.max(Math.trunc(refresh), 5), 1440)
        : DEFAULT_INFISICAL_REFRESH_MINUTES,
  };
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

/** The destinations any bot is allowed to run on.  An absent allowlist means
 * "every destination is allowed", which is the shipped default and the
 * behavior an upgraded install sees until the operator narrows it.  An empty
 * allowlist is a deliberate, persisted "no bot may run on any desktop here". */
export function allowedBotComputers(cfg: AppConfig): Array<"cloud" | "vm" | "local"> | null {
  const list = cfg.botDefaults?.allowedComputers;
  // Absent and null are the same answer — "the operator never narrowed
  // anything" — and they must not diverge, because null reaches here from
  // both the wire and any config.json written before the key was dropped.
  if (list === undefined || list === null) return null;
  // De-duplicate while keeping the order the operator chose.
  return [...new Set(list)];
}

/** Filter a granted set against the operator allowlist.  An absent allowlist
 * passes everything through.  An entry blocked by the allowlist is dropped;
 * the result keeps the order of the input. */
export function filterAllowedComputers<T extends "cloud" | "vm" | "local">(
  granted: readonly T[],
  allowed: Array<"cloud" | "vm" | "local"> | null,
): T[] {
  if (allowed === null) return [...granted];
  const set = new Set(allowed);
  return granted.filter((entry) => set.has(entry));
}

export function skillRecorderEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillRecorder === true;
}

/** Tool steps in the transcript.  On by default.
 *
 * They used to be off, and the reason was sound at the time: a chip carried
 * a bare tool name, so a hundred of them said only "work happened".  A step
 * now says what it read, what it ran and how long it took (see
 * `shared/tool-activity.ts`), which is the difference between noise and the
 * record of a turn.  Settings still turns them off.
 *
 * Kept in step with `src/lib/feature-flags.ts`: this is the value the
 * clients are handed, so a default that disagreed with theirs would decide
 * the question here and make the other one dead code. */
export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls !== false;
}

export function summarizeToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.summarizeToolCalls !== false;
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".botfleet");
const LEGACY_HOME_DATA_DIRS = [".openmausbot", ".opengrokbot"] as const;
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

function migrateLegacyHomeDir(current: string, legacyNames: readonly string[]): void {
  if (existsSync(current)) return;
  for (const name of legacyNames) {
    const legacy = join(homedir(), name);
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, current);
      return;
    } catch {
      /* cross-device or busy — try the next predecessor */
    }
  }
}

export function ensureDirs() {
  // one-time migration from the pre-rename data dirs — bots, transcripts,
  // config and keys all carry over. Skip when tests isolate via OMB_DATA_DIR.
  if (!process.env.OMB_DATA_DIR) migrateLegacyHomeDir(DATA_DIR, LEGACY_HOME_DATA_DIRS);
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
  } catch {
    /* first run — env fallbacks below */
  }
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  //
  // This overlay is unchanged, and deliberately so.  `server/secret-map.ts`
  // sits ABOVE it rather than replacing it: for the names an external secret
  // store holds, the store wins; for every other name the ordering below —
  // env over file here, file over env in the per-call readers — is exactly
  // what it has always been.
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  cfg.openaiCompat = { ...cfg.openaiCompat };
  if (process.env.OPENAI_COMPAT_API_KEY !== undefined) cfg.openaiCompat.key = process.env.OPENAI_COMPAT_API_KEY;
  if (process.env.OPENAI_COMPAT_URL !== undefined) cfg.openaiCompat.url = process.env.OPENAI_COMPAT_URL;
  // Mirrors openaiCompat: the MiniMax driver reads `MINIMAX_API_KEY` and
  // `MINIMAX_BASE_URL` from the environment on its own, so without this
  // overlay a key exported in the shell would be invisible to the Settings
  // card that reports where the value came from — the driver would work and
  // the app would still say "not configured".
  cfg.minimax = { ...cfg.minimax };
  if (process.env.MINIMAX_API_KEY !== undefined) cfg.minimax.key = process.env.MINIMAX_API_KEY;
  if (process.env.MINIMAX_BASE_URL !== undefined) cfg.minimax.url = process.env.MINIMAX_BASE_URL;
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  // Mirrors openaiCompat above: the desktop shell moves the key into
  // credentials.bin and hands it back as DEEPSEEK_API_KEY at spawn, so this
  // is the one place a packaged-app save becomes visible again. Without it
  // the file value the tombstone leaves behind ("") was final: nothing ever
  // read the env var back, so configStatus.deepseek.configured stayed false
  // forever after a save.
  cfg.deepseek = { ...cfg.deepseek };
  if (process.env.DEEPSEEK_API_KEY !== undefined) cfg.deepseek.key = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_URL !== undefined) cfg.deepseek.url = process.env.DEEPSEEK_URL;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  // The secret store's own machine identity, which is the one credential pair
  // that cannot come out of the store.  The alias names mirror the pair the
  // iOS ship workflow already uses, so a single identity works in CI, on a
  // headless machine, and in Settings without being renamed on the way.
  // First defined wins, and env beats the file here for the same reason it
  // does above: the desktop shell injects it at spawn.
  cfg.infisical = { ...cfg.infisical };
  const identity: Array<[field: "clientId" | "clientSecret" | "projectId" | "siteUrl" | "environment" | "secretPath", names: string[]]> = [
    ["clientId", ["INFISICAL_CLIENT_ID", "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"]],
    ["clientSecret", ["INFISICAL_CLIENT_SECRET", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"]],
    ["projectId", ["INFISICAL_PROJECT_ID"]],
    ["siteUrl", ["INFISICAL_SITE_URL", "INFISICAL_DOMAIN"]],
    ["environment", ["INFISICAL_ENVIRONMENT"]],
    ["secretPath", ["INFISICAL_SECRET_PATH"]],
  ];
  for (const [field, names] of identity) {
    const name = names.find((candidate) => process.env[candidate] !== undefined);
    if (name !== undefined) cfg.infisical[field] = process.env[name];
  }
  // One resolution point, last: whatever the store holds for a mapped name
  // overwrites what env and file just agreed on, and the provenance of every
  // mapped field is recorded for the Secrets card.  With no store configured
  // the snapshot is null and this is a no-op.
  resolveSecretFields(cfg, process.env, infisicalSnapshot());
  return cfg;
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.minimax?.key, "MINIMAX_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    // Keeps the running process in step with a packaged-app save the same
    // way every sibling credential above does — loadConfig() prefers env,
    // so without this entry the key just saved to credentials.bin would
    // stay invisible to this process until the next launch.
    [patch.deepseek?.key, "DEEPSEEK_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
    [patch.usage?.ingestUrl, "USAGE_MONITOR_INGEST_URL"],
    [patch.usage?.ingestToken, "USAGE_MONITOR_INGEST_TOKEN"],
    [patch.usage?.readToken, "USAGE_READ_TOKEN"],
    // Without this, an identity injected by a plist or a shell export would
    // keep shadowing the one just saved in Settings, and the card would report
    // a store the operator has already replaced.
    [patch.infisical?.clientSecret, "INFISICAL_CLIENT_SECRET"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  if (patch.openaiCompat?.url !== undefined) {
    if (patch.openaiCompat.url) process.env["OPENAI_COMPAT_URL"] = patch.openaiCompat.url;
    else delete process.env["OPENAI_COMPAT_URL"];
  }
  if (patch.minimax?.url !== undefined) {
    if (patch.minimax.url) process.env["MINIMAX_BASE_URL"] = patch.minimax.url;
    else delete process.env["MINIMAX_BASE_URL"];
  }
  if (patch.deepseek?.url !== undefined) {
    if (patch.deepseek.url) process.env["DEEPSEEK_URL"] = patch.deepseek.url;
    else delete process.env["DEEPSEEK_URL"];
  }
  if (patch.infisical?.clientId !== undefined) {
    if (patch.infisical.clientId) process.env["INFISICAL_CLIENT_ID"] = patch.infisical.clientId;
    else delete process.env["INFISICAL_CLIENT_ID"];
  }
}

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  // The MiniMax driver spawns no CLI, so neither of these has ever been
  // needed by a child process — they are listed for the same reason
  // OPENAI_COMPAT_* are: a workspace credential the harness holds must not
  // ride into an unrelated engine through `...process.env`.
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_URL",
  // The secret store's machine identity.  It reads every name in the project,
  // so of everything on this list it is the one that must never ride into a
  // spawned engine CLI.  `electron/diagnostics.mjs` mirrors these four in
  // this exact order.
  //
  // Both spellings, because `resolveSecretFields` above accepts the
  // universal-auth aliases as equals: a headless install that exports only
  // the alias pair — the pair the iOS ship workflow already uses, which is
  // why the aliases exist — is authenticated exactly as strongly, so
  // stripping the canonical names alone would hand every bot CLI a machine
  // identity that can read the whole project.
  //
  // Deliberately NOT extended to the pointer names (project id, site URL,
  // domain, environment, secret path): those are not credentials, they carry
  // nothing an engine could authenticate with, and once both identity pairs
  // are gone they unlock nothing.  This list is what a child must never
  // inherit, not everything the store happens to read.
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Merge a partial config into ~/.botfleet/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
type CheckedConfigPatch = z.infer<ReturnType<typeof appConfigSchema.partial>>;

type ExternalCredentialSection = "xai" | "openaiCompat" | "minimax" | "composio" | "box" | "opencodeGo" | "deepseek" | "tts" | "imageGen" | "infisical";

export function saveConfig(
  patch: Partial<AppConfig>,
  options: { externalCredentialSections?: Partial<Record<ExternalCredentialSection, boolean>> } = {},
): void {
  const p = join(DATA_DIR, "config.json");
  const checkedPatch = appConfigSchema.partial().parse(patch);
  // Last line of defence, on the parsed COPY so a caller's own object is
  // never mutated: whatever the store is currently canonical for does not go
  // to disk in cleartext.  A route that hands us the live config object --
  // instead of the section it owns -- is handing us every value
  // `resolveSecretFields` just wrote into it, and persisting those would put
  // the vault's contents in `~/.botfleet/config.json` for anything running as
  // this user, Time Machine, and every backup to read.  An empty string is
  // left alone: that is the write-through path's deliberate tombstone.
  // SAFETY: `checkedPatch` is `appConfigSchema.partial()`'s output — the same
  // sections `AppConfig` declares, differing only in zod's wider literal
  // unions, which the section-and-path walk below never reads.
  const strippedFromDisk = stripVaultManagedValues(checkedPatch as Partial<AppConfig>);
  if (strippedFromDisk.length > 0) {
    // Field ids only, never values -- and worth saying out loud, because it
    // means a caller tried to persist something the store owns.
    console.warn(`[secrets] not persisting vault-managed values: ${strippedFromDisk.join(", ")}`);
  }
  mkdirSync(DATA_DIR, { recursive: true });
  // Under the cross-process lock (electron/config-file-lock.mjs) -- the same
  // one the Electron auto-updater and boot migrations take -- so the read,
  // the merge and the rename happen with no other writer in between.  A
  // save from the other process can never be answered with this one's
  // stale snapshot, and vice versa.  (PR #251 review, board a2a3a586.)
  updateConfigFile(p, (raw) => {
    const merged = mergeConfigPatch(raw, checkedPatch);
    for (const [section, present] of Object.entries(options.externalCredentialSections ?? {})) {
      const current = jsonObjectSchema.safeParse(merged[section]);
      const next: JsonObject = current.success ? { ...current.data } : {};
      if (present) next.credentialStorage = "external";
      else delete next.credentialStorage;
      merged[section] = next;
    }
    return merged;
  }, { mode: 0o600 });
}

/** Merge a validated patch into the parsed on-disk object.  Runs under the
 * config lock, so it must stay synchronous and must not call back into
 * saveConfig. */
function mergeConfigPatch(raw: Record<string, unknown>, checkedPatch: CheckedConfigPatch): JsonObject {
  const parsed = jsonObjectSchema.safeParse(raw);
  const disk: JsonObject = parsed.success ? parsed.data : {};
  // usage, qdrant and observability are operator-supplied endpoints (Usage
  // Monitor telemetry, Bot RAG, Sentry).  They must merge like the other
  // sections: a URL-only patch must not wipe a stored token, and a
  // toggle-only patch must not wipe a stored DSN.  Omitting them from this
  // list meant PATCH /api/config { usage } never wrote
  // ~/.botfleet/config.json, so Settings reloaded empty fields.
  //
  // `deepseek` was missing for the same reason and had the same bug: the key
  // is in the schema, in the API Keys panel and in the tombstone list, but a
  // save of it never reached disk.  `infisical` is here from the start so the
  // machine identity does not repeat it a third time.
  for (const key of ["xai", "openaiCompat", "minimax", "composio", "box", "opencodeGo", "deepseek", "tts", "imageGen", "profile", "rooms", "localVm", "features", "autoUpdate", "ingress", "usage", "qdrant", "observability", "infisical", "botDefaults"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
    disk[key] = merged;
  }
  // `botDefaults.allowedComputers: null` means "clear the allowlist".  The
  // section merge above cannot express that -- it assigns the null straight
  // through -- so the key is removed here instead, which keeps config.json
  // holding only the two states the reader has ever had to understand:
  // the key is present and narrows, or it is absent and allows everything.
  if (checkedPatch.botDefaults?.allowedComputers === null) {
    const stored = jsonObjectSchema.safeParse(disk.botDefaults);
    if (stored.success) {
      const { allowedComputers: _cleared, ...rest } = stored.data;
      disk.botDefaults = rest;
    }
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  if (checkedPatch.conversationMode !== undefined) disk.conversationMode = checkedPatch.conversationMode;
  if (checkedPatch.terminology !== undefined) disk.terminology = checkedPatch.terminology;
  if (checkedPatch.terminologyCustom !== undefined) disk.terminologyCustom = checkedPatch.terminologyCustom;
  if (checkedPatch.deleteInstance) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    if (currentInstances.success && currentInstances.data) {
      delete currentInstances.data[checkedPatch.deleteInstance];
      disk.instances = currentInstances.data;
    }
  }
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  return disk;
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so those injected keys are stripped
 * back out before the map is returned — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function patchInstanceConfig(
  cfg: AppConfig,
  instanceId: string,
  patch: { cli?: string; fullAuto?: boolean; enabled?: boolean; key?: string; externalCredential?: boolean },
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };

  // Every OTHER instance is carried through in the form it already has on
  // disk, untouched.  This function used to hand back a stripped copy of the
  // whole live map, which meant patching one engine's CLI path rewrote every
  // other engine's entry too — and stripped anything that happened to look
  // like a workspace default in all of them.  A patch changes one instance.
  const persistable: InstanceConfigMap = { ...persistableInstanceConfigs(next) };

  // The one being patched is read in PERSISTABLE form, never live: `map` came
  // out of instanceConfigs(), so its entry carries what workspace config
  // materialized onto it — the injected credential env, and a `config.url`
  // resolved from the workspace endpoint.  Layering the patch onto that would
  // copy both into `nextConfig` and persist them: the key half leaves a
  // PREVIOUS key behind in the persisted environment, still shadowing the one
  // just saved, and the url half turns a fallback into a per-instance
  // override that the next workspace change can no longer reach.
  const persisted = { ...(persistable[instanceId] ?? stripInjectedDefaults(next, { [instanceId]: map[instanceId] })[instanceId]) };
  persistable[instanceId] = persisted;

  const currentConfig = jsonObjectSchema.safeParse(persisted.config);
  const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};

  if (patch.cli !== undefined) {
    const cliKey = patch.cli.trim();
    if (cliKey) {
      nextConfig.cli = cliKey;
    } else {
      delete nextConfig.cli;
    }
  }

  if (patch.fullAuto !== undefined) {
    if (patch.fullAuto) {
      nextConfig.fullAuto = true;
    } else {
      delete nextConfig.fullAuto;
    }
  }

  // Dev-mode (no Electron bridge) fallback only: the caller in server/index.ts
  // intercepts `key` ahead of this function whenever the request carries
  // `?secretStorage=external`, so a key routed through the encrypted store
  // never reaches here and never lands in `nextConfig` — it rides a
  // runtime-only environment override instead. This branch is what a plain
  // PATCH (dev/browser, no bridge) falls back to, same plaintext-in-config.json
  // shape the create-time `customConfig.key` path already uses.
  if (patch.key !== undefined) {
    const keyValue = patch.key.trim();
    if (keyValue) {
      nextConfig.key = keyValue;
    } else {
      delete nextConfig.key;
    }
  }

  if (patch.externalCredential !== undefined) {
    if (patch.externalCredential) nextConfig.credentialStorage = "external";
    else delete nextConfig.credentialStorage;
  }

  // `enabled` lives on the entry envelope, not in `entry.config` — same shape
  // the registry reads in ProviderRegistry.load. Re-enabling clears the flag
  // so a true re-enable and a fresh install both round-trip as the same
  // on-disk form — explicit `undefined`, NOT `delete`: saveConfig's instances
  // merge is per-key (mergeConfigPatch does Object.assign(merged, entry) onto
  // the existing disk entry), so a key this object never HAS is invisible to
  // that merge and a stale `enabled: false` already on disk would survive a
  // re-enable forever. Keeping the key with an explicit `undefined` value
  // clears it on merge — JSON.stringify drops it from the file the same way
  // `entry.config = undefined` already does just below.
  if (patch.enabled !== undefined) {
    // Set on the stripped copy, which is the object that gets persisted.
    persisted.enabled = patch.enabled ? undefined : false;
  }

  persisted.config = Object.keys(nextConfig).length ? nextConfig : undefined;
  next.instances = persistable;
  return { ok: true, config: next };
}

export function deleteInstanceConfig(
  cfg: AppConfig,
  instanceId: string,
): { ok: boolean; config: AppConfig } {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  delete map[instanceId];
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one instance — shared with
 * patchInstanceConfig() so the inject rule and the strip rule cannot drift apart.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process.
 *
 * `openai-compat` is the one driver with multiple instances (a user-added
 * custom engine shares it), so the driver check alone is not enough — the
 * workspace's `openaiCompat.key`/`url` may only reach the single reserved
 * `openaiCompat` instance. A user-added instance keeps the same driver but
 * points at whatever arbitrary endpoint the user just typed in; injecting the
 * shared credential into it too would hand that endpoint the workspace's real
 * OpenRouter/Groq key as a bearer token. A custom instance gets only the key
 * (if any) the user entered for that specific instance, via `config.key`. */
function injectedEnvironment(
  cfg: AppConfig,
  driver: string,
  instanceId: string,
  /** The entry's own opaque `config` blob, for the one driver whose
   * per-instance key rides in it — `readInstanceConfigText` is its parse. */
  entryConfig?: InstanceConfig["config"],
): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  const isWorkspaceOpenAiCompatInstance = driver === "openai-compat" && instanceId === "openaiCompat";
  if (isWorkspaceOpenAiCompatInstance && cfg.openaiCompat?.key)
    environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
  if (isWorkspaceOpenAiCompatInstance && cfg.openaiCompat?.url)
    environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  // MiniMax is the second driver that can carry more than one instance, and
  // the same instance-id gate applies for the same reason: a second instance
  // points at whatever endpoint the operator typed in (the China host, a
  // gateway, a reseller), so the workspace key may only reach the reserved
  // `minimax` instance.  Unlike openai-compat the driver reads no `config.key`
  // of its own — `resolveMinimaxCredentials` looks at the instance
  // environment, then process env, then ~/.mmx/config.json — so a
  // per-instance key is delivered here, and takes precedence over the
  // workspace one for the instance that carries it.
  if (driver === "minimax") {
    const instanceKey = readInstanceConfigText(entryConfig, "key");
    if (instanceKey) environment.set("MINIMAX_API_KEY", instanceKey);
    else if (instanceId === "minimax" && cfg.minimax?.key)
      environment.set("MINIMAX_API_KEY", cfg.minimax.key);
  }
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  return environment;
}

/** One string field out of an instance's opaque `config` blob.  The blob is
 * `z.json()` in the schema, so this IS its parse boundary — the same shape
 * `cliOfRaw` and `fullAutoOfRaw` already use in the registry. */
const instanceTextSchema = z.object({
  key: z.string().optional(),
  url: z.string().optional(),
  urlSource: z.string().optional(),
});

function readInstanceConfigText(
  raw: InstanceConfig["config"],
  field: "key" | "url" | "urlSource",
): string | undefined {
  const parsed = instanceTextSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data[field]?.trim();
  return value ? value : undefined;
}

/** The per-instance environment variable each driver that supports more than
 * one instance reads its API key from.  Declared in
 * electron/workspace-credentials.mjs and re-exported here: the desktop shell's
 * boot-time marker repair walks the same table and cannot import TypeScript,
 * and two copies of it is exactly the drift that left MiniMax instances out
 * of that repair. */
export { INSTANCE_API_KEY_ENV } from "../electron/workspace-credentials.mjs";

/** Strip everything instanceConfigs() materialized onto an entry from
 * WORKSPACE config, before that entry is persisted.
 *
 * Two kinds of value, one rule.  The credential env is the obvious one:
 * instanceConfigs() bakes each secret into the consuming entry's
 * `environment` for the live driver to read, and anything that persists a
 * snapshot of that transient map — adding the first custom engine when
 * `cfg.instances` was never set, patching a per-instance override — must
 * strip them back out, or config.json ends up holding a literal copy of a
 * secret that was never meant to live on disk and a later rotation leaves the
 * stale copy still active.
 *
 * `config.url` is the same bug wearing different clothes.  The workspace
 * endpoint is a FALLBACK: an instance with no url of its own resolves one at
 * load time.  Persisting the resolved value turns that fallback into a
 * per-instance override, so the next change to the workspace endpoint
 * silently stops reaching the instance it was set for, and Settings reports
 * an endpoint the engine is no longer using.
 *
 * Which url is which is decided by PROVENANCE, never by comparing values.
 * instanceConfigs() stamps `urlSource: "workspace"` on exactly the entries it
 * resolved one onto, and only those are stripped.  Comparing values instead
 * was its own bug in both directions: a connection the operator deliberately
 * pointed at the workspace's own endpoint looked identical to a resolved
 * fallback, so it was stripped and then silently re-pointed by the next
 * workspace change — and an entry written before this marker existed has no
 * way to prove it was typed, so it is left alone rather than guessed at. */
export function stripInjectedDefaults(cfg: AppConfig, map: InstanceConfigMap): InstanceConfigMap {
  const stripped: InstanceConfigMap = {};
  for (const [id, entry] of Object.entries(map)) {
    const next = { ...entry };
    if (readInstanceConfigText(entry.config, "urlSource") === WORKSPACE_URL_SOURCE) {
      const parsed = jsonObjectSchema.safeParse(entry.config);
      const { url: _resolved, urlSource: _marker, ...rest } = parsed.success ? parsed.data : {};
      next.config = Object.keys(rest).length ? rest : undefined;
    }
    if (!entry.environment) {
      stripped[id] = next;
      continue;
    }
    const injected = injectedEnvironment(cfg, entry.driver, id, entry.config);
    const environment = { ...entry.environment };
    for (const [k, v] of Object.entries(environment)) {
      if (injected.get(k) === v) delete environment[k];
    }
    stripped[id] = Object.keys(environment).length
      ? { ...next, environment }
      : { ...next, environment: undefined };
  }
  return stripped;
}

/** Stamped by instanceConfigs() onto an entry whose `config.url` it resolved
 * from workspace config, and read by stripInjectedDefaults() on the way back
 * out.  Transient by construction: it never survives a persist, so an entry
 * on disk carrying it would have to have been written by a build that had
 * this materialiser and not this strip. */
const WORKSPACE_URL_SOURCE = "workspace";

/** The workspace-level endpoint a driver's instances fall back to, if it has
 * one.  Only the two engines configured with an endpoint and a key do. */
function workspaceDriverUrl(cfg: AppConfig, driver: string): string | undefined {
  if (driver === "openai-compat") return cfg.openaiCompat?.url;
  if (driver === "minimax") return cfg.minimax?.url;
  return undefined;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars — but only into the
// driver that consumes each key (injectedEnvironment above).
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google models exclusively ride `antigravityAgent` (the `agy` CLI).
  // Gemini direct CLI and API drivers have been retired in favor of the
  // mature, fully integrated Antigravity driver.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    dsh: { driver: "dshAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    antigravity: { driver: "antigravityAgent" },
    minimax: { driver: "minimax" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  };
  const CUSTOM_ONLY = {
    kimi: { driver: "kimiAgent" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    dsh: { driver: "dshAgent" },
    minimax: { driver: "minimax" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  // Product fleets pick up newly shipped engines. A one-off test/shadow map
  // (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    // instanceConfigs() builds a transient runtime map. Never mutate the
    // caller's persisted entries while injecting workspace defaults: doing so
    // would turn the first workspace URL into a stale per-instance override.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    for (const [key, value] of injectedEnvironment(cfg, entry.driver, id, entry.config)) environment[key] = value;
    entry.environment = environment;
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.  MiniMax joins
    // openai-compat here because its own `decodeMinimaxConfig` reads
    // `config.url` first and only then `MINIMAX_BASE_URL` from process env —
    // a workspace URL saved in Settings would otherwise never reach it.
    const workspaceUrl = workspaceDriverUrl(cfg, entry.driver);
    if (workspaceUrl) {
      const parsed = jsonObjectSchema.safeParse(entry.config);
      const current = parsed.success ? parsed.data : {};
      // Stamped as workspace-resolved so the persist paths can tell this url
      // apart from one the operator typed, WITHOUT comparing the two values —
      // they are frequently equal, and guessing from that is how a typed
      // endpoint got silently re-pointed.
      if (typeof current.url !== "string" || !current.url.trim()) {
        entry.config = { ...current, url: workspaceUrl, urlSource: WORKSPACE_URL_SOURCE };
      }
    }
  }
  return map;
}

/** The base instances map a new entry (e.g. a newly added custom engine)
 * should be merged onto before persisting. When `cfg.instances` is already
 * set, it IS the persistable base — reuse it untouched. On a default
 * install (`cfg.instances` absent), the base has to be instanceConfigs()'s
 * materialized default fleet so the full built-in roster round-trips onto
 * disk once `instances` becomes non-empty — but that map is the LIVE
 * transient one, with injected credentials baked into `environment`
 * (BOX_TOKEN, OPENCODE_API_KEY, OPENAI_COMPAT_API_KEY, …), so it must be
 * stripped first or saving it copies those live secrets into config.json. */
export function persistableInstanceConfigs(cfg: AppConfig): InstanceConfigMap {
  return cfg.instances && Object.keys(cfg.instances).length
    ? cfg.instances
    : stripInjectedDefaults(cfg, instanceConfigs(cfg));
}
