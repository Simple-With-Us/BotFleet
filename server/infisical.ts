// The secret-source manager: fetches Infisical asynchronously and publishes a
// synchronous snapshot through `secret-map.ts`'s `setInfisicalSnapshot` — the
// only place a vault value enters the process (see that module's own header
// for the three rules that keep it safe).  Modelled on `UsageTelemetryManager`
// (`configure`/`getStatus`/`probe`) and `UsageQuotaPoller` (`start`/`stop`, a
// fixed interval, a single-flight guard) so this reads like every other
// background poller in the server, not like a fourth pattern.
//
// Nothing here ever puts a secret VALUE into a log line, a thrown message, or
// the status view this module hands back — only names, field ids and counts
// leave this module.  `writeSecret` is the one path that sends a value
// anywhere at all, and it goes straight to Infisical over the connection
// `login()` already authenticated, never through a log line.
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { normalizeInfisicalSecretPath, type InfisicalAuthMethod, type InfisicalSettings, type ResolvedInfisicalReadSource } from "./config.ts";
import { dataDir } from "./data-dir.ts";
import { InfisicalError, login, listSecrets, upsertSecret } from "./infisical-client.ts";
import { redactSecretsInText } from "./redact.ts";
import { SECRET_FIELDS, infisicalSnapshot, setInfisicalSnapshot, vaultNames as snapshotVaultNames } from "./secret-map.ts";
import { KNOB_FIELDS, KNOB_INFISICAL_NAMES, knobSource } from "./knob-map.ts";

export type RefreshReason = "boot" | "timer" | "settings" | "manual";

/** Named destinations still require credentials dedicated to the requested scope. */
export type VaultProject = "botfleet" | "fleet-ops";

/** The only environment the fleet's project has.  The fleet refuses a
 * non-prod environment for it, so a read that named one would be asking for
 * a project that does not exist. */
export const FLEET_OPS_ENVIRONMENT = "prod";

/** The fleet's project id, or "" when this host has none.
 *
 * It is never committed — the fleet keeps that project id out of every
 * repository — so it comes from the environment, in the variable the
 * fleet's own tools read (`INFISICAL_FLEET_OPS_PROJECT_ID`).
 *
 * A project id is only a locator; it never authorizes using another
 * project's credential to access the fleet project. */
export function fleetOpsProjectId(): string {
  return (process.env.INFISICAL_FLEET_OPS_PROJECT_ID ?? "").trim();
}

/** Everything the loopback status route and the Secrets card read.  Values
 * never ride here — only the site URL, the project id, the environment, the
 * path, names, field ids and counts. */
export interface InfisicalStatusView {
  authMethod: InfisicalAuthMethod;
  configured: boolean;
  enabled: boolean;
  enabledSetting: boolean;
  writeThrough: boolean;
  /** Where the machine identity itself came from.  Env always outranks the
   * config file for these two names, matching `loadConfig()`'s own overlay. */
  source: "env" | "config" | "none";
  siteUrl: string | null;
  projectId: string | null;
  environment: string;
  secretPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasToken: boolean;
  hasWriteToken: boolean;
  /** The selected read credential was refused; no broader credential is tried. */
  readTokenRefused: boolean;
  /** The same for the write token. */
  writeTokenRefused: boolean;
  refreshMinutes: number;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
  stale: boolean;
  pendingProviderReload: boolean;
  vaultCount: number;
  vaultNames: string[];
  appliedCount: number;
  appliedFields: string[];
  /** Tunable knobs the vault holds (`server/knob-map.ts`): how many, and
   * which mapped knob ids the last resolution applied.  Values never ride
   * here for credentials; knob values are already visible in Settings, so
   * only ids and counts leave this module either way. */
  knobCount: number;
  appliedKnobs: string[];
  unusedVaultNames: string[];
  readSources: Array<{ name: string; projectId: string; environment: string; secretPath: string; hasReadToken: boolean; hasWriteToken: boolean; tokenFile: string; tokenEnv: string; writeTokenFile: string; writeTokenEnv: string; ok: boolean; error: string | null }>;
}

/** Every Infisical name this process will ever apply, built once from the
 * same tables `secret-map.ts` and `knob-map.ts` use — so the three modules
 * can never disagree about what "mapped" means. */
const MAPPED_INFISICAL_NAMES: ReadonlySet<string> = new Set([
  ...SECRET_FIELDS.map((spec) => spec.infisicalName),
  ...KNOB_INFISICAL_NAMES,
]);

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_BOOT_CAP_MS = 25_000;
const DEFAULT_REFRESH_MINUTES = 15;

/** Per-HTTP-call timeout.  Overridable for the same reason the boot cap is:
 * a test that wants to prove `preload()` never hangs on an unreachable store
 * should not also have to wait out a real multi-second network timeout to
 * see it. */
function callTimeoutMs(): number {
  const raw = Number(process.env.OMB_INFISICAL_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
}

/** What an uninstalled manager reports: nothing configured, nothing running.
 * Used whenever `configure()` has not been called yet, or its getter throws —
 * a status view must never crash the route that asks for one. */
const UNSET_SETTINGS: InfisicalSettings = {
  authMethod: "service-token",
  enabled: false,
  writeThrough: false,
  siteUrl: "",
  projectId: "",
  environment: "",
  secretPath: "/",
  clientId: "",
  clientSecret: "",
  token: "",
  writeToken: "",
  readSources: [],
  refreshMinutes: DEFAULT_REFRESH_MINUTES,
};

function bootCapMs(): number {
  const raw = Number(process.env.OMB_INFISICAL_BOOT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BOOT_CAP_MS;
}

/** Only the explicitly selected auth method can configure the primary vault. */
function isConfigured(settings: InfisicalSettings): boolean {
  if (!settings.projectId.trim()) return false;
  if (settings.authMethod === "machine-identity") return hasMachineIdentity(settings);
  const source = settings.readSources.find((entry) => scopeSignature(entry.projectId, entry.environment, normalizeInfisicalSecretPath(entry.secretPath)) === vaultScope(settings));
  return source ? Boolean(source.tokenFile || source.tokenEnv) : Boolean(settings.token.trim());
}

/** The HTTP statuses that mean the BEARER itself was refused.  401 is a
 * revoked or expired token, 403 is a grant that does not cover what was
 * asked for, 404 is a project, environment or path that is gone.  Every
 * other status -- 429, any 5xx, a timeout, a dropped connection -- is a
 * transient condition and says nothing about whether the token is still
 * good.  A transient condition must therefore never cost the token:  the
 * vault stays configured and the next refresh tries the same token again. */
const DEFINITIVE_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** The HTTP status the server answered with, or `undefined` when the call
 * never got one:  a transport failure, a timeout, a dropped connection.
 * Only an `InfisicalError` carries a status, and anything else is a
 * transport failure and counts as transient.  The unknown value a catch
 * block hands over is decoded here, at the boundary where it arrives, so
 * everything downstream works with a number instead of an unparsed value. */
function rejectionStatus(cause: unknown): number | undefined {
  return cause instanceof InfisicalError ? cause.statusCode : undefined;
}

/** Whether a status the server actually returned is a definitive refusal:
 * the bearer was refused outright. */
function isDefinitiveRejection(status: number): boolean {
  return DEFINITIVE_REJECTION_STATUSES.has(status);
}

/** What a refusal is remembered under:  the project, environment and path
 * the call was made against.  Change one of them and the remembered
 * refusal no longer applies, because the answer it was based on was about
 * a different request. */
function scopeSignature(projectId: string, environment: string, secretPath: string): string {
  return [projectId.trim(), environment.trim(), secretPath.trim()].join("\u0000");
}

/** The scope of the whole vault:  the settings' project, environment and
 * path.  A refresh reads exactly this, so a refusal has to match it to
 * count against the configured token. */
function vaultScope(settings: InfisicalSettings): string {
  return scopeSignature(settings.projectId, settings.environment, normalizeInfisicalSecretPath(settings.secretPath));
}

/** The scope a refusal is remembered under when the CREDENTIAL itself was
 * rejected rather than the thing it was asked for.  A 401 says the bearer
 * is revoked or expired, and that is true of every request the bearer
 * makes, so the refusal applies everywhere the token goes.  A 403 (a grant
 * that does not cover what was asked for) and a 404 (a project,
 * environment or path that is gone) say something about ONE request, so
 * they are remembered against that request's scope and no other. */
const CREDENTIAL_REFUSAL_SCOPE = "*";

/** The scope a refusal of `status` is remembered under. */
function refusalScope(status: number, scope: string): string {
  return status === 401 ? CREDENTIAL_REFUSAL_SCOPE : scope;
}

/** Whether the explicitly selected machine identity has both bootstrap values. */
function hasMachineIdentity(settings: InfisicalSettings): boolean {
  return Boolean(settings.clientId.trim() && settings.clientSecret.trim());
}

/** What `preload()`'s race resolves to when the boot cap wins.  A distinct
 * sentinel rather than `undefined`, because "the cap fired" and "the refresh
 * came back with a status" have to be told apart: the first is a boot that
 * gave up waiting and must SAY so, and `undefined` cannot carry that. */
const BOOT_CAP_REACHED = Symbol("infisical.boot-cap-reached");

/** Resolves after `ms`, always — never rejects.  Unref'd so the common case
 * (the real refresh finishes first) does not keep the process alive waiting
 * for this to fire. */
function afterDelay(ms: number): Promise<typeof BOOT_CAP_REACHED> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(BOOT_CAP_REACHED), ms);
    timer.unref?.();
  });
}

/** Read directly off `process.env` rather than off the resolved settings:
 * by the time `loadConfig()` has handed a config object to
 * `infisicalSettings()`, its own env-over-file overlay has already picked a
 * winner, so this reproduces that same alias order to report which one it
 * was, rather than guessing from the resolved value. */
function identitySource(configured: boolean, settings: InfisicalSettings): "env" | "config" | "none" {
  if (!configured) return "none";
  if (settings.authMethod !== "machine-identity") {
    const source = settings.readSources.find((entry) => scopeSignature(entry.projectId, entry.environment, normalizeInfisicalSecretPath(entry.secretPath)) === vaultScope(settings));
    return source ? (source.tokenEnv ? "env" : "config") : ((process.env.INFISICAL_TOKEN ?? "").trim() ? "env" : "config");
  }
  const envClientId = (process.env.INFISICAL_CLIENT_ID || process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID || "").trim();
  const envClientSecret = (
    process.env.INFISICAL_CLIENT_SECRET || process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || ""
  ).trim();
  return envClientId && envClientSecret ? "env" : "config";
}

class InfisicalManager {
  private settingsGetter: (() => InfisicalSettings) | null = null;
  private onApplied: ((reason: RefreshReason) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The cadence `this.timer` was actually armed with, so `start()` can tell
   * a re-arm at a NEW interval from a no-op re-arm at the same one. */
  private timerMinutes: number | null = null;
  /** The refresh currently talking to Infisical, if any.  A second caller
   * never gets handed a stale snapshot and told it synced: Sync Now that
   * lands during a slow timer refresh has to report a read that started
   * after the click, not what the last one found. */
  private inFlightRefresh: Promise<InfisicalStatusView> | null = null;
  /** The one follow-up run queued behind `inFlightRefresh`.  Callers that
   * arrive while a read is in flight share it, so N overlapping callers cost
   * one extra round trip between them, never N. */
  private queuedRefresh: Promise<InfisicalStatusView> | null = null;

  private lastSyncAt: string | null = null;
  private lastAttemptAt: string | null = null;
  private lastSyncMs: number | null = null;
  private snapshotScope: string | null = null;
  private lastError: string | null = null;
  private stale = false;
  private pendingProviderReload = false;
  /** What `bootLineIfChanged()` last handed back a caller to print, with
   * `bootLine()`'s own trailing `ms=NNN` timing stripped — see that
   * method for why. */
  private lastLoggedBootLineSignature: string | null = null;
  /** The service tokens this manager has already seen refused, by mode.
   * The VALUE is remembered, not a flag:  a rotated token is a new value
   * from the same setting, and it has to be tried again rather than inherit
   * the old token's rejection.  The SCOPE it was refused under is
   * remembered with it, because a wrong project id answers 404 and looks
   * exactly like a revoked token:  fixing the project id in Settings has to
   * put the token back in play rather than leave it deprioritized forever.
   *
   * A refusal the operator can fix without touching the token -- a grant
   * widened, a path created, a vault restored -- changes neither the value
   * nor the scope, so the memory cannot notice it on its own.  The escape
   * hatch is `retryRefusedTokens()`, which the Sync Now and the Settings
   * save paths call:  an explicit ask for a retry is the operator saying
   * the thing I fixed, try it again. */
  private rejectedTokens = new Map<string, Array<{ token: string; scope: string }>>();
  private warnedReadSources = new Set<string>();
  private readSourceStatus = new Map<string, { ok: boolean; error: string | null }>();


  /** Live view of app config, installed by the server at boot.  A getter
   * (not a snapshot) so a Settings save takes effect on the next refresh
   * without a restart. */
  configure(getter: (() => InfisicalSettings) | null, onApplied: ((reason: RefreshReason) => void) | null = null): void {
    this.settingsGetter = getter;
    this.onApplied = onApplied ?? null;
    // A new settings source starts the "have we already printed this"
    // question over — mainly so repeated test setup does not inherit a
    // signature from a previous manager configuration.
    this.lastLoggedBootLineSignature = null;
    this.snapshotScope = null;
    // The same goes for the refused-token memory:  a new settings source is
    // a new credential, and it must be tried on its own merits rather than
    // inherit the previous source's rejection.
    this.rejectedTokens.clear();
    this.warnedReadSources.clear();
    this.readSourceStatus.clear();
  }

  /** Forget every remembered refusal, so the configured tokens are tried
   * again on the next call.  A Sync Now and a Settings save are the operator
   * asking for exactly that:  a grant widened, a path created or a vault
   * restored changes nothing about the token itself, so a token remembered
   * as refused would otherwise stay deprioritized until the process
   * restarted.  The background refreshes do not clear it, because a timer
   * tick must not re-probe a token the server has already refused. */
  retryRefusedTokens(): void {
    this.rejectedTokens.clear();
    this.warnedReadSources.clear();
  }

  private warnReadSource(source: ResolvedInfisicalReadSource, detail: string): void {
    const locator = source.tokenFile ? `token file ${source.tokenFile}` : source.tokenEnv ? `env ${source.tokenEnv}` : "no token file or env";
    const key = `${source.name}\u0000${locator}`;
    this.readSourceStatus.set(source.name, { ok: false, error: detail });
    if (this.warnedReadSources.has(key)) return;
    this.warnedReadSources.add(key);
    console.warn(`[infisical] read source "${source.name}" unavailable (${locator}): ${detail}`);
  }

  /** The failure a source read rejects with.  Names the source and its
   * token file or env name only — never a token value. */
  private readSourceFailure(source: ResolvedInfisicalReadSource, detail: string, statusCode = 502): InfisicalError {
    const locator = source.tokenFile ? `token file ${source.tokenFile}` : source.tokenEnv ? `env ${source.tokenEnv}` : "no token file or env";
    return new InfisicalError(`read source "${source.name}" unavailable (${locator}): ${detail}`, statusCode);
  }

  private async resolveSourceToken(source: ResolvedInfisicalReadSource): Promise<{ token: string } | { error: string }> {
    if (source.tokenFile) {
      // The file's contents become a bearer token sent to `siteUrl`, so
      // the path itself is part of the trust boundary: it must live in
      // the BotFleet config directory (where `config.json` lives), be a
      // real regular file, and be owner-only.  Any failure is a refusal,
      // never a warning-and-continue.
      const configDir = resolve(dataDir());
      const candidate = resolve(source.tokenFile);
      if (candidate !== configDir && !candidate.startsWith(`${configDir}${sep}`)) {
        return { error: `token file ${source.tokenFile} is outside the BotFleet config directory ${configDir}; refusing to read it` };
      }
      try {
        const st = await lstat(candidate);
        if (st.isSymbolicLink()) return { error: `token file ${source.tokenFile} is a symlink; refusing to read it` };
        if (!st.isFile()) return { error: `token file ${source.tokenFile} is not a regular file; refusing to read it` };
        if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
          return { error: `token file ${source.tokenFile} is readable or writable by group or other (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it` };
        }
        // A symlinked parent directory must not smuggle the file out of
        // the config directory the lexical check above approved.
        const realConfigDir = await realpath(configDir);
        const realCandidate = await realpath(candidate);
        if (realCandidate !== realConfigDir && !realCandidate.startsWith(`${realConfigDir}${sep}`)) {
          return { error: `token file ${source.tokenFile} is outside the BotFleet config directory ${configDir}; refusing to read it` };
        }
        // Read through a verified handle, not the path again: open
        // without following a symlink swapped in since the checks
        // above, then re-verify on the descriptor (the pattern
        // `electron/infisical-read.mjs` uses for its bootstrap token).
        let handle: FileHandle;
        try {
          handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        } catch (e) {
          if (e instanceof Error && "code" in e && e.code === "ELOOP") {
            return { error: `token file ${source.tokenFile} is a symlink; refusing to read it` };
          }
          throw e;
        }
        try {
          const handleStat = await handle.stat();
          if (!handleStat.isFile()) return { error: `token file ${source.tokenFile} is not a regular file; refusing to read it` };
          if (process.platform !== "win32" && (handleStat.mode & 0o077) !== 0) {
            return { error: `token file ${source.tokenFile} is readable or writable by group or other (mode ${(handleStat.mode & 0o777).toString(8)}); run chmod 600 on it` };
          }
          if (handleStat.dev !== st.dev || handleStat.ino !== st.ino) {
            return { error: `token file ${source.tokenFile} changed while it was read; refusing to read it` };
          }
          const token = (await handle.readFile("utf8")).trim();
          return token ? { token } : { error: "token file is empty" };
        } finally {
          await handle.close();
        }
      } catch (e) {
        const code = e instanceof Error && "code" in e && e.code ? String(e.code) : "error";
        return { error: `token file cannot be read (${code})` };
      }
    }
    if (source.tokenEnv) {
      const token = (process.env[source.tokenEnv] ?? "").trim();
      return token ? { token } : { error: `env ${source.tokenEnv} is empty or unset` };
    }
    return { error: "no tokenFile or tokenEnv configured" };
  }

  /** A folder grant is exact, including root; trailing slashes are normalized. */
  private sourceCovers(source: ResolvedInfisicalReadSource, requestedPath: string): boolean {
    const stored = normalizeInfisicalSecretPath(source.secretPath);
    const requested = normalizeInfisicalSecretPath(requestedPath);
    return requested === stored;
  }

  private findReadSource(settings: InfisicalSettings, projectId: string, environment: string, secretPath: string): ResolvedInfisicalReadSource | undefined {
    const requested = normalizeInfisicalSecretPath(secretPath);
    return (settings.readSources ?? [])
      .filter((src) => src.projectId === projectId && src.environment === environment && this.sourceCovers(src, requested))
      .sort((a, b) => normalizeInfisicalSecretPath(b.secretPath).length - normalizeInfisicalSecretPath(a.secretPath).length)[0];
  }

  private async readWithSource(settings: InfisicalSettings, source: ResolvedInfisicalReadSource, secretPath: string, projectId: string, environment: string): Promise<ReadonlyMap<string, string>> {
    if (settings.configurationError) throw new InfisicalError(settings.configurationError, 409);
    const resolved = await this.resolveSourceToken(source);
    if ("error" in resolved) {
      this.warnReadSource(source, resolved.error);
      throw this.readSourceFailure(source, resolved.error, 409);
    }
    const scope = scopeSignature(projectId, environment, secretPath);
    const mode = `source:${source.name}:read`;
    if (this.isRefused(mode, resolved.token, scope)) {
      this.warnReadSource(source, "token was refused by the server");
      throw this.readSourceFailure(source, "token was refused by the server", 401);
    }
    try {
      const { values } = await listSecrets({
        siteUrl: settings.siteUrl,
        token: resolved.token,
        projectId,
        environment,
        secretPath,
        viewValues: true,
        timeoutMs: callTimeoutMs(),
      });
      this.readSourceStatus.set(source.name, { ok: true, error: null });
      return new Map(values);
    } catch (err) {
      const status = rejectionStatus(err);
      if (status !== undefined && isDefinitiveRejection(status)) this.rememberRefusal(mode, resolved.token, refusalScope(status, scope));
      const raw = err instanceof Error ? err.message : "unknown error";
      const detail = redactSecretsInText(raw).split(resolved.token).join("[redacted]");
      this.warnReadSource(source, detail);
      throw this.readSourceFailure(source, detail, status ?? 502);
    }
  }

  async readSource(name: string, secretPath?: string): Promise<ReadonlyMap<string, string>> {
    const settings = this.settings();
    const source = (settings.readSources ?? []).find((src) => src.name === name);
    if (!source) {
      const key = `missing\u0000${name}`;
      if (!this.warnedReadSources.has(key)) {
        this.warnedReadSources.add(key);
        console.warn(`[infisical] read source "${name}" is not configured`);
      }
      throw new InfisicalError(`read source "${name}" is not configured`, 404);
    }
    if (settings.enabled !== true) {
      this.warnReadSource(source, "Infisical is turned off");
      throw this.readSourceFailure(source, "Infisical is turned off", 409);
    }
    const explicit = secretPath?.trim();
    if (!explicit) {
      return this.readWithSource(settings, source, normalizeInfisicalSecretPath(source.secretPath), source.projectId, source.environment);
    }
    const requested = normalizeInfisicalSecretPath(explicit);
    if (!this.sourceCovers(source, requested)) {
      const detail = `requested path ${requested} is not covered by the source's secretPath ${normalizeInfisicalSecretPath(source.secretPath)}`;
      this.warnReadSource(source, detail);
      throw this.readSourceFailure(source, detail, 403);
    }
    return this.readWithSource(settings, source, requested, source.projectId, source.environment);
  }

  private settings(): InfisicalSettings {
    try {
      return this.settingsGetter?.() ?? UNSET_SETTINGS;
    } catch {
      return UNSET_SETTINGS;
    }
  }

  /** Whether the configured token for this mode is one the server refused
   * for the CURRENT scope.  A scope change makes the old refusal about a
   * different request, so it no longer counts.  A refusal of the
   * credential itself (a 401) counts everywhere, because the bearer is
   * refused however it is used. */
  private refusedNow(settings: InfisicalSettings, mode: "read" | "write"): boolean {
    if (settings.authMethod === "machine-identity") return false;
    const configured = (mode === "write" ? settings.writeToken : settings.token).trim();
    if (!configured) return false;
    return this.isRefused(mode, configured, vaultScope(settings));
  }

  /** Whether a refusal is remembered for this token and this scope. */
  private isRefused(mode: string, token: string, scope: string): boolean {
    const remembered = this.rejectedTokens.get(mode) ?? [];
    return remembered.some(
      (entry) => entry.token === token && (entry.scope === CREDENTIAL_REFUSAL_SCOPE || entry.scope === scope),
    );
  }

  /** Remember a refusal for this token and scope.  The list stays short:
   * one entry per refused scope, and one entry is dropped once it grows
   * past the cap, so a long-lived install cannot accumulate them without
   * end. */
  private rememberRefusal(mode: string, token: string, scope: string): void {
    const remembered = this.rejectedTokens.get(mode) ?? [];
    if (!remembered.some((entry) => entry.token === token && entry.scope === scope)) {
      remembered.push({ token, scope });
    }
    while (remembered.length > 16) this.forgetOneRefusal(remembered);
    this.rejectedTokens.set(mode, remembered);
  }

  /** Drop one remembered refusal to make room under the cap.  A
   * credential-wide refusal -- a 401, remembered against every scope -- is
   * the one worth keeping:  it is what stops a revoked bearer from being
   * tried again, and evicting it would let a dead token look alive for one
   * more request.  A scope-scoped refusal -- a 403 or a 404 -- says only
   * that one request was refused, so it is the cheap one to lose.  The
   * oldest credential-wide entry goes only when there is no scoped one left
   * to drop, and the cap always holds either way. */
  private forgetOneRefusal(remembered: Array<{ token: string; scope: string }>): void {
    const scoped = remembered.findIndex((entry) => entry.scope !== CREDENTIAL_REFUSAL_SCOPE);
    if (scoped >= 0) {
      remembered.splice(scoped, 1);
      return;
    }
    remembered.shift();
  }

  /** Authenticate only when the operator explicitly selected machine identity. */
  private async machineIdentityToken(settings: InfisicalSettings): Promise<string> {
    return login({
      siteUrl: settings.siteUrl,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      timeoutMs: callTimeoutMs(),
    });
  }

  /** Select exactly one credential for the requested scope and operation.
   * Missing or refused service tokens never activate a machine identity. */
  private async withCredential<T>(
    settings: InfisicalSettings,
    mode: "read" | "write",
    call: (token: string) => Promise<T>,
    scope: string = vaultScope(settings),
  ): Promise<T> {
    if (settings.configurationError) throw new InfisicalError(settings.configurationError, 409);
    if (settings.authMethod === "machine-identity" && scope === vaultScope(settings)) {
      if (!hasMachineIdentity(settings)) {
        throw new InfisicalError("The selected Infisical machine identity is not configured.", 409);
      }
      return call(await this.machineIdentityToken(settings));
    }
    const source = (settings.readSources ?? []).find((entry) =>
      scopeSignature(entry.projectId, entry.environment, normalizeInfisicalSecretPath(entry.secretPath)) === scope);
    let configured: string;
    const refusalMode = source ? `source:${source.name}:${mode}` : mode;
    if (source) {
      const locator = mode === "write" ? { ...source, tokenFile: source.writeTokenFile ?? "", tokenEnv: source.writeTokenEnv ?? "" } : source;
      const resolved = await this.resolveSourceToken(locator);
      if ("error" in resolved) {
        this.warnReadSource(source, resolved.error);
        throw this.readSourceFailure(source, `${mode}: ${resolved.error}`, 409);
      }
      configured = resolved.token;
    } else {
      if (scope !== vaultScope(settings) || settings.authMethod === "machine-identity") {
        throw new InfisicalError("No dedicated Infisical credential is configured for this exact project, environment and folder.", 403);
      }
      configured = (mode === "write" ? settings.writeToken : settings.token).trim();
    }
    if (!configured) throw new InfisicalError(`No Infisical ${mode} service token is configured for this exact scope.`, 409);
    if (this.isRefused(refusalMode, configured, scope)) {
      throw new InfisicalError(`The configured Infisical ${mode} service token was refused by the server; replace it or retry after correcting its scope.`, 401);
    }
    try {
      const result = await call(configured);
      if (source) this.readSourceStatus.set(source.name, { ok: true, error: null });
      return result;
    } catch (err) {
      const status = rejectionStatus(err);
      if (status !== undefined && isDefinitiveRejection(status)) this.rememberRefusal(refusalMode, configured, refusalScope(status, scope));
      if (source) this.warnReadSource(source, `Infisical ${mode} failed (${status ?? 502})`);
      if (err instanceof Error && err.message.includes(configured)) {
        throw new InfisicalError(err.message.split(configured).join("[redacted]"), status ?? 502, err instanceof InfisicalError && err.writeLanded);
      }
      throw err;
    }
  }

  /** Set by the harness when a timer-triggered refresh changed a
   * fleet-reloading credential: the new value is already live in `cfg`, but
   * nothing has rebuilt the fleet on it yet.  The harness clears it once
   * Sync Now or a Settings save actually reloads providers.  Not part of the
   * shared contract's method list — an addition `server/index.ts` needs to
   * carry this bit, since only it knows what "reload providers" means. */
  setPendingProviderReload(value: boolean): void {
    this.pendingProviderReload = value;
  }

  /** Boot, Sync Now, a Settings save and the timer all funnel through here.
   * Unconfigured or turned off: no request is made, and the snapshot is
   * cleared so resolution falls straight back to env and file.  Otherwise:
   * fresh login, one secrets list, publish the snapshot.  A failure of any
   * kind leaves the previous snapshot exactly as it was — a network blip
   * must never swap credentials out from under a running fleet — and marks
   * the result stale instead. */
  async refresh(reason: RefreshReason): Promise<InfisicalStatusView> {
    const settings = this.settings();
    this.lastAttemptAt = new Date().toISOString();
    const configured = isConfigured(settings);

    if (settings.enabled && settings.configurationError) {
      setInfisicalSnapshot(null, []);
      this.lastError = settings.configurationError;
      this.stale = true;
      return this.getStatus();
    }

    if (!configured || settings.enabled !== true) {
      setInfisicalSnapshot(null, []);
      this.lastError = null;
      this.stale = false;
      return this.getStatus();
    }

    // Queue a fresh run BEHIND the one in flight rather than joining it.
    //
    // Two reasons this cannot be a plain coalesce.  Returning the PREVIOUS
    // snapshot would answer 200 with an untouched `lastSyncAt` — a timer
    // refresh holds the manager for two HTTP calls (up to 16 s on the default
    // budget) and `preload()`'s losing refresh can still be running well
    // after boot, so a Sync Now landing in either window read to the operator
    // as a broken button.  But handing that caller the in-flight run is
    // wrong in a worse way: that run listed the store BEFORE this caller had
    // a reason to ask.  `writeSecret()` is the sharp case — it upserts and
    // then refreshes, and an in-flight read started a moment earlier still
    // carries the pre-write value, so the save would tombstone the local copy
    // and apply the old vault snapshot on top of it, reporting success.
    // Changing the project or the identity mid-read has the same shape.
    //
    // So a caller that arrives mid-read waits for that read to finish and
    // then gets its own, which is the first read that can possibly reflect
    // what it just did.  One follow-up is enough for any number of them:
    // they all share it, and it starts after every write that preceded it.
    if (this.inFlightRefresh) {
      if (!this.queuedRefresh) {
        const queued: Promise<InfisicalStatusView> = this.inFlightRefresh
          // Never rejects, so a failed read in front cannot poison the
          // follow-up — `runRefresh` records the failure and resolves.
          .catch(() => undefined)
          .then(() => {
            if (this.queuedRefresh === queued) this.queuedRefresh = null;
            return this.startRefresh(reason);
          });
        this.queuedRefresh = queued;
      }
      return this.queuedRefresh;
    }
    return this.startRefresh(reason);
  }

  /** Start a run and publish it as the one in flight.  Split out so the
   * queued follow-up above installs itself the same way the first caller
   * does, and so the slot is only ever cleared by the run that owns it. */
  private startRefresh(reason: RefreshReason): Promise<InfisicalStatusView> {
    const tracked: Promise<InfisicalStatusView> = this.runRefresh(reason).finally(() => {
      if (this.inFlightRefresh === tracked) this.inFlightRefresh = null;
    });
    this.inFlightRefresh = tracked;
    return tracked;
  }

  /** The actual login-and-list, with `refresh()` owning the single-flight
   * guard around it.  Never rejects: a failure keeps the previous snapshot,
   * records a redacted reason and marks the result stale. */
  private async runRefresh(reason: RefreshReason): Promise<InfisicalStatusView> {
    const settings = this.settings();
    const snapshotScope = `${settings.siteUrl}\u0000${vaultScope(settings)}`;
    if (this.snapshotScope !== null && this.snapshotScope !== snapshotScope) {
      setInfisicalSnapshot(null, []);
      this.lastSyncAt = null;
      this.snapshotScope = null;
    }
    const start = Date.now();
    try {
      const { names, values } = await this.withCredential(settings, "read", (token) =>
        listSecrets({
          siteUrl: settings.siteUrl,
          token,
          projectId: settings.projectId,
          environment: settings.environment,
          secretPath: settings.secretPath,
          viewValues: true,
          timeoutMs: callTimeoutMs(),
        }),
      );
      const current = this.settings();
      if (!current.enabled || !isConfigured(current)) {
        setInfisicalSnapshot(null, []);
        this.snapshotScope = null;
        this.lastSyncAt = null;
        this.lastError = null;
        this.stale = false;
        return this.getStatus();
      }
      if (`${current.siteUrl}\u0000${vaultScope(current)}` !== snapshotScope) {
        setInfisicalSnapshot(null, []);
        this.snapshotScope = null;
        this.lastSyncAt = null;
        throw new InfisicalError("Infisical connection changed during refresh; the previous scope's response was discarded.", 409);
      }
      setInfisicalSnapshot(values, names);
      this.snapshotScope = snapshotScope;
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncMs = Date.now() - start;
      this.lastError = null;
      this.stale = false;
      // Only the reasons NOBODY is already following up on.  `manual` and
      // `settings` come from callers that run `applyResolvedSecrets`
      // themselves the moment this resolves, so firing here as well starts a
      // second, unawaited apply — and on the write-through path that apply
      // rebuilds the whole fleet from inside a PATCH handler that is still
      // executing, killing in-flight turns before the save has even landed.
      if (reason === "boot" || reason === "timer") this.onApplied?.(reason);
    } catch (err) {
      this.lastError = err instanceof InfisicalError ? err.message : err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      this.stale = true;
    }
    return this.getStatus();
  }

  /** Bounded so boot can never hang on a slow or unreachable store: whichever
   * settles first between the real refresh and the cap wins the race.  The
   * refresh itself keeps running in the background either way — a slow
   * success still lands and updates the snapshot, it is just not what boot
   * waited for. Always resolves.
   *
   * When the cap wins, the in-flight refresh has stamped `lastAttemptAt` and
   * nothing else: no error, not stale, `vaultCount: 0`.  Reporting that
   * verbatim makes `bootLine()` print the SUCCESS form (`enabled … vault=0
   * applied=0 ms=0`) for a boot that never finished syncing, and the card
   * read `Connected`.  The per-call budget is 8 s against a 12 s cap, so any
   * run where login succeeds and the list is slow lands here — this is the
   * normal shape of a slow-network boot, not a corner case.  Say so instead. */
  async preload(): Promise<InfisicalStatusView> {
    const cap = bootCapMs();
    const settings = this.settings();
    const result = await Promise.race([this.refresh("boot"), afterDelay(cap)]);
    if (result !== BOOT_CAP_REACHED) return result;
    if (isConfigured(settings) && settings.enabled === true) {
      this.lastError = `boot sync exceeded ${cap} ms; still running in the background`;
      this.stale = true;
    }
    return this.getStatus();
  }

  /** Idempotent over an UNCHANGED cadence, re-arming over a changed one.
   * `refreshMinutes` is read when the interval is created, so a Settings save
   * that narrows it from 15 to 5 used to leave the old interval running while
   * both the status route and the card echoed the new number — a rotation
   * landing up to three times later than the UI promised. */
  start(): void {
    const minutes = Math.max(5, this.settings().refreshMinutes || DEFAULT_REFRESH_MINUTES);
    if (this.timer && this.timerMinutes === minutes) return;
    this.stop();
    this.timerMinutes = minutes;
    this.timer = setInterval(() => {
      void this.refresh("timer");
    }, minutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerMinutes = null;
  }

  getStatus(): InfisicalStatusView {
    const settings = this.settings();
    const configured = isConfigured(settings);
    const names = snapshotVaultNames();
    const snap = infisicalSnapshot();
    const appliedFields = snap
      ? SECRET_FIELDS.filter((spec) => (snap.get(spec.infisicalName) ?? "").length > 0).map((spec) => spec.id)
      : [];
    const appliedKnobs = KNOB_FIELDS.filter((spec) => knobSource(spec.id) === "infisical").map((spec) => spec.id);
    const unusedVaultNames = names.filter((name) => !MAPPED_INFISICAL_NAMES.has(name));

    return {
      authMethod: settings.authMethod ?? "service-token",
      configured,
      enabled: configured && settings.enabled === true,
      enabledSetting: settings.enabled === true,
      writeThrough: settings.writeThrough === true,
      source: identitySource(configured, settings),
      siteUrl: settings.siteUrl,
      projectId: settings.projectId,
      environment: settings.environment || "prod",
      secretPath: settings.secretPath || "/",
      hasClientId: Boolean(settings.clientId.trim()),
      hasClientSecret: Boolean(settings.clientSecret.trim()),
      hasToken: Boolean(settings.token.trim()),
      hasWriteToken: Boolean(settings.writeToken.trim()),
      readTokenRefused: this.refusedNow(settings, "read"),
      writeTokenRefused: this.refusedNow(settings, "write"),
      refreshMinutes: settings.refreshMinutes,
      lastSyncAt: this.lastSyncAt,
      lastAttemptAt: this.lastAttemptAt,
      lastSyncMs: this.lastSyncMs,
      lastError: this.lastError,
      stale: this.stale,
      pendingProviderReload: this.pendingProviderReload,
      vaultCount: names.length,
      vaultNames: [...names],
      appliedCount: appliedFields.length,
      appliedFields,
      knobCount: names.filter((name) => KNOB_INFISICAL_NAMES.has(name)).length,
      appliedKnobs,
      unusedVaultNames,
      readSources: (settings.readSources ?? []).map((src) => ({
        name: src.name,
        projectId: src.projectId,
        environment: src.environment,
        secretPath: src.secretPath,
        hasReadToken: Boolean(src.tokenFile || src.tokenEnv),
        hasWriteToken: Boolean(src.writeTokenFile || src.writeTokenEnv),
        tokenFile: src.tokenFile,
        tokenEnv: src.tokenEnv,
        writeTokenFile: src.writeTokenFile ?? "",
        writeTokenEnv: src.writeTokenEnv ?? "",
        ok: this.readSourceStatus.get(src.name)?.ok ?? false,
        error: this.readSourceStatus.get(src.name)?.error ?? null,
      })),
    };
  }

  /** Settings → Test Connection.  Never touches the snapshot: proving the
   * identity works must not change what any bot resolves to mid-session. */
  async probe(): Promise<{ ok: boolean; error: string | null; secretCount: number; names: string[] }> {
    const settings = this.settings();
    if (!settings.enabled) return { ok: false, error: "Infisical is turned off.", secretCount: 0, names: [] };
    if (settings.configurationError) return { ok: false, error: settings.configurationError, secretCount: 0, names: [] };
    if (!isConfigured(settings)) {
      return { ok: false, error: "Add a project id and a service token (or a machine identity) first.", secretCount: 0, names: [] };
    }
    // An explicit probe retries the selected credential without changing auth method.
    const configured = settings.token.trim();
    this.retryRefusedTokens();
    try {
      const { names } = await this.withCredential(settings, "read", (token) => listSecrets({
        siteUrl: settings.siteUrl,
        token,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        viewValues: false,
        timeoutMs: callTimeoutMs(),
      }));
      return { ok: true, error: null, secretCount: names.length, names: [...names] };
    } catch (err) {
      let error = err instanceof InfisicalError ? err.message : err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      const status = rejectionStatus(err);
      if (configured && status !== undefined && isDefinitiveRejection(status)) {
        error = `The configured read service token was refused by the server:  ${error}.  Save a rotated token in Settings and the next refresh will use it.`;
      }
      return { ok: false, error, secretCount: 0, names: [] };
    }
  }

  /** Read a single exact scope without publishing its values to app config.
   * A secondary scope requires a dedicated source; primary credentials never
   * authorize another project, environment or folder. */
  async readPath(
    secretPath: string,
    scope: { projectId?: string; environment?: string } = {},
  ): Promise<ReadonlyMap<string, string>> {
    const settings = this.settings();
    const projectId = scope.projectId?.trim() || settings.projectId;
    const environment = scope.environment?.trim() || settings.environment;
    secretPath = normalizeInfisicalSecretPath(secretPath);
    const primaryIdentity = settings.authMethod === "machine-identity" && scopeSignature(projectId, environment, secretPath) === vaultScope(settings);
    const source = settings.enabled === true && !primaryIdentity ? this.findReadSource(settings, projectId, environment, secretPath) : undefined;
    if (source) return this.readWithSource(settings, source, secretPath, projectId, environment);
    if (!isConfigured(settings) || settings.enabled !== true) {
      throw new InfisicalError("Infisical is not configured and turned on for this workspace.", 409);
    }
    const { values } = await this.withCredential(
      settings,
      "read",
      (token) =>
        listSecrets({
          siteUrl: settings.siteUrl,
          token,
          projectId,
          environment,
          secretPath,
          viewValues: true,
          timeoutMs: callTimeoutMs(),
        }),
      scopeSignature(projectId, environment, secretPath),
    );
    return new Map(values);
  }

  /** Resolve a named project locator, then require its dedicated scoped source. */
  async readProjectPath(project: VaultProject, secretPath: string): Promise<ReadonlyMap<string, string>> {
    if (project === "botfleet") return this.readPath(secretPath);
    const projectId = fleetOpsProjectId();
    if (!projectId) {
      throw new InfisicalError(
        "The fleet's Infisical project is not configured on this host: set INFISICAL_FLEET_OPS_PROJECT_ID.",
        409,
      );
    }
    return this.readPath(secretPath, { projectId, environment: FLEET_OPS_ENVIRONMENT });
  }

  /** Write through one explicitly scoped source without borrowing a read
   * credential or publishing a secondary project's values as app config. */
  async writeSource(sourceName: string, name: string, value: string): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled || !settings.writeThrough) throw new InfisicalError("Infisical write-through is turned off.", 409);
    if (!value) throw new InfisicalError("Clearing an Infisical-managed value is not supported.", 409);
    const source = settings.readSources.find((entry) => entry.name === sourceName);
    if (!source) throw new InfisicalError("The named Infisical source is not configured.", 404);
    // Resolve the named source itself, even if another entry names the same scope.
    const scoped = { ...settings, authMethod: "service-token" as const, readSources: [source] };
    await this.withCredential(scoped, "write", (token) => upsertSecret({
      siteUrl: settings.siteUrl, token, projectId: source.projectId,
      environment: source.environment, secretPath: normalizeInfisicalSecretPath(source.secretPath),
      name, value, timeoutMs: callTimeoutMs(),
    }), scopeSignature(source.projectId, source.environment, normalizeInfisicalSecretPath(source.secretPath)));
    if (scopeSignature(source.projectId, source.environment, normalizeInfisicalSecretPath(source.secretPath)) === vaultScope(settings)) {
      const result = await this.refresh("settings");
      if (result.stale || result.lastError) throw new InfisicalError("Infisical write landed, but verification failed.", 502, true);
      if (infisicalSnapshot()?.get(name) !== value) throw new InfisicalError("Infisical write landed, but the vault holds a different value.", 409, true);
    }
  }

  /** A Settings save of a value the vault manages, with Write Through on.
   * Refuses with a 409 before any request is made when write-through is off
   * or the caller is trying to clear a managed value — both are policy
   * refusals the harness reports the same way it reports the refusal gate
   * itself.  Any other failure is the underlying `InfisicalError` from the
   * HTTP calls, which the harness turns into a 502.  On success, refreshes
   * so the just-written value is what the next resolution sees. */
  async writeSecret(name: string, value: string): Promise<void> {
    const settings = this.settings();
    if (settings.writeThrough !== true) {
      throw new InfisicalError("Write Through to Infisical is turned off.", 409);
    }
    if (!value) {
      // NBSP + space, not two ASCII spaces: this message is rendered inline
      // in a plain <div> by every card that can hit it, and HTML collapses a
      // run of ordinary whitespace to one visible space.
      throw new InfisicalError("Clearing a value managed by Infisical is not supported.\u00A0 Remove it in Infisical.", 409);
    }
    if (!isConfigured(settings)) {
      throw new InfisicalError("Add a project id and a service token (or a machine identity) first.", 409);
    }
    try {
      await this.withCredential(settings, "write", (token) =>
        upsertSecret({
          siteUrl: settings.siteUrl,
          token,
          projectId: settings.projectId,
          environment: settings.environment,
          secretPath: settings.secretPath,
          name,
          value,
          timeoutMs: callTimeoutMs(),
        }),
      );
    } catch (err) {
      // When a timeout or network drop occurs during upsert, the write may
      // have already committed in Infisical before the connection severed.
      // Reconcile by running a refresh to check if the vault holds the value.
      if (err instanceof InfisicalError && (err.statusCode === 504 || err.statusCode === 502)) {
        const check = await this.refresh("settings").catch(() => null);
        if (check && !check.stale && !check.lastError) {
          const current = infisicalSnapshot();
          if (current && current.get(name) === value) {
            return;
          }
        }
      }
      throw err;
    }

    const refreshed = await this.refresh("settings");
    if (refreshed.lastError || refreshed.stale) {
      // Upsert landed in Infisical, but verification refresh failed.
      // Do not overwrite the in-memory snapshot with unverified values:
      // any valid snapshot published by a preceding or concurrent refresh
      // must be preserved. Throw writeLanded InfisicalError so callers know
      // the write reached the vault while verification failed.
      throw new InfisicalError(
        `Secret "${name}" was updated in Infisical, but verification refresh failed: ${refreshed.lastError ?? "vault snapshot was not updated"}`,
        502,
        true,
      );
    }

    const snapshot = infisicalSnapshot();
    if (!snapshot || snapshot.get(name) !== value) {
      // Verification succeeded but the returned canonical snapshot has a
      // different value (e.g. concurrent rotation). Preserve the fetched
      // canonical snapshot and report conflict.
      throw new InfisicalError(
        `Secret "${name}" was updated in Infisical, but vault contains a different value.`,
        409,
        true,
      );
    }
  }

  /** Names, field ids and counts only — see the module header.  The fifth
   * "credentials changed" form is not rendered here: it names the fields a
   * timer refresh changed, which only `server/index.ts`'s
   * `applyResolvedSecrets` knows, so that line is logged there instead. */
  bootLine(): string {
    const status = this.getStatus();
    if (!status.configured) {
      return "[infisical] disabled: not configured (select an auth method and add its credentials in Settings > Secrets)";
    }
    if (!status.enabled) {
      return "[infisical] disabled by settings";
    }
    // A refused token is a fact about the credential, not about the sync.
    // It is worked out BEFORE the error branch, because the case that
    // matters most -- a refused token with no machine identity to fall back
    // to -- IS an error case, and the line that reports the error has to
    // name the refusal as well or the operator cannot tell a revoked token
    // from a broken vault.
    const refused = [
      status.readTokenRefused ? "read-token-refused" : "",
      status.writeTokenRefused ? "write-token-refused" : "",
    ].filter(Boolean).join(",");
    const refusedPart = refused ? ` ${refused}` : "";
    if (status.lastError) {
      return `[infisical] unavailable: ${status.lastError}; using environment and config values${refusedPart}`;
    }
    const fields = status.appliedFields.join(",");
    const sourcesPart = status.readSources.length ? ` sources=${status.readSources.map((s) => `${s.name}:${s.ok ? "ok" : s.error ? "error" : "unknown"}`).join(",")}` : "";
    return `[infisical] enabled env=${status.environment} path=${status.secretPath} vault=${status.vaultCount} applied=${status.appliedCount} fields=${fields} unused=${status.unusedVaultNames.length}${refusedPart}${sourcesPart} ms=${status.lastSyncMs ?? 0}`;
  }

  /** `bootLine()`'s text, or `null` when it is unchanged from the last time
   * THIS method was called (OP11).  `server/index.ts` prints unconditionally
   * at boot and used to print again on every Settings PATCH that carried an
   * `infisical` block, even one that changed nothing — on this Mac, which
   * has no machine identity configured, that meant "disabled: not
   * configured" on every unrelated settings save.  Both call sites route
   * through here so there is one source of truth for "did this change".
   *
   * The comparison strips `bootLine()`'s own trailing `ms=NNN`: that field
   * is a fresh sync's timing, not part of the configuration, and changes on
   * every successful refresh even when nothing else did — comparing the
   * raw string would make this never dedupe at all. */
  bootLineIfChanged(): string | null {
    const line = this.bootLine();
    const signature = line.replace(/ ms=\d+$/, "");
    if (signature === this.lastLoggedBootLineSignature) return null;
    this.lastLoggedBootLineSignature = signature;
    return line;
  }
}

export const infisical = new InfisicalManager();
