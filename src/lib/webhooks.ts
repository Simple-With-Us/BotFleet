import type { RoutineRunOn } from "@/lib/routines";
import { niceCalendarDate, niceCalendarTime } from "./routine-calendar";
import { CENTRAL_TIME_ZONE, startOfDayInTimeZone } from "../../shared/time-zone";

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

/** GitHub events people most often point a bot at.  The editor lists these as
 * checkboxes; an event type the sender names that is not here is added by hand. */
export const COMMON_WEBHOOK_EVENT_TYPES: readonly string[] = [
  "pull_request",
  "push",
  "check_run",
  "check_suite",
  "workflow_run",
  "issues",
  "issue_comment",
  "release",
];

/** The harness keeps at most this many event types per webhook and refuses a
 * longer list, so the editor stops adding at the same number. */
export const MAX_WEBHOOK_EVENT_TYPES = 20;
/** The harness cuts a longer event type down to this many characters. */
const MAX_EVENT_TYPE_LENGTH = 200;

/** The two settings that decide which deliveries run, as one webhook holds
 * them.  A webhook that never had the flag reads as off. */
export interface WebhookFilterValues {
  mergedPullRequestsOnly: boolean;
  eventTypes: string[];
}

/** What a change sends: only the setting that changed. */
export type WebhookFilterPatch = Partial<WebhookFilterValues>;

export function webhookFilterValues(
  webhook: Pick<WebhookTrigger, "mergedPullRequestsOnly" | "eventTypes">,
): WebhookFilterValues {
  return {
    mergedPullRequestsOnly: webhook.mergedPullRequestsOnly === true,
    eventTypes: webhook.eventTypes ?? [],
  };
}

/** Event types typed into the add box.  Split on commas and never on spaces,
 * because a sender's event name can hold them: GitLab sends "Merge Request Hook". */
export function parseEventTypes(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim().slice(0, MAX_EVENT_TYPE_LENGTH))
    .filter(Boolean);
}

/** `current` plus the new names, in order, without repeats and never past the
 * limit.  Returns a new list; the argument is left alone. */
export function addEventTypes(current: readonly string[], added: readonly string[]): string[] {
  const next = [...current];
  for (const name of added) {
    if (next.length >= MAX_WEBHOOK_EVENT_TYPES) break;
    if (!next.includes(name)) next.push(name);
  }
  return next;
}

export function setEventTypeChecked(current: readonly string[], name: string, checked: boolean): string[] {
  return checked ? addEventTypes(current, [name]) : current.filter((value) => value !== name);
}

/** "Filtered 12 deliveries, last at 3:15 PM", or null while nothing has been
 * filtered.  Times are Central like the rest of Routines, and a delivery from
 * an earlier day also names its date. */
export function filteredDeliveriesLabel(
  webhook: Pick<WebhookTrigger, "ignoredCount" | "lastIgnoredAt">,
  now = Date.now(),
): string | null {
  const count = webhook.ignoredCount ?? 0;
  if (!(count > 0)) return null;
  const head = `Filtered ${count.toLocaleString()} ${count === 1 ? "delivery" : "deliveries"}`;
  const at = webhook.lastIgnoredAt;
  if (at === undefined) return head;
  const today = startOfDayInTimeZone(at, CENTRAL_TIME_ZONE) === startOfDayInTimeZone(now, CENTRAL_TIME_ZONE);
  return `${head}, last at ${today ? "" : `${niceCalendarDate(at, false)}, `}${niceCalendarTime(at)}`;
}
