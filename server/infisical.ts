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
import type { InfisicalSettings } from "./config.ts";
import { InfisicalError, login, listSecrets, upsertSecret } from "./infisical-client.ts";
import { redactSecretsInText } from "./redact.ts";
import { SECRET_FIELDS, infisicalSnapshot, setInfisicalSnapshot, vaultNames as snapshotVaultNames } from "./secret-map.ts";

export type RefreshReason = "boot" | "timer" | "settings" | "manual";

/** Everything the loopback status route and the Secrets card read.  Values
 * never ride here — only the site URL, the project id, the environment, the
 * path, names, field ids and counts. */
export interface InfisicalStatusView {
  configured: boolean;
  enabled: boolean;
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
  unusedVaultNames: string[];
}

/** Every Infisical name this process will ever apply, built once from the
 * same table `secret-map.ts` uses — so the two modules can never disagree
 * about what "mapped" means. */
const MAPPED_INFISICAL_NAMES: ReadonlySet<string> = new Set(SECRET_FIELDS.map((spec) => spec.infisicalName));

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
  enabled: false,
  writeThrough: false,
  siteUrl: "",
  projectId: "",
  environment: "",
  secretPath: "/",
  clientId: "",
  clientSecret: "",
  refreshMinutes: DEFAULT_REFRESH_MINUTES,
};

function bootCapMs(): number {
  const raw = Number(process.env.OMB_INFISICAL_BOOT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BOOT_CAP_MS;
}

/** All three parts are required: a project with no identity cannot be read,
 * and an identity with no project has nothing to read.  Mirrors
 * `config.ts`'s `infisicalConfigured`, restated over a resolved
 * `InfisicalSettings` rather than a raw `AppConfig` so this module never
 * needs to import the config shape as a value. */
function isConfigured(settings: InfisicalSettings): boolean {
  return Boolean(settings.projectId.trim() && settings.clientId.trim() && settings.clientSecret.trim());
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
function identitySource(configured: boolean): "env" | "config" | "none" {
  if (!configured) return "none";
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
  private lastError: string | null = null;
  private stale = false;
  private pendingProviderReload = false;
  /** What `bootLineIfChanged()` last handed back a caller to print, with
   * `bootLine()`'s own trailing `ms=NNN` timing stripped — see that
   * method for why. */
  private lastLoggedBootLineSignature: string | null = null;

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
  }

  private settings(): InfisicalSettings {
    try {
      return this.settingsGetter?.() ?? UNSET_SETTINGS;
    } catch {
      return UNSET_SETTINGS;
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
    const start = Date.now();
    try {
      const token = await login({
        siteUrl: settings.siteUrl,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        timeoutMs: callTimeoutMs(),
      });
      const { names, values } = await listSecrets({
        siteUrl: settings.siteUrl,
        token,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        viewValues: true,
        timeoutMs: callTimeoutMs(),
      });
      setInfisicalSnapshot(values, names);
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
    const unusedVaultNames = names.filter((name) => !MAPPED_INFISICAL_NAMES.has(name));

    return {
      configured,
      enabled: configured && settings.enabled === true,
      writeThrough: settings.writeThrough === true,
      source: identitySource(configured),
      siteUrl: configured ? settings.siteUrl : null,
      projectId: configured ? settings.projectId : null,
      environment: settings.environment || "prod",
      secretPath: settings.secretPath || "/",
      hasClientId: Boolean(settings.clientId.trim()),
      hasClientSecret: Boolean(settings.clientSecret.trim()),
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
      unusedVaultNames,
    };
  }

  /** Settings → Test Connection.  Never touches the snapshot: proving the
   * identity works must not change what any bot resolves to mid-session. */
  async probe(): Promise<{ ok: boolean; error: string | null; secretCount: number; names: string[] }> {
    const settings = this.settings();
    if (!isConfigured(settings)) {
      return { ok: false, error: "Add a project id and machine identity first.", secretCount: 0, names: [] };
    }
    try {
      const token = await login({
        siteUrl: settings.siteUrl,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        timeoutMs: callTimeoutMs(),
      });
      const { names } = await listSecrets({
        siteUrl: settings.siteUrl,
        token,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        viewValues: false,
        timeoutMs: callTimeoutMs(),
      });
      return { ok: true, error: null, secretCount: names.length, names: [...names] };
    } catch (err) {
      const error = err instanceof InfisicalError ? err.message : err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      return { ok: false, error, secretCount: 0, names: [] };
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
      throw new InfisicalError("Add a project id and machine identity first.", 409);
    }
    const token = await login({
      siteUrl: settings.siteUrl,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      timeoutMs: callTimeoutMs(),
    });
    try {
      await upsertSecret({
        siteUrl: settings.siteUrl,
        token,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        name,
        value,
        timeoutMs: callTimeoutMs(),
      });
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
      return "[infisical] disabled: not configured (add a machine identity in Settings > Secrets)";
    }
    if (!status.enabled) {
      return "[infisical] disabled by settings";
    }
    if (status.lastError) {
      return `[infisical] unavailable: ${status.lastError}; using environment and config values`;
    }
    const fields = status.appliedFields.join(",");
    return `[infisical] enabled env=${status.environment} path=${status.secretPath} vault=${status.vaultCount} applied=${status.appliedCount} fields=${fields} unused=${status.unusedVaultNames.length} ms=${status.lastSyncMs ?? 0}`;
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
