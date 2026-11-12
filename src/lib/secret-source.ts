/** Client-side helpers for the Secrets card and the per-field provenance
 * badges: where a mapped credential came from, what the Secret Store pill
 * says, and the settings patch the card saves.
 *
 * `SecretSource` mirrors `server/secret-map.ts`'s own union — duplicated
 * rather than imported, the same way `observability-status.ts` duplicates
 * `ObservabilityStatusView` instead of importing the server module: the
 * renderer cannot pull in a server file (it would drag `node:crypto` into
 * the browser bundle), so the shared shape is a few lines of copy the tests
 * below keep honest, not a shared import. */
export type SecretSource = "infisical" | "env" | "file" | "none";

/** Sentence case, for the "Value" column of the provenance table.  A field
 * this install has never resolved from anywhere reports "Not set", which is
 * a fourth, distinct state from "This computer" — the latter means a value
 * exists and it is the file's own copy. */
export function secretSourceLabel(source: SecretSource | undefined): "Infisical" | "Environment" | "This computer" | "Not set" {
  if (source === "infisical") return "Infisical";
  if (source === "env") return "Environment";
  if (source === "file") return "This computer";
  return "Not set";
}

export type SecretSourceTone = "managed" | "environment" | "local" | "unset";

/** The visual weight for each source — `managed` is the one state that
 * changes what the operator can do with the field (the input disables and
 * the save path can refuse), so it is the only tone that reads as an accent
 * rather than a neutral fact. */
export function secretSourceTone(source: SecretSource | undefined): SecretSourceTone {
  if (source === "infisical") return "managed";
  if (source === "env") return "environment";
  if (source === "file") return "local";
  return "unset";
}

/** What the provenance chip actually says.
 *
 * `elsewhere` is a path the SERVER found holding this value outside
 * everything the secret map can see — today only `~/.mmx/config.json`, which
 * the MiniMax driver reads on its own. It is reported only when no source
 * the map does see has a value, so it can never claim credit for a key that
 * is really coming from the environment or the vault. Naming the file beats
 * "Not set" next to an engine whose turns visibly work. */
export interface SecretSourceDisplay {
  label: string;
  tone: SecretSourceTone;
  /** True when `label` is a path outside BotFleet rather than a managed
   * source — the chip renders it verbatim instead of upper-casing it. */
  external: boolean;
}

export function secretSourceDisplay(
  source: SecretSource | undefined,
  elsewhere?: string | null,
): SecretSourceDisplay {
  if (elsewhere && (source === undefined || source === "none")) {
    return { label: elsewhere, tone: "local", external: true };
  }
  return { label: secretSourceLabel(source), tone: secretSourceTone(source), external: false };
}

export type InfisicalPillTone = "active" | "off" | "error" | "waiting";

export interface InfisicalPillLabel {
  label: "Connected" | "Turned off" | "Not configured" | "Error" | "Stale" | "Waiting";
  tone: InfisicalPillTone;
}

/** The Secret Store card's status pill.  Modelled on `observabilityBadge`
 * (`observability-status.ts`) and `telemetryBadge`: a live error always wins,
 * then "no status yet", then the configured/enabled/stale ladder. `stale`
 * is the state a timer refresh failure leaves behind — the previous
 * snapshot is still in effect, but it may be behind the vault by now, which
 * is worth a distinct label from a clean "Connected". */
export function infisicalStatusLabel(
  status: { configured: boolean; enabled: boolean; lastError?: string | null; stale?: boolean } | null,
  fetchError?: string | null,
): InfisicalPillLabel {
  const lastError = fetchError || status?.lastError || null;
  if (lastError) return { label: "Error", tone: "error" };
  if (!status) return { label: "Waiting", tone: "waiting" };
  if (!status.configured) return { label: "Not configured", tone: "off" };
  if (!status.enabled) return { label: "Turned off", tone: "off" };
  if (status.stale) return { label: "Stale", tone: "waiting" };
  return { label: "Connected", tone: "active" };
}

/** Where the Use Infisical switch starts, given the config/status blocks.
 *
 * Prefer the persisted operator toggle, which remains meaningful before
 * credentials exist.
 *
 * Older servers expose only effective `enabled`, so
 * retain the previous compatibility fallback for those responses. */
export function infisicalSwitchDefault(
  config: { configured?: boolean; enabled?: boolean; enabledSetting?: boolean } | null | undefined,
): boolean {
  if (config?.enabledSetting === true || config?.enabledSetting === false) return config.enabledSetting;
  if (!config?.configured) return true;
  return config.enabled !== false;
}

const INFISICAL_ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,64}$/;
const INFISICAL_PROJECT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** What the Secret Store card sends on Save.  `siteUrl`, `projectId`,
 * `environment` and `secretPath` are always present — an empty string is the
 * documented "clear this" path `server/config.ts`'s `parseConfigPatch` reads
 * for all four, and the form always starts them populated from the last
 * fetched status, so resending them is just an echo unless the operator
 * deliberately blanked one.
 *
 * Credential fields are different: `GET /api/infisical/status` reports only
 * configured flags, so a blank input means "leave the saved credential
 * alone" and is omitted from the patch. */
export type InfisicalConfigPatch = {
  enabled: boolean;
  writeThrough: boolean;
  authMethod: "service-token" | "machine-identity";
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId?: string;
  clientSecret?: string;
  token?: string;
  writeToken?: string;
  readSources?: InfisicalReadSourcePatch[];
  refreshMinutes: number;
};

export type InfisicalReadSourcePatch = {
  name: string;
  projectId: string;
  environment?: string;
  secretPath?: string;
  tokenFile?: string;
  tokenEnv?: string;
  writeTokenFile?: string;
  writeTokenEnv?: string;
};

export type InfisicalSourceDraft = {
  name: string;
  projectId: string;
  environment: string;
  secretPath: string;
  readSourceType: "file" | "env";
  readSource: string;
  writeSourceType: "file" | "env";
  writeSource: string;
};

/** Keep the server's file-before-environment credential precedence on save. */
export function sourceDraftsFromStatus(sources: readonly InfisicalReadSourcePatch[]): InfisicalSourceDraft[] {
  return sources.map((source) => ({
    name: source.name,
    projectId: source.projectId,
    environment: source.environment ?? "prod",
    secretPath: source.secretPath ?? "/",
    readSourceType: source.tokenFile ? "file" : "env",
    readSource: source.tokenFile || source.tokenEnv || "",
    writeSourceType: source.writeTokenFile ? "file" : "env",
    writeSource: source.writeTokenFile || source.writeTokenEnv || "",
  }));
}

export function buildInfisicalConfigPatch(input: {
  enabled: boolean;
  writeThrough: boolean;
  authMethod: "service-token" | "machine-identity";
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId: string;
  clientSecret: string;
  token: string;
  writeToken: string;
  readSources?: InfisicalSourceDraft[];
  refreshMinutes: number;
}): { ok: true; patch: InfisicalConfigPatch } | { ok: false; error: string } {
  const siteUrl = input.siteUrl.trim();
  if (siteUrl && !isAbsoluteHttpsUrl(siteUrl)) {
    return { ok: false, error: "Site URL must be an absolute https:// URL." };
  }
  const secretPath = input.secretPath.trim();
  if (secretPath && !secretPath.startsWith("/")) {
    return { ok: false, error: "Secret Path must start with /." };
  }
  const environment = input.environment.trim();
  if (environment && !INFISICAL_ENVIRONMENT_PATTERN.test(environment)) {
    return { ok: false, error: "Environment must be 1 to 64 lowercase letters, numbers, or dashes." };
  }
  const projectId = input.projectId.trim();
  if (projectId && !INFISICAL_PROJECT_ID_PATTERN.test(projectId)) {
    return { ok: false, error: "Project ID must be 1 to 64 letters, numbers, or dashes." };
  }
  if (!Number.isFinite(input.refreshMinutes) || input.refreshMinutes < 5 || input.refreshMinutes > 1440) {
    return { ok: false, error: "Refresh Minutes must be between 5 and 1440." };
  }

  const sources: InfisicalReadSourcePatch[] = [];
  const sourceNames = new Set<string>();
  const sourceScopes = new Set<string>();
  for (const [index, draft] of (input.readSources ?? []).entries()) {
    const name = draft.name.trim();
    const sourceProjectId = draft.projectId.trim();
    const sourceEnvironment = draft.environment.trim();
    const sourcePath = draft.secretPath.trim();
    const readSource = draft.readSource.trim();
    const writeSource = draft.writeSource.trim();
    if (![name, sourceProjectId, sourceEnvironment, sourcePath, readSource, writeSource].some(Boolean)) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      return { ok: false, error: `Source ${index + 1}: Name must use lowercase letters, numbers, or dashes.` };
    }
    if (sourceNames.has(name)) return { ok: false, error: `Source ${index + 1}: Names must be unique.` };
    sourceNames.add(name);
    if (!sourceProjectId || !INFISICAL_PROJECT_ID_PATTERN.test(sourceProjectId)) {
      return { ok: false, error: `Source ${index + 1}: Project ID must be 1 to 64 letters, numbers, or dashes.` };
    }
    if (!sourceEnvironment || !INFISICAL_ENVIRONMENT_PATTERN.test(sourceEnvironment)) {
      return { ok: false, error: `Source ${index + 1}: Environment must be 1 to 64 lowercase letters, numbers, or dashes.` };
    }
    if (!sourcePath || !/^\/[A-Za-z0-9/_-]*$/.test(sourcePath) || sourcePath.length > 200) {
      return { ok: false, error: `Source ${index + 1}: Folder must be / or an absolute Infisical folder path.` };
    }
    const scope = `${sourceProjectId}\u0000${sourceEnvironment}\u0000${sourcePath.replace(/\/$/, "") || "/"}`;
    if (sourceScopes.has(scope)) return { ok: false, error: `Source ${index + 1}: Project, environment, and folder must be unique.` };
    sourceScopes.add(scope);
    if (!readSource && !writeSource) {
      return { ok: false, error: `Source ${index + 1}: Add a read token source, a write token source, or both.` };
    }
    const source: InfisicalReadSourcePatch = { name, projectId: sourceProjectId, environment: sourceEnvironment, secretPath: sourcePath };
    if (readSource) {
      if (draft.readSourceType === "env") {
        if (!/^[A-Z][A-Z0-9_]*$/.test(readSource)) return { ok: false, error: `Source ${index + 1}: Read token environment name is invalid.` };
        source.tokenEnv = readSource;
      } else {
        if (!readSource.startsWith("/")) return { ok: false, error: `Source ${index + 1}: Read token file must be an absolute path.` };
        source.tokenFile = readSource;
      }
    }
    if (writeSource) {
      if (draft.writeSourceType === "env") {
        if (!/^[A-Z][A-Z0-9_]*$/.test(writeSource)) return { ok: false, error: `Source ${index + 1}: Write token environment name is invalid.` };
        source.writeTokenEnv = writeSource;
      } else {
        if (!writeSource.startsWith("/")) return { ok: false, error: `Source ${index + 1}: Write token file must be an absolute path.` };
        source.writeTokenFile = writeSource;
      }
    }
    sources.push(source);
  }

  const patch: InfisicalConfigPatch = {
    enabled: input.enabled,
    writeThrough: input.writeThrough,
    authMethod: input.authMethod,
    siteUrl,
    projectId,
    environment,
    secretPath,
    refreshMinutes: Math.trunc(input.refreshMinutes),
  };
  if (input.readSources !== undefined) patch.readSources = sources;
  const clientId = input.clientId.trim();
  if (clientId) patch.clientId = clientId;
  const clientSecret = input.clientSecret.trim();
  if (clientSecret) patch.clientSecret = clientSecret;
  const token = input.token.trim();
  if (token) patch.token = token;
  const writeToken = input.writeToken.trim();
  if (writeToken) patch.writeToken = writeToken;
  return { ok: true, patch };
}

export interface InfisicalPatchSplit {
  /** Noncredential settings and source locators for the config patch. */
  configPatch: Omit<InfisicalConfigPatch, "clientSecret" | "token" | "writeToken">;
  /** New credentials handed to Electron's encrypted credential route. */
  bridgeCredentials: Array<{ name: "infisicalClientSecret" | "infisicalReadToken" | "infisicalWriteToken"; value: string }>;
}

/** Disable reads at the requested destination before a new credential can
 * trigger a reload, then enable only after every encrypted write succeeds. */
export async function saveInfisicalSettings<T>(
  split: InfisicalPatchSplit,
  saveConfig: (patch: InfisicalPatchSplit["configPatch"]) => Promise<T>,
  saveCredential: (name: InfisicalPatchSplit["bridgeCredentials"][number]["name"], value: string) => Promise<void>,
): Promise<T> {
  if (split.bridgeCredentials.length) {
    await saveConfig({ ...split.configPatch, enabled: false });
    try {
      for (const credential of split.bridgeCredentials) {
        await saveCredential(credential.name, credential.value);
      }
    } catch {
      throw new Error("The protected credential could not be saved.\u00a0 Infisical was left disabled; retry the save.");
    }
  }
  return saveConfig(split.configPatch);
}

/** Split settings and locator metadata from credentials that Electron stores
 * encrypted.  Without the bridge, a new credential is refused rather than
 * sent in a plain config request. */
export function splitInfisicalPatch(patch: InfisicalConfigPatch, hasBridge: boolean): InfisicalPatchSplit | { error: string } {
  const { clientSecret, token, writeToken, ...configPatch } = patch;
  const bridgeCredentials: InfisicalPatchSplit["bridgeCredentials"] = [];
  if (clientSecret) bridgeCredentials.push({ name: "infisicalClientSecret", value: clientSecret });
  if (token) bridgeCredentials.push({ name: "infisicalReadToken", value: token });
  if (writeToken) bridgeCredentials.push({ name: "infisicalWriteToken", value: writeToken });
  if (!hasBridge && bridgeCredentials.length) {
    return { error: "Save Infisical credentials from the BotFleet desktop app so they stay in its encrypted credential store." };
  }
  return { configPatch, bridgeCredentials };
}
