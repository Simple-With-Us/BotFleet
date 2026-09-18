// Error and performance reporting, resolved once and served to everything
// else that needs it.  The harness owns the answer: the DSN comes from the
// environment or ~/.botfleet/config.json, the Sentry runtime is
// reconfigured live when either changes, and the desktop renderer asks this
// module for the DSN instead of carrying a build-time copy.
//
// Two rules hold everywhere in here.  The kill switch is explicit — a DSN
// with no `enabled` flag reports, and only a stored `false` stops it, so
// nothing ever goes quiet without saying why.  And the public key half of a
// DSN never reaches a log line, a status field, or a broadcast frame; only
// the ingest host and the project id do.
import { observabilitySettings, type ObservabilitySettings } from "./config.ts";
import { secretSource } from "./secret-map.ts";
import {
  applySentryConfig,
  describeDsn,
  getSentry,
  isSentryActive,
  MALFORMED_DSN_MESSAGE,
  sentryDsnFromEnv,
  sentryRuntimeState,
  type SentryRuntimeInput,
  type SentrySource,
} from "./sentry.ts";

export interface ObservabilityStatusView {
  /** Reporting is actually meant to be happening: a DSN is stored and the
   * kill switch is on.  The Settings pill reads straight off this. */
  enabled: boolean;
  /** The stored switch before DSN/configuration validity is folded in. */
  requestedEnabled: boolean;
  configured: boolean;
  /** `"infisical"` is the fourth answer the Sentry lane never had: the
   * secret store holds the DSN, so neither the environment nor this
   * computer decided it.  The other three keep their meanings. */
  source: SentrySource | "infisical";
  host: string | null;
  projectId: string | null;
  environment: string;
  tracesSampleRate: number;
  logsEnabled: boolean;
  profilingAvailable: boolean;
  totalCaptured: number;
  lastEventAt: string | null;
  lastError: string | null;
}

class ObservabilityManager {
  private totalCaptured = 0;
  private lastEventAt: string | null = null;

  /** Live view of app config, installed by the server at boot.  A getter,
   * not a snapshot, so a settings change takes effect without a restart. */
  private settingsProvider: (() => ObservabilitySettings | undefined) | null = null;

  configure(getter: (() => ObservabilitySettings | undefined) | null): void {
    this.settingsProvider = getter;
  }

  private settings(): ObservabilitySettings {
    try {
      return this.settingsProvider?.() ?? observabilitySettings({});
    } catch {
      return observabilitySettings({});
    }
  }

  /** True when the secret store is what put the stored DSN there.
   *
   * `sentryDsn` is the one mapped field this module resolves env-first, so
   * without this an environment DSN would beat a rotated stored value forever
   * and the card would call a stored DSN "Settings". */
  private dsnFromVault(): boolean {
    return secretSource("observability.sentryDsn") === "infisical";
  }

  /** The secret store, then env, then config, then nothing.  Env wins over
   * the config file so a CI runner or the LaunchAgent can pin a DSN; Settings
   * then shows "Environment" as the source and disables the field rather than
   * pretending it is editable.  The store outranks both for the one name it
   * can hold, because a rotated value there is the whole point of putting it
   * there. */
  private resolve(): SentryRuntimeInput {
    const settings = this.settings();
    const envDsn = sentryDsnFromEnv();
    const fromVault = this.dsnFromVault();
    const dsn = fromVault ? settings.dsn : (envDsn ?? settings.dsn);
    // The SDK only ever sees the three original sources; a vault DSN travels
    // as "config" because that is where `loadConfig()` put it.  `getStatus()`
    // is where the operator-facing fourth answer is told apart.
    const source: SentrySource = fromVault ? "config" : envDsn ? "env" : settings.dsn ? "config" : "none";
    return {
      dsn: dsn ?? null,
      enabled: settings.enabled,
      environment: settings.environment,
      tracesSampleRate: settings.tracesSampleRate,
      logsEnabled: settings.logsEnabled,
      source,
    };
  }

  /** Re-read the config and bring the Sentry client in line with it. */
  async apply(): Promise<ObservabilityStatusView> {
    await applySentryConfig(this.resolve());
    return this.getStatus();
  }

  getStatus(): ObservabilityStatusView {
    const input = this.resolve();
    const runtime = sentryRuntimeState();
    const parsed = input.dsn ? describeDsn(input.dsn) : null;
    // A stored string that is not a DSN never starts the SDK, so calling it
    // "enabled" would put a green pill and an `[sentry] enabled` boot line
    // in front of an operator whose harness is reporting nothing.  Stored
    // and env-pinned values both arrive raw so `configured` can say a value
    // is on file — that is what makes a malformed DSN legible rather than
    // looking like nothing was set.
    const malformed = input.dsn !== null && parsed === null;
    return {
      enabled: input.enabled && input.dsn !== null && !malformed,
      requestedEnabled: input.enabled,
      configured: input.dsn !== null,
      source: this.dsnFromVault() ? "infisical" : input.source,
      host: parsed?.host ?? null,
      projectId: parsed?.projectId ?? null,
      environment: input.environment,
      tracesSampleRate: input.tracesSampleRate,
      logsEnabled: input.logsEnabled,
      profilingAvailable: runtime.profilingAvailable,
      totalCaptured: this.totalCaptured,
      lastEventAt: this.lastEventAt,
      // The runtime only knows what the last `apply()` saw; a DSN that has
      // not reached the SDK yet is judged here so a status read before boot
      // finishes still names the problem.
      lastError: runtime.lastError ?? (malformed ? MALFORMED_DSN_MESSAGE : null),
    };
  }

  /** The full DSN, public key and all.  One caller only: the loopback route
   * the desktop renderer reads so it can start its own browser SDK.  Every
   * other surface gets `getStatus()`, which carries the host and nothing
   * that could be used to write to the project. */
  effectiveDsn(): string | null {
    return this.resolve().dsn;
  }

  /** P3's capture sink calls this so the Settings card can show that events
   * are really leaving this computer, not merely that a DSN is stored. */
  noteCapture(): void {
    this.totalCaptured += 1;
    this.lastEventAt = new Date().toISOString();
  }

  /** Send one real event and wait for it to leave.  Settings > Send Test
   * Event is the only caller: the operator gets to see the event land in
   * their own project rather than trust a green pill. */
  async probe(): Promise<{ ok: boolean; error: string | null; eventId: string | null }> {
    const status = this.getStatus();
    if (!status.configured) {
      return { ok: false, error: "Set a Sentry DSN first.", eventId: null };
    }
    if (!status.enabled) {
      return {
        ok: false,
        error: "Diagnostics are turned off.  Turn them on to send a test event.",
        eventId: null,
      };
    }
    if (!isSentryActive()) await this.apply();
    const sdk = getSentry();
    if (!isSentryActive() || !sdk) {
      return {
        ok: false,
        error: sentryRuntimeState().lastError ?? "Sentry is not running on this computer.",
        eventId: null,
      };
    }
    try {
      const eventId = sdk.withScope((scope) => {
        scope.setTag("botfleet.probe", "true");
        return sdk.captureMessage("BotFleet observability test", "info");
      });
      const flushed = await sdk.flush(3000);
      this.noteCapture();
      return {
        ok: flushed,
        error: flushed ? null : "The test event did not reach Sentry within 3 seconds.",
        eventId: eventId || null,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        eventId: null,
      };
    }
  }

  resetForTests(): void {
    this.totalCaptured = 0;
    this.lastEventAt = null;
    this.settingsProvider = null;
  }
}

export const observability = new ObservabilityManager();

/** The one-line boot and re-apply summary.  Built here so every caller
 * prints the same thing and none of them can put a DSN in a log file. */
export function observabilityBootLine(view: ObservabilityStatusView): string {
  if (!view.configured) {
    return "[sentry] disabled: no DSN configured (set one in Settings > Observability)";
  }
  // An error means nothing is being reported, whatever the switch says, so
  // it has to beat both remaining branches.  "enabled" is the word an
  // operator greps a boot log for; appending the reason to the end of a line
  // that opens with it tells them the opposite of the truth.
  if (view.lastError) {
    return `[sentry] misconfigured (${view.source}): ${view.lastError.slice(0, 160)}`;
  }
  if (!view.enabled) {
    return "[sentry] disabled by settings: a DSN is stored, diagnostics are turned off";
  }
  const parts = [
    `[sentry] enabled (${view.source})`,
    `env=${view.environment}`,
    `traces=${view.tracesSampleRate}`,
    `logs=${view.logsEnabled ? "on" : "off"}`,
  ];
  if (view.host) parts.push(`host=${view.host}`);
  if (view.projectId) parts.push(`project=${view.projectId}`);
  return parts.join(" ");
}
