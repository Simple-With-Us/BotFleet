// Where a BF role bot's Zulip key comes from.  Two implementations of
// `ZulipCredentialSource`, and neither is on by default:
//
//   - the file source: a `<Role>-zuliprc` file in the folder
//     `zulip.credentialDir` names (INI `[api]` with email, key and site, mode
//     600).  The folder has NO default on purpose: BotFleet's own rule is
//     that the product server does not read fleet handoff files (AGENTS.md
//     "Secret Handoff", docs/secrets.md), so it stays off until the operator
//     points it at a folder.
//   - the Infisical source: `ZULIP_<ROLE>_EMAIL` and `ZULIP_<ROLE>_API_KEY`
//     (optionally `_SITE`) in one Infisical folder (`zulip.infisicalPath`,
//     default `/zulip`), read through the harness's InfisicalManager with
//     its machine identity.  The folder is in BotFleet's own project and
//     environment unless `zulip.infisicalProjectId` / `zulip.infisicalEnv`
//     name another:  the fleet keeps the BF keys in AI Fleet Coordinator's
//     `prod` `/zulip`, and BotFleet reads them there rather than holding a
//     copy (docs/zulip.md, D0).  On only when `zulip.credentialSource` is
//     "infisical".
//
// The key lives only in the returned object and in the client's
// Authorization header.  It never enters `process.env` (so a spawned CLI
// cannot inherit it), and every error text that leaves this module names the
// path, never a line of the file: an INI parser that quotes the bad line
// could be quoting the key.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

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
  /** The role's credentials.  Throws ZulipCredentialError ("missing" when
   *  the role is simply not set up there). */
  load(role: string): ZulipCredentials | Promise<ZulipCredentials>;
}

/** One Infisical folder the Infisical source reads. */
export interface ZulipVaultLocation {
  secretPath: string;
  /** Another Infisical project's id.  Unset: the harness's own project. */
  projectId?: string;
  /** Another environment's slug.  Unset: the harness's own environment. */
  environment?: string;
  /** When set, only these names are kept from the folder.  A shared folder
   *  (AI Fleet Coordinator's `/zulip` holds every seat's key) then never
   *  leaves another seat's key in this process's memory. */
  names?: readonly string[];
}

/** Reads one Infisical folder: names to values, kept in memory by the
 *  caller and nowhere else. */
export type ZulipVaultReader = (location: ZulipVaultLocation) => Promise<ReadonlyMap<string, string>>;

/** A short, value-free label for a location, for status and error text:
 *  `/zulip` in the harness's own project and environment, otherwise
 *  `<project> <env> /zulip`. */
export function describeVaultLocation(location: Pick<ZulipVaultLocation, "secretPath" | "projectId" | "environment">): string {
  return [location.projectId, location.environment, location.secretPath].filter((part) => part?.trim()).join(" ");
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

/** A site given without a scheme means https; a trailing slash is noise. */
function normalizeSite(site: string): string {
  const trimmed = site.trim().replace(/\/+$/, "");
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The shape of one bot's credential fields, whichever source produced them
 *  (a zuliprc file or a vault folder: both are outside the type system, so
 *  both pass through here before the values are used).  Deliberately loose
 *  where Zulip is: the email needs an `@` with text on both sides (no TLD
 *  rule, a self-hosted realm may use a bare host), the key is printable ASCII
 *  with no whitespace (a CR or LF inside a vault value would otherwise break
 *  the Authorization header), and its length is not fixed.  Whether the site
 *  is https, and whether it is the configured realm, stay with `resolveRealm`
 *  and `verifyCredentialRealm`. */
const zulipCredentialFieldsSchema = z.object({
  email: z.string().max(320).regex(/^[^\s@]+@[^\s@]+$/),
  key: z.string().regex(/^[\x21-\x7e]+$/),
  site: z.string().max(2048).refine(isHttpUrl),
});

/** Validate the three fields.  A failure names the fields that are wrong and
 *  the source, never a value and never zod's own message: an issue text could
 *  quote the input, and the key is one of the inputs. */
function checkCredentialFields(
  fields: { email: string; key: string; site: string },
  source: string,
): { email: string; key: string; site: string } {
  const parsed = zulipCredentialFieldsSchema.safeParse(fields);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "credentials")))];
  throw new ZulipCredentialError(`${source}: invalid ${names.join(", ")}`, "invalid");
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
  return checkCredentialFields({ email: values.email!, key: values.key!, site: normalizeSite(values.site!) }, path);
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

/** The vault names for one role: `BF-Plumber` -> `ZULIP_BF_PLUMBER_*`. */
export function zulipVaultNames(role: string): { email: string; key: string; site: string } {
  const stem = `ZULIP_${role.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return { email: `${stem}_EMAIL`, key: `${stem}_API_KEY`, site: `${stem}_SITE` };
}

export const ZULIP_DEFAULT_INFISICAL_PATH = "/zulip";

/** Every vault name the given roles can use, sorted and de-duplicated, so
 *  the same set of roles always yields the same list (and cache key). */
export function zulipVaultNamesFor(roles: readonly string[]): string[] {
  const names = new Set<string>();
  for (const role of roles) {
    if (!validZulipRole(role.trim())) continue;
    const n = zulipVaultNames(role);
    names.add(n.email).add(n.key).add(n.site);
  }
  return [...names].sort();
}

/** The Infisical source.  `read` is the harness's InfisicalManager (wrap it
 *  in `cachedVaultReader` so reconnects do not each hit the vault).  The
 *  folder is in another project or environment when `projectId` or
 *  `environment` is set.  With `roles` (the bound bots' roles), each read
 *  asks for those roles' names only, so one read serves every bot and a
 *  shared folder's other keys are not kept.  The key stays in the returned
 *  object; error text names the vault names and the folder, never a value.
 *  Without a `_SITE` name the site is the realm, and
 *  `verifyCredentialRealm` still checks it. */
export function infisicalCredentialSource(
  read: ZulipVaultReader,
  opts: { path?: string; projectId?: string; environment?: string; roles?: readonly string[]; realm: string },
): ZulipCredentialSource {
  const secretPath = opts.path?.trim() || ZULIP_DEFAULT_INFISICAL_PATH;
  const projectId = opts.projectId?.trim() || undefined;
  const environment = opts.environment?.trim() || undefined;
  const where = describeVaultLocation({ secretPath, projectId, environment });
  const bound = opts.roles?.map((role) => role.trim());
  return {
    describe: (role) => (validZulipRole(role) ? `infisical ${where} ${zulipVaultNames(role).key.replace(/_API_KEY$/, "_*")}` : "invalid role"),
    load: async (role) => {
      if (!validZulipRole(role)) throw new ZulipCredentialError(`"${role}" is not a valid Zulip role name`, "invalid");
      const names = zulipVaultNames(role);
      // A role loaded outside the bound set still gets its own names.
      const keep = bound ? zulipVaultNamesFor(bound.includes(role) ? bound : [...bound, role]) : undefined;
      let values: ReadonlyMap<string, string>;
      try {
        values = await read({ secretPath, projectId, environment, names: keep });
      } catch (e) {
        // The manager's errors are value-free; keep only its message.
        const why = e instanceof Error ? e.message : "unknown error";
        throw new ZulipCredentialError(`cannot read Infisical ${where}: ${why}`, "invalid");
      }
      const email = values.get(names.email)?.trim();
      const key = values.get(names.key)?.trim();
      const missing = [!email && names.email, !key && names.key].filter(Boolean);
      if (missing.length) throw new ZulipCredentialError(`Infisical ${where} has no ${missing.join(" or ")}`, "missing");
      const source = `infisical ${where}`;
      const site = normalizeSite(values.get(names.site)?.trim() || opts.realm);
      return { ...checkCredentialFields({ email: email!, key: key!, site }, source), source };
    },
  };
}

/** One vault read per location per `ttlMs`, shared by every role and every
 *  reconnect.  A location's `names`, when set, are the only names kept: the
 *  rest of the folder is dropped as soon as the read returns, so the cache
 *  holds the bound roles' keys and nothing else.  A failed read is not
 *  cached, so the next retry reads again. */
export function cachedVaultReader(
  read: ZulipVaultReader,
  opts: { ttlMs?: number; now?: () => number } = {},
): ZulipVaultReader {
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; values: Promise<ReadonlyMap<string, string>> }>();
  return (location) => {
    const names = location.names ? [...new Set(location.names)].sort() : null;
    const cacheKey = JSON.stringify([
      location.projectId?.trim() ?? "",
      location.environment?.trim() ?? "",
      location.secretPath,
      names,
    ]);
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < ttlMs) return hit.values;
    const values = read(location).then((all): ReadonlyMap<string, string> => {
      if (!names) return all;
      const kept = new Map<string, string>();
      for (const name of names) {
        const value = all.get(name);
        if (value !== undefined) kept.set(name, value);
      }
      return kept;
    });
    cache.set(cacheKey, { at: now(), values });
    values.catch(() => {
      if (cache.get(cacheKey)?.values === values) cache.delete(cacheKey);
    });
    return values;
  };
}

/** The credential source for these settings, or null when none is set up.
 *
 *  - `OMB_ZULIP_CREDENTIAL_DIR` (tests, a soak rig) always means the file
 *    source.
 *  - `credentialSource: "infisical"` means the Infisical source, and needs
 *    the harness's vault reader.  It reads `infisicalPath` in
 *    `infisicalProjectId` / `infisicalEnv` when those are set, and asks for
 *    the names of the roles in `bots` only.
 *  - Otherwise (`"file"` or unset) the file source, when `credentialDir`
 *    names an absolute folder. */
export function credentialSourceFor(
  settings:
    | {
        credentialDir?: string;
        credentialSource?: "file" | "infisical";
        infisicalPath?: string;
        infisicalProjectId?: string;
        infisicalEnv?: string;
        bots?: Record<string, { role: string }>;
        realm?: string;
      }
    | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: { vault?: ZulipVaultReader; realm?: string } = {},
): ZulipCredentialSource | null {
  const envDir = env.OMB_ZULIP_CREDENTIAL_DIR?.trim();
  if (!envDir && settings?.credentialSource === "infisical") {
    if (!deps.vault) return null;
    return infisicalCredentialSource(deps.vault, {
      path: settings.infisicalPath,
      projectId: settings.infisicalProjectId,
      environment: settings.infisicalEnv,
      roles: Object.values(settings.bots ?? {}).map((bot) => bot.role),
      realm: deps.realm ?? settings.realm ?? ZULIP_DEFAULT_REALM,
    });
  }
  const dir = envDir || settings?.credentialDir?.trim();
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
