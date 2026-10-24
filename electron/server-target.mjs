// Which BotFleet server the desktop app talks to.
//
// The packaged app has always talked to the harness on this Mac.  It can also
// point at a remote harness — a headless box behind `tailscale serve` and an
// owner gate — without changing anything else: the renderer still runs on a
// loopback origin (the UI shim), and the shim streams /api through to the
// remote server.
//
// The choice lives in one small file in the app's user-data directory, so the
// user can point the app somewhere else without a rebuild:
//
//   { "mode": "local" | "remote", "url": "https://host:8799", "token"?: "…", "savedUrl"?: "…" }
//
// `url` is the server to use while `mode` is "remote".  `savedUrl` is the last
// url that was known to be valid; it is kept even when the mode is "local" so
// the menu can offer to switch back.
//
// `token` is the gate token of a remote server that needs one: the desktop
// app sends it in the `x-botfleet-gate-token` header on every request.  A
// Tailscale serve URL in front of the BotFleet owner gate accepts either a
// Tailscale login (a user-owned device) or that token (a tagged device, which
// gets no identity header at all).
//
// `BOTFLEET_SERVER_URL` overrides the file: "local" means this Mac, anything
// else must be a valid server url.  It exists for a one-off launch (a support
// session against a remote box) without touching the file on disk.
// `BOTFLEET_SERVER_TOKEN` overrides the token the same way.
//
// No electron import here on purpose: this module is read by the main
// process and by plain `node --test`.

import fs from "node:fs";
import path from "node:path";

export const SERVER_TARGET_FILE = "server-target.json";

/**
 * A runtime string test without `typeof`.
 *
 * The values here arrive from a file, an environment variable or a dialog, so
 * they are decoded once at this boundary and everything after it works on the
 * decoded text.
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

function targetFilePath(userDataDir) {
  return path.join(String(userDataDir ?? ""), SERVER_TARGET_FILE);
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

/** Read the target file's parsed body, or null when it is missing/unreadable. */
function readTargetFile(userDataDir) {
  let text;
  try {
    text = fs.readFileSync(targetFilePath(userDataDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate the parsed target file.
 *
 * The file is hand-editable by design ("Set Remote Server…" opens it), so
 * every field is checked before anything uses it.  The mode must be one the
 * app knows, the urls must be strings, and the token must be a real gate
 * token.
 *
 * An invalid token is dropped and reported rather than used: a token the
 * gate will refuse is worse than no token, because it looks configured.
 * The same rule decides whether a token may be carried over into a new
 * file, so the reader and the writer can never disagree about it.
 *
 * @param {unknown} parsed
 * @returns {{ value: { mode: "local" | "remote", url?: string, savedUrl?: string, token?: string } | null, error: string | null, urlError?: string | null }}
 */
export function validateTargetFile(parsed) {
  if (!isRecord(parsed)) {
    return { value: null, error: `${SERVER_TARGET_FILE} is not a JSON object` };
  }
  const mode = parsed.mode;
  if (mode !== "local" && mode !== "remote") {
    return { value: null, error: `${SERVER_TARGET_FILE} has no valid "mode"` };
  }
  const value = { mode };
  let urlError = null;
  if (isString(parsed.url)) {
    const trimmed = parsed.url.trim();
    if (mode === "remote") {
      // A remote url is the one field the app acts on, so it is validated
      // here with the rest of the file:  no caller can see an unchecked one.
      // An invalid one is left out of the value and reported, and the rest
      // of the file (the token) is still returned, so the writer can carry
      // the token over when the owner fixes the address from the menu.
      const validated = validateRemoteServerUrl(trimmed);
      if (validated.ok) value.url = validated.origin;
      else urlError = `The remote server URL in ${SERVER_TARGET_FILE} is not valid: ${validated.error}`;
    } else {
      // A local file may carry a url the user is still typing (the
      // template), so it is kept as given and validated before use.
      value.url = trimmed;
    }
  }
  if (isString(parsed.savedUrl)) value.savedUrl = parsed.savedUrl.trim();
  let error = null;
  if (isString(parsed.token) && parsed.token.trim()) {
    const checked = validateGateToken(parsed.token);
    if (checked.ok) value.token = checked.token;
    else error = `The gate token in ${SERVER_TARGET_FILE} is not valid: ${checked.error}`;
  }
  // An unusable address outranks a dropped token:  it is the error that
  // decides where the app can go.
  return { value, error: urlError ?? error, urlError };
}

/**
 * The validated target file, or null when there is no readable file.
 *
 * This is the one way to look at the file's contents: every field comes
 * back validated, so a caller can never act on a shape the app would
 * refuse.
 *
 * @param {string} userDataDir
 * @returns {{ mode: "local" | "remote", url?: string, savedUrl?: string, token?: string } | null}
 */
export function readServerTargetFile(userDataDir) {
  const parsed = readTargetFile(userDataDir);
  if (!parsed) return null;
  return validateTargetFile(parsed).value;
}

/** The last url in the file that is still valid, as an origin, or null. */
function savedOriginFrom(parsed) {
  if (!parsed) return null;
  // While the target is remote, `url` is the address the app is actually
  // pointed at, so it wins over `savedUrl` — a hand-edited file can name a
  // new server while still carrying the old one as its saved url.  In local
  // mode `url` is only a template to edit, and `savedUrl` is the last server
  // worth switching back to.
  const candidates = parsed.mode === "remote"
    ? [parsed.url, parsed.savedUrl]
    : [parsed.savedUrl, parsed.url];
  for (const candidate of candidates) {
    if (!isString(candidate)) continue;
    const validated = validateRemoteServerUrl(candidate);
    if (validated.ok) return validated.origin;
  }
  return null;
}

/**
 * The gate token from the environment, if any.
 *
 * The environment overrides the token in the file, the same way
 * `BOTFLEET_SERVER_URL` overrides the url.  An invalid value is reported
 * rather than used: a token that is silently dropped is a token the gate
 * refuses, with no hint of why.
 *
 * @param {NodeJS.ProcessEnv|undefined} environment
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
function tokenFromEnv(environment) {
  const token = environment?.BOTFLEET_SERVER_TOKEN;
  const raw = isString(token) ? token.trim() : "";
  if (!raw) return { ok: true, token: "" };
  const checked = validateGateToken(raw);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, token: checked.token };
}

/**
 * Which server this launch should use.
 *
 * Never throws: a broken file is a broken preference, not a broken app, so
 * the answer is "this Mac" plus an `error` the caller can log.
 *
 * In remote mode the answer also carries the gate `token`, when the server
 * needs one.  A token is optional: a server behind a Tailscale login does
 * not need one.  An invalid token is ignored and reported, so the app still
 * talks to the remote server and the log says why the gate may refuse it.
 *
 * @param {{ userDataDir: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ mode: "local" } | { mode: "remote", origin: string, token?: string, error?: string, tokenDropped?: boolean } | { mode: "local", error: string }}
 */
export function readServerTarget({ userDataDir, env = process.env } = {}) {
  const overrideValue = env?.BOTFLEET_SERVER_URL;
  const override = isString(overrideValue) ? overrideValue.trim() : "";
  if (override) {
    if (override.toLowerCase() === "local") return { mode: "local" };
    const validated = validateRemoteServerUrl(override);
    if (!validated.ok) return { mode: "local", error: `BOTFLEET_SERVER_URL is not a valid server URL: ${validated.error}` };
    const fromEnv = tokenFromEnv(env);
    if (!fromEnv.ok) {
      return {
        mode: "remote",
        origin: validated.origin,
        error: `BOTFLEET_SERVER_TOKEN is not a valid gate token: ${fromEnv.error}`,
        tokenDropped: true,
      };
    }
    return fromEnv.token
      ? { mode: "remote", origin: validated.origin, token: fromEnv.token }
      : { mode: "remote", origin: validated.origin };
  }

  let text;
  try {
    text = fs.readFileSync(targetFilePath(userDataDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: "local" };
    return { mode: "local", error: `Could not read ${SERVER_TARGET_FILE}: ${error?.message ?? error}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { mode: "local", error: `${SERVER_TARGET_FILE} is not valid JSON` };
  }

  // The file is hand-editable, so it is validated as a whole before any of
  // it is used: an unknown mode, a missing url or a bad token is reported,
  // never acted on.
  const checked = validateTargetFile(parsed);
  if (!checked.value) {
    return { mode: "local", error: checked.error };
  }
  const file = checked.value;

  if (file.mode === "local") return { mode: "local" };
  if (checked.urlError) return { mode: "local", error: checked.urlError };
  const validated = validateRemoteServerUrl(file.url);
  if (!validated.ok) {
    return { mode: "local", error: `The remote server URL in ${SERVER_TARGET_FILE} is not valid: ${validated.error}` };
  }

  const remote = { mode: "remote", origin: validated.origin };

  // The environment overrides the token in the file.
  const fromEnv = tokenFromEnv(env);
  if (!fromEnv.ok) {
    return {
      ...remote,
      error: `BOTFLEET_SERVER_TOKEN is not a valid gate token: ${fromEnv.error}`,
      tokenDropped: true,
    };
  }
  if (fromEnv.token) return { ...remote, token: fromEnv.token };
  if (file.token) return { ...remote, token: file.token };
  if (checked.error) return { ...remote, error: checked.error, tokenDropped: true };
  return remote;
}

/**
 * Write the target file.
 *
 * The write is atomic (a temporary file plus a rename) so a crash mid-write
 * cannot leave a half-written target behind, and the file is owner-only: it
 * names a private server address and may carry a gate token.
 *
 * Switching back to "local" keeps the last valid url in the file, so the menu
 * can offer to switch back to it without the user typing it again.
 *
 * The gate token is kept too: a target written without a token must not
 * silently drop the token the file already had, or switching servers in the
 * menu would lock the owner out of a server they had just configured.  A new
 * token replaces the old one only when it is handed in.
 *
 * @param {string} userDataDir
 * @param {{ mode: "local" | "remote", url?: string, token?: string }} target
 * @returns {{ mode: "local" | "remote", url?: string, savedUrl?: string, token?: string }}
 */
export function writeServerTarget(userDataDir, { mode, url, token } = {}) {
  if (mode !== "local" && mode !== "remote") {
    throw new Error(`Unknown server target mode: ${String(mode)}`);
  }
  const previousFile = readTargetFile(userDataDir);
  const previous = savedOriginFrom(previousFile);
  // The carried-over token is validated with the same rule the reader uses:
  // the file is hand-editable, so a token typed by hand (or pasted with a
  // stray character) must not be written back — the reader would reject it
  // and the owner would be locked out of the server they had configured.
  const previousChecked = previousFile ? validateTargetFile(previousFile) : null;
  const previousToken = previousChecked?.value?.token ?? "";

  // A token handed in is checked; a token already in the file is kept only
  // when it is a valid gate token.
  let chosenToken = "";
  if (isString(token) && token.trim()) {
    const checked = validateGateToken(token);
    if (!checked.ok) throw new Error(checked.error);
    chosenToken = checked.token;
  } else if (previousToken) {
    chosenToken = previousToken;
  }

  let target;
  if (mode === "remote") {
    const validated = validateRemoteServerUrl(url);
    if (!validated.ok) throw new Error(validated.error);
    target = { mode: "remote", url: validated.origin, savedUrl: validated.origin };
  } else {
    // A url may be handed in for the "local" mode too: the menu writes a
    // template the user then edits.  It is stored as given — the reader
    // validates before it is ever used.
    const requested = isString(url) ? url.trim() : "";
    const kept = requested || previous || "";
    target = { mode: "local" };
    if (kept) {
      target.url = kept;
      target.savedUrl = kept;
    }
  }
  if (chosenToken) target.token = chosenToken;

  fs.mkdirSync(String(userDataDir ?? ""), { recursive: true });
  const file = targetFilePath(userDataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* a filesystem without POSIX modes is not a reason to fail the write */
  }
  fs.renameSync(temporary, file);
  return target;
}

/**
 * Write the target file as an empty template, but only when it does not
 * exist yet.
 *
 * The template is what the user edits: the server address, the gate token
 * and the mode.  The url is deliberately empty and is NOT validated — the
 * whole point of the template is that the user types the address into it.
 * An existing file is never touched, because the user may have put a real
 * address and a real token in it already.
 *
 * @param {string} userDataDir
 * @returns {{ written: boolean, file: string }}
 */
export function writeServerTargetTemplate(userDataDir) {
  fs.mkdirSync(String(userDataDir ?? ""), { recursive: true });
  const file = targetFilePath(userDataDir);
  if (fs.existsSync(file)) return { written: false, file };

  const template = { mode: "local", url: "", token: "" };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* a filesystem without POSIX modes is not a reason to fail the write */
  }
  fs.renameSync(temporary, file);
  return { written: true, file };
}

/**
 * The last valid remote url in the file, as an origin, or null when there is
 * none.  This is what the menu offers to switch back to.
 *
 * @param {string} userDataDir
 * @returns {string | null}
 */
export function readSavedRemoteUrl(userDataDir) {
  return savedOriginFrom(readTargetFile(userDataDir));
}
