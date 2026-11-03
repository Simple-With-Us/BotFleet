// Raw HTTP calls to Infisical's universal-auth and secrets APIs.  No SDK:
// `@infisical/sdk` is in neither `package.json` nor `pnpm-lock.yaml`, and
// thirty lines of `fetch` is the size `CONTRIBUTING.md` asks for over a new
// dependency.  The CI-side fetcher (`scripts/infisical-fetch.mjs`) speaks the
// same wire shapes but is a deliberately separate script — the server bundle
// and a GitHub Action step ship independently and neither should import the
// other.
//
// Every failure becomes an `InfisicalError` carrying only a generic message
// ("Infisical login failed: HTTP 401") and the HTTP status.  Upstream error
// bodies are never read into that message: Infisical's own error payloads
// have echoed request fields on some 4xx responses, and none of that belongs
// in a log line or a Settings card.  The message is still passed through
// `redactSecretsInText` as a second line of defence, so a future change to
// this file cannot quietly start leaking a credential just by adding detail
// to a thrown message.
import { redactSecretsInText } from "./redact.ts";
import { z } from "zod";
import { parseJson } from "./schema.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const serviceTokenFolderSchema = z.string().startsWith("/").refine((path) => !/[*?[\]{}]/.test(path));
const vendorServiceTokenScopesSchema = z.array(z.looseObject({
  environment: z.string().min(1),
  secretPath: serviceTokenFolderSchema,
})).min(1);
const serializedServiceTokenScopesSchema = z.string().transform((encoded, context) => {
  try {
    const parsed = vendorServiceTokenScopesSchema.safeParse(parseJson(encoded));
    if (parsed.success) return parsed.data;
  } catch { /* Invalid JSON is reported through the same vendor schema boundary. */ }
  context.addIssue({ code: "custom", message: "Invalid serialized service-token scopes" });
  return z.NEVER;
});
const vendorServiceTokenMetadataSchema = z.looseObject({
  workspace: z.string().refine((project) => Boolean(project.trim())),
  projectId: z.string().optional(),
  scopes: z.union([vendorServiceTokenScopesSchema, serializedServiceTokenScopesSchema]),
  permissions: z.array(z.enum(["read", "write"])).min(1),
  expiresAt: z.string().nullable(),
});

export class InfisicalError extends Error {
  readonly statusCode: number;
  readonly writeLanded: boolean;

  constructor(message: string, statusCode: number, writeLanded = false) {
    super(redactSecretsInText(message));
    this.name = "InfisicalError";
    this.statusCode = statusCode;
    this.writeLanded = writeLanded;
  }
}

function httpError(fallback: string, status: number): InfisicalError {
  return new InfisicalError(`${fallback}: HTTP ${status}`, status);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      err.message.includes("timeout") ||
      err.message.includes("aborted")
    );
  }
  return false;
}

function toInfisicalError(err: unknown, operation: string, timeoutMs: number): InfisicalError {
  if (err instanceof InfisicalError) return err;
  if (isTimeoutError(err)) {
    return new InfisicalError(`Infisical ${operation} timed out after ${timeoutMs} ms`, 504);
  }
  const message = err instanceof Error ? err.message : "network failure";
  return new InfisicalError(`Infisical ${operation} failed: ${message}`, 502);
}

export interface LoginOptions {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

/** `POST {siteUrl}/api/v1/auth/universal-auth/login` — returns the bearer
 * token string only, never the rest of the response body.  The request body
 * is built with `JSON.stringify`, never string interpolation, so a client
 * secret containing a quote can never reshape the request. */
export async function login({
  siteUrl,
  clientId,
  clientSecret,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: LoginOptions): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toInfisicalError(err, "login", timeoutMs);
  }
  if (!res.ok) throw httpError("Infisical login failed", res.status);

  // SAFETY: Infisical's response body is untyped JSON off the wire; the cast
  // only names the one field read below, and that field is re-checked with
  // `typeof` before it is ever treated as the token.
  let rawBody: unknown;
  try {
    rawBody = await res.json();
  } catch (err) {
    if (isTimeoutError(err)) throw toInfisicalError(err, "login", timeoutMs);
    throw new InfisicalError("Infisical login failed: invalid response body", 502);
  }
  const body = rawBody && typeof rawBody === "object" ? (rawBody as { accessToken?: unknown }) : null;
  const token = body && typeof body.accessToken === "string" ? body.accessToken : "";
  if (!token) throw new InfisicalError("Infisical login response carried no accessToken", 502);
  return token;
}

export interface VerifyServiceTokenOptions {
  siteUrl: string;
  token: string;
  projectId: string;
  environment: string;
  secretPath: string;
  mode: "read" | "write";
  timeoutMs?: number;
}

/** Verify the token's own flat metadata before requesting secrets: the raw
 * secrets endpoint may clamp a requested folder to a granted folder.
 * Only expiry leaves this boundary; response bodies and token values never do. */
export async function verifyServiceToken({
  siteUrl, token, projectId, environment, secretPath, mode, timeoutMs = DEFAULT_TIMEOUT_MS,
}: VerifyServiceTokenOptions): Promise<{ expiresAt: number | null }> {
  try {
    if (siteUrl !== siteUrl.trim()) throw new Error("Invalid service-token site");
    const site = new URL(siteUrl);
    const authority = /^https:\/\/([^/?#\\]*)/i.exec(siteUrl)?.[1];
    if (!authority || authority.includes("@") || site.protocol !== "https:" || !site.hostname ||
        site.username || site.password || /[?#\\]/.test(siteUrl)) throw new Error("Invalid service-token site");
  } catch {
    throw new InfisicalError("Infisical service-token site must be an absolute HTTPS URL without userinfo, query or fragment", 403);
  }
  if (!serviceTokenFolderSchema.safeParse(secretPath).success) {
    throw new InfisicalError("Infisical service-token scope must use a literal folder", 403);
  }
  let response: Response;
  try {
    response = await fetch(`${siteUrl}/api/v2/service-token`, {
      method: "GET", headers: { authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new InfisicalError(isTimeoutError(error)
      ? `Infisical service-token verification timed out after ${timeoutMs} ms`
      : "Infisical service-token verification failed", isTimeoutError(error) ? 504 : 502);
  }
  if (!response.ok) throw httpError("Infisical service-token verification failed", response.status);
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new InfisicalError("Infisical service-token verification returned invalid metadata", 502); }
  const invalid = () => new InfisicalError("Infisical service-token verification returned invalid metadata", 502);
  const parsed = vendorServiceTokenMetadataSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const metadata = parsed.data;
  if (metadata.workspace !== projectId ||
      (metadata.projectId !== undefined && metadata.projectId !== projectId)) {
    throw new InfisicalError("Infisical service token does not belong to the configured project", 403);
  }
  const normalizeFolder = (path: string) => path.replace(/\/+$/, "") || "/";
  const matches = metadata.scopes.some((scope) => scope.environment === environment &&
    normalizeFolder(scope.secretPath) === normalizeFolder(secretPath));
  if (!matches) throw new InfisicalError("Infisical service token does not grant the exact configured environment and folder", 403);
  if (mode === "read" ? !metadata.permissions.includes("read") || metadata.permissions.includes("write")
    : !metadata.permissions.includes("write")) {
    throw new InfisicalError(mode === "read" ? "Infisical read credential must be read-only"
      : "Infisical write credential must grant write permission", 403);
  }
  let expiresAt: number | null = null;
  if (metadata.expiresAt !== null) {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.expiresAt)) throw invalid();
    expiresAt = Date.parse(metadata.expiresAt);
    if (!Number.isFinite(expiresAt)) throw invalid();
    const date = metadata.expiresAt.slice(0, 10);
    const calendarDate = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0, 10) !== date) throw invalid();
    if (expiresAt <= Date.now()) throw new InfisicalError("Infisical service token has expired", 401);
  }
  return { expiresAt };
}

export interface ListSecretsOptions {
  siteUrl: string;
  token: string;
  projectId: string;
  environment: string;
  secretPath: string;
  /** `false` for a probe (Settings → Test Connection): the request still
   * runs against the same endpoint, but no value ever comes back, so a probe
   * cannot accidentally populate the snapshot. */
  viewValues: boolean;
  timeoutMs?: number;
}

export interface ListSecretsResult {
  /** Every secret name Infisical returned for this path, mapped or not.
   * Reporting "in Infisical, not used by BotFleet" is the whole reason this
   * list is not pre-filtered here. */
  names: string[];
  /** Populated only when `viewValues` is true; empty otherwise. */
  values: Map<string, string>;
}

/** `GET {siteUrl}/api/v3/secrets/raw` for the whole path, in one call. */
export async function listSecrets({
  siteUrl,
  token,
  projectId,
  environment,
  secretPath,
  viewValues,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ListSecretsOptions): Promise<ListSecretsResult> {
  const qs = new URLSearchParams({
    workspaceId: projectId,
    environment,
    secretPath,
    viewSecretValue: viewValues ? "true" : "false",
    expandSecretReferences: "false",
    include_imports: "false",
  });
  let res: Response;
  try {
    res = await fetch(`${siteUrl}/api/v3/secrets/raw?${qs.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toInfisicalError(err, "secrets list", timeoutMs);
  }
  if (!res.ok) throw httpError("Infisical secrets list failed", res.status);

  // SAFETY: same untyped-wire-JSON reasoning as `login()` above — the cast
  // names only the one field this function reads, and every row pulled out
  // of it is re-validated below before it is trusted for anything.
  let listRawBody: unknown;
  try {
    listRawBody = await res.json();
  } catch (err) {
    if (isTimeoutError(err)) throw toInfisicalError(err, "secrets list", timeoutMs);
    throw new InfisicalError("Infisical secrets list failed: invalid response body", 502);
  }
  const body = listRawBody && typeof listRawBody === "object" ? (listRawBody as { secrets?: unknown }) : null;
  if (!Array.isArray(body?.secrets)) {
    throw new InfisicalError("Infisical secrets list response carried no secrets array", 502);
  }
  const rows = body.secrets;
  const names: string[] = [];
  const values = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // SAFETY: guarded on the line above — `row` is a non-null object here,
    // and `secretKey` is read as `unknown` and re-checked with `typeof`
    // immediately below before it is ever used as a name.
    const key = (row as Record<string, unknown>).secretKey;
    if (typeof key !== "string" || !key) continue;
    names.push(key);
    if (!viewValues) continue;
    // SAFETY: as above — read as `unknown`, only ever used once confirmed
    // to be a non-empty string.
    const value = (row as Record<string, unknown>).secretValue;
    if (typeof value === "string" && value.length > 0) values.set(key, value);
  }
  return { names, values };
}

export interface UpsertSecretOptions {
  siteUrl: string;
  token: string;
  projectId: string;
  environment: string;
  secretPath: string;
  name: string;
  value: string;
  timeoutMs?: number;
}

/** `PATCH {siteUrl}/api/v3/secrets/raw/{name}`, falling back to `POST` with
 * `type: "shared"` on a 404 — the name does not exist in the vault yet.
 * Called only from `infisical.ts`'s write-through path, which never calls it
 * with an empty `value`; clearing a managed value is refused before this
 * module is ever reached. */
export async function upsertSecret({
  siteUrl,
  token,
  projectId,
  environment,
  secretPath,
  name,
  value,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: UpsertSecretOptions): Promise<void> {
  const url = `${siteUrl}/api/v3/secrets/raw/${encodeURIComponent(name)}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  let patchRes: Response;
  try {
    patchRes = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ workspaceId: projectId, environment, secretPath, secretValue: value }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toInfisicalError(err, "secret update", timeoutMs);
  }
  if (patchRes.ok) return;
  if (patchRes.status !== 404) throw httpError("Infisical secret update failed", patchRes.status);

  let postRes: Response;
  try {
    postRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: projectId, environment, secretPath, secretValue: value, type: "shared" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toInfisicalError(err, "secret create", timeoutMs);
  }
  if (!postRes.ok) throw httpError("Infisical secret create failed", postRes.status);
}
