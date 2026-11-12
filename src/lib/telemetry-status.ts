/** Shape of GET /api/telemetry/status (server/telemetry.ts TelemetryStatus). */
export type TelemetryStatusView = {
  enabled?: boolean;
  /** null when nothing is configured — there is no fallback endpoint. */
  ingestUrl?: string | null;
  lastError?: string | null;
  lastAckAt?: string | null;
  totalSent?: number;
};

/** The host of the configured ingest endpoint, or null when unconfigured.
 * Never a literal hostname: what shows is whatever the operator set. */
export function telemetryHost(status: TelemetryStatusView | null): string | null {
  const raw = status?.ingestUrl?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return raw;
  }
}

export type TelemetryBadge = {
  label: string;
  tone: "error" | "active" | "off" | "waiting";
};

/** Honest Usage Monitor badge.  Missing DSN / never posted is not "Active". */
export function telemetryBadge(
  status: TelemetryStatusView | null,
  fetchError?: string | null,
): TelemetryBadge {
  const lastError = fetchError || status?.lastError || null;
  if (lastError) return { label: "Error", tone: "error" };
  if (!status) return { label: "Waiting", tone: "waiting" };
  if (status.enabled && (status.lastAckAt || (status.totalSent ?? 0) > 0)) {
    return { label: "Active Telemetry", tone: "active" };
  }
  if (!status.enabled) return { label: "Not configured", tone: "off" };
  return { label: "Waiting", tone: "waiting" };
}
