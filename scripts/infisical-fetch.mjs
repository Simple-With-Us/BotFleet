// CI-side Infisical fetch: universal-auth login, one bulk secrets list, then
// per requested name mask + export into $GITHUB_ENV -- falling back to a
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
// A login/list failure never crashes the job -- callers still get their
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

/** POST .../api/v1/auth/universal-auth/login -- returns the bearer token
 * string only.  Body is built with JSON.stringify, never string
 * interpolation, so a client secret containing a quote cannot break the
 * request shape. */
export async function loginUniversalAuth({ siteUrl, clientId, clientSecret, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const res = await fetchImpl(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Infisical login failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const token = body && body.accessToken;
  if (!token) {
    throw new Error("Infisical login response carried no accessToken");
  }
  return token;
}

/** GET .../api/v3/secrets/raw for the whole path in one call -- returns a
 * Map<secretKey, secretValue>.  viewSecretValue is always "true" here; this
 * script only ever runs where values are needed (it exists to populate
 * GITHUB_ENV), unlike the probe path in server/infisical.ts. */
export async function listSecretsRaw({ siteUrl, token, projectId, environment, secretPath, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const qs = new URLSearchParams({
    workspaceId: projectId,
    environment,
    secretPath,
    viewSecretValue: "true",
    expandSecretReferences: "false",
    include_imports: "false",
  });
  const res = await fetchImpl(`${siteUrl}/api/v3/secrets/raw?${qs.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Infisical secrets list failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const values = new Map();
  for (const s of body?.secrets ?? []) {
    if (s && s.secretKey && s.secretValue) {
      values.set(s.secretKey, s.secretValue);
    }
  }
  return values;
}

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

/** Resolves the vault snapshot (empty map when unconfigured or the fetch
 * failed) -- never throws; a failure is reported through `log` and the
 * caller proceeds on GH_FALLBACK_<NAME> alone. */
async function resolveVaultValues({ siteUrl, projectId, clientId, clientSecret, environment, secretPath, fetchImpl, log }) {
  if (!projectId || !clientId || !clientSecret) {
    return new Map();
  }
  try {
    const token = await loginUniversalAuth({ siteUrl, clientId, clientSecret, fetchImpl });
    return await listSecretsRaw({ siteUrl, token, projectId, environment, secretPath, fetchImpl });
  } catch (err) {
    // Never interpolate the raw error body -- Infisical error payloads have
    // echoed request fields on some 4xx responses in the past, and none of
    // that belongs in a public Actions log.
    const reason = err instanceof Error ? err.message : "unknown error";
    log(`::warning::Infisical ${environment} fetch unavailable (${reason}); using GitHub secret fallbacks only.`);
    return new Map();
  }
}

export async function run({ env = process.env, fetchImpl = fetch, log = (line) => console.log(line) } = {}) {
  const names = splitNames(env.INFISICAL_NAMES);
  const required = new Set(splitNames(env.INFISICAL_REQUIRED));
  const siteUrl = stripTrailingSlash(env.INFISICAL_SITE_URL || "https://app.infisical.com");
  const projectId = env.INFISICAL_PROJECT_ID || "";
  const environment = env.INFISICAL_ENVIRONMENT || "prod";
  const secretPath = env.INFISICAL_SECRET_PATH || "/";
  const clientId = env.INFISICAL_CLIENT_ID || "";
  const clientSecret = env.INFISICAL_CLIENT_SECRET || "";
  const githubEnvPath = env.GITHUB_ENV || "";

  const vaultValues = await resolveVaultValues({ siteUrl, projectId, clientId, clientSecret, environment, secretPath, fetchImpl, log });

  const missingRequired = [];
  for (const name of names) {
    let value = vaultValues.get(name) || "";
    if (!value) {
      value = env[`GH_FALLBACK_${name}`] || "";
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
