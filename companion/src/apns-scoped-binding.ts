// Opt-in APNs key read through a caller-supplied read-only service token.
// The default companion path does not call this module. Nothing here reads
// the environment, fleet-secrets, or a shared machine identity.
import { createHash } from "node:crypto";

import { isJsonBoolean, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json.ts";

/** Shared-key names. A pinned Apple key id selects `AUTHKEY_<KEY_ID>` instead. */
export const APNS_SCOPED_KEY_ID_NAME = "APNS_KEY_ID";
export const APNS_SCOPED_P8_NAME = "APNS_KEY_P8";

const KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
const EXPIRES_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REFERENCE_PATTERN = /\$\{[^}]*\}/;
const REFERENCE_REDACTION = /\$\{[^}]*\}/g;
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const SERVICE_TOKEN_PATTERN = /\bst\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*/g;

export interface ApnsScopedRequest {
  method: "GET";
  headers: { readonly authorization: string };
  redirect: "error";
  cache: "no-store";
  credentials: "omit";
  signal: AbortSignal;
}

/** Injected by the caller. Tests pass a fake. Production does not call this module. */
export type ApnsScopedFetch = (url: string, init: ApnsScopedRequest) => Promise<Response>;

/** Explicit binding. The caller supplies every field. This module does not invent a project, folder, or token. */
export interface ApnsScopedBinding {
  projectId: string;
  environment: string;
  folder: string;
  siteUrl: string;
  token: string;
  fetchImpl: ApnsScopedFetch;
}

/** Cache and timeout knobs, supplied by the companion so this module does not read the environment. */
export interface ApnsScopedTiming {
  pin: string;
  timeoutMs: number;
  retryMs: number;
  cacheMs: number;
  keyIdFallback: string;
  now?: () => number;
}

export interface ApnsScopedSecretRead {
  p8: string | null;
  keyId: string | null;
}

export interface ScopedApnsMaterial {
  pin: string;
  keyId: string;
  p8: string | null;
}

interface ScopedCacheEntry {
  identity: string;
  pin: string;
  keyId: string;
  p8: string | null;
  at: number;
}

interface ExpectedSecret {
  name: string;
  projectId: string;
  environment: string;
  folder: string;
  token: string;
}

interface ApnsScopedEndpoint {
  site: string;
  folder: string;
  projectId: string;
  environment: string;
  token: string;
  timeoutMs: number;
}

/** Names this binding is allowed to request. Anything else is refused before a read. */
export function apnsScopedSecretNames(pin: string): readonly string[] {
  if (!pin) return [APNS_SCOPED_P8_NAME, APNS_SCOPED_KEY_ID_NAME];
  if (!KEY_ID_PATTERN.test(pin)) return [];
  return [`AUTHKEY_${pin}`];
}

/** Strip known secret material from a binding error. Fixed messages still pass through here. */
export function redactApnsBindingText(message: string, secrets: readonly string[]): string {
  let redacted = message;
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 8))];
  unique.sort((left, right) => right.length - left.length);
  for (const secret of unique) redacted = redacted.split(secret).join("«redacted»");
  return redacted.replace(PEM_PATTERN, "«redacted»").replace(SERVICE_TOKEN_PATTERN, "«redacted»").replace(REFERENCE_REDACTION, "«redacted»");
}

export class ApnsScopedBindingError extends Error {
  constructor(message: string, secrets: readonly string[] = []) {
    super(redactApnsBindingText(message, secrets));
    this.name = "ApnsScopedBindingError";
  }
}

let scopedEntry: ScopedCacheEntry | null = null;
let scopedGeneration = 0;
const scopedFlights = new Map<string, Promise<ScopedApnsMaterial>>();

/** Test seam: forget a scoped read. Also called when the companion clears its own key cache. */
export function resetScopedApnsCache(): void {
  scopedEntry = null;
  scopedFlights.clear();
  scopedGeneration += 1;
}

function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

function literalFolder(path: string): string | null {
  if (!path.startsWith("/")) return null;
  if (/[*?[\]{}]/.test(path) || path.includes("//")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path.replace(/\/+$/, "") || "/";
}

function serviceSite(siteUrl: string): string | null {
  if (!siteUrl || siteUrl !== siteUrl.trim() || /[?#\\]/.test(siteUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    return null;
  }
  const authority = /^https:\/\/([^/\\?#]*)/i.exec(siteUrl)?.[1];
  if (!authority || authority.includes("@") || authority.includes("\\")) return null;
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function literalProject(projectId: string): string | null {
  if (!projectId || projectId !== projectId.trim() || projectId.length > 128 || /[\s/?#]/.test(projectId)) return null;
  return projectId;
}

function literalEnvironment(environment: string): string | null {
  if (!environment || environment !== environment.trim() || environment.length > 64 || !/^[A-Za-z0-9_-]+$/.test(environment)) {
    return null;
  }
  return environment;
}

function usableToken(token: string): string | null {
  if (!token || token !== token.trim() || /\s/.test(token) || token.length < 8 || token.length > 4096) return null;
  return token;
}

function positiveInt(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function bindingProblem(binding: ApnsScopedBinding): string | null {
  if (!serviceSite(binding.siteUrl)) return "APNs binding site must be an absolute HTTPS URL.";
  if (!literalFolder(binding.folder)) return "APNs binding folder must be a literal path.";
  if (!literalProject(binding.projectId)) return "APNs binding project is not configured.";
  if (!literalEnvironment(binding.environment)) return "APNs binding environment is not configured.";
  if (!usableToken(binding.token)) return "APNs binding token is not configured.";
  return null;
}

function stringField(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  return isJsonString(value) ? value : null;
}

function booleanField(obj: JsonObject, key: string): boolean | null {
  const value = obj[key];
  return isJsonBoolean(value) ? value : null;
}

function arrayField(obj: JsonObject, key: string): JsonValue[] | null {
  const value = obj[key];
  return Array.isArray(value) ? value : null;
}

function stringItems(items: JsonValue[]): string[] | null {
  const out: string[] = [];
  for (const item of items) {
    if (!isJsonString(item)) return null;
    out.push(item);
  }
  return out;
}

function parseScopes(value: JsonValue): { environment: string; secretPath: string }[] | null {
  let raw = value;
  if (isJsonString(value)) {
    try {
      raw = parseJson(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scopes: { environment: string; secretPath: string }[] = [];
  for (const item of raw) {
    if (!isJsonObject(item)) return null;
    const environment = stringField(item, "environment");
    const secretPath = stringField(item, "secretPath");
    const folder = secretPath ? literalFolder(secretPath) : null;
    if (!environment || !folder) return null;
    scopes.push({ environment, secretPath: folder });
  }
  return scopes;
}

function invalid(token: string): ApnsScopedBindingError {
  return new ApnsScopedBindingError("APNs binding token metadata is invalid.", [token]);
}

function assertExpiry(value: JsonValue, token: string): void {
  if (value === null) return;
  if (!isJsonString(value) || !EXPIRES_AT_PATTERN.test(value)) throw invalid(token);
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) throw invalid(token);
  const date = value.slice(0, 10);
  const calendarDate = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0, 10) !== date) throw invalid(token);
  if (expiresAt <= Date.now()) throw new ApnsScopedBindingError("APNs binding token has expired.", [token]);
}

function assertMetadataBody(body: JsonValue, projectId: string, environment: string, folder: string, token: string): void {
  if (!isJsonObject(body)) throw invalid(token);
  const workspace = stringField(body, "workspace");
  if (!workspace || !workspace.trim()) throw invalid(token);
  if (workspace !== projectId) {
    throw new ApnsScopedBindingError("APNs binding token does not belong to the configured project.", [token]);
  }
  if (Object.hasOwn(body, "projectId")) {
    const claimed = stringField(body, "projectId");
    if (!claimed || claimed !== projectId) {
      throw new ApnsScopedBindingError("APNs binding token does not belong to the configured project.", [token]);
    }
  }
  if (!Object.hasOwn(body, "scopes")) throw invalid(token);
  const scopes = parseScopes(body.scopes);
  if (!scopes) throw invalid(token);
  if (!scopes.every((scope) => scope.environment === environment && scope.secretPath === folder)) {
    throw new ApnsScopedBindingError("APNs binding token does not grant the exact environment and folder.", [token]);
  }
  const permissionsValue = arrayField(body, "permissions");
  if (!permissionsValue) throw invalid(token);
  const permissions = stringItems(permissionsValue);
  if (!permissions || permissions.length === 0 || permissions.some((item) => item !== "read" && item !== "write")) {
    throw invalid(token);
  }
  if (!permissions.includes("read") || permissions.includes("write")) {
    throw new ApnsScopedBindingError("APNs binding credential must be read-only.", [token]);
  }
  if (!Object.hasOwn(body, "expiresAt")) throw invalid(token);
  assertExpiry(body.expiresAt, token);
}

async function fetchJson(
  binding: ApnsScopedBinding,
  url: string,
  timeoutMs: number,
  token: string,
  absentOk: boolean,
): Promise<JsonValue | null> {
  let response: Response;
  try {
    response = await binding.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const leaked = err instanceof Error ? err.message : "";
    throw new ApnsScopedBindingError("APNs binding read failed.", [token, leaked]);
  }
  let text = "";
  try {
    text = await response.text();
  } catch (err) {
    const leaked = err instanceof Error ? err.message : "";
    throw new ApnsScopedBindingError("APNs binding read failed.", [token, leaked, text]);
  }
  if (response.status === 404 && absentOk) return null;
  if (!response.ok) throw new ApnsScopedBindingError("APNs binding read failed.", [token, text]);
  try {
    return parseJson(text);
  } catch {
    throw new ApnsScopedBindingError("APNs binding read failed.", [token, text]);
  }
}

function configured(binding: ApnsScopedBinding, timeoutMs: number): ApnsScopedEndpoint {
  const problem = bindingProblem(binding);
  const site = serviceSite(binding.siteUrl);
  const folder = literalFolder(binding.folder);
  const projectId = literalProject(binding.projectId);
  const environment = literalEnvironment(binding.environment);
  const token = usableToken(binding.token);
  const timeout = positiveInt(timeoutMs);
  if (problem || !site || !folder || !projectId || !environment || !token || !timeout) {
    throw new ApnsScopedBindingError(problem ?? "APNs binding is not configured.", [binding.token]);
  }
  return { site, folder, projectId, environment, token, timeoutMs: timeout };
}

async function assertMetadata(binding: ApnsScopedBinding, timeoutMs: number): Promise<ApnsScopedEndpoint> {
  const config = configured(binding, timeoutMs);
  const body = await fetchJson(binding, `${config.site}/api/v2/service-token`, config.timeoutMs, config.token, false);
  if (body === null) throw new ApnsScopedBindingError("APNs binding read failed.", [config.token]);
  assertMetadataBody(body, config.projectId, config.environment, config.folder, config.token);
  return config;
}

/** Check the token's own metadata. A mismatch never continues on to a secret read. */
export async function verifyApnsScopedBinding(binding: ApnsScopedBinding, timeoutMs = 30_000): Promise<void> {
  await assertMetadata(binding, timeoutMs);
}

function assertNoImports(obj: JsonObject, token: string): void {
  if (!Object.hasOwn(obj, "imports")) return;
  const imports = obj.imports;
  if (Array.isArray(imports) && imports.length === 0) return;
  throw new ApnsScopedBindingError("APNs binding secret was a reference, import, or descendant.", [token]);
}

function secretRow(body: JsonValue, token: string): JsonObject {
  if (!isJsonObject(body)) throw new ApnsScopedBindingError("APNs binding read failed.", [token]);
  assertNoImports(body, token);
  if (isJsonObject(body.secret)) return body.secret;
  const secrets = arrayField(body, "secrets");
  if (secrets) {
    const first = secrets[0];
    if (secrets.length !== 1 || !first || !isJsonObject(first)) {
      throw new ApnsScopedBindingError("APNs binding secret was a reference, import, or descendant.", [token]);
    }
    return first;
  }
  if (stringField(body, "secretKey")) return body;
  throw new ApnsScopedBindingError("APNs binding read failed.", [token]);
}

function acceptedValue(row: JsonObject, expected: ExpectedSecret): string {
  const secretKey = stringField(row, "secretKey");
  const secretValue = stringField(row, "secretValue");
  const secretPath = stringField(row, "secretPath");
  const workspace = stringField(row, "workspace");
  const environment = stringField(row, "environment");
  const hidden = booleanField(row, "secretValueHidden");
  const type = Object.hasOwn(row, "type") ? stringField(row, "type") : null;
  const folder = secretPath ? literalFolder(secretPath) : null;
  const rejected = secretKey !== expected.name
    || secretValue === null
    || !secretValue.trim()
    || workspace !== expected.projectId
    || environment !== expected.environment
    || hidden !== false
    || folder !== expected.folder
    || type === null && Object.hasOwn(row, "type")
    || type !== null && type !== "shared"
    || REFERENCE_PATTERN.test(secretValue);
  if (rejected || secretValue === null) {
    throw new ApnsScopedBindingError("APNs binding secret was a reference, import, or descendant.", [expected.token, secretValue ?? ""]);
  }
  return secretValue;
}

function secretUrl(site: string, projectId: string, environment: string, folder: string, name: string): string {
  const query = new URLSearchParams({
    workspaceId: projectId,
    environment,
    secretPath: folder,
    viewSecretValue: "true",
    expandSecretReferences: "false",
    include_imports: "false",
    recursive: "false",
  });
  return `${site}/api/v3/secrets/raw/${encodeURIComponent(name)}?${query.toString()}`;
}

async function readOne(
  binding: ApnsScopedBinding,
  config: ApnsScopedEndpoint,
  name: string,
): Promise<string | null> {
  const body = await fetchJson(
    binding,
    secretUrl(config.site, config.projectId, config.environment, config.folder, name),
    config.timeoutMs,
    config.token,
    true,
  );
  if (body === null) return null;
  return acceptedValue(secretRow(body, config.token), {
    name,
    projectId: config.projectId,
    environment: config.environment,
    folder: config.folder,
    token: config.token,
  });
}

/** Read only the declared APNs names. Metadata is checked first, and a bad token never reaches the secret endpoint. */
export async function readDeclaredApnsSecrets(
  binding: ApnsScopedBinding,
  pin: string,
  timeoutMs = 30_000,
): Promise<ApnsScopedSecretRead> {
  const names = apnsScopedSecretNames(pin);
  const p8Name = names[0];
  if (!p8Name) throw new ApnsScopedBindingError("APNs binding key id is not a declared name.");
  const config = await assertMetadata(binding, timeoutMs);
  let p8: string | null;
  try {
    p8 = await readOne(binding, config, p8Name);
  } catch (err) {
    if (err instanceof ApnsScopedBindingError) throw err;
    throw new ApnsScopedBindingError("APNs binding read failed.", [config.token]);
  }
  if (!p8 || names.length === 1) return { p8, keyId: p8 ? pin : null };
  const idName = names[1];
  if (!idName) return { p8, keyId: null };
  try {
    const idValue = await readOne(binding, config, idName);
    const keyId = idValue && KEY_ID_PATTERN.test(idValue.trim()) ? idValue.trim() : null;
    return { p8, keyId };
  } catch (err) {
    if (!(err instanceof ApnsScopedBindingError)) {
      throw new ApnsScopedBindingError("APNs binding read failed.", [config.token]);
    }
    // The PEM is already in hand. A bad id is the same as a missing id: keep the PEM and let the caller retry the id.
    return { p8, keyId: null };
  }
}

function cacheIdentity(binding: ApnsScopedBinding, pin: string): string {
  const folder = literalFolder(binding.folder) ?? binding.folder;
  const stamp = createHash("sha256").update(binding.token).digest("hex").slice(0, 16);
  return [binding.siteUrl, binding.projectId, binding.environment, folder, pin, stamp].join("\n");
}

function remember(
  identity: string,
  timing: ApnsScopedTiming,
  generation: number,
  completedAt: number,
  read: ApnsScopedSecretRead,
): ScopedApnsMaterial {
  const previous = scopedEntry && scopedEntry.identity === identity ? scopedEntry : null;
  const p8 = read.p8 && read.p8.length > 0 ? read.p8 : null;
  const store = (next: ScopedCacheEntry): ScopedApnsMaterial => {
    if (generation === scopedGeneration) scopedEntry = next;
    return { pin: next.pin, keyId: next.keyId, p8: next.p8 };
  };
  if (p8 === null && previous?.p8) {
    return store({ ...previous, at: completedAt - (timing.cacheMs - timing.retryMs) });
  }
  if (timing.pin || p8 === null) {
    return store({
      identity,
      pin: timing.pin,
      keyId: timing.pin || timing.keyIdFallback,
      p8,
      at: completedAt,
    });
  }
  if (read.keyId) {
    return store({ identity, pin: timing.pin, keyId: read.keyId, p8, at: completedAt });
  }
  const keyId = previous && previous.p8 === p8 ? previous.keyId : timing.keyIdFallback;
  return store({
    identity,
    pin: timing.pin,
    keyId,
    p8,
    at: completedAt - (timing.cacheMs - timing.retryMs),
  });
}

async function readScopedFromBinding(
  binding: ApnsScopedBinding,
  timing: ApnsScopedTiming,
  identity: string,
  generation: number,
  now: () => number,
): Promise<ScopedApnsMaterial> {
  let read: ApnsScopedSecretRead = { p8: null, keyId: null };
  try {
    read = await readDeclaredApnsSecrets(binding, timing.pin, timing.timeoutMs);
  } catch {
    read = { p8: null, keyId: null };
  }
  // Stamp the entry when the read finishes, including a slow id read, so the retry window starts at completion.
  return remember(identity, timing, generation, now(), read);
}

/** Cached scoped read. Failures become an empty key, matching the companion's fail-closed vault read. */
export async function loadScopedApnsMaterial(
  binding: ApnsScopedBinding,
  timing: ApnsScopedTiming,
): Promise<ScopedApnsMaterial> {
  const now = timing.now ?? Date.now;
  const identity = cacheIdentity(binding, timing.pin);
  if (
    scopedEntry
    && scopedEntry.identity === identity
    && now() - scopedEntry.at < (scopedEntry.p8 ? timing.cacheMs : timing.retryMs)
  ) {
    return { pin: scopedEntry.pin, keyId: scopedEntry.keyId, p8: scopedEntry.p8 };
  }
  const existing = scopedFlights.get(identity);
  if (existing) return existing;
  const generation = scopedGeneration;
  let resolveFlight: (value: ScopedApnsMaterial) => void = () => {};
  const flight = new Promise<ScopedApnsMaterial>((resolve) => {
    resolveFlight = resolve;
  });
  scopedFlights.set(identity, flight);
  void readScopedFromBinding(binding, timing, identity, generation, now).then(resolveFlight, () => {
    resolveFlight({ pin: timing.pin, keyId: timing.pin || timing.keyIdFallback, p8: null });
  }).finally(() => {
    if (scopedFlights.get(identity) === flight) scopedFlights.delete(identity);
  });
  return flight;
}
