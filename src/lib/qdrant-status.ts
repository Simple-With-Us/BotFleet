import type { AccessTokenState } from "../../server/recall-access.ts";

export type QdrantStatus = {
  configured?: boolean;
  state?: "unconfigured" | "degraded" | "ready";
  source?: "recall-cli" | "recall-service" | "unconfigured";
  checkedAt?: number;
  lastSuccessAt?: number | null;
  ready: boolean;
  error?: string;
  pointsCount?: number;
  collection?: string;
  collections?: string[];
  accessTokenState?: AccessTokenState;
};

/**
 * The warning for a half-configured Cloudflare Access service token, or null
 * when the pair is whole (or absent, which is the ordinary case — most
 * services are not behind Access).
 *
 * Half a pair is the quiet failure: `accessHeaders` sends BOTH halves or
 * neither, so a stored secret with an empty id sends nothing at all, and the
 * service answers a login page that reads like an outage.  Sentence case,
 * because this is status text.
 */
export function qdrantAccessWarning(state: AccessTokenState | undefined): string | null {
  if (state === "missing-id") {
    return "The Cloudflare Access client id is missing, so the cloud recall service will refuse this Mac.";
  }
  if (state === "missing-secret") {
    return "The Cloudflare Access client secret is missing, so the cloud recall service will refuse this Mac.";
  }
  return null;
}

export function qdrantRouteLabel(status: QdrantStatus | null, configuredUrl: string): string {
  const source = status?.source ?? (configuredUrl.trim() ? "recall-service" : "recall-cli");
  if (source === "recall-service") return "Recall service";
  if (source === "recall-cli") return "This Mac's recall CLI";
  return "Not configured";
}

export function qdrantStateLabel(status: QdrantStatus | null): string {
  if (!status) return "Not checked";
  if (status.state === "unconfigured" || status.source === "unconfigured") return "Not configured";
  if (status.state === "ready" || status.ready) return "Ready";
  return "Needs attention";
}

export function qdrantLastSuccessLabel(status: QdrantStatus | null): string {
  if (status?.lastSuccessAt == null) return "None recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(status.lastSuccessAt);
}

export async function settleQdrantSave<T>(operation: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save shared memory settings.",
    };
  }
}

export async function settleQdrantSaveWithStatusFence<T>(
  operation: () => Promise<T>,
  testRevisionAtStart: number,
  currentTestRevision: () => number,
): Promise<{ ok: true; value: T; clearTestResult: boolean } | { ok: false; error: string }> {
  const result = await settleQdrantSave(operation);
  if (!result.ok) return result;
  return {
    ...result,
    clearTestResult: currentTestRevision() === testRevisionAtStart,
  };
}

export async function waitForLatestQdrantSave(
  currentSave: () => Promise<boolean> | null,
  hasFailedSave: () => boolean = () => false,
): Promise<boolean> {
  while (true) {
    const pending = currentSave();
    if (!pending) return !hasFailedSave();
    if (!(await pending)) return false;
    const latest = currentSave();
    if (!latest || latest === pending) return !hasFailedSave();
  }
}

export function qdrantTestResultIfCurrent<T>(
  testRevision: number,
  currentTestRevision: () => number,
  result: T,
): T | null {
  return currentTestRevision() === testRevision ? result : null;
}
