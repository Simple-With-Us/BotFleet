import type { RoutineRunOn } from "@/lib/routines";

/** Sentry severity levels, ordered from least to most severe. */
export type SentryLevel = "debug" | "info" | "warning" | "error" | "fatal";

/** PagerDuty incident urgency. */
export type PagerDutyUrgency = "high" | "low";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  eventTypes?: string[];
  /** Allowlist of the payload's action (GitHub/Sentry `action`, PagerDuty
   *  `event.event_type`, or a top-level `event`/`type` string). */
  actions?: string[];
  /** GitHub only: the pull request or issue must carry one of these labels. */
  requiredLabels?: string[];
  /** GitHub only: a completed run must have one of these conclusions. */
  conclusions?: string[];
  /** GitHub only: run only for the repository's default branch. */
  defaultBranchOnly?: boolean;
  /** Sentry only: ignore issues and events below this level. */
  minSentryLevel?: SentryLevel;
  /** Sentry only: ignore every delivery from these projects. */
  excludeSentryProjects?: string[];
  /** PagerDuty only: require this incident urgency. */
  pagerdutyUrgency?: PagerDutyUrgency;
  /** Runs only when a GitHub pull request is merged; every other delivery is
   * filtered before a run exists. */
  mergedPullRequestsOnly?: boolean;
  /** Deliveries filtered at ingress, counted since the count began. */
  ignoredCount?: number;
  lastIgnoredAt?: number;
  /** Minutes this webhook stays quiet after it runs.  Requests that arrive
   * inside the gap wait and go into one turn when it closes. */
  minGapMinutes?: number;
  oneShotWake?: boolean;
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
  actions?: string[];
  requiredLabels?: string[];
  conclusions?: string[];
  defaultBranchOnly?: boolean;
  minSentryLevel?: SentryLevel;
  excludeSentryProjects?: string[];
  pagerdutyUrgency?: PagerDutyUrgency;
  mergedPullRequestsOnly?: boolean;
  minGapMinutes?: number;
  oneShotWake?: boolean;
}

export interface WebhookVerificationSample {
  receivedAt: number;
  eventName?: string;
  contentType?: string;
  preview: string;
}

export type WebhookAttemptOutcome = "accepted" | "captured" | "duplicate" | "ignored" | "rejected";

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  receivedAt: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number;
  eventName?: string;
  preview?: string;
  deliveryId?: string;
  runId?: string;
  reason?: string;
}

export interface WebhookIngressStatus {
  available: boolean;
  baseUrl: string;
  error?: string;
}

export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
  /** Capability URL for senders that cannot configure an Authorization header. */
  url: string;
}

/** New local webhooks are ready to execute immediately. Editing an existing
 * webhook must preserve its current pause/verification state. */
export function webhookActivationDefaults(
  webhook?: Pick<WebhookTrigger, "enabled" | "verificationPending">,
): Pick<WebhookTriggerInput, "enabled" | "verificationPending"> {
  return {
    enabled: webhook?.enabled ?? true,
    verificationPending: webhook?.verificationPending ?? false,
  };
}
