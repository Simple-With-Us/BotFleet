import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { TurnBillingMode } from "./contracts.ts";
import {
  aiTokensFromTurn,
  aiUsageTotalTokens,
  cleanAiUsage,
  tokenCount,
  type AiUsageBlock,
} from "./ai-usage.ts";
import { FailureLogDedup } from "./log-dedup.ts";
import { getSentry, isSentryActive } from "./sentry.ts";
import {
  UsageTelemetryOutbox,
  terminalStatusFor,
  usageTelemetryDestinationHash,
  type DurableTelemetryBatch,
  type TerminalHttpStatus,
} from "./telemetry-outbox.ts";

export interface TelemetryTurnParams {
  botId: string;
  botName: string;
  threadId: string;
  taskTitle?: string;
  cwd?: string | null;
  instanceId: string;
  modelId?: string;
  /** The whole context the turn sent: cache reads and cache writes are
   * INCLUDED (the driver contract, server/contracts.ts).  Telemetry splits
   * them back out. */
  inputTokens?: number;
  outputTokens?: number;
  /** The cache-read share of `inputTokens`. */
  cachedInputTokens?: number;
  /** The cache-write shares of `inputTokens`, by TTL.  A driver that cannot
   * tell the TTL reports its one figure as 5 minutes, as the shared usage
   * schema does. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** The reasoning share of `outputTokens`, for engines that report it. */
  reasoningTokens?: number;
  /** The model the provider says answered, when it says (`modelId` is the one
   * that was asked for). */
  servedModelId?: string;
  /** Turn start to the first streamed token, when anything streamed. */
  ttftMs?: number;
  /** The fleet seat the bot ran as, when the install assigns seats. */
  seat?: string;
  /** Why the turn ended (`end_turn`, `interrupted`, a terminal reason).  Only
   * read for a turn that reported no usage, to say why it did not. */
  stopReason?: string | null;
  costUsd?: number | null;
  /** Classifies costUsd as cash spend or a provider-reported equivalent. */
  billingMode?: TurnBillingMode;
  latencyMs?: number;
  success?: boolean;
  /** Set for a room turn, so Usage Monitor can tell shared-room spend from
   * a 1:1 task turn.  Absent on 1:1 turns; never an empty string. */
  roomId?: string;
  roomName?: string;
  /** The engine that ran the turn (`claudeAgent`, `codex`, `opencodeGo`, …).
   * Preferred over the instance-id heuristics when it is known, because an
   * instance id is operator-chosen and an engine id is not. */
  driverKind?: string;
  /** UTF-8 bytes of the system prompt the driver was handed, split at the
   * volatile boundary (server/system-prompt.ts): stable bytes ride the
   * cacheable prefix, volatile bytes are re-delivered in the turn that
   * changed them.  Present only when the server assembled a split prompt
   * for the turn; read against `cachedInputTokens` to see whether the
   * prefix is actually being cached. */
  promptBytes?: { stable: number; volatile: number };
  /** The child harness's own native session id for this turn (Claude
   * Code's `--session-id`, an ACP session, a Codex thread), when the child
   * reported one.  Stamped as `metadata.childSessionId` so Usage Monitor can
   * pair this event with the child's own telemetry and count the turn once. */
  childSessionId?: string;
  /** When the turn was dispatched, in epoch milliseconds. */
  turnStartedAtMs?: number;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** The configured ingest endpoint, or null when nothing is configured.
   * Never a placeholder: an unconfigured install has no endpoint to name. */
  ingestUrl: string | null;
  totalSent: number;
  totalFailed: number;
  queuedBatches: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
  droppedBatches: number;
  overflowDroppedBatches: number;
  destinationChangeDroppedBatches: number;
  rejectedEvents: number;
  failedAttempts: number;
  persistenceFailures: number;
  nonDurableBatches: number;
  corruptFilesQuarantined: number;
  terminalQuarantinedBatches: number;
  terminalQuarantineEvictedBatches: number;
  lastTerminalStatus: TerminalHttpStatus | null;
  lastTerminalAt: string | null;
  deadLetterBatches: number;
  deadLetterEvictedBatches: number;
  lastDeadLetterAt: string | null;
  lastAckAt: string | null;
  lastError: string | null;
}

/** One project-classification rule: any `match` substring found in the
 * working directory, bot name, or task title resolves to `slug`. */
export interface UsageProjectRule {
  slug: string;
  match: string[];
}

/** Everything telemetry reads out of app config. Every field is optional —
 * BotFleet ships no endpoint, no token, and no project names. */
export interface UsageSettings {
  ingestUrl?: string | null;
  ingestToken?: string | null;
  projects?: UsageProjectRule[];
}

/** The v2 metadata bag: a flat map of primitives, which is exactly what the
 * shared schema's `z.record` accepts (and all it accepts — a nested object
 * would be refused).  Values are clipped to 500 characters by the receiver. */
export type TelemetryMetadata = Record<string, string | number | boolean | null>;

/** One event exactly as it goes on the wire.  The v2 batch schema is
 * `.strict()`, so a key that is not in this shape rejects the whole event —
 * that is why the model id rides `producerKeyRef` and `metadata.model`
 * rather than a top-level `model` field. */
export interface TelemetryV2Event {
  eventId: string;
  environment: string;
  provider: string;
  service: string;
  project: string;
  label: string;
  producerKeyRef?: string;
  billingMode: "actual" | "estimated";
  metricType: "usage";
  quantity: number;
  unit: "request" | "token";
  requests: number;
  costUsd?: number;
  confidence: "actual" | "estimated";
  occurredAt: string;
  metadata: TelemetryMetadata;
  /** The canonical AI usage block (UM-1592).  Strict on the receiving side:
   * built only by `cleanAiUsage` so it never carries a key or value the
   * schema would refuse. */
  ai?: AiUsageBlock;
  // Durable outbox events are an open bag; this keeps v2 events assignable.
  [key: string]: unknown;
}

/** One v2 batch exactly as it goes on the wire.  `producerId` is the fleet
 * name Usage Monitor keys idempotency on, and `producerInstanceId` is this
 * computer — together with each event id they make a resend a duplicate
 * rather than a second charge. */
interface TelemetryV2Batch extends DurableTelemetryBatch {
  schemaVersion: 2;
  producerId: string;
  producerInstanceId: string;
  events: TelemetryV2Event[];
}

/** Usage Monitor's v2 ingest acknowledgement.  Counts only — the receiver
 * reports how many events it kept, never why one was refused. */
interface UsageIngestAck {
  received?: number;
  persisted?: number;
  duplicates?: number;
  pruned?: number;
  rejected?: number;
}

/** Which Usage Monitor provider row a turn belongs to, and which model
 * inside it.  `provider` is UM's canon; `service` is the model id. */
export interface ProviderAndService {
  provider: string;
  service: string;
}

const INGEST_PATH = "/api/ingest/usage";

/** Classify a turn into a project slug using the operator's own rules, in
 * order. With no rule matched (or no rules at all) the slug is derived from
 * the working directory's basename, so the stream stays useful without any
 * configuration and without shipping anybody's repo names. */
export function inferProject(
  cwd?: string | null,
  botName?: string,
  taskTitle?: string,
  projects?: UsageProjectRule[],
): string {
  const haystack = [cwd || "", botName || "", taskTitle || ""].join("\n").toLowerCase();

  for (const rule of projects ?? []) {
    const slug = (rule?.slug || "").trim();
    if (!slug) continue;
    const terms = (rule?.match ?? []).map((term) => String(term || "").trim().toLowerCase()).filter(Boolean);
    if (terms.some((term) => haystack.includes(term))) return slug;
  }

  if (cwd && cwd !== homedir() && cwd !== "/") {
    const base = basename(cwd).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    if (base.length > 0) return base;
  }

  return "general";
}

/** Engine id → Usage Monitor provider name.  These are UM's canon
 * (`provider-identity.ts` alias table), NOT Sentry's `gen_ai.system`
 * vocabulary in `sentry-ai.ts` — the two namespaces are deliberately
 * separate and must not be unified.
 *
 * Keys are normalised: lower-cased, non-alphanumerics dropped, a trailing
 * "agent" removed.  That makes one row cover the driver kind, the default
 * instance id, and any casing of either (`claudeAgent`, `claude`, `Claude`). */
const PROVIDER_BY_ENGINE = new Map<string, string>(Object.entries({
  claude: "anthropic",
  anthropic: "anthropic",
  codex: "openai",
  openai: "openai",
  grok: "xai",
  xai: "xai",
  antigravity: "google-ai",
  gemini: "google-ai",
  google: "google-ai",
  deepseek: "deepseek",
  dsh: "dsh",
  kimi: "moonshot",
  moonshot: "moonshot",
  cursor: "cursor",
  minimax: "minimax",
  mcode: "minimax",
  box: "box",
  // `computer` is the default instance id that rides the boxAgent driver.
  computer: "box",
  openrouter: "openrouter",
  droid: "droid",
  qwen: "qwen",
  hermes: "hermes",
  opencode: "opencode",
  opencodego: "opencode",
  pi: "pi",
}));

/** OpenAI-compatible is a shell over many providers, so the engine id alone
 * does not name one.  It is resolved after the model heuristics have had a
 * chance, and only then falls back to itself. */
const AMBIGUOUS_ENGINE = "openai-compat";

function normaliseEngine(value: string): string {
  const token = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return token.endsWith("agent") ? token.slice(0, -"agent".length) : token;
}

/** The provider this engine always speaks to, or null when the engine does
 * not settle the question by itself. */
function providerForEngine(engine?: string): string | null {
  if (!engine) return null;
  const raw = engine.trim().toLowerCase();
  if (raw === AMBIGUOUS_ENGINE || raw === "openaicompat") return null;
  return PROVIDER_BY_ENGINE.get(normaliseEngine(engine)) ?? null;
}

export function inferProviderAndService(
  instanceId: string,
  modelId?: string,
  driverKind?: string,
): ProviderAndService {
  const inst = (instanceId || "").toLowerCase();
  const model = (modelId || "").toLowerCase();
  const service = modelId || instanceId || "unknown";

  // MiniMax running under DSH / other bridges attributes to minimax
  if (model.includes("minimax")) {
    return { provider: "minimax", service: modelId || "unknown" };
  }

  // The engine wins when it names a provider on its own.  An instance id is
  // operator-chosen text; an engine id is ours.
  const fromEngine = providerForEngine(driverKind);
  if (fromEngine) return { provider: fromEngine, service: modelId || "unknown" };

  if (inst.includes("deepseek") || model.includes("deepseek")) {
    return { provider: "deepseek", service: modelId || "unknown" };
  }
  if (inst.includes("grok") || model.includes("grok")) {
    return { provider: "xai", service: modelId || "unknown" };
  }
  if (inst.includes("claude") || model.includes("claude") || model.includes("sonnet")) {
    return { provider: "anthropic", service: modelId || "unknown" };
  }
  if (inst.includes("codex") || model.includes("gpt") || model.includes("o1") || model.includes("o3")) {
    return { provider: "openai", service: modelId || "unknown" };
  }
  if (inst.includes("antigravity") || model.includes("gemini")) {
    return { provider: "google-ai", service: modelId || "unknown" };
  }
  if (inst.includes("cursor")) {
    return { provider: "cursor", service: modelId || "unknown" };
  }
  if (inst.includes("kimi") || model.includes("moonshot")) {
    return { provider: "moonshot", service: modelId || "unknown" };
  }

  // Still nothing: an OpenAI-compatible instance reports itself honestly
  // rather than claiming to be OpenAI.
  const engineFallback = driverKind ? normaliseEngine(driverKind) : "";
  if (driverKind && (driverKind.trim().toLowerCase() === AMBIGUOUS_ENGINE || engineFallback === "openaicompat")) {
    return { provider: AMBIGUOUS_ENGINE, service };
  }

  // Anything else falls back to the instance id verbatim.  Deliberately not
  // to `normaliseEngine(driverKind)`: an engine PROVIDER_BY_ENGINE does not
  // know is not canonical either, and normalising it strips punctuation and
  // a trailing "agent" — which would rename an operator's own instance
  // (`local_llm` → `localllm`, `computer-2` → `computer2`) into a second
  // Usage Monitor provider row and split that engine's spend history in two.
  // A name this table does not recognise is left exactly as it was written.
  return { provider: instanceId || "custom", service };
}

/** The v2 schema caps every string field, and it is `.strict()` about the
 * result: one over-long value rejects the whole event, which on this path
 * means a turn's spend silently never arrives.  Clipping at the source is
 * cheaper than losing the row. */
function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Which slice of a turn's tokens a LEGACY event reports.  Only the
 * unreported-turn event still carries one (`unknown`, which Usage Monitor's
 * legacy mapping treats as inert): a turn that reported usage is one event
 * with the `ai` block, not a slice per token type. */
type TokenType = "unknown";

/** Why a turn that reported no usage reported none.  Read it against
 * `stopReason`: a failed turn (a rate limit, a cancel, a spawn error) ends
 * before any usage frame, and an engine that streams only a context
 * occupancy figure (DSH's ACP server) can end a good turn without one. */
type UsageGap = "failed" | "unreported";

/** Exactly the metadata one turn stamps on its event.  Named rather than the
 * open `TelemetryMetadata` bag so the keys are a contract: the nine that have
 * always ridden along, the room fields a room turn adds, the two prompt-byte
 * figures a split system prompt adds (flat numbers, because the v2 bag
 * accepts only primitives), and the ones BF-2435 adds.  The canonical figures
 * live in the `ai` block;  the legacy keys stay so a reader that predates
 * the block still sees the turn. */
type TurnMetadata = {
  botName: string;
  botId: string;
  threadId: string;
  /** The whole context sent, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  cacheWriteOneHourTokens?: number;
  reasoningTokens?: number;
  cwd: string | null;
  latencyMs?: number;
  ttftMs?: number;
  success: boolean;
  tokenType?: TokenType;
  model: string | null;
  servedModel?: string;
  seat?: string;
  instanceId: string;
  usageReported: boolean;
  usageGap?: UsageGap;
  stopReason?: string;
  estimatedCostUsd?: number;
  roomId?: string;
  roomName?: string;
  promptStableBytes?: number;
  promptVolatileBytes?: number;
  /** The engine that ran the turn, verbatim (`claudeAgent`, `codex`,
   * `opencodeGo`, `mcodeAgent`, `dshAgent`, `minimax`, …). */
  childHarness?: string;
  /** The child's native session id; absent when unknown, never blank. */
  childSessionId?: string;
  /** ISO time the turn began, when known. */
  turnStartedAt?: string;
};

/** Turn one completed turn into the events that go on the wire.
 *
 * One event per turn, carrying the canonical `ai` block (UM-1592, BF-2435).
 * It replaces the three `tokenType` slice events this used to emit, which
 * each repeated the turn's totals in metadata and which had no place for a
 * cache write.  Usage Monitor sums `ai.tokens` across events, so a turn is
 * reported ONCE.
 *
 * No cache double count.  A driver's `input` figure is the whole context,
 * cache reads and cache writes included (`drivers/claude.ts` sums
 * `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
 * into one number, and names the cached shares beside it).  The `ai` block
 * wants UNCACHED input, so the cache shares are subtracted back out and
 * reported in their own buckets, each priced at its own rate: reads at the
 * read rate, 5 minute and 1 hour writes at the write rates.  The event
 * `quantity` is the sum of the buckets, which is what the slices summed to.
 *
 * Actual money lands once, on the event: `costUsd` is the turn's cash
 * charge.  A subscription-equivalent estimate rides metadata
 * (`estimatedCostUsd`) and never enters Usage Monitor's actual-spend pool;
 * `ai.billingMode` and `ai.costSource` say which kind of figure it is.
 *
 * An unreported turn says so.  A turn with no token figures at all emits one
 * `quantity: 0` event flagged `usageReported: false` and no `ai` block (an
 * `ai` block on it would put a tokenless row in the per-request view), with
 * `usageGap` and `stopReason` saying why there is nothing to count. */
export function buildTurnEvents(
  params: TelemetryTurnParams,
  opts: { projects?: UsageProjectRule[]; now?: number } = {},
): TelemetryV2Event[] {
  const inferred = inferProviderAndService(params.instanceId, params.modelId, params.driverKind);
  const provider = clip(inferred.provider, 80);
  const service = clip(inferred.service, 120);
  const project = clip(inferProject(params.cwd, params.botName, params.taskTitle, opts.projects), 120);

  const inTokens = tokenCount(params.inputTokens);
  const outTokens = tokenCount(params.outputTokens);
  const cachedTokens = tokenCount(params.cachedInputTokens);
  const cacheWrite5m = tokenCount(params.cacheWrite5mTokens);
  const cacheWrite1h = tokenCount(params.cacheWrite1hTokens);
  const reasoningTokens = Math.min(tokenCount(params.reasoningTokens), outTokens);

  const now = opts.now ?? Date.now();
  const occurredAt = new Date(now).toISOString();
  // `:none` and `:turn` are the longest suffixes, so reserving five characters
  // keeps every id under the schema's 200-character cap.
  const prefix = clip(`bf:${provider}:${params.botId}:${now}:${randomUUID().slice(0, 8)}`, 195);
  const label = clip(params.taskTitle || params.botName || "turn", 160);
  const environment = process.env.NODE_ENV === "production" ? "production" : "operator";
  const keyRef = clip((params.modelId || "").trim(), 160);
  const servedModel = clip((params.servedModelId || "").trim(), 160);
  const seat = clip((params.seat || "").trim(), 80);
  const roomId = (params.roomId || "").trim();
  const roomName = (params.roomName || "").trim();

  // A cost that is not a finite, non-negative number is not a cost.  The
  // schema refuses a negative `costUsd` and would take the whole event down
  // with it, so an unusable figure is dropped rather than sent.
  const reportedCost =
    params.costUsd != null && Number.isFinite(params.costUsd) && params.costUsd >= 0 ? params.costUsd : null;
  const estimatedCost = params.billingMode === "estimated" ? reportedCost : null;
  const cost = params.billingMode === "estimated" ? null : reportedCost;
  // The prompt halves' byte counts are a size, never a spend: two flat
  // non-negative integers, or nothing when the turn's prompt was not split.
  const promptBytes = params.promptBytes
    && Number.isFinite(params.promptBytes.stable) && Number.isFinite(params.promptBytes.volatile)
    ? { stable: Math.max(0, Math.round(params.promptBytes.stable)), volatile: Math.max(0, Math.round(params.promptBytes.volatile)) }
    : null;

  const tokens = aiTokensFromTurn({
    input: inTokens,
    output: outTokens,
    cachedInput: cachedTokens,
    cacheWrite5m,
    cacheWrite1h,
    reasoning: reasoningTokens,
  });
  const total = aiUsageTotalTokens(tokens);
  const usageReported = total > 0;
  const success = params.success !== false;

  const metadata: TurnMetadata = {
    botName: params.botName,
    botId: params.botId,
    threadId: params.threadId,
    inputTokens: inTokens,
    outputTokens: outTokens,
    cachedInputTokens: cachedTokens,
    cwd: params.cwd || null,
    success,
    model: keyRef || null,
    instanceId: params.instanceId,
    usageReported,
  };
  if (cacheWrite5m > 0) metadata.cacheWriteTokens = cacheWrite5m;
  if (cacheWrite1h > 0) metadata.cacheWriteOneHourTokens = cacheWrite1h;
  if (reasoningTokens > 0) metadata.reasoningTokens = reasoningTokens;
  if (params.latencyMs !== undefined && Number.isFinite(params.latencyMs) && params.latencyMs >= 0) {
    metadata.latencyMs = params.latencyMs;
  }
  if (params.ttftMs !== undefined && Number.isFinite(params.ttftMs) && params.ttftMs >= 0) {
    metadata.ttftMs = params.ttftMs;
  }
  if (servedModel) metadata.servedModel = servedModel;
  if (seat) metadata.seat = seat;
  if (roomId) {
    metadata.roomId = roomId;
    if (roomName) metadata.roomName = roomName;
  }
  if (estimatedCost != null) metadata.estimatedCostUsd = estimatedCost;
  if (promptBytes) {
    metadata.promptStableBytes = promptBytes.stable;
    metadata.promptVolatileBytes = promptBytes.volatile;
  }
  // De-duplication keys against the child harness's own telemetry.  Decided
  // here, once, from the turn's own facts: the event is persisted as built
  // and a replay must carry exactly the same content.
  const childHarness = clip((params.driverKind || "").trim(), 80);
  if (childHarness) metadata.childHarness = childHarness;
  const childSessionId = clip((params.childSessionId || "").trim(), 200);
  if (childSessionId) metadata.childSessionId = childSessionId;
  if (
    params.turnStartedAtMs !== undefined &&
    Number.isFinite(params.turnStartedAtMs) &&
    params.turnStartedAtMs > 0
  ) {
    // A finite number past the Date range is an Invalid Date, whose
    // toISOString throws; one optional key must never cost the turn's event.
    const started = new Date(params.turnStartedAtMs);
    if (!Number.isNaN(started.getTime())) metadata.turnStartedAt = started.toISOString();
  }
  if (!usageReported) {
    metadata.tokenType = "unknown";
    metadata.usageGap = success ? "unreported" : "failed";
    const stopReason = (params.stopReason ?? "").trim();
    if (stopReason) metadata.stopReason = clip(stopReason, 80);
  }

  const priced = cost != null;
  const event: TelemetryV2Event = {
    eventId: `${prefix}:${usageReported ? "turn" : "none"}`,
    environment,
    provider,
    service,
    project,
    label,
    billingMode: priced ? "actual" : "estimated",
    metricType: "usage",
    quantity: total,
    unit: "token",
    // The turn is one request.
    requests: 1,
    confidence: priced ? "actual" : "estimated",
    occurredAt,
    metadata,
  };
  if (keyRef) event.producerKeyRef = keyRef;
  if (cost != null) event.costUsd = cost;
  if (usageReported) {
    const ai = cleanAiUsage({
      model: { requested: keyRef, served: servedModel },
      harness: "botfleet",
      seat,
      tokens,
      durationMs: params.latencyMs,
      ttftMs: params.ttftMs,
      // The engine bills a subscription seat (`estimated`: the equivalent API
      // price) or pay-as-you-go (`actual`).  An engine that priced nothing
      // says nothing rather than guessing a mode.
      billingMode: params.billingMode === "estimated" ? "subscription" : params.billingMode === "actual" ? "payg" : undefined,
      costSource:
        params.billingMode === "estimated" ? "estimated" : params.billingMode === "actual" && cost != null ? "billed" : undefined,
    });
    if (ai) event.ai = ai;
  }
  return [event];
}

/** Spend that is not a chat turn: a synthesized clip, a generated avatar, a
 * speech summary, a voice-call token.  Nothing here carries prompt text, a
 * key, or a task title. */
export interface TelemetryAuxParams {
  kind: "tts" | "avatar-image" | "speech-summary" | "sts-session";
  /** Usage Monitor's provider name for who was paid. */
  provider: string;
  /** The model, voice engine or surface inside that provider. */
  service: string;
  label: string;
  /** `token` when the provider reported tokens (then `ai.tokens` is the
   * measure), else `request`: a count of calls, with the real measure
   * (characters, images) in `metadata`. */
  unit?: "request" | "token";
  /** How many units; defaults to 1 request. */
  quantity?: number;
  costUsd?: number | null;
  /** Whether `costUsd` is a charge or an estimate.  Absent means unpriced. */
  billingMode?: "actual" | "estimated";
  latencyMs?: number;
  success?: boolean;
  ai?: AiUsageBlock;
  /** Flat primitives only; the outbox keeps just the keys it allowlists. */
  metadata?: TelemetryMetadata;
}

/** One v2 event for non-turn spend.  The same envelope as a turn event, so
 * Usage Monitor attributes it to the same producer and the same idempotency
 * rules apply. */
export function buildAuxEvent(params: TelemetryAuxParams, opts: { now?: number } = {}): TelemetryV2Event {
  const now = opts.now ?? Date.now();
  const provider = clip(params.provider.trim() || "custom", 80);
  const service = clip(params.service.trim() || "unknown", 120);
  const ai = params.ai ? cleanAiUsage({ harness: "botfleet", ...params.ai }) : undefined;
  const unit = params.unit ?? "request";
  const quantity = unit === "token" ? aiUsageTotalTokens(ai?.tokens) : Math.max(0, Math.round(params.quantity ?? 1));
  const cost =
    params.costUsd != null && Number.isFinite(params.costUsd) && params.costUsd >= 0 ? params.costUsd : null;
  const priced = cost != null && params.billingMode !== undefined;
  const metadata: TelemetryMetadata = {
    kind: params.kind,
    success: params.success !== false,
    ...params.metadata,
  };
  if (params.latencyMs !== undefined && Number.isFinite(params.latencyMs) && params.latencyMs >= 0) {
    metadata.latencyMs = params.latencyMs;
  }
  const event: TelemetryV2Event = {
    eventId: clip(`bf:${provider}:${params.kind}:${now}:${randomUUID().slice(0, 8)}`, 200),
    environment: process.env.NODE_ENV === "production" ? "production" : "operator",
    provider,
    service,
    project: "general",
    label: clip(params.label, 160),
    producerKeyRef: service,
    billingMode: priced && params.billingMode === "actual" ? "actual" : "estimated",
    metricType: "usage",
    quantity,
    unit,
    requests: 1,
    confidence: priced && params.billingMode === "actual" ? "actual" : "estimated",
    occurredAt: new Date(now).toISOString(),
    metadata,
  };
  if (cost != null && params.billingMode === "actual") event.costUsd = cost;
  if (cost != null && params.billingMode === "estimated") event.metadata.estimatedCostUsd = cost;
  if (ai) event.ai = ai;
  return event;
}

/** The BF-2435 details of a settled turn, read off its `turn.completed`: the
 * cache writes by TTL, the reasoning share, the served model, time to first
 * token, the seat, and why it ended.  Spread into `trackTurn` so the 1:1 and
 * room sites cannot report different things.  Each key is present only when
 * the turn actually said it, never a fabricated zero. */
export function turnUsageDetail(
  event: {
    usage?: { cacheWrite5m?: number; cacheWrite1h?: number; reasoning?: number };
    servedModel?: string;
    stopReason?: string | null;
  },
  timing: { ttftMs?: number } | undefined,
  seat: string | null | undefined,
): Pick<
  TelemetryTurnParams,
  "cacheWrite5mTokens" | "cacheWrite1hTokens" | "reasoningTokens" | "servedModelId" | "ttftMs" | "seat" | "stopReason"
> {
  const detail: ReturnType<typeof turnUsageDetail> = {};
  if (event.usage?.cacheWrite5m !== undefined) detail.cacheWrite5mTokens = event.usage.cacheWrite5m;
  if (event.usage?.cacheWrite1h !== undefined) detail.cacheWrite1hTokens = event.usage.cacheWrite1h;
  if (event.usage?.reasoning !== undefined) detail.reasoningTokens = event.usage.reasoning;
  if (event.servedModel) detail.servedModelId = event.servedModel;
  if (timing?.ttftMs !== undefined) detail.ttftMs = timing.ttftMs;
  if (seat) detail.seat = seat;
  if (event.stopReason !== undefined) detail.stopReason = event.stopReason;
  return detail;
}

export class UsageTelemetryManager {
  private totalSent = 0;
  private totalFailed = 0;
  private lastAckAt: string | null = null;
  private lastError: string | null = null;
  private readonly outbox: UsageTelemetryOutbox | null;

  constructor(options: { enableOutbox?: boolean; outboxPath?: string; retryBaseMs?: number } = {}) {
    const enableOutbox = options.enableOutbox ?? process.env.NODE_ENV !== "test";
    this.outbox = enableOutbox
      ? new UsageTelemetryOutbox({
        // The outbox itself requires an explicit path and will not pick a
        // homedir default.  Production still needs a durable location when
        // neither options nor env named one.
        path: options.outboxPath
          ?? process.env.BOTFLEET_USAGE_OUTBOX_PATH
          ?? join(DATA_DIR, "usage-telemetry-outbox.json"),
        retryBaseMs: options.retryBaseMs,
        onDiagnostic: (outcome, count) => {
          if (!isSentryActive()) return;
          getSentry()?.metrics.count("usage_telemetry.outbox", count, {
            attributes: { outcome },
          });
        },
      })
      : null;
  }

  /** Collapses repeats of the SAME failure (an HTTP status, a dispatch
   * exception, an unusable destination) into one line plus a ten-minute
   * summary instead of one line per attempt — two days of `server.log` held
   * 279 `[telemetry]` lines, almost all repeats of the same failure (HS23). */
  private readonly failureLog = new FailureLogDedup({
    summaryIntervalMs: 10 * 60_000,
    log: (message) => console.warn(`[telemetry] ${message}`),
    formatSummary: (count, since, last) => `${count} telemetry sends failed since ${since} (last: ${last})`,
  });

  /** Live view of app config, installed by the server at boot. A getter (not
   * a snapshot) so a settings change takes effect without a restart. */
  private settingsProvider: (() => UsageSettings | undefined) | null = null;

  configure(provider: (() => UsageSettings | undefined) | null): void {
    this.settingsProvider = provider;
    // A new (or cleared) settings provider means whatever failure run was
    // in progress under the OLD provider no longer applies — drop it
    // silently rather than let a stale count resurface as a misleading
    // summary under the new configuration.
    this.failureLog.clear();
    this.outbox?.configure(provider
      ? () => {
          const config = this.getIngestConfig();
          if (!config) return null;
          const endpoint = `${config.baseUrl}${INGEST_PATH}`;
          return {
            destinationHash: usageTelemetryDestinationHash(endpoint),
            deliver: (batch: DurableTelemetryBatch) =>
              this.postBatch(endpoint, config.token, batch),
          };
        }
      : null);
  }

  private settings(): UsageSettings {
    try {
      return this.settingsProvider?.() ?? {};
    } catch {
      return {};
    }
  }

  /** `baseUrl`/`token` are honored only once they are actually usable.
   * `settings.ingestUrl` is already validated by `usageIngestUrl()`
   * (`isAbsoluteHttpUrl`, same `new URL()` check as below) before it ever
   * reaches here — but the `USAGE_MONITOR_INGEST_URL` env-var fallback on
   * the next line is NOT, and neither token fallback strips anything but
   * leading/trailing whitespace.  A malformed URL or a token carrying an
   * internal control character makes `fetch()` itself throw `TypeError` on
   * every dispatch attempt — 25 such throws over two days in the field,
   * each classified as merely-retryable and retried forever by the outbox
   * (OP2d).  Rejecting here means the bad input is validated once and
   * logged once (deduped like every other failure below) instead of thrown
   * per batch, and the outbox is told "not configured" rather than handed
   * a batch it can never deliver. */
  private getIngestConfig(): { baseUrl: string; token: string } | null {
    const settings = this.settings();
    // Config first, env as the fallback that keeps existing installs working.
    const rawUrl = (settings.ingestUrl || process.env.USAGE_MONITOR_INGEST_URL || "").trim();
    let baseUrl = rawUrl.replace(/\/+$/, "");
    if (baseUrl.endsWith(INGEST_PATH)) {
      baseUrl = baseUrl.slice(0, -INGEST_PATH.length).replace(/\/+$/, "");
    }

    const token =
      settings.ingestToken?.trim() ||
      process.env.USAGE_MONITOR_INGEST_TOKEN?.trim() ||
      process.env.USAGE_INGEST_TOKEN?.trim();

    if (!baseUrl || !token) return null;

    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported scheme "${parsed.protocol}"`);
      }
    } catch {
      this.failureLog.report("config:bad-url", `ingest URL is not usable: ${baseUrl}`);
      return null;
    }
    // A bearer token becomes a raw HTTP header value; CR/LF/NUL are invalid
    // there and are exactly what turns a `fetch()` call into a thrown
    // TypeError rather than a rejected Response.
    if (/[\r\n\0]/.test(token)) {
      this.failureLog.report("config:bad-token", "ingest token contains control characters");
      return null;
    }

    return { baseUrl, token };
  }

  getStatus(): TelemetryStatus {
    const config = this.getIngestConfig();
    const outbox = this.outbox?.status() ?? {
      queuedBatches: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeMs: null,
      droppedBatches: 0,
      overflowDroppedBatches: 0,
      destinationChangeDroppedBatches: 0,
      rejectedEvents: 0,
      failedAttempts: 0,
      persistenceFailures: 0,
      nonDurableBatches: 0,
      corruptFilesQuarantined: 0,
      terminalQuarantinedBatches: 0,
      terminalQuarantineEvictedBatches: 0,
      lastTerminalStatus: null,
      lastTerminalAt: null,
      deadLetterBatches: 0,
      deadLetterEvictedBatches: 0,
      lastDeadLetterAt: null,
    };
    return {
      enabled: config !== null,
      ingestUrl: config ? `${config.baseUrl}${INGEST_PATH}` : null,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      lastAckAt: this.lastAckAt,
      lastError: this.lastError,
      ...outbox,
    };
  }

  /** POST one probe event and wait for the Usage Monitor ACK.  Used by
   * Settings → Test Connection so the operator can see the token works
   * without waiting for a bot turn. */
  async probe(): Promise<{ ok: boolean; error: string | null; ingestUrl: string | null }> {
    const config = this.getIngestConfig();
    if (!config) {
      return {
        ok: false,
        error: "Set a Usage Monitor URL and ingest token first.",
        ingestUrl: null,
      };
    }
    const endpoint = `${config.baseUrl}${INGEST_PATH}`;
    const eventId = `bf:probe:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const batch: TelemetryV2Batch = {
      schemaVersion: 2,
      producerId: "botfleet",
      producerInstanceId: hostname(),
      events: [
        {
          eventId,
          environment: process.env.NODE_ENV === "production" ? "production" : "operator",
          provider: "botfleet",
          service: "connection-test",
          project: "general",
          label: "BotFleet connection test",
          billingMode: "estimated",
          metricType: "usage",
          quantity: 1,
          unit: "token",
          requests: 1,
          confidence: "estimated",
          occurredAt: new Date().toISOString(),
          metadata: { probe: true, success: true },
        },
      ],
    };
    const posted = await this.postBatch(endpoint, config.token, batch);
    posted.onPersisted?.();
    return { ok: posted.ok, error: posted.error, ingestUrl: endpoint };
  }

  trackTurn(params: TelemetryTurnParams): void {
    const config = this.getIngestConfig();
    if (!config) return;
    this.enqueueEvents(config, buildTurnEvents(params, { projects: this.settings().projects }));
  }

  /** Report spend that is not a chat turn.  Best effort and silent when no
   * Usage Monitor is configured, like `trackTurn`: accounting must never
   * make a clip, an avatar or a call fail. */
  trackAux(params: TelemetryAuxParams): void {
    const config = this.getIngestConfig();
    if (!config) return;
    try {
      this.enqueueEvents(config, [buildAuxEvent(params)]);
    } catch (error) {
      this.failureLog.report("aux-build", `could not build a ${params.kind} event: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  private enqueueEvents(config: { baseUrl: string; token: string }, events: TelemetryV2Event[]): void {
    if (events.length === 0) return;

    const batch: TelemetryV2Batch = {
      schemaVersion: 2,
      producerId: "botfleet",
      producerInstanceId: hostname(),
      events,
    };

    const endpoint = `${config.baseUrl}${INGEST_PATH}`;
    if (this.outbox) {
      this.outbox.enqueue(usageTelemetryDestinationHash(endpoint), batch);
      return;
    }
    void this.postBatch(endpoint, config.token, batch).then((posted) => posted.onPersisted?.());
  }

  async dispose(): Promise<void> {
    await this.outbox?.dispose();
  }

  private async postBatch(
    endpoint: string,
    token: string,
    batch: DurableTelemetryBatch,
  ): Promise<{ ok: boolean; error: string | null; acknowledged: boolean; rejected: number; terminalStatus?: TerminalHttpStatus; onPersisted?: () => void }> {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        // A 200 is not the same as "kept".  Usage Monitor answers with per
        // batch counts, and a batch it validated but refused comes back as
        // 200 with `rejected` set — which used to be filed as a clean send.
        // A complete count invariant is the durable-delivery boundary.  A
        // malformed or partial 2xx body remains queued for idempotent replay.
        // SAFETY: isCompleteUsageIngestAck validates every field and the
        // count invariant before any value is treated as acknowledged.
        const ack = (await res.json().catch(() => null)) as UsageIngestAck | null;
        if (!isCompleteUsageIngestAck(ack, batch.events.length)) {
          const error = "Usage Monitor returned an ambiguous acknowledgement";
          this.totalFailed += 1;
          this.lastError = error;
          this.failureLog.report("ambiguous", error);
          return { ok: false, error, acknowledged: false, rejected: 0 };
        }
        const rejected = ackCount(ack?.rejected);
        const received = ackCount(ack?.received);
        this.lastAckAt = new Date().toISOString();
        if (rejected > 0) {
          const error = `Usage Monitor rejected ${rejected} of ${received || rejected} events`.slice(0, 200);
          this.totalFailed += rejected;
          this.lastError = error;
          this.failureLog.report("rejected", `ingest rejected ${rejected} of ${received || rejected} events`);
          return { ok: false, error, acknowledged: true, rejected };
        }
        this.lastError = null;
        // Healthy again: print any pending "N failed since…" summary now
        // rather than let it wait out the full window, and start the next
        // incident (if any) with its own fresh first line.
        this.failureLog.reset();
        // Counted by whoever owns durability: the outbox runs this only
        // after it has persisted the ack, the direct path right away.
        const onPersisted = () => {
          this.totalSent += 1;
        };
        return { ok: true, error: null, acknowledged: true, rejected: 0, onPersisted };
      }
      const error = `Usage Monitor returned HTTP ${res.status}`;
      this.totalFailed += 1;
      this.lastError = error;
      this.failureLog.report(`http-${res.status}`, error);
      const terminalStatus = terminalStatusFor(res.status);
      const result: { ok: boolean; error: string | null; acknowledged: boolean; rejected: number; terminalStatus?: TerminalHttpStatus } = {
        ok: false,
        error,
        acknowledged: false,
        rejected: 0,
      };
      if (terminalStatus !== undefined) result.terminalStatus = terminalStatus;
      return result;
    } catch (err) {
      const reason = err instanceof Error && err.name ? err.name : "unknown";
      const error = `Usage Monitor dispatch failed (${reason})`;
      this.totalFailed += 1;
      this.lastError = error;
      this.failureLog.report(`dispatch-${reason}`, error);
      return { ok: false, error, acknowledged: false, rejected: 0 };
    }
  }
}

/** An ACK count, or 0 for anything that is not one.  The receiver is
 * trusted to answer honestly, not to answer at all — a missing field, a
 * negative, or a value that never was a number all read as "not reported". */
function ackCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function isCompleteUsageIngestAck(
  ack: UsageIngestAck | null,
  expectedReceived: number,
): ack is Required<UsageIngestAck> {
  if (!ack) return false;
  const counts = [ack.received, ack.persisted, ack.duplicates, ack.pruned, ack.rejected];
  if (!counts.every((value) => Number.isInteger(value) && Number(value) >= 0)) return false;
  const received = Number(ack.received);
  return received === expectedReceived &&
    Number(ack.persisted) + Number(ack.duplicates) + Number(ack.pruned) + Number(ack.rejected) === received;
}

export const telemetry = new UsageTelemetryManager();
