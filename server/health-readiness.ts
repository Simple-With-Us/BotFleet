// The readiness fields of the `/health` and `/api/health` payloads.
//
// `ready` is the desktop boot probe's contract: `electron/server-boot-probe`
// polls while `ready` is false and declares the child booted once it flips
// true, so a permanent boot failure must NOT hold `ready` false or the app
// would wait out its whole boot budget and report a timeout.  Degradation
// that boot survived — today only a failed webhook ingress listener — is
// surfaced instead as the top-level `degraded` flag (plus the error text)
// alongside `ready`, so health consumers see it in the main payload rather
// than only in a settings-side ingress field.

export interface HealthReadinessInput {
  booting: boolean;
  webhookIngressError: string | null;
}

export function healthReadiness(input: HealthReadinessInput) {
  return {
    ready: !input.booting,
    booting: input.booting,
    degraded: input.webhookIngressError !== null,
    webhookIngressError: input.webhookIngressError,
  };
}
