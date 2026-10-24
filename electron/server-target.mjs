// Which BotFleet server the desktop app talks to.
//
// Infisical is the sole source of truth for every secret, setting and on/off
// switch, so the server target is no longer a file in the app's user-data
// directory.  It is three names in the vault:
//
//   BOTFLEET_SERVER_MODE          "local" or "remote"
//   BOTFLEET_SERVER_URL           the server origin, when the mode is remote
//   BOTFLEET_SERVER_GATE_TOKEN    the gate token of that server
//
// There is no environment-variable override, no fallback chain and no local
// copy: if the vault cannot be read, the app says so and stops.  The ONE
// local item is the bootstrap — a read-only Infisical service token, scoped
// to the BotFleet project, the prod environment and the /botfleet-server
// path.  On the Mac it lives in the login Keychain as a generic password.
//
// No electron import here on purpose: this module is read by the main
// process and by plain `node --test`.

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  BOTFLEET_INFISICAL_ENVIRONMENT,
  BOTFLEET_SERVER_SECRET_PATH,
  readInfisicalSecrets,
  validateServiceToken,
} from "./infisical-read.mjs";

/** The old target file.  It is never read; it only earns a warning. */
export const SERVER_TARGET_FILE = "server-target.json";

/** The Keychain service the bootstrap token is filed under. */
export const KEYCHAIN_SERVICE = "BotFleet Infisical read token";

/** The Keychain account the bootstrap token is filed under. */
export const KEYCHAIN_ACCOUNT = "botfleet";

/** The Infisical name the mode comes from. */
const MODE_NAME = "BOTFLEET_SERVER_MODE";

/** The Infisical name the remote server address comes from. */
const URL_NAME = "BOTFLEET_SERVER_URL";

/** The Infisical name the gate token comes from. */
const TOKEN_NAME = "BOTFLEET_SERVER_GATE_TOKEN";

/**
 * How the vault is named in every message: the project, the environment and
 * the path.  A message may name the scope and the offending NAME, never a
 * value — a value in a message is a value in every log that catches it.
 */
const INFISICAL_SCOPE = `Infisical (BotFleet ${BOTFLEET_INFISICAL_ENVIRONMENT} ${BOTFLEET_SERVER_SECRET_PATH})`;

/** The `security` exit code for "no such item in the keychain". */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

/** The promisified `execFile`, so the keychain read is one await. */
const execFileAsync = promisify(execFileCallback);

/**
 * A runtime string test without `typeof`.
 *
 * The values here arrive from the vault, so they are decoded once at this
 * boundary and everything after it works on the decoded text.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Loopback hosts that may be reached over plain http. */
function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Check a server url and normalize it to an origin.
 *
 * https is accepted anywhere.  http is accepted only for a loopback host,
 * which is what an `ssh -L 8799:127.0.0.1:8799` tunnel looks like from this
 * side — a remote server is never reached over plain http.
 *
 * Everything else is refused: credentials in the url, a path, a query string
 * and a fragment all mean the value is not a bare server origin, and a url
 * that carries a secret is a url that ends up in a log file.
 *
 * @param {unknown} input
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
export function validateRemoteServerUrl(input) {
  if (!isString(input) || input.trim() === "") {
    return { ok: false, error: "The server URL is empty" };
  }
  const raw = input.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The server URL must use https (http is only allowed for a loopback tunnel)" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "The server URL must not contain credentials" };
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return { ok: false, error: "The server URL must not have a path" };
  }
  if (url.search !== "") {
    return { ok: false, error: "The server URL must not have a query string" };
  }
  if (url.hash !== "") {
    return { ok: false, error: "The server URL must not have a fragment" };
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return { ok: false, error: "Plain http is only allowed for a loopback address (an ssh -L tunnel)" };
  }
  return { ok: true, origin: url.origin };
}

/**
 * Check a gate token.
 *
 * A gate token is a shared secret, so it is held to a narrow shape: 16 to
 * 256 characters drawn from the URL-safe set.  That is long enough to be a
 * real secret and narrow enough that a pasted value is either a token or
 * obviously not one — a 20-character phrase with spaces in it is a mistake,
 * not a credential.
 *
 * The value is trimmed first, because a token is usually pasted out of a
 * terminal and a trailing newline is not part of it.
 *
 * @param {unknown} input
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
export function validateGateToken(input) {
  if (!isString(input)) {
    return { ok: false, error: "The gate token is not a string" };
  }
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: "The gate token is empty" };
  }
  if (raw.length < 16 || raw.length > 256) {
    return { ok: false, error: "The gate token must be 16 to 256 characters long" };
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(raw)) {
    return {
      ok: false,
      error: "The gate token may only contain letters, digits, '.', '_', '~' and '-'",
    };
  }
  return { ok: true, token: raw };
}

/**
 * Whether the old target file is still on disk.
 *
 * The file is never read — not its mode, not its url, not its token.  Only
 * its existence matters: the app warns the owner that it is ignored so it
 * can be deleted.
 *
 * @param {string} userDataDir
 * @returns {boolean}
 */
function legacyTargetFileExists(userDataDir) {
  try {
    return fs.existsSync(path.join(String(userDataDir ?? ""), SERVER_TARGET_FILE));
  } catch {
    return false;
  }
}

/**
 * Read the bootstrap Infisical service token from the login Keychain.
 *
 * The token is a generic password under one service and one account.  It is
 * read with `security find-generic-password -w`, which prints the secret on
 * stdout: the value is never logged, never put in an error message and never
 * put on a command line.
 *
 * A missing item is not an error: this Mac simply has no bootstrap token, and
 * the app runs against its own local server, which is code and not a
 * setting.  Any other failure — a locked keychain, a `security` that cannot
 * run — is an error the caller has to report.
 *
 * @param {{ execFileImpl?: Function }} options
 * @returns {Promise<string | null>} the service token, or null when there is none
 */
export async function readKeychainServiceToken({ execFileImpl = execFileAsync } = {}) {
  if (process.platform !== "darwin") return null;
  let stdout;
  try {
    const result = await execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 10_000, encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    stdout = isString(result) ? result : result?.stdout;
  } catch (error) {
    // `security` exits 44 when the keychain holds no such item.
    if (Number(error?.code) === KEYCHAIN_ITEM_NOT_FOUND) return null;
    throw new Error("could not read the Infisical read token from the Keychain");
  }
  try {
    return validateServiceToken(String(stdout ?? "").trim());
  } catch {
    throw new Error("could not read the Infisical read token from the Keychain");
  }
}

/**
 * The reason a vault read failed, without a value.
 *
 * @param {unknown} error
 * @returns {string}
 */
function infisicalFailureMessage(error) {
  const reason = String(error?.reason ?? "");
  const http = /^http-(\d+)$/.exec(reason);
  if (http) return `${INFISICAL_SCOPE} answered HTTP ${http[1]}`;
  if (reason === "unreachable") return `${INFISICAL_SCOPE} could not be read: the vault could not be reached`;
  if (reason === "bad-output") return `${INFISICAL_SCOPE} could not be read: the vault answered with a body the app cannot use`;
  if (reason === "missing") return `${INFISICAL_SCOPE} could not be read: the vault answered without the secrets`;
  return `${INFISICAL_SCOPE} could not be read`;
}

/**
 * A validation reason that never quotes the value it is about.
 *
 * @param {unknown} error
 * @param {string} raw
 * @returns {string}
 */
function safeReason(error, raw) {
  const message = String(error ?? "").trim();
  if (!message) return "the value is not valid";
  if (raw && message.includes(raw)) return "the value is not a valid server URL";
  return message;
}

/**
 * Which server this launch should use.
 *
 * The answer comes from the vault and from nowhere else:
 *
 *   - no bootstrap token in the Keychain means this Mac has no Infisical
 *     enrollment, and the app's own local server is code rather than a
 *     setting, so the answer is "this Mac";
 *   - `BOTFLEET_SERVER_MODE` "local" means the same, but now Infisical says
 *     so;
 *   - `BOTFLEET_SERVER_MODE` "remote" needs a valid `BOTFLEET_SERVER_URL`
 *     and a valid `BOTFLEET_SERVER_GATE_TOKEN`, or the app has nothing it
 *     could talk to;
 *   - anything else — a vault that cannot be read, a mode that is missing or
 *     unknown, a remote target without a usable address or token — is an
 *     error.  There is no fallback to the local server: quietly talking to a
 *     different server than the owner configured is the one failure mode
 *     that must never happen.
 *
 * Every answer carries `legacyFile`, which says whether the old target file
 * is still on disk.  It is never read.
 *
 * @param {{
 *   readToken?: () => Promise<string | null>,
 *   readSecrets?: (options: { serviceToken: string, names: string[] }) => Promise<Record<string, string>>,
 *   userDataDir?: string,
 * }} options
 * @returns {Promise<
 *   { mode: "local", source: "not-enrolled", legacyFile: boolean } |
 *   { mode: "local", source: "infisical", legacyFile: boolean } |
 *   { mode: "remote", source: "infisical", origin: string, token: string, legacyFile: boolean } |
 *   { mode: "error", source: "infisical", message: string, legacyFile: boolean }
 * >}
 */
export async function resolveServerTarget({
  readToken = readKeychainServiceToken,
  readSecrets = readInfisicalSecrets,
  userDataDir,
} = {}) {
  const legacyFile = legacyTargetFileExists(userDataDir);

  let serviceToken;
  try {
    serviceToken = await readToken();
  } catch (error) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} could not be read: ${String(error?.message ?? error)}`,
    };
  }
  if (!serviceToken) {
    // This Mac has no Infisical bootstrap at all.
    return { mode: "local", source: "not-enrolled", legacyFile };
  }

  let secrets;
  try {
    secrets = await readSecrets({
      serviceToken,
      names: [MODE_NAME, URL_NAME, TOKEN_NAME],
    });
  } catch (error) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: infisicalFailureMessage(error),
    };
  }

  const mode = isString(secrets?.[MODE_NAME]) ? secrets[MODE_NAME].trim().toLowerCase() : "";
  if (mode !== "local" && mode !== "remote") {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} has no valid ${MODE_NAME} (it must be "local" or "remote")`,
    };
  }
  if (mode === "local") {
    return { mode: "local", source: "infisical", legacyFile };
  }

  // Remote: the address and the gate token both have to be there and both
  // have to be valid, or the app has nothing it could talk to.
  const rawUrl = isString(secrets?.[URL_NAME]) ? secrets[URL_NAME].trim() : "";
  if (!rawUrl) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} has no ${URL_NAME}`,
    };
  }
  const url = validateRemoteServerUrl(rawUrl);
  if (!url.ok) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} has an invalid ${URL_NAME}: ${safeReason(url.error, rawUrl)}`,
    };
  }

  const rawToken = isString(secrets?.[TOKEN_NAME]) ? secrets[TOKEN_NAME].trim() : "";
  if (!rawToken) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} has no ${TOKEN_NAME}`,
    };
  }
  const token = validateGateToken(rawToken);
  if (!token.ok) {
    return {
      mode: "error",
      source: "infisical",
      legacyFile,
      message: `${INFISICAL_SCOPE} has an invalid ${TOKEN_NAME}: ${token.error}`,
    };
  }

  return {
    mode: "remote",
    source: "infisical",
    legacyFile,
    origin: url.origin,
    token: token.token,
  };
}
