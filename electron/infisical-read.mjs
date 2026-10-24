// Read-only Infisical access for the pieces of BotFleet that run outside the
// harness: the Linux owner gate reads its whole configuration from the vault.
//
// The owner rule is that Infisical is the sole source of truth for every
// secret, setting and on/off switch.  There is no environment-variable read
// here, no fallback chain and no override: if the vault cannot be read, the
// caller fails loudly instead of guessing.
//
// The ONE local item allowed is the bootstrap: a read-only Infisical service
// token, scoped to this project, this environment and one path.  It is read
// from a file that must be a regular file, owned by the service user, mode
// 0600.  That token is the only thing that ever lives on the host disk, and
// it is never written to a log, an error message or a URL.
//
// No electron import here on purpose: this module is read by plain
// `node --test` and by the gate that runs headless on the Linux box.

import fs from "node:fs";

/** The Infisical site the vault lives on. */
export const INFISICAL_SITE = "https://app.infisical.com";

/** The BotFleet project.  Every read below is scoped to it. */
export const BOTFLEET_INFISICAL_PROJECT_ID = "836aebe2-c8f7-4e09-978e-7e3e82500bce";

/** The environment the server reads. */
export const BOTFLEET_INFISICAL_ENVIRONMENT = "prod";

/** The path the server's own secrets live under. */
export const BOTFLEET_SERVER_SECRET_PATH = "/botfleet-server";

/** The shortest and longest service token this reader accepts. */
const MIN_SERVICE_TOKEN_LENGTH = 20;
const MAX_SERVICE_TOKEN_LENGTH = 2048;

/**
 * A failed read.  The reason is a stable, machine-readable label; the message
 * names the status and the path and never a token or a value.
 */
export class InfisicalReadError extends Error {
  /**
   * @param {"unreachable" | `http-${number}` | "bad-output" | "missing"} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "InfisicalReadError";
    this.reason = reason;
  }
}

/**
 * A runtime string test without `typeof`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

/**
 * A plain object, decoded the same way: an array or a null is not one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Check that a value is an Infisical service token.
 *
 * A service token starts with `st.`, carries no whitespace and is between
 * 20 and 2048 characters long.  The value itself never appears in the error:
 * a message that quotes the token would put it in every log that catches it.
 *
 * @param {unknown} value
 * @returns {string} the trimmed token
 */
export function validateServiceToken(value) {
  const token = isString(value) ? value.trim() : "";
  const ok =
    token.startsWith("st.") &&
    token.length >= MIN_SERVICE_TOKEN_LENGTH &&
    token.length <= MAX_SERVICE_TOKEN_LENGTH &&
    !/\s/.test(token);
  if (!ok) {
    throw new Error("the Infisical read token is not a service token (st.…)");
  }
  return token;
}

/**
 * The URL the raw secrets are read from.
 *
 * `secretPath` is percent-encoded, so the path travels as one segment and
 * never reaches the vault as a second path.
 *
 * @returns {string}
 */
function rawSecretsUrl() {
  const query = new URLSearchParams({
    workspaceId: BOTFLEET_INFISICAL_PROJECT_ID,
    environment: BOTFLEET_INFISICAL_ENVIRONMENT,
    secretPath: BOTFLEET_SERVER_SECRET_PATH,
    include_imports: "false",
  });
  return `${INFISICAL_SITE}/api/v3/secrets/raw?${query.toString()}`;
}

/**
 * Read a set of secrets from the vault.
 *
 * The read is one request for the whole path; only the requested names come
 * back, and only when the vault holds them.  A name that is absent is simply
 * absent from the result: the caller decides what an absent name means.
 *
 * A value that still holds a `${...}` reference did not resolve, so it is
 * refused rather than used as if it were a secret.
 *
 * @param {{serviceToken: string, names: string[], fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * @returns {Promise<Record<string, string>>}
 */
export async function readInfisicalSecrets({
  serviceToken,
  names,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  const token = validateServiceToken(serviceToken);
  const wanted = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    if (isString(name) && name) wanted.add(name);
  }

  let response;
  try {
    response = await fetchImpl(rawSecretsUrl(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err?.name === "TimeoutError" || err?.name === "AbortError"
      ? "the request timed out"
      : "the request failed";
    throw new InfisicalReadError(
      "unreachable",
      `Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) could not be read: ${detail}`,
    );
  }

  if (!response?.ok) {
    const status = Number(response?.status ?? 0);
    throw new InfisicalReadError(
      `http-${status}`,
      `Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) answered HTTP ${status}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new InfisicalReadError(
      "bad-output",
      `Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) answered with a body that is not JSON`,
    );
  }

  if (!isRecord(body) || !("secrets" in body)) {
    throw new InfisicalReadError(
      "missing",
      `Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) answered without a secrets list`,
    );
  }
  if (!Array.isArray(body.secrets)) {
    throw new InfisicalReadError(
      "bad-output",
      `Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) answered with a malformed secrets list`,
    );
  }

  const out = {};
  for (const row of body.secrets) {
    if (!isRecord(row)) continue;
    const key = row.secretKey;
    if (!isString(key) || !wanted.has(key)) continue;
    const value = row.secretValue;
    if (!isString(value)) continue;
    if (value.includes("${")) {
      throw new InfisicalReadError(
        "bad-output",
        `the secret ${key} in Infisical (${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH}) is an unresolved reference`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read the bootstrap service token from its file.
 *
 * The file is opened without following symlinks and is then checked: it has
 * to be a regular file, owned by the user the process runs as, and mode 0600.
 * Anything else is a configuration error, not something to work around.
 *
 * @param {string} path
 * @returns {string} the validated service token
 */
export function readBootstrapTokenFile(path) {
  const file = String(path ?? "");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === "ELOOP") {
      throw new Error(`the Infisical read token file ${file} is a symlink; it must be a regular file`);
    }
    if (err?.code === "ENOENT") {
      throw new Error(`the Infisical read token file ${file} does not exist`);
    }
    throw new Error(
      `the Infisical read token file ${file} could not be opened: ${err?.code ?? "unknown error"}`,
    );
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`the Infisical read token file ${file} is not a regular file`);
    }
    const geteuid = process.geteuid;
    const euid = Object.prototype.toString.call(geteuid) === "[object Function]" ? geteuid() : null;
    if (euid !== null && stat.uid !== euid) {
      throw new Error(`the Infisical read token file ${file} is not owned by the service user`);
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `the Infisical read token file ${file} must be mode 0600 (it is ${mode.toString(8).padStart(4, "0")})`,
      );
    }
    const content = fs.readFileSync(fd, "utf8");
    return validateServiceToken(content);
  } finally {
    fs.closeSync(fd);
  }
}
