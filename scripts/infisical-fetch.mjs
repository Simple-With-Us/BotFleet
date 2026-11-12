// Managed CI verifies the dedicated service-token scope, then uses one bulk
// secrets list, per-name masking, and $GITHUB_ENV export -- falling back to a
// same-named GH_FALLBACK_<NAME> step env var, warning when a name stays
// empty everywhere, and failing only for a name listed in `required`.
//
// Runs unmodified on GitHub-hosted macOS, Windows and Linux runners: no CLI
// install (ios-ship.yml's `brew install infisical/get-cli/infisical` is
// macOS-only), no dependency (`@infisical/sdk` is in neither package.json
// nor pnpm-lock.yaml) -- just global `fetch`, which every GitHub runner's
// Node ships with.
//
// Never prints a secret value except as the payload of an `::add-mask::`
// workflow command, which is the mechanism GitHub uses to scrub it from the
// rendered log from that point on -- one command per LINE of the value, see
// `maskValue` below, because the runner's parser stops at the first newline.
// A verification/list failure never crashes the job -- callers still get their
// GH_FALLBACK_<NAME> values, or the missing-name warning/error below.
import { appendFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

function splitNames(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripTrailingSlash(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function validateInfisicalSiteUrl(siteUrl) {
  const raw = String(siteUrl ?? "");
  const invalid = () => new Error("Infisical site URL must be a valid HTTPS URL without userinfo, query, or fragment.");
  if (!raw || raw !== raw.trim() || /[?#\\]/.test(raw)) throw invalid();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid();
  }
  const authority = raw.match(/^https:\/\/([^/\\?#]*)/i)?.[1];
  if (parsed.protocol !== "https:" || !parsed.hostname || !authority || authority.includes("@") ||
      authority.includes("\\") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid();
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Validate the flat service-token record returned by Infisical before listing
 * secrets.  Keep this helper local so the hosted workflow stays dependency-free
 * and all network access remains injectable through `fetchImpl`. */
/* oxlint-disable anti-slop/no-runtime-typeof -- These HTTP boundaries validate token and secret metadata without dependencies because CI runs before pnpm install. */
function isLiteralFolder(path) {
  return typeof path === "string" && path.startsWith("/") && !/[*?[\]{}]/.test(path) &&
    !path.includes("//") && !path.split("/").some((segment) => segment === "." || segment === "..");
}

export async function verifyServiceTokenMetadata({
  siteUrl, token, projectId, environment, secretPath, mode, fetchImpl = fetch, timeoutMs = 30_000,
}) {
  const baseUrl = validateInfisicalSiteUrl(siteUrl);
  if (!isLiteralFolder(secretPath)) {
    throw new Error("Infisical service-token scope must use a literal folder.");
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v2/service-token`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Infisical service-token verification failed.");
  }
  if (!response.ok) throw new Error("Infisical service-token verification failed.");

  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Infisical service-token metadata is invalid.");
  }
  const invalid = () => new Error("Infisical service-token metadata is invalid.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const metadata = raw;
  let scopes = metadata.scopes;
  if (typeof scopes === "string") {
    try {
      scopes = JSON.parse(scopes);
    } catch {
      throw invalid();
    }
  }
  if (typeof metadata.workspace !== "string" || !metadata.workspace.trim() ||
      !Array.isArray(scopes) || !scopes.length ||
      !Array.isArray(metadata.permissions) || !metadata.permissions.length ||
      !metadata.permissions.every((permission) => permission === "read" || permission === "write")) {
    throw invalid();
  }
  if (metadata.projectId !== undefined && typeof metadata.projectId !== "string") throw invalid();
  if (metadata.workspace !== projectId ||
      (metadata.projectId !== undefined && metadata.projectId !== projectId)) {
    throw new Error("Infisical service token does not belong to the configured project.");
  }

  const normalizeFolder = (path) => path.replace(/\/+$/, "") || "/";
  let exactScopeMatches = false;
  for (const rawScope of scopes) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) throw invalid();
    if (typeof rawScope.environment !== "string" || !rawScope.environment ||
        !isLiteralFolder(rawScope.secretPath)) throw invalid();
    if (rawScope.environment === environment &&
        normalizeFolder(rawScope.secretPath) === normalizeFolder(secretPath)) exactScopeMatches = true;
  }
  if (!exactScopeMatches) throw new Error("Infisical service token does not grant the configured environment and folder.");
  if (mode === "read" ? !metadata.permissions.includes("read") || metadata.permissions.includes("write")
    : !metadata.permissions.includes("write")) {
    throw new Error(mode === "read"
      ? "Infisical read credential must be read-only."
      : "Infisical write credential must grant write permission.");
  }

  let expiresAt = null;
  if (metadata.expiresAt !== null) {
    if (typeof metadata.expiresAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.expiresAt)) throw invalid();
    expiresAt = Date.parse(metadata.expiresAt);
    if (!Number.isFinite(expiresAt)) throw invalid();
    const date = metadata.expiresAt.slice(0, 10);
    const calendarDate = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0, 10) !== date) throw invalid();
    if (expiresAt <= Date.now()) throw new Error("Infisical service token has expired.");
  }
  return { expiresAt };
}

/** GET .../api/v3/secrets/raw for the whole path in one call -- returns a
 * Map<secretKey, secretValue>.  viewSecretValue is always "true" here; this
 * script only ever runs where values are needed (it exists to populate
 * GITHUB_ENV), unlike the probe path in server/infisical.ts.
 *
 * References, imports, and descendants stay disabled so returned values cannot
 * be resolved from another folder before their provenance is checked. */
export async function listSecretsRaw({
  siteUrl, token, projectId, environment, secretPath, fetchImpl = fetch, timeoutMs = 30_000,
  names, log = () => {},
}) {
  const baseUrl = validateInfisicalSiteUrl(siteUrl);
  await verifyServiceTokenMetadata({ siteUrl: baseUrl, token, projectId, environment, secretPath, mode: "read", fetchImpl, timeoutMs });
  const qs = new URLSearchParams({
    workspaceId: projectId,
    environment,
    secretPath,
    viewSecretValue: "true",
    expandSecretReferences: "false",
    include_imports: "false",
    recursive: "false",
  });
  const res = await fetchImpl(`${baseUrl}/api/v3/secrets/raw?${qs.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Infisical secrets list failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.secrets)) {
    throw new Error("Infisical secrets list returned invalid metadata.");
  }
  const selected = names === undefined ? null : new Set(names);
  const normalizeFolder = (path) => path.replace(/\/+$/, "") || "/";
  const values = new Map();
  for (const secret of body.secrets) {
    if (!secret || typeof secret !== "object" || Array.isArray(secret) ||
        typeof secret.secretKey !== "string" || !secret.secretKey) continue;
    if (selected && !selected.has(secret.secretKey)) continue;
    // v3 requires workspace/environment/hidden, while secretPath is optional on list rows.
    if (secret.workspace !== projectId || secret.environment !== environment ||
        secret.secretValueHidden !== false || typeof secret.secretValue !== "string" ||
        (secret.secretPath !== undefined && (!isLiteralFolder(secret.secretPath) ||
          normalizeFolder(secret.secretPath) !== normalizeFolder(secretPath)))) {
      log(`::warning::${secret.secretKey} has invalid or out-of-scope Infisical metadata; trying its existing GitHub secret fallback.`);
      continue;
    }
    values.set(secret.secretKey, secret.secretValue);
  }
  return values;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Registers each LINE of the value as its own mask, and never the joined
 * value.
 *
 * `::add-mask::` is a workflow command the runner parses one LINE at a
 * time: it registers only the text up to the first newline, then echoes the
 * remaining lines of that same write to the job log as ordinary, unmasked
 * output.  So a command carrying a whole multi-line value is not merely
 * useless -- emitting it FIRST is the leak itself: the runner registers line
 * one and prints every line after it into a public log, before the per-line
 * commands that would have hidden them have run.  A wrapped base64 blob --
 * which is exactly what `base64` produces on both macOS and GNU coreutils
 * unless given `-b 0` / `-w 0` -- is the everyday shape of such a value.
 *
 * GitHub's own `secrets.*` machinery registers each line of a multi-line
 * secret as a separate mask; this does the same, so a signing certificate or
 * an ASC key routed through this action is scrubbed as thoroughly as it was
 * when the workflow read it from `secrets.*`.  A single-line value is its own
 * only line, so it still costs exactly one command.
 *
 * The `seen` set collapses a value whose lines repeat, and the `trim()`
 * guard keeps a blank trailing line from registering the empty string (which
 * would mask nothing and warn on some runner versions). */
export function maskValue(value, log) {
  const seen = new Set();
  for (const line of String(value).split(/\r?\n/)) {
    if (!line.trim() || seen.has(line)) continue;
    seen.add(line);
    log(`::add-mask::${line}`);
  }
}

/** Appends one GitHub Actions multiline env-var entry.  The delimiter is
 * random per call so a value that happens to contain a fixed delimiter
 * string can never break the file for a later name. */
export function writeGithubEnvValue(path, name, value, appendFileImpl = appendFileSync) {
  if (!path) return;
  const delimiter = `INFISICAL_${randomUUID().replace(/-/g, "")}`;
  appendFileImpl(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Any embedded reference expression would make the value depend on another vault name. */
export const UNRESOLVED_REFERENCE = /\$\{[^}]*\}/;

export function isUnresolvedReference(value) {
  return UNRESOLVED_REFERENCE.test(String(value ?? "").trim());
}

/** Resolves the vault snapshot (empty map when unconfigured or the fetch
 * failed) -- never throws; a failure is reported through `log` and the
 * caller proceeds on GH_FALLBACK_<NAME> alone.
 *
 * Machine identities are deliberately unavailable to managed CI. */
async function resolveVaultValues({ siteUrl, projectId, token, environment, secretPath, fetchImpl, log, names }) {
  const serviceToken = String(token ?? "").trim();
  if (!projectId) return new Map();
  if (!serviceToken) {
    log("::warning::Infisical service token is not configured; migration is pending and only existing GitHub secret fallbacks can be used.");
    return new Map();
  }
  try {
    return await listSecretsRaw({
      siteUrl, token: serviceToken, projectId, environment, secretPath, fetchImpl, names, log,
    });
  } catch {
    // Never interpolate the raw error body -- Infisical error payloads have
    // echoed request fields on some 4xx responses in the past, and none of
    // that belongs in a public Actions log.
    log(`::warning::Infisical ${environment} fetch unavailable; using existing GitHub secret fallbacks only.`);
    return new Map();
  }
}

export async function run({
  env = process.env, fetchImpl = fetch, log = (line) => console.log(line),
} = {}) {
  const names = splitNames(env.INFISICAL_NAMES);
  const required = new Set(splitNames(env.INFISICAL_REQUIRED));
  const siteUrl = stripTrailingSlash(env.INFISICAL_SITE_URL || "https://app.infisical.com");
  const projectId = env.INFISICAL_PROJECT_ID || "";
  const environment = env.INFISICAL_ENVIRONMENT || "prod";
  const secretPath = env.INFISICAL_SECRET_PATH || "/";
  const token = env.INFISICAL_TOKEN || "";
  const githubEnvPath = env.GITHUB_ENV || "";

  const vaultValues = await resolveVaultValues({
    siteUrl, projectId, token, environment, secretPath, fetchImpl, log, names,
  });

  const missingRequired = [];
  for (const name of names) {
    let value = vaultValues.get(name) || "";
    if (isUnresolvedReference(value)) {
      log(`::warning::${name} contains an Infisical reference expression; trying its existing GitHub secret fallback.`);
      value = "";
    }
    if (!value) {
      value = env[`GH_FALLBACK_${name}`] || "";
      if (isUnresolvedReference(value)) {
        log(`::warning::${name} has a GitHub secret fallback containing a reference expression; the value is unavailable.`);
        value = "";
      }
    }
    if (!value) {
      const message = `${name} is empty after the Infisical ${environment} export and the GitHub secret fallback.`;
      if (required.has(name)) {
        missingRequired.push(name);
        log(`::error::${message}`);
      } else {
        log(`::warning::${message}`);
      }
      continue;
    }
    maskValue(value, log);
    writeGithubEnvValue(githubEnvPath, name, value);
  }

  if (missingRequired.length > 0) {
    throw new Error(`Missing required Infisical name(s): ${missingRequired.join(", ")}`);
  }
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isEntryModule();
if (isMain) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
