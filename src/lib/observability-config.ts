/** Client-side Diagnostics (Sentry) settings patch.  An empty DSN field is
 * omitted so a Save cannot wipe a stored key the input never echoed back —
 * the same rule `usage-config.ts` applies to its tokens.  Clearing a stored
 * DSN is a separate, explicit action (PATCH `{ sentryDsn: "" }`), never a
 * side effect of leaving this field blank. */

const MAX_ENVIRONMENT_LENGTH = 80;

/** @sentry/core's own DSN grammar, transcribed — the browser copy of the
 * rule `server/sentry.ts` `describeDsn` enforces on the harness side.  The
 * renderer cannot import a server module, so the grammar is duplicated here
 * and `server/config.test.ts` runs both copies over the same table to keep
 * them from drifting.
 *
 * It is stricter than `new URL` on purpose: the SDK's `DSN_REGEX` wants a
 * word-character public key (a hyphen or a dot fails it), a word/dot/hyphen
 * host or a bracketed IPv6 literal, and an all-digit project id.  Accepting
 * a shape the SDK refuses is not a cosmetic mismatch — the SDK answers a
 * DSN it cannot parse by printing the whole string, public key included,
 * through `console.error`, and then captures nothing. */
const DSN_PUBLIC_KEY = /^\w+$/;
const DSN_PASSWORD = /^\w*$/;
const DSN_HOST = /^(?:\[[:.%\w]+\]|[\w.-]+)$/;
const DSN_PROJECT_ID = /^\d+$/;

export function isSentryDsn(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!DSN_PUBLIC_KEY.test(parsed.username)) return false;
  if (!DSN_PASSWORD.test(parsed.password)) return false;
  if (!DSN_HOST.test(parsed.hostname)) return false;
  const projectId = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  return DSN_PROJECT_ID.test(projectId);
}

/** What the Send Diagnostics switch should show before the operator touches
 * it.  The harness reports `enabled` as the EFFECTIVE state (false whenever
 * no DSN is configured), but the stored flag defaults to on, so an install
 * with no DSN yet must show the switch on unless the newer status payload
 * carries an explicit opt-out.  Otherwise the first Save after pasting a
 * DSN would write `enabled: false` and turn diagnostics off. */
export function initialSendDiagnostics(
  status: { configured: boolean; enabled: boolean; requestedEnabled?: boolean } | null | undefined,
): boolean {
  if (!status) return true;
  if (status.requestedEnabled !== undefined) return status.requestedEnabled;
  if (!status.configured) return true;
  return status.enabled;
}

export type ObservabilityConfigPatch = {
  sentryDsn?: string;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  aiTracesSampleRate?: number;
  httpTracesSampleRate?: number;
  uiTracesSampleRate?: number;
  logsEnabled: boolean;
};

export function buildObservabilityConfigPatch(input: {
  sentryDsn: string;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  aiTracesSampleRate?: number;
  httpTracesSampleRate?: number;
  uiTracesSampleRate?: number;
  logsEnabled: boolean;
}): { ok: true; patch: ObservabilityConfigPatch } | { ok: false; error: string } {
  const dsn = input.sentryDsn.trim();
  if (dsn && !isSentryDsn(dsn)) {
    return {
      ok: false,
      error: "The diagnostics key must be an https:// Sentry DSN with a key and a numeric project id.",
    };
  }
  const environment = input.environment.trim();
  if (environment.length > MAX_ENVIRONMENT_LENGTH) {
    return { ok: false, error: `Environment must be ${MAX_ENVIRONMENT_LENGTH} characters or fewer.` };
  }
  if (!Number.isFinite(input.tracesSampleRate) || input.tracesSampleRate < 0 || input.tracesSampleRate > 1) {
    return { ok: false, error: "Traces sample rate must be between 0 and 1." };
  }
  if (
    input.aiTracesSampleRate !== undefined &&
    (!Number.isFinite(input.aiTracesSampleRate) || input.aiTracesSampleRate < 0 || input.aiTracesSampleRate > 1)
  ) {
    return { ok: false, error: "AI traces sample rate must be between 0 and 1." };
  }
  if (
    input.httpTracesSampleRate !== undefined &&
    (!Number.isFinite(input.httpTracesSampleRate) || input.httpTracesSampleRate < 0 || input.httpTracesSampleRate > 1)
  ) {
    return { ok: false, error: "HTTP traces sample rate must be between 0 and 1." };
  }
  if (
    input.uiTracesSampleRate !== undefined &&
    (!Number.isFinite(input.uiTracesSampleRate) || input.uiTracesSampleRate < 0 || input.uiTracesSampleRate > 1)
  ) {
    return { ok: false, error: "UI traces sample rate must be between 0 and 1." };
  }

  const patch: ObservabilityConfigPatch = {
    enabled: input.enabled,
    environment,
    tracesSampleRate: input.tracesSampleRate,
    logsEnabled: input.logsEnabled,
  };
  if (input.aiTracesSampleRate !== undefined) patch.aiTracesSampleRate = input.aiTracesSampleRate;
  if (input.httpTracesSampleRate !== undefined) patch.httpTracesSampleRate = input.httpTracesSampleRate;
  if (input.uiTracesSampleRate !== undefined) patch.uiTracesSampleRate = input.uiTracesSampleRate;
  if (dsn) patch.sentryDsn = dsn;
  return { ok: true, patch };
}
