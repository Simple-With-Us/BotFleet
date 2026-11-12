import { createHash } from "node:crypto";

import type { AppConfig } from "./config.ts";

export type ConnectorFailureKind =
  | "authentication"
  | "credential_pending"
  | "credential_unreadable"
  | "invalid_response"
  | "network"
  | "permission"
  | "rate_limited"
  | "timeout"
  | "upstream"
  | "unknown";

export type ConnectorReadinessState =
  | "credential_pending"
  | "credential_unreadable"
  | "degraded"
  | "ready"
  | "unconfigured";

export interface ConnectorReadiness {
  ready: boolean;
  configured: boolean;
  state: ConnectorReadinessState;
  checkedAt: number;
  lastSuccessAt: number | null;
  failure?: { kind: ConnectorFailureKind; message: string };
}

export interface ConnectorInventoryResult<ServiceState> {
  services: Record<string, ServiceState>;
  authoritative: boolean;
  credentialStore: "ok" | "pending" | "unavailable";
  readiness: ConnectorReadiness;
}

export type ConnectorCredentialState = "available" | "pending" | "unreadable";

export interface ConnectorIdentity {
  /** A one-way digest.  Credentials and private service URLs never leave the server. */
  key: string | null;
  configured: boolean;
}

interface ReadinessProbeOptions<ServiceState> {
  identify: (cfg: AppConfig) => ConnectorIdentity;
  load: (cfg: AppConfig) => Promise<Record<string, ServiceState>>;
  now?: () => number;
}

const MAX_SUCCESS_HISTORY = 64;

function taggedNumber(error: unknown, field: "status" | "upstreamStatus"): number | undefined {
  if (!error || typeof error !== "object" || !(field in error)) return undefined;
  const value = Number((error as Record<string, unknown>)[field]);
  return Number.isFinite(value) ? value : undefined;
}

/** Convert provider failures into a fixed, secret-free status.  The upstream
 * response body and URL are intentionally never copied into the API result. */
export function safeConnectorFailure(error: unknown): { kind: ConnectorFailureKind; message: string } {
  const upstreamStatus = taggedNumber(error, "upstreamStatus") ?? taggedNumber(error, "status");
  if (upstreamStatus === 401) {
    return { kind: "authentication", message: "The connected-apps credential was rejected." };
  }
  if (upstreamStatus === 403) {
    return { kind: "permission", message: "The connected-apps credential cannot list accounts." };
  }
  if (upstreamStatus === 429) {
    return { kind: "rate_limited", message: "The connected-apps service is temporarily rate limited." };
  }
  if (upstreamStatus !== undefined && upstreamStatus >= 500) {
    return { kind: "upstream", message: "The connected-apps service is temporarily unavailable." };
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/abort|timeout/i.test(name) || /timed? ?out|timeout/i.test(message)) {
    return { kind: "timeout", message: "The connected-apps service did not answer in time." };
  }
  if (name === "TypeError" || /fetch failed|network|econn|enotfound|socket/i.test(message)) {
    return { kind: "network", message: "BotFleet could not reach the connected-apps service." };
  }
  if (
    error instanceof SyntaxError
    || name === "SyntaxError"
    || name === "ZodError"
    || /invalid response|invalid json|unexpected token|unexpected end of json|expected property name/i.test(message)
  ) {
    return { kind: "invalid_response", message: "The connected-apps service returned an invalid response." };
  }
  return { kind: "unknown", message: "BotFleet could not verify connected apps." };
}

export function connectorIdentityDigest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Build one process-local readiness probe.  Only the same connection identity
 * and observed config generation share work or last-success evidence. */
export function createConnectorInventoryProbe<ServiceState>(options: ReadinessProbeOptions<ServiceState>) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<ConnectorInventoryResult<ServiceState>>>();
  const lastSuccesses = new Map<string, number>();
  let lastIdentityKey: string | null | undefined;
  let configGeneration = 0;

  const snapshot = (cfg: AppConfig): ConnectorIdentity & { generationKey: string | null } => {
    const identity = options.identify(cfg);
    if (identity.key !== lastIdentityKey) {
      lastIdentityKey = identity.key;
      configGeneration += 1;
    }
    return {
      ...identity,
      generationKey: identity.key === null ? null : `${configGeneration}:${identity.key}`,
    };
  };

  const unavailable = (
    state: "credential_pending" | "credential_unreadable" | "unconfigured",
  ): ConnectorInventoryResult<ServiceState> => {
    const checkedAt = now();
    if (state === "unconfigured") {
      return {
        services: {},
        authoritative: true,
        credentialStore: "ok",
        readiness: { ready: false, configured: false, state, checkedAt, lastSuccessAt: null },
      };
    }
    const pendingCredential = state === "credential_pending";
    return {
      services: {},
      authoritative: false,
      credentialStore: pendingCredential ? "pending" : "unavailable",
      readiness: {
        ready: false,
        configured: pendingCredential,
        state,
        checkedAt,
        lastSuccessAt: null,
        failure: pendingCredential
          ? { kind: "credential_pending", message: "Connected Apps is waiting for its encrypted credential." }
          : { kind: "credential_unreadable", message: "BotFleet could not read the encrypted Connected Apps credential." },
      },
    };
  };

  const status = async (
    cfg: AppConfig,
    credentialState: ConnectorCredentialState = "available",
  ): Promise<ConnectorInventoryResult<ServiceState>> => {
    if (credentialState === "pending") return unavailable("credential_pending");
    if (credentialState === "unreadable") return unavailable("credential_unreadable");

    let initial: ReturnType<typeof snapshot>;
    try {
      initial = snapshot(cfg);
    } catch (error) {
      const checkedAt = now();
      return {
        services: {}, authoritative: false, credentialStore: "ok",
        readiness: {
          ready: false, configured: true, state: "degraded", checkedAt, lastSuccessAt: null,
          failure: safeConnectorFailure(error),
        },
      };
    }
    if (!initial.configured || !initial.generationKey) return unavailable("unconfigured");

    const existing = pending.get(initial.generationKey);
    if (existing) return existing;

    const run = async (): Promise<ConnectorInventoryResult<ServiceState>> => {
      const lastSuccessAt = lastSuccesses.get(initial.generationKey!) ?? null;
      try {
        const services = await options.load(cfg);
        const current = snapshot(cfg);
        if (current.generationKey !== initial.generationKey) return status(cfg);
        const checkedAt = now();
        lastSuccesses.delete(initial.generationKey!);
        lastSuccesses.set(initial.generationKey!, checkedAt);
        if (lastSuccesses.size > MAX_SUCCESS_HISTORY) lastSuccesses.delete(lastSuccesses.keys().next().value!);
        return {
          services,
          authoritative: true,
          credentialStore: "ok",
          readiness: {
            ready: true, configured: true, state: "ready", checkedAt, lastSuccessAt: checkedAt,
          },
        };
      } catch (error) {
        const current = snapshot(cfg);
        if (current.generationKey !== initial.generationKey) return status(cfg);
        return {
          services: {},
          authoritative: false,
          credentialStore: "ok",
          readiness: {
            ready: false,
            configured: true,
            state: "degraded",
            checkedAt: now(),
            lastSuccessAt,
            failure: safeConnectorFailure(error),
          },
        };
      }
    };
    const promise = run().finally(() => {
      if (pending.get(initial.generationKey!) === promise) pending.delete(initial.generationKey!);
    });
    pending.set(initial.generationKey, promise);
    return promise;
  };

  return status;
}
