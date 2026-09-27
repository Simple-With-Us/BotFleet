import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RoutineRunOn } from "./routines.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";
import {
  asRecord,
  isGithubWebhookPayload,
  isSentryWebhookPayload,
  pickStr,
  serializeWebhookPayload,
} from "./webhook-payload.ts";

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
  /** New UI-created hooks capture one authenticated request before they can run. */
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  /** Optional event-name allowlist. Empty means every event type. */
  eventTypes?: string[];
  /** Minimum minutes between activations of this trigger.  Deliveries that
   * arrive inside the gap wait and run together when it closes, rather than
   * waking the bot once each.  Absent or 0 runs every delivery. */
  minGapMinutes?: number;
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
  minGapMinutes?: number;
}

type CleanWebhookInput = Omit<
  WebhookTrigger,
  | "id"
  | "endpointId"
  | "createdAt"
  | "updatedAt"
  | "lastReceivedAt"
  | "lastRunId"
  | "deliveryCount"
  | "verifiedAt"
  | "verificationSample"
>;

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

interface StoredWebhookTrigger extends WebhookTrigger {
  secretHash: string;
}

interface DeliveryReceipt {
  key: string;
  runId: string;
  at: number;
}

interface WebhookFile {
  version: 1;
  webhooks: StoredWebhookTrigger[];
  deliveries: DeliveryReceipt[];
  attempts?: WebhookAttempt[];
}

interface CreatedWebhook {
  webhook: WebhookTrigger;
  secret: string;
}

export interface WebhookEvent {
  payload: JsonValue;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId?: string;
  deliveryId: string;
  duplicate: boolean;
  captured?: boolean;
  ignored?: boolean;
}

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: WebhookManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Resolve a live bot by display name. Used to reroute fleet-infra Sentry
   * onto Plumber without baking that bot's id into the webhook record. */
  findBotIdByName?: (name: string) => string | undefined;
  enqueue: (input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }) => { id: string };
  cancelQueued?: (webhookId: string, message: string) => void;
  pendingRuns?: (webhookId: string) => number;
}

export type WebhookManagerEvent =
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt };

/** How long a burst of save() calls coalesces into one atomic write.
 * Trailing-edge: set once per burst, not reset per call, so sustained
 * receipt traffic still flushes on a bounded cadence. */
const SAVE_DEBOUNCE_MS = 250;
const MAX_DELIVERIES = 2_000;
// Attempts carry a payload preview (see previewPayload below) and are UI
// history, not idempotency state like deliveries — 2,000 of them with a
// 2,000-character preview each made webhooks.json a 3 MB write on every
// receipt.  500 keeps enough recent history for the delivery log without the
// bulk.
const MAX_ATTEMPTS = 500;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const MAX_PENDING_RUNS = 3;
const MAX_IGNORED_ATTEMPTS_PER_WINDOW = 3;
const IGNORED_ATTEMPTS_WINDOW_MS = 10_000;

const runOnSchema = z
  .enum(["bot", "cloud", "maus"])
  .transform((value): "bot" | "cloud" => (value === "maus" ? "bot" : value));
const eventTypesSchema = z.array(z.string()).max(20).optional();
/** A whole number of minutes.  A day is the ceiling — past that a person
 * wants a schedule, not a trigger. */
const minGapSchema = z.number().int().min(0).max(1440).optional();
const triggerInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: runOnSchema.optional(),
  enabled: z.boolean().optional(),
  verificationPending: z.boolean().optional(),
  eventTypes: eventTypesSchema,
  minGapMinutes: minGapSchema,
});
const triggerPatchSchema = triggerInputSchema.partial();
const verificationSampleSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  eventName: z.string().optional(),
  contentType: z.string().optional(),
  preview: z.string(),
});
const storedWebhookSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string().min(1),
  runOn: runOnSchema,
  enabled: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastReceivedAt: z.number().finite().nonnegative().nullish().transform((val) => val ?? undefined),
  lastRunId: z.string().nullish().transform((val) => val ?? undefined),
  deliveryCount: z.number().int().nonnegative(),
  verificationPending: z.boolean().optional(),
  verifiedAt: z.number().finite().nonnegative().optional(),
  verificationSample: verificationSampleSchema.optional(),
  eventTypes: eventTypesSchema,
  minGapMinutes: minGapSchema,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const deliveryReceiptSchema = z.object({
  key: z.string().min(1),
  runId: z.string().min(1),
  at: z.number().finite().nonnegative(),
});
const webhookAttemptSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  eventName: z.string().optional(),
  preview: z.string().optional(),
  deliveryId: z.string().optional(),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
const webhookFileSchema = z.object({
  version: z.literal(1),
  webhooks: z.array(storedWebhookSchema),
  deliveries: z.array(deliveryReceiptSchema),
  attempts: z.array(webhookAttemptSchema).optional(),
});
const taskPayloadSchema = z.object({ task: z.string().optional(), message: z.string().optional() });
const statusErrorSchema = z.object({ status: z.number().int().optional() });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invalidInput(error: z.ZodError): never {
  fail(400, schemaIssue(error, "Invalid webhook settings"));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): CleanWebhookInput {
  const name = input.name.trim().slice(0, 80);
  const prompt = input.prompt.trim().slice(0, 20_000);
  const botId = input.botId.trim();
  const runOn = input.runOn ?? "bot";
  if (!name) fail(400, "Give the webhook a name");
  if (!botId) fail(400, "Choose a Bot");
  if (runOn !== "bot" && runOn !== "cloud") fail(400, "Choose where this webhook runs");
  const eventTypes = Array.from(new Set(
    (input.eventTypes ?? [])
      .map((value) => value.trim().slice(0, 200))
      .filter(Boolean),
  )).slice(0, 20);
  const enabled = input.enabled !== false;
  const clean: CleanWebhookInput = {
    name,
    prompt,
    botId,
    runOn,
    enabled,
    verificationPending: enabled ? false : input.verificationPending === true,
  };
  if (eventTypes.length) clean.eventTypes = eventTypes;
  // 0 means "no gap", which is also the absent value — keep the record small
  const minGapMinutes = Math.max(0, Math.min(1440, Math.round(input.minGapMinutes ?? 0)));
  if (minGapMinutes > 0) clean.minGapMinutes = minGapMinutes;
  return clean;
}

function parseTriggerInput(value: JsonValue): WebhookTriggerInput {
  const parsed = triggerInputSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function parseTriggerPatch(value: JsonValue): Partial<WebhookTriggerInput> {
  const parsed = triggerPatchSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: JsonValue): string {
  return serializeWebhookPayload(payload);
}

function previewPayload(payload: JsonValue): string {
  return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 512);
}

function taskFromPayload(payload: JsonValue): string {
  const parsed = taskPayloadSchema.safeParse(payload);
  if (!parsed.success) return "";
  const task = parsed.data.task ?? parsed.data.message ?? "";
  return task.trim().slice(0, 20_000);
}

export interface IngressIgnoreDecision {
  ignore: boolean;
  reason?: string;
}

// The scope patterns below are large (several KB each) and costly to compile.
// A fresh `new RegExp` per event lets V8 drop the compiled code on GC and
// recompile it on the next event, which made ingress take tens of seconds on
// slower CI runners.  Keep one compiled instance per (source, flags).  Every
// pattern here is non-global and non-sticky, so a shared instance carries no
// `lastIndex` state between calls.  The level text comes from the payload, so
// the cache is capped rather than allowed to grow with every distinct value.
const SCOPE_PATTERN_CACHE_LIMIT = 256;
const scopePatternCache = new Map<string, RegExp>();
function scopePattern(source: string, flags: string): RegExp {
  const key = `${flags}/${source}`;
  let pattern = scopePatternCache.get(key);
  if (!pattern) {
    pattern = new RegExp(source, flags);
    if (scopePatternCache.size >= SCOPE_PATTERN_CACHE_LIMIT) scopePatternCache.clear();
    scopePatternCache.set(key, pattern);
  }
  return pattern;
}

export function shouldIgnoreWebhookEvent(
  trigger: { prompt?: string; name?: string; eventTypes?: string[] },
  event: WebhookEvent,
): IngressIgnoreDecision {
  const payload = event.payload;
  const rawPrompt = trigger.prompt ?? "";
  const prompt = rawPrompt.replace(/[\u2018\u2019\u201B\u2032`]/g, "'");
  const rawName = trigger.name ?? "";
  const name = rawName.replace(/[\u2018\u2019\u201B\u2032`]/g, "'");

  // The error-only scope reads the prompt, or the name when the prompt is
  // empty; its overrides read that same field.  (Level and assignment
  // overrides also read the name when the name states the exclusion -- see
  // levelSources.)
  const overrideText = prompt.trim() ? prompt : name;

  // 1. Sentry Ingress Pre-Filter (only applies to verified Sentry payloads)
  if (isSentryWebhookPayload(payload)) {
    const root = asRecord(payload);
    const data = asRecord(root?.data) ?? root;
    const issue = asRecord(data?.issue);
    const ev = asRecord(data?.event);
    const level = pickStr(issue, "level") ?? pickStr(ev, "level") ?? pickStr(root, "level");
    const action = pickStr(root, "action");

    const isLevelExcluded = (lvl: string): boolean => {
      // Find exclusion phrases, stopping at clause boundaries (;, \n, .)
      // Distinguish noun usages like "drop in warning", "drop of warning", or "recent drop of" from imperative drop commands.
      // Passive "ignored"/"dropped"/"excluded"/"skipped" count only after a be/get auxiliary ("warnings are ignored",
      // "assignments should be dropped"), so adjective uses like "handle dropped warnings" stay positive.
      const negativeWord = `(?:[a-z]+n't|cannot|do\\s+not|never|not|no|neither|without|stop(?:\\s+to)?|quit|avoid)`;
      const negationModifiers = `(?:(?:just|ever|simply|really|always|blindly)\\s+){0,2}`;
      const handlingVerb = `(?:investigate|act(?:\\s+on)?|handle|process|triage|fix|resolve|watch|monitor|track|escalate|alert|notify|keep|retain)`;
      const handlingGerundOrParticiple = `(?:investigating|investigated|acting(?:\\s+on)?|acted(?:\\s+on)?|handling|handled|processing|processed|triaging|triaged|fixing|fixed|resolving|resolved|watching|watched|monitoring|monitored|tracking|tracked|escalating|escalated|alerting|alerted|notifying|notified|keeping|kept|retaining|retained)`;
      const allHandlingVerbs = `(?:${handlingVerb}|${handlingGerundOrParticiple})`;
      const passiveAux = `(?:(?:to|be|get|have\\s+been)\\s+){1,2}`;
      const negatedHandlingVerb = `(?:\\b${negativeWord}\\s+${negationModifiers}(?:${passiveAux})?${allHandlingVerbs}\\b|\\b(?:is|are|be|was|were|get|gets|got)\\s+(?:not|never)\\s+${negationModifiers}(?:${passiveAux})?${allHandlingVerbs}\\b)`;

      const passiveExclusionAux = `(?:is|are|be|was|were|get|gets|got|(?:should|must|can|could|would|will)\\s+be)`;
      const exclusionVerb = `(?:\\b(?:out\\s+of|not\\s+in)\\s+scope\\b|\\bstay silent\\b|\\b(?:ignore|ignoring|exclude|excluding|skip|skipping)\\b|(?<!\\b(?:a|an|the|any|sharp|sudden|recent|new)\\s+)\\bdrop\\b(?!s?\\s+(?:in|of)\\b)|\\b${passiveExclusionAux}\\s+(?:ignored|dropped|excluded|skipped)\\b|${negatedHandlingVerb})`;
      // Positive handling/investigation verbs that govern events (must not be preceded by negation)
      const contrastingVerb = `(?<!\\b(?:[a-z]+n't|cannot|do\\s+not|never|not|no|neither|without|stop|quit|avoid)(?:\\s+\\w+){0,2}\\s+)\\b(?:investigate|act|handle|process|triage|fix|resolve|watch|monitor|track|escalate|alert|notify|keep|retain)\\b`;
      const inScopePhrase = String.raw`(?<!\bnot\s+)\b(?:in\s+scope|tracked|monitored|included|allowed|handled|processed)\b`;
      // An exception word, contrast word (not), positive handling verb, or in-scope assertion stops exclusion scanning so exclusions bind to their target
      const exceptionBoundary = String.raw`\b(?:except|but|without|not(?!\s+in\s+scope\b)|other\s+than|apart\s+from|aside\s+from)\b|${contrastingVerb}|${inScopePhrase}`;
      const verbFirstPattern = scopePattern(
        `${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${lvl}s?\\b`,
        "i",
      );
      const targetFirstPattern = scopePattern(
        `\\b${lvl}s?\\b(?:(?!${exceptionBoundary})[^.;\\n])*?${exclusionVerb}`,
        "i",
      );
      const positiveScopeException = scopePattern(
        `(?:${contrastingVerb}(?:(?!${exclusionVerb})[^.;\\n])*?\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\b(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${lvl}s?\\b` +
          `|\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\b(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${lvl}s?\\b(?:(?!${exclusionVerb})[^.;\\n])*?${contrastingVerb})`,
        "i",
      );
      const allLevelsPattern = `(?:error|warning|info|debug)s?(?:\\s+events?)?`;
      const levelCoordination = `(?:\\b${allLevelsPattern}\\b\\s*(?:,|/|\\bor\\b|\\band\\b|\\bnor\\b)\\s*)*`;
      const bareNegativePattern = scopePattern(
        `(?:^|[.;\\n]|${contrastingVerb}[^.;\\n]*?)\\s*\\b(?:no|not|neither)\\s+(?:any\\s+)?${levelCoordination}\\b${lvl}s?(?:\\s+events?)?\\b`,
        "i",
      );
      const otherLevels = ["error", "warning", "info", "debug"].filter((l) => l !== lvl);
      const otherLevelsPattern = `(?:${otherLevels.map((l) => `${l}s?`).join("|")})`;
      // The trigger name is an instruction too: "Ignore warning events" with an
      // empty prompt must be honored, same as the name checks below.
      const excludes = (text: string) =>
        verbFirstPattern.test(text) ||
        targetFirstPattern.test(text) ||
        positiveScopeException.test(text) ||
        bareNegativePattern.test(text);
      const hasLevelExclusion = excludes(prompt) || excludes(name);
      // Overrides below read the prompt, plus the name when the name itself
      // states the exclusion: a name "Ignore warnings; investigate warning
      // events" keeps warnings even next to an unrelated prompt, while a
      // title that states no exclusion ("Error Monitor Warning Ignorer") is
      // never read for an override.
      const levelSources = [prompt, ...(excludes(name) ? [name] : [])].filter((text) => text.trim());
      if (!hasLevelExclusion) {
        if (lvl !== "error") {
          const nonErrorTarget = `\\bnon-?errors?(?:\\s+events?)?\\b`;
          const nonErrorExclusionPattern = scopePattern(
            `${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?${nonErrorTarget}` +
              `|${nonErrorTarget}(?:(?!${exceptionBoundary})[^.;\\n])*?${exclusionVerb}`,
            "i",
          );
          const nonErrorNegationPattern = scopePattern(
            `(?:${negativeWord}\\s+${negationModifiers}${exclusionVerb}[^.;\\n]*?${nonErrorTarget}` +
              `|${nonErrorTarget}[^.;\\n]*?${negativeWord}\\s+[^.;\\n]*?${exclusionVerb}` +
              `|${negativeWord}\\s+[^.;\\n]*?${nonErrorTarget}[^.;\\n]*?${exclusionVerb})`,
            "i",
          );
          const positiveHandling = `(?:investigate|act(?:\\s+on)?|handle|process|triage|fix|resolve|watch|monitor|track|escalate|alert|notify|focus(?:\\s+on)?)`;
          const negationErrorOnly = scopePattern(
            `\\b(?:do\\s+not|don't|never|not)(?:\\s+${positiveHandling})?\\s+(?:only|exclusively)\\b`,
            "i",
          );
          const inclusionPhrase = `(?:in\\s+scope|tracked|monitored|included|allowed|handled|processed|investigated|triaged|resolved)`;
          const errorOnlyPattern = scopePattern(
            `(?:` +
              `\\b(?:only|exclusively)\\s+${positiveHandling}\\s+errors?(?:\\s+events?)?\\b` +
              `|\\b${positiveHandling}\\s+(?:only|exclusively)\\s+errors?(?:\\s+events?)?\\b` +
              `|\\b${positiveHandling}\\s+errors?(?:\\s+events?)?\\s+(?:only|exclusively)\\b` +
              `|\\b(?:only|exclusively)\\s+errors?(?:\\s+events?)?\\s+(?:are\\s+)?${inclusionPhrase}\\b` +
              `|\\berrors?(?:\\s+events?)?\\s+(?:only|exclusively)\\s+(?:are\\s+)?${inclusionPhrase}\\b` +
              `|\\b(?:(?:only|exclusively)\\s+errors?(?:\\s+events?)?|errors?(?:\\s+events?)?\\s+(?:only|exclusively))\\b(?!\\s*(?:(?:are|is|should(?:\\s+be)?|were|was|get|gets|must(?:\\s+be)?)\\s+)?(?:${exclusionVerb}|to\\s+be\\s+(?:ignored|dropped|excluded|skipped)))(?:\\s*[.;\\n]|\\s*$)` +
            `)`,
            "i",
          );

          const allExceptErrorsPattern = scopePattern(
            `(?:` +
              `${exclusionVerb}\\s+(?:all(?:\\s+(?:events?|deliveries|payloads|alerts?|issues?|notifications?|messages?))?|everything|anything)\\s+(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\s+errors?(?:\\s+events?)?\\b` +
              `|\\b(?:all(?:\\s+(?:events?|deliveries|payloads|alerts?|issues?|notifications?|messages?))?|everything|anything)\\s+(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\s+errors?(?:\\s+events?)?(?:[^.;\\n]*?\\b(?:are|is|should(?:\\s+be)?|were|was|must(?:\\s+be)?)\\s+)?${exclusionVerb}` +
              `|\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\s+errors?(?:\\s+events?)?\\s*[,;]?\\s*(?:(?:are|is|should(?:\\s+be)?|were|was|must(?:\\s+be)?)\\s+)?${exclusionVerb}\\s+(?:all(?:\\s+(?:events?|deliveries|payloads|alerts?|issues?|notifications?|messages?))?|everything|anything)` +
              `|\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\s+errors?(?:\\s+events?)?\\s*[,;]?\\s*(?:all(?:\\s+(?:events?|deliveries|payloads|alerts?|issues?|notifications?|messages?))?|everything|anything)[^.;\\n]*?${exclusionVerb}` +
            `)`,
            "i",
          );
          const negationAllExceptErrors = scopePattern(
            `(?:` +
              `${negativeWord}\\s+${negationModifiers}${exclusionVerb}[^.;\\n]*?(?:all|everything|anything)[^.;\\n]*?errors?` +
              `|${negativeWord}\\s+[^.;\\n]*?(?:all|everything|anything)\\s+(?:except|aside|other|excluding|without)[^.;\\n]*?errors?[^.;\\n]*?${exclusionVerb}` +
            `)`,
            "i",
          );

          const isPromptAllExceptErrors = allExceptErrorsPattern.test(prompt) && !negationAllExceptErrors.test(prompt);
          const isNameAllExceptErrors = allExceptErrorsPattern.test(name) && !negationAllExceptErrors.test(name);

          const isPromptErrorOnly =
            (nonErrorExclusionPattern.test(prompt) && !nonErrorNegationPattern.test(prompt)) ||
            (errorOnlyPattern.test(prompt) && !negationErrorOnly.test(prompt)) ||
            isPromptAllExceptErrors;
          const isNameErrorOnly =
            (nonErrorExclusionPattern.test(name) && !nonErrorNegationPattern.test(name)) ||
            (errorOnlyPattern.test(name) && !negationErrorOnly.test(name)) ||
            isNameAllExceptErrors;

          const isErrorOnlyScope = prompt.trim() ? isPromptErrorOnly : isNameErrorOnly;
          if (isErrorOnlyScope) {

            const positiveTargetsLevel = scopePattern(
              `${contrastingVerb}(?:(?!(?:${exclusionVerb}|\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\b))[^.;\\n])*?(?<!\\b(?:do\\s+not|don't|never|not|no|neither|without|except(?:\\s+for)?|aside\\s+from|other\\s+than)\\s+)\\b${lvl}s?\\b` +
                `|\\b${lvl}s?\\b(?:(?!(?:${exclusionVerb}|${otherLevelsPattern}\\b))[^.;\\n])*?\\b(?:are|is\\s+)?(?<!\\bnot\\s+)(?:in\\s+scope|tracked|monitored|included|allowed|handled|processed)\\b`,
              "i",
            );
            if (positiveTargetsLevel.test(overrideText)) return false;

            const carveOutPattern = scopePattern(
              `\\b(?:except|and|also|or|but|along\\s+with|as\\s+well\\s+as|unless)\\b(?:(?!\\b(?:do\\s+not|don't|never|not|no|neither|without)\\b)[^.;\\n])*?\\b${lvl}s?\\b`,
              "i",
            );
            if (carveOutPattern.test(overrideText)) return false;

            const exceptClause = `(?:except(?:\\s+for)?(?!\\s+${otherLevelsPattern}\\b))`;
            const conditional = `(?:unless|${exceptClause}|only\\s+(?:if|when|in|from|for|on)|if|when)`;
            const conditionalGap = `(?:(?!${contrastingVerb})[^.;\\n])*?`;
            const conditionalPattern = scopePattern(
              `\\b${conditional}\\b${conditionalGap}\\b${lvl}s?\\b` +
                `|\\b${lvl}s?\\b${conditionalGap}\\b${conditional}\\b`,
              "i",
            );
            if (conditionalPattern.test(prompt)) return false;

            return true;
          }
        }
        return false;
      }

      // Positive investigation verbs or in-scope assertions override exclusion only when they specifically target this level
      // (read from `levelSources`: the prompt, plus the name when it states the exclusion)
      const positiveTargetsLevel = scopePattern(
        `${contrastingVerb}(?:(?!(?:${exclusionVerb}|\\b(?:except(?:\\s+for)?|aside\\s+from|other\\s+than|excluding|without)\\b))[^.;\\n])*?(?<!\\b(?:do\\s+not|don't|never|not|no|neither|without|except(?:\\s+for)?|aside\\s+from|other\\s+than)\\s+)\\b${lvl}s?\\b` +
          `|\\b${lvl}s?\\b(?:(?!(?:${exclusionVerb}|${otherLevelsPattern}\\b))[^.;\\n])*?\\b(?:are|is\\s+)?(?<!\\bnot\\s+)(?:in\\s+scope|tracked|monitored|included|allowed|handled|processed)\\b`,
        "i",
      );
      if (levelSources.some((text) => positiveTargetsLevel.test(text))) return false;

      const interveningPattern = scopePattern(
        `${exclusionVerb}[^.;\\n]*?${contrastingVerb}[^.;\\n]*?\\b${lvl}s?\\b`,
        "i",
      );
      if (levelSources.some((text) => interveningPattern.test(text))) return false;

      // "Don't just ignore", "do not ever ignore": up to two adverbs may sit
      // between the negation and the exclusion verb.  Closed list, so an
      // unrelated word in between never turns an exclusion into a negation.
      const negationPattern = scopePattern(
        `(?:${negativeWord}\\s+${negationModifiers}${exclusionVerb}[^.;\\n]*?\\b${lvl}s?\\b` +
          `|\\b${lvl}s?\\b[^.;\\n]*?${negativeWord}\\s+[^.;\\n]*?${exclusionVerb}` +
          `|${negativeWord}\\s+[^.;\\n]*?\\b${lvl}s?\\b[^.;\\n]*?${exclusionVerb})`,
        "i",
      );
      if (negationPattern.test(prompt) || negationPattern.test(name)) return false;

      // A conditional carve-out ("ignore warning events unless they occur
      // in production", "except in production", "only in staging", "only if from staging") qualifies
      // the exclusion, and the payload carries nothing to evaluate the condition with.
      // Conservative: keep the event rather than drop one the condition
      // would have kept.  The scan must not cross another instruction
      // verb — "ignore warnings, notify when resolved" conditions the
      // notify, not the ignore.
      const exceptClause = `(?:except(?:\\s+for)?(?!\\s+${otherLevelsPattern}\\b))`;
      const conditional = `(?:unless|${exceptClause}|only\\s+(?:if|when|in|from|for|on)|if|when)`;
      const conditionalGap = `(?:(?!${contrastingVerb})[^.;\\n])*?`;
      const conditionalPattern = scopePattern(
        `${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${lvl}s?\\b${conditionalGap}\\b${conditional}\\b` +
          `|\\b${conditional}\\b${conditionalGap}${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${lvl}s?\\b` +
          `|\\b${lvl}s?\\b${conditionalGap}${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${conditional}\\b`,
        "i",
      );
      if (conditionalPattern.test(prompt) || conditionalPattern.test(name)) return false;
      return true;
    };

    const isAssignmentAction = action === "assigned" || action === "unassigned";
    let isAssignmentHandled = false;

    if (isAssignmentAction) {
      const assignmentTarget = `\\b(?:un-?assign(?:ed|ment|ee)?s?|re-?assign(?:ed|ment|ee)?s?|assign(?:ed|ment|ee)?s?|ownership)\\b`;
      const isAssignmentExcluded = (): boolean => {
        const negativeWord = `(?:[a-z]+n't|cannot|do\\s+not|never|not|no|neither|without|stop(?:\\s+to)?|quit|avoid)`;
        const negationModifiers = `(?:(?:just|ever|simply|really|always|blindly)\\s+){0,2}`;
        const handlingVerb = `(?:investigate|act(?:\\s+on)?|handle|process|triage|fix|resolve|watch|monitor|track|escalate|alert|notify|keep|retain)`;
        const handlingGerundOrParticiple = `(?:investigating|investigated|acting(?:\\s+on)?|acted(?:\\s+on)?|handling|handled|processing|processed|triaging|triaged|fixing|fixed|resolving|resolved|watching|watched|monitoring|monitored|tracking|tracked|escalating|escalated|alerting|alerted|notifying|notified|keeping|kept|retaining|retained)`;
        const allHandlingVerbs = `(?:${handlingVerb}|${handlingGerundOrParticiple})`;
        const passiveAux = `(?:(?:to|be|get|have\\s+been)\\s+){1,2}`;
        const negatedHandlingVerb = `(?:\\b${negativeWord}\\s+${negationModifiers}(?:${passiveAux})?${allHandlingVerbs}\\b|\\b(?:is|are|be|was|were|get|gets|got)\\s+(?:not|never)\\s+${negationModifiers}(?:${passiveAux})?${allHandlingVerbs}\\b)`;

        const passiveExclusionAux = `(?:is|are|be|was|were|get|gets|got|(?:should|must|can|could|would|will)\\s+be)`;
        const exclusionVerb = `(?:\\b(?:out\\s+of|not\\s+in)\\s+scope\\b|\\bstay silent\\b|\\b(?:ignore|ignoring|exclude|excluding|skip|skipping)\\b|(?<!\\b(?:a|an|the|any|sharp|sudden|recent|new)\\s+)\\bdrop\\b(?!s?\\s+(?:in|of)\\b)|\\b${passiveExclusionAux}\\s+(?:ignored|dropped|excluded|skipped)\\b|${negatedHandlingVerb})`;
        const contrastingVerb = `(?<!\\b(?:[a-z]+n't|cannot|do\\s+not|never|not|no|neither|without|stop|quit|avoid)(?:\\s+\\w+){0,2}\\s+)\\b(?:investigate|act|handle|process|triage|fix|resolve|watch|monitor|track|escalate|alert|notify|keep|retain)\\b`;
        const inScopePhrase = String.raw`(?<!\bnot\s+)\b(?:in\s+scope|tracked|monitored|included|allowed|handled|processed)\b`;
        const exceptionBoundary = String.raw`\b(?:except|but|without|not(?!\s+in\s+scope\b)|other\s+than|apart\s+from|aside\s+from)\b|${contrastingVerb}|${inScopePhrase}`;
        const verbFirstPattern = scopePattern(
          `${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?${assignmentTarget}`,
          "i",
        );
        const targetFirstPattern = scopePattern(
          `${assignmentTarget}(?:(?!${exceptionBoundary})[^.;\\n])*?${exclusionVerb}`,
          "i",
        );
        const negationPattern = scopePattern(
          `(?:${negativeWord}\\s+${negationModifiers}${exclusionVerb}[^.;\\n]*?${assignmentTarget}` +
            `|${assignmentTarget}[^.;\\n]*?${negativeWord}\\s+[^.;\\n]*?${exclusionVerb}` +
            `|${negativeWord}\\s+[^.;\\n]*?${assignmentTarget}[^.;\\n]*?${exclusionVerb})`,
          "i",
        );
        if (negationPattern.test(prompt) || negationPattern.test(name)) return false;

        const negatedTargetPattern = scopePattern(
          `\\b(?:not|no|neither|without|never|except(?:\\s+for)?|aside\\s+from|other\\s+than)\\s+(?:any\\s+)?${assignmentTarget}` +
            `|${assignmentTarget}\\s+(?:are|is\\s+)?(?:not|never|out\\s+of\\s+scope)\\b`,
          "i",
        );
        if (negatedTargetPattern.test(prompt) || negatedTargetPattern.test(name)) return true;

        const assignmentExcludes = (text: string) => verbFirstPattern.test(text) || targetFirstPattern.test(text);
        if (!assignmentExcludes(prompt) && !assignmentExcludes(name)) return false;
        // Overrides read the prompt, plus the name when it states the exclusion.
        const assignmentSources = [prompt, ...(assignmentExcludes(name) ? [name] : [])].filter((text) => text.trim());

        const positiveTargetsAssignment = scopePattern(
          `${contrastingVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?(?<!\\b(?:do\\s+not|don't|never|not|no|neither|without)\\s+(?:any\\s+)?)${assignmentTarget}` +
            `|${assignmentTarget}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b(?:are|is\\s+)?(?<!\\bnot\\s+)(?:in\\s+scope|tracked|monitored|included|allowed|handled|processed)\\b`,
          "i",
        );
        if (assignmentSources.some((text) => positiveTargetsAssignment.test(text))) return false;

        const interveningPattern = scopePattern(
          `${exclusionVerb}[^.;\\n]*?${contrastingVerb}[^.;\\n]*?${assignmentTarget}`,
          "i",
        );
        if (assignmentSources.some((text) => interveningPattern.test(text))) return false;

        // A conditional carve-out ("ignore assignment updates unless assigned to
        // the on-call engineer", "except in production", "only for primary") qualifies the
        // exclusion, and the payload carries nothing to evaluate the condition with.
        // Conservative: keep the event rather than drop one the condition would have kept.
        const conditional = `(?:unless|except(?:\\s+for)?|only\\s+(?:if|when|in|from|for|on)|if|when)`;
        const conditionalGap = `(?:(?!${contrastingVerb})[^.;\\n])*?`;
        const conditionalPattern = scopePattern(
          `${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?${assignmentTarget}${conditionalGap}\\b${conditional}\\b` +
            `|\\b${conditional}\\b${conditionalGap}${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?${assignmentTarget}` +
            `|${assignmentTarget}${conditionalGap}${exclusionVerb}(?:(?!${exceptionBoundary})[^.;\\n])*?\\b${conditional}\\b`,
          "i",
        );
        if (conditionalPattern.test(prompt) || conditionalPattern.test(name)) return false;
        return true;
      };

      if (isAssignmentExcluded()) {
        return {
          ignore: true,
          reason: `Sentry action '${action}' is marked out of scope by trigger instructions`,
        };
      }

      const assignmentMatcher = /\b(?:un-?assign(?:ed|ment|ee)?s?|re-?assign(?:ed|ment|ee)?s?|assign(?:ed|ment|ee)?s?|ownership)\b/i;
      const positiveAssignmentMatcher = scopePattern(
        `(?<!\\b(?:not|no|neither|without|never|except(?:\\s+for)?|aside\\s+from|other\\s+than)\\s+(?:any\\s+)?)${assignmentTarget}`,
        "i",
      );
      const assignmentContextMatcher = /\b(?:(?:assignment|ownership|issue)\s+(?:router|triage)|(?:router|triage)\s+(?:for\s+)?(?:assignments?|assignees?|ownership|owners?))\b/i;
      const handlesAssignments =
        (trigger.eventTypes ?? []).some((e) => assignmentMatcher.test(e)) ||
        positiveAssignmentMatcher.test(name) ||
        positiveAssignmentMatcher.test(prompt) ||
        assignmentContextMatcher.test(prompt) ||
        assignmentContextMatcher.test(name);

      if (handlesAssignments) {
        isAssignmentHandled = true;
      } else if (
        /\b(?:incidents?|alerts?|fatal|errors?|breakages?|crash(?:es)?)\b/i.test(name) ||
        /\b(?:incidents?|fatal|broken|crash(?:es)?)\b/i.test(prompt)
      ) {
        return {
          ignore: true,
          reason: `Sentry action '${action}' is an issue assignment update, not a runtime incident`,
        };
      }
    }

    if (!isAssignmentHandled && (level === "warning" || level === "info" || level === "debug")) {
      if (isLevelExcluded(level)) {
        return {
          ignore: true,
          reason: `Sentry level '${level}' is marked out of scope by trigger instructions`,
        };
      }
    }
  }

  // 2. GitHub Compile Gates Pre-Filter (only applies to verified GitHub payloads)
  const isCompileGatesTrigger =
    /\bcompile[\s-]*gates?\b/i.test(name) || /\b(?:own compile gates|bf-compiler)\b/i.test(prompt);
  if (isCompileGatesTrigger && isGithubWebhookPayload(payload)) {
    const eventName = event.eventName;
    const root = asRecord(payload);
    const action = pickStr(root, "action");

    if (eventName === "workflow_run") {
      const workflowRun = asRecord(root?.workflow_run);
      const runStatus = pickStr(workflowRun, "status");
      const runConclusion = pickStr(workflowRun, "conclusion");
      const isTerminalFailure =
        runStatus === "completed" &&
        (runConclusion === "failure" ||
          runConclusion === "timed_out" ||
          runConclusion === "action_required" ||
          runConclusion === "startup_failure");
      if (!isTerminalFailure) {
        const desc = action ? `action '${action}'` : `status '${runStatus ?? "unknown"}'`;
        return {
          ignore: true,
          reason: `GitHub workflow_run ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else if (eventName === "check_run") {
      const checkRun = asRecord(root?.check_run);
      const checkStatus = pickStr(checkRun, "status");
      const checkConclusion = pickStr(checkRun, "conclusion");
      const isTerminalFailure =
        checkStatus === "completed" &&
        (checkConclusion === "failure" ||
          checkConclusion === "timed_out" ||
          checkConclusion === "action_required" ||
          checkConclusion === "startup_failure");
      if (!isTerminalFailure) {
        const desc = checkStatus ? `status '${checkStatus}'` : (action ? `action '${action}'` : "pending");
        return {
          ignore: true,
          reason: `GitHub check_run ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else if (eventName === "check_suite") {
      const checkSuite = asRecord(root?.check_suite);
      const suiteStatus = pickStr(checkSuite, "status");
      const suiteConclusion = pickStr(checkSuite, "conclusion");
      const isTerminalFailure =
        suiteStatus === "completed" &&
        (suiteConclusion === "failure" ||
          suiteConclusion === "timed_out" ||
          suiteConclusion === "action_required" ||
          suiteConclusion === "startup_failure");
      if (!isTerminalFailure) {
        const desc = suiteStatus ? `status '${suiteStatus}'` : (action ? `action '${action}'` : "pending");
        return {
          ignore: true,
          reason: `GitHub check_suite ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else if (eventName === "workflow_job") {
      const workflowJob = asRecord(root?.workflow_job);
      const jobStatus = pickStr(workflowJob, "status");
      const jobConclusion = pickStr(workflowJob, "conclusion");
      const isTerminalFailure =
        jobStatus === "completed" &&
        (jobConclusion === "failure" ||
          jobConclusion === "timed_out" ||
          jobConclusion === "action_required" ||
          jobConclusion === "startup_failure");
      if (!isTerminalFailure) {
        const desc = jobStatus ? `status '${jobStatus}'` : (action ? `action '${action}'` : "pending");
        return {
          ignore: true,
          reason: `GitHub workflow_job ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else if (eventName === "pull_request") {
      const pr = asRecord(root?.pull_request);
      const isMerged = action === "closed" && (pr?.merged === true || pickStr(pr, "merged_at") !== undefined);
      if (!isMerged) {
        const desc = action === "closed" ? "unmerged closed" : `action '${action ?? "unknown"}'`;
        return {
          ignore: true,
          reason: `GitHub pull_request ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else if (eventName === "status") {
      const state = pickStr(root, "state");
      const isTerminalFailure = state === "failure" || state === "error";
      if (!isTerminalFailure) {
        const desc = state ? `state '${state}'` : "pending";
        return {
          ignore: true,
          reason: `GitHub status ${desc} ignored: compile gates wait for concluded failure or merged PR`,
        };
      }
    } else {
      return {
        ignore: true,
        reason: `GitHub event '${eventName ?? "unknown"}' ignored: compile gates wait for concluded failure or merged PR`,
      };
    }
  }

  return { ignore: false };
}

/** Sentry issue-webhook project slug, when the payload carries one. */
export function sentryProjectSlug(payload: JsonValue): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const data = asRecord(root.data) ?? root;
  const issue = asRecord(data.issue);
  const ev = asRecord(data.event) ?? asRecord(root.event);
  const projectValue = issue?.project ?? ev?.project ?? data.project ?? root.project;
  if (typeof projectValue === "string" && projectValue.trim()) return projectValue.trim();
  const project = asRecord(projectValue);
  const slug = project?.slug ?? project?.name;
  return typeof slug === "string" && slug.trim() ? slug.trim() : undefined;
}

export const FLEET_INFRA_SENTRY_PROJECT = "fleet-infra";
export const PLUMBER_BOT_NAME = "Plumber";

export function resolveWebhookBotId(
  trigger: { botId: string; name: string },
  payload: JsonValue,
  findBotIdByName?: (name: string) => string | undefined,
  botState?: (botId: string) => "ready" | "busy" | "missing",
): { botId: string; skipConfiguredPrompt: boolean } {
  // Name is owner-configured, not attacker-controlled.  Do not reroute an
  // unrelated webhook just because its untrusted JSON mentioned fleet-infra.
  if (!/\bsentry\b/i.test(trigger.name)) {
    return { botId: trigger.botId, skipConfiguredPrompt: false };
  }
  if (sentryProjectSlug(payload) !== FLEET_INFRA_SENTRY_PROJECT) {
    return { botId: trigger.botId, skipConfiguredPrompt: false };
  }
  const plumberId = findBotIdByName?.(PLUMBER_BOT_NAME)?.trim();
  if (!plumberId || plumberId === trigger.botId) {
    return { botId: trigger.botId, skipConfiguredPrompt: false };
  }
  if (botState?.(plumberId) === "missing") {
    return { botId: trigger.botId, skipConfiguredPrompt: false };
  }
  return { botId: plumberId, skipConfiguredPrompt: true };
}

function eventPrompt(
  trigger: StoredWebhookTrigger,
  event: WebhookEvent,
  receivedAt: number,
  deliveryId: string,
  opts?: { skipConfiguredPrompt?: boolean },
): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${deliveryId}`,
    event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
    event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
    event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
  ].filter(Boolean);
  const configured = opts?.skipConfiguredPrompt ? "" : trigger.prompt.trim();
  const requestedTask = configured ? "" : taskFromPayload(event.payload);
  const instructionBlock = configured
    ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
    : requestedTask
      ? ["[AUTHENTICATED WEBHOOK TASK]", requestedTask, "[/AUTHENTICATED WEBHOOK TASK]"]
      : [
          "[DEFAULT WEBHOOK INSTRUCTIONS]",
          "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
          "[/DEFAULT WEBHOOK INSTRUCTIONS]",
        ];
  return [
    ...instructionBlock,
    "",
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    ...metadata,
    "",
    serializePayload(event.payload),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  private attempts: WebhookAttempt[] = [];
  private rate = new Map<string, number[]>();
  private recentIgnored = new Map<string, number[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    this.now = options.now ?? Date.now;
    try {
      const rawText = readFileSync(this.file, "utf8");
      const parsed = webhookFileSchema.safeParse(parseJson(rawText));
      if (!parsed.success) throw parsed.error;
      this.webhooks = parsed.data.webhooks;
      this.deliveries = parsed.data.deliveries.slice(-MAX_DELIVERIES);
      this.attempts = (parsed.data.attempts ?? []).slice(-MAX_ATTEMPTS);
      // One-shot: rewrite legacy runOn "maus" → "bot" on disk.
      if (/"runOn"\s*:\s*"maus"/.test(rawText)) this.save();
    } catch {
      this.webhooks = [];
      this.deliveries = [];
      this.attempts = [];
    }
  }

  list(): WebhookTrigger[] {
    return this.webhooks.map(publicTrigger);
  }

  listAttempts(): WebhookAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  create(input: JsonValue): CreatedWebhook {
    const clean = cleanInput(parseTriggerInput(input));
    if (this.options.botState(clean.botId) === "missing") fail(400, "That Bot no longer exists");
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
    };
    this.webhooks.unshift(trigger);
    // The caller is about to receive the only copy of this secret, so its
    // hash must be on disk before we return — a crash inside a debounce
    // window would otherwise hand out a secret no restarted harness accepts.
    // If the write fails, undo the insert so memory never runs ahead of disk.
    try {
      this.saveNow();
    } catch (error) {
      const at = this.webhooks.indexOf(trigger);
      if (at !== -1) this.webhooks.splice(at, 1);
      throw error;
    }
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  update(id: string, value: JsonValue): WebhookTrigger | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const patch = parseTriggerPatch(value);
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: patch.botId ?? trigger.botId,
      runOn: patch.runOn ?? trigger.runOn,
      enabled: patch.enabled ?? trigger.enabled,
      verificationPending: patch.verificationPending ?? trigger.verificationPending,
      eventTypes: patch.eventTypes ?? trigger.eventTypes,
      minGapMinutes: patch.minGapMinutes ?? trigger.minGapMinutes,
    });
    if (this.options.botState(clean.botId) === "missing") fail(400, "That Bot no longer exists");
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (!clean.eventTypes?.length) delete trigger.eventTypes;
    if (!clean.minGapMinutes) delete trigger.minGapMinutes;
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(id: string): boolean {
    const at = this.webhooks.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    const [trigger] = this.webhooks.splice(at, 1);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
    this.rate.delete(trigger.endpointId);
    this.recentIgnored.delete(trigger.id);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
    return true;
  }

  rotateSecret(id: string): { webhook: WebhookTrigger; secret: string } | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const secret = newSecret();
    const previous = { secretHash: trigger.secretHash, updatedAt: trigger.updatedAt };
    trigger.secretHash = hashSecret(secret);
    trigger.updatedAt = this.now();
    // Same contract as create(): the new hash is durable before the secret is
    // returned, so a crash cannot leave the rotated-out secret valid on disk
    // after the caller was told it was replaced.  A failed write restores the
    // old hash and throws instead of returning a secret that never landed.
    try {
      this.saveNow();
    } catch (error) {
      Object.assign(trigger, previous);
      throw error;
    }
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.webhooks) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.options.cancelQueued?.(trigger.id, "The assigned Bot was deleted");
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    if (trigger.verificationPending && !trigger.enabled) return this.captureVerification(trigger, event);
    try {
      return this.dispatch(trigger, event);
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      this.recordRejectedForTrigger(trigger, status, error instanceof Error ? error.message : String(error), event);
      throw error;
    }
  }

  test(id: string, payload: JsonValue = { event: "botfleet.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const eventName = trigger.eventTypes?.[0] ?? "botfleet.test";
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName,
      userAgent: "BotFleet webhook tester",
      deliveryId: `test-${randomUUID()}`,
    });
  }

  recordRejected(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
  }

  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    if (!trigger.enabled) fail(409, "This webhook is paused");
    if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned Bot no longer exists");

    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const duplicate = this.deliveries.find((delivery) => delivery.key === key);
      if (duplicate) {
        this.appendAttempt(trigger, event, {
          outcome: "duplicate",
          statusCode: 202,
          deliveryId: requestedDeliveryId,
          runId: duplicate.runId,
          reason: "Duplicate delivery ignored",
        });
        this.save();
        return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
      }
    }

    const allowed = trigger.eventTypes ?? [];
    if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
      const deliveryId = requestedDeliveryId || randomUUID();
      this.recordIgnoredAttempt(
        trigger,
        event,
        deliveryId,
        event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
      );
      return { deliveryId, duplicate: false, ignored: true };
    }

    const route = resolveWebhookBotId(
      trigger,
      event.payload,
      this.options.findBotIdByName,
      this.options.botState,
    );

    if (!route.skipConfiguredPrompt) {
      const ignoreDecision = shouldIgnoreWebhookEvent(trigger, event);
      if (ignoreDecision.ignore) {
        const deliveryId = requestedDeliveryId || randomUUID();
        this.recordIgnoredAttempt(
          trigger,
          event,
          deliveryId,
          ignoreDecision.reason ?? "Ignored by trigger ingress filter",
        );
        return { deliveryId, duplicate: false, ignored: true };
      }
    }

    const now = this.now();

    // A sender retrying an already-accepted delivery must remain idempotent
    // even while this webhook's queue is full. Only new work consumes a slot.
    if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING_RUNS) {
      fail(429, "This webhook already has too many unfinished tasks");
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);

    const deliveryId = requestedDeliveryId || randomUUID();
    const run = this.options.enqueue({
      webhookId: trigger.id,
      webhookName: trigger.name,
      prompt: eventPrompt(trigger, event, now, deliveryId, {
        skipConfiguredPrompt: route.skipConfiguredPrompt,
      }),
      botId: route.botId,
      runOn: trigger.runOn,
      deliveryId,
      receivedAt: now,
    });
    this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    trigger.lastReceivedAt = now;
    trigger.lastRunId = run.id;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.appendAttempt(trigger, event, {
      outcome: "accepted",
      statusCode: 202,
      deliveryId,
      runId: run.id,
    });
    // This just added a new entry to `this.deliveries` — the record that
    // makes a retried delivery idempotent. It must be durable before the
    // HTTP 202 is returned, or a restart between accepting this delivery and
    // a debounced flush would forget it, and the sender's retry would be
    // treated as new.  create() and rotateSecret() make the same exception
    // for newly issued secrets; every other save() here can coalesce.
    this.saveNow();
    this.emit(trigger);
    return { runId: run.id, deliveryId, duplicate: false };
  }

  private captureVerification(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    const receivedAt = this.now();
    const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
    trigger.verificationPending = false;
    trigger.verifiedAt = receivedAt;
    trigger.lastReceivedAt = receivedAt;
    trigger.updatedAt = receivedAt;
    const sample: WebhookVerificationSample = {
      receivedAt,
      preview: previewPayload(event.payload),
    };
    if (event.eventName) sample.eventName = event.eventName.slice(0, 200);
    if (event.contentType) sample.contentType = event.contentType.slice(0, 200);
    trigger.verificationSample = sample;
    this.appendAttempt(trigger, event, {
      outcome: "captured",
      statusCode: 202,
      deliveryId,
      reason: "Test event captured; enable the webhook to start Bot tasks",
    });
    this.save();
    this.emit(trigger);
    return { deliveryId, duplicate: false, captured: true };
  }

  private recordRejectedForTrigger(trigger: StoredWebhookTrigger, statusCode: number, reason: string, event: Partial<WebhookEvent>): WebhookAttempt {
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.save();
    return attempt;
  }

  private recordIgnoredAttempt(
    trigger: StoredWebhookTrigger,
    event: WebhookEvent,
    deliveryId: string,
    reason: string,
  ): void {
    const now = this.now();
    const recent = (this.recentIgnored.get(trigger.id) ?? []).filter(
      (at) => now - at < IGNORED_ATTEMPTS_WINDOW_MS,
    );
    if (recent.length < MAX_IGNORED_ATTEMPTS_PER_WINDOW) {
      recent.push(now);
      this.recentIgnored.set(trigger.id, recent);
      this.appendAttempt(trigger, event, {
        outcome: "ignored",
        statusCode: 202,
        deliveryId,
        reason,
      });
      this.save();
    }
  }

  private appendAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: Pick<WebhookAttempt, "outcome" | "statusCode"> & Partial<Pick<WebhookAttempt, "deliveryId" | "runId" | "reason">>,
  ): WebhookAttempt {
    const attempt: WebhookAttempt = {
      id: randomUUID(),
      webhookId: trigger.id,
      receivedAt: this.now(),
      outcome: details.outcome,
      statusCode: details.statusCode,
    };
    if (event.eventName) attempt.eventName = event.eventName.slice(0, 200);
    if (event.payload !== undefined) attempt.preview = previewPayload(event.payload);
    if (details.deliveryId) attempt.deliveryId = details.deliveryId.slice(0, 200);
    if (details.runId) attempt.runId = details.runId;
    if (details.reason) attempt.reason = details.reason;
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
    return attempt;
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  /** Coalesces bursts of save() calls — a push storm was one full
   * serialize-fsync-rename per event on the request path — into one write.
   * See flushNow() for the durability exception on the receive path. */
  private save(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushFromTimer(), SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Mark dirty and write through now.  For the few mutations that must be
   * durable before the call returns; throws if the write fails. */
  private saveNow(): void {
    this.dirty = true;
    this.flushNow();
  }

  /** The debounce timer's flush.  A throw here would be an uncaught exception
   * in a timer callback, so a failed write is logged instead; `dirty` stays
   * set, and the next save() or the shutdown flush retries the whole file. */
  private flushFromTimer(): void {
    this.saveTimer = null;
    try {
      this.flushNow();
    } catch (error) {
      console.error("webhooks: debounced save failed; the next save or shutdown retries it", error);
    }
  }

  /** Synchronous, immediate write-through — used by the receive path for the
   * new-delivery record (see dispatch()), by tests asserting on-disk state
   * right after a mutation, and by the shutdown path so a pending coalesced
   * save is never lost when the process exits. A no-op when nothing is
   * dirty.  `dirty` is cleared only after the write succeeds, so a failed
   * write throws with the pending mutation still marked for the next try. */
  flushNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries, attempts: this.attempts } satisfies WebhookFile),
      { mode: 0o600 },
    );
    this.dirty = false;
  }
}
