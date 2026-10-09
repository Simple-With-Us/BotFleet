// Where a BF role bot's Zulip key comes from.
//
// One source today: a `<Role>-zuliprc` file in the folder `zulip.credentialDir`
// names (INI `[api]` with email, key and site, mode 600).  The folder has NO
// default on purpose: BotFleet's own rule is that the product server does not
// read fleet handoff files (AGENTS.md "Secret Handoff", docs/secrets.md), so
// the file source stays off until the operator points it at a folder.  An
// Infisical-backed source is the planned second implementation of
// `ZulipCredentialSource` (docs/zulip.md, follow-ups).
//
// The key lives only in the returned object and in the client's
// Authorization header.  It never enters `process.env` (so a spawned CLI
// cannot inherit it), and every error text that leaves this module names the
// path, never a line of the file: an INI parser that quotes the bad line
// could be quoting the key.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ZulipCredentials {
  email: string;
  /** The API key.  Never logged, never put in env. */
  key: string;
  site: string;
  /** Where it came from, for status and error text. */
  source: string;
}

export class ZulipCredentialError extends Error {
  /** "missing": no file yet, so the bot is simply not set up.  Anything else
   *  is a file that exists and is wrong. */
  readonly reason: "missing" | "invalid" | "insecure" | "realm";
  constructor(message: string, reason: "missing" | "invalid" | "insecure" | "realm") {
    super(message);
    this.name = "ZulipCredentialError";
    this.reason = reason;
  }
}

/** A role is a file code like `BF-Plumber`: letters, digits, `-` and `_`,
 *  starting with a letter or digit.  Checked before it is joined into a path,
 *  so a role can never walk out of the credential folder. */
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export function validZulipRole(role: string): boolean {
  return ROLE_RE.test(role);
}

export interface ZulipCredentialSource {
  /** A short, secret-free description for status ("file ~/.secrets/…"). */
  describe(role: string): string;
  load(role: string): ZulipCredentials;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1).trim();
  return v;
}

/** Parse a zuliprc's `[api]` section.  Comments (`#`, `;`) and other sections
 *  are ignored.  Throws a message that names the path only. */
export function parseZuliprc(text: string, path: string): Omit<ZulipCredentials, "source"> {
  let section = "";
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim().toLowerCase();
      continue;
    }
    if (section !== "api") continue;
    const eq = line.search(/[=:]/);
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim().toLowerCase();
    if (name === "email" || name === "key" || name === "site") values[name] = stripQuotes(line.slice(eq + 1));
  }
  const missing = (["email", "key", "site"] as const).filter((name) => !values[name]);
  if (missing.length) {
    throw new ZulipCredentialError(`${path}: the [api] section is missing ${missing.join(", ")}`, "invalid");
  }
  let site = values.site!.replace(/\/+$/, "");
  if (!site.includes("://")) site = `https://${site}`;
  return { email: values.email!, key: values.key!, site };
}

/** Read one zuliprc file.  Refuses anything that is not a regular file and
 *  anything group- or world-accessible, the way the fleet CLI does. */
export function readZuliprc(path: string): ZulipCredentials {
  let mode: number;
  let isFile: boolean;
  try {
    const st = statSync(path);
    mode = st.mode;
    isFile = st.isFile();
  } catch (e) {
    // SAFETY: statSync throws a Node system error, which carries `code`.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ZulipCredentialError(`no credential file at ${path}`, "missing");
    throw new ZulipCredentialError(`cannot read ${path} (${code ?? "error"})`, "invalid");
  }
  if (!isFile) throw new ZulipCredentialError(`${path} is not a regular file`, "invalid");
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new ZulipCredentialError(
      `${path} is readable by group or other (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`,
      "insecure",
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // SAFETY: readFileSync throws a Node system error, which carries `code`.
    const code = (e as NodeJS.ErrnoException).code;
    throw new ZulipCredentialError(`cannot read ${path} (${code ?? "error"})`, "invalid");
  }
  return { ...parseZuliprc(text, path), source: path };
}

/** The file source: `<dir>/<Role>-zuliprc`. */
export function fileCredentialSource(dir: string): ZulipCredentialSource {
  const root = resolve(expandHome(dir));
  const pathFor = (role: string): string => {
    if (!validZulipRole(role)) throw new ZulipCredentialError(`"${role}" is not a valid Zulip role name`, "invalid");
    return join(root, `${role}-zuliprc`);
  };
  return {
    describe: (role) => (validZulipRole(role) ? `file ${join(root, `${role}-zuliprc`)}` : "invalid role"),
    load: (role) => readZuliprc(pathFor(role)),
  };
}

/** The credential source for these settings, or null when none is set up.
 *  `OMB_ZULIP_CREDENTIAL_DIR` overrides the setting (tests, a soak rig). */
export function credentialSourceFor(
  settings: { credentialDir?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ZulipCredentialSource | null {
  const dir = env.OMB_ZULIP_CREDENTIAL_DIR?.trim() || settings?.credentialDir?.trim();
  if (!dir) return null;
  const expanded = expandHome(dir);
  if (!isAbsolute(expanded)) return null;
  return fileCredentialSource(expanded);
}

export const ZULIP_DEFAULT_REALM = "https://simplewithus.zulipchat.com";

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** The realm this harness talks to, normalized, or an error message.
 *  `OMB_ZULIP_REALM` overrides the setting.  Plain http is allowed only on
 *  loopback (the tests' fake server). */
export function resolveRealm(
  settings: { realm?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { realm: string } | { error: string } {
  const raw = (env.OMB_ZULIP_REALM?.trim() || settings?.realm?.trim() || ZULIP_DEFAULT_REALM).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `the Zulip realm "${raw}" is not a URL` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return { error: "the Zulip realm must be https (plain http is allowed only on loopback)" };
  }
  return { realm: url.origin };
}

/** Refuse credentials whose site is not the realm: the key must never be
 *  sent to a host the operator did not name. */
export function verifyCredentialRealm(creds: ZulipCredentials, realm: string): void {
  let site: URL;
  try {
    site = new URL(creds.site);
  } catch {
    throw new ZulipCredentialError(`${creds.source}: site is not a URL`, "invalid");
  }
  if (site.origin !== new URL(realm).origin) {
    throw new ZulipCredentialError(
      `${creds.source}: site ${site.host} is not the configured realm ${new URL(realm).host}; refusing to send the key there`,
      "realm",
    );
  }
}
