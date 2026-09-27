/** Shape of GET /api/observability (server/observability.ts ObservabilityStatusView).
 * `dsn` is the one place the full Sentry DSN travels — the renderer needs it
 * to start the browser SDK.  Nothing in this module ever reads or returns it. */
export type ObservabilityStatusView = {
  enabled?: boolean;
  requestedEnabled?: boolean;
  /** A DSN is on file, whether or not diagnostics are currently enabled. */
  configured?: boolean;
  /** `"infisical"` is the fourth answer the Sentry lane never had: the SDK
   * itself only ever sees `env`/`config`/`none` (`server/observability.ts`),
   * but a store-held DSN reports this instead so the card names the vault
   * rather than calling it "Settings". */
  source?: "env" | "config" | "none" | "infisical";
  host?: string | null;
  projectId?: string | null;
  environment?: string;
  tracesSampleRate?: number;
  aiTracesSampleRate?: number;
  httpTracesSampleRate?: number;
  uiTracesSampleRate?: number;
  logsEnabled?: boolean;
  profilingAvailable?: boolean;
  totalCaptured?: number;
  lastEventAt?: string | null;
  lastError?: string | null;
  dsn?: string | null;
};

/** The host of the configured Sentry DSN, or null when unconfigured.
 * Reads only the server-resolved `host` field — never the full DSN, even
 * though a fuller payload may carry one alongside it. */
export function observabilityHost(status: ObservabilityStatusView | null): string | null {
  return status?.host?.trim() || null;
}

export type ObservabilityBadge = {
  label: string;
  tone: "error" | "active" | "off" | "waiting";
};

/** Honest diagnostics badge.  A DSN on file that is switched off reads
 * "Turned off", not "Not configured" — those are different states an
 * operator needs to tell apart. */
export function observabilityBadge(
  status: ObservabilityStatusView | null,
  fetchError?: string | null,
): ObservabilityBadge {
  const lastError = fetchError || status?.lastError || null;
  if (lastError) return { label: "Error", tone: "error" };
  if (!status) return { label: "Waiting", tone: "waiting" };
  if (status.requestedEnabled === false) return { label: "Turned off", tone: "off" };
  if (!status.configured) return { label: "Not configured", tone: "off" };
  if (!status.enabled) return { label: "Turned off", tone: "off" };
  return { label: "Sending diagnostics", tone: "active" };
}
