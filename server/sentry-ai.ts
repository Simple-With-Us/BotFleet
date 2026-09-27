// Sentry AI / agent observability for the BotFleet harness (Sentry Agents).
//
// Drivers speak CLI, ACP, or raw OpenAI-compatible HTTP — not the OpenAI,
// Anthropic, Vercel AI, or LangChain SDKs — so official auto-instrumentation
// has nothing to patch.  We emit the same gen_ai.* spans those integrations
// would: invoke_agent, execute_tool, gen_ai.chat.  Conversation id is the
// thread id (`setConversationId` + `gen_ai.conversation.id`).  Agent name is
// the bot title (`gen_ai.agent.name`) so Agents Dashboard rows are identifiable.
// `setUser` fills the Conversations User column from bot/room identity.
//
// Manual spans still omit raw prompts, transcripts, and tool arguments (they
// can carry credentials).  SDK `dataCollection.genAI` is ON by default for
// any future/auto integration path; kill with `SENTRY_AI_DATA_COLLECTION=0`.
//
// The gen_ai.* vocabulary here is SENTRY's, not Usage Monitor's.  `x_ai`,
// `gcp.gemini`, and `moonshot` are Sentry provider names; the Usage Monitor
// canon (`xai`, `google-ai`, …) lives in server/telemetry.ts.  The two must
// not be unified — they are different registries that happen to overlap.
import type { RuntimeEvent } from "./contracts.ts";
import { observability } from "./observability.ts";
import { classifyError } from "./drivers/retry.ts";
import { redactSecretsInText } from "./redact.ts";
import { getSentry, isSentryActive, scrubWebhookSecrets } from "./sentry.ts";

export type SpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  end(): void;
};

/** Scope a single capture without touching the global Sentry scope. */
export type SentryCaptureContext = {
  tags?: Record<string, string>;
  /** Sentry's grouping key.  Every capture in this file happens at one of
   * two call sites, so the default stack-trace grouping would fold every
   * engine's failures into one Issue (BOTFLEET-M); an explicit fingerprint
   * splits them by driver kind and failure class instead.  The driver kind,
   * not the gen_ai provider name, because two engines share one provider
   * name (dshAgent and the DeepSeek HTTP driver are both "deepseek") and
   * fail for unrelated reasons.  Built only from bounded values — never the
   * raw free-text message. */
  fingerprint?: string[];
};

/** A non-exception capture: a condition worth an Issue at warning level,
 * such as an engine that is not installed, rather than a crash. */
export type SentryMessageContext = SentryCaptureContext & {
  level?: "info" | "warning" | "error";
};

export type SentryBreadcrumb = {
  category: string;
  message: string;
  level?: "info" | "warning" | "error";
  data?: Record<string, string | number | boolean>;
};

export type SentryAiSink = {
  setConversationId?: (id: string) => void;
  /** Conversations User column.  Pass null to clear. */
  setUser?: (user: { id?: string; username?: string; email?: string } | null) => void;
  startInactiveSpan: (opts: {
    op: string;
    name: string;
    attributes?: Record<string, string | number | boolean>;
    /** Nest the new span under this one.  Omitted (never `null`) when there
     *  is nothing to nest under: Sentry reads an explicit `null` as "this
     *  span has NO parent", which would force a chat round into its own
     *  trace root instead of letting it fall back to whatever span is
     *  active. */
    parentSpan?: SpanLike;
  }) => SpanLike;
  captureException: (error: Error, context?: SentryCaptureContext) => void;
  /** Optional so a stand-in sink with only captureException still works;
   * without it a setup failure falls back to captureException. */
  captureMessage?: (message: string, context?: SentryMessageContext) => void;
  addBreadcrumb?: (crumb: SentryBreadcrumb) => void;
};

/** Who ran this turn.  A driver only ever knows a thread id; the harness
 * store knows which bot, which engine instance, and which room that thread
 * belongs to, so the harness installs a resolver at boot and every span
 * picks the identity up from there. */
export interface TurnIdentity {
  botId?: string;
  botName?: string;
  instanceId?: string;
  model?: string;
  roomId?: string;
  roomName?: string;
}

type AgentTurn = {
  span: SpanLike;
  model?: string;
  provider: string;
  identity: TurnIdentity | null;
  tools: Map<string, SpanLike>;
};

const turns = new Map<string, AgentTurn>();
// Diagnostics can be enabled after turn.started was emitted.  Keep the
// provider-error boundary independently from span state so a later failed
// completion still deduplicates against the captured runtime error.
const reportedProviderErrors = new Set<string>();
// An ACP "initialize timed out" is breadcrumbed as an expected condition,
// but the turn then finishes as a generic rpc_error.  Remember those turns
// so the completion breadcrumbs too instead of paging a second report.
const initTimeoutTurns = new Set<string>();
// A setup runtime.error ("`dsh` isn't installed") is breadcrumbed, and the
// turn then ends as a reasonless spawn_error.  Keep the setup text per turn
// so the completion reports what actually went wrong (BOTFLEET-13) instead
// of "bot turn failed: spawn_error".
const setupErrorTurns = new Map<string, string>();
// The chat-completions loop reports its own model-request timeout as
// runtime.error "the model did not answer within …" and then ends the turn
// with stopReason "timeout" — the same stop reason its wall-clock budget
// uses.  Only a turn that saw the request-timeout message may treat
// "timeout" as expected; a wall-clock stop still pages.
const modelTimeoutTurns = new Set<string>();

let identityResolver: ((threadId: string) => TurnIdentity | null) | null = null;

/** Install (or clear, with null) the harness's thread → identity lookup. */
export function configureTurnIdentity(
  resolver: ((threadId: string) => TurnIdentity | null) | null,
): void {
  identityResolver = resolver;
}

function identityFor(threadId: string): TurnIdentity | null {
  if (!identityResolver) return null;
  try {
    return identityResolver(threadId);
  } catch {
    // Telemetry must never take down a turn.  A resolver that throws —
    // a store lookup racing a deleted bot — degrades to no identity.
    return null;
  }
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed || undefined;
}

/** The botfleet.* attributes one turn contributes to a span or a capture.
 * Every field is optional because a blank one is skipped outright: an
 * empty-string tag is worse than an absent one, since Sentry then groups
 * every unidentified turn under a single facet value. */
export type TurnIdentityAttributes = {
  "botfleet.bot.id"?: string;
  "botfleet.bot.name"?: string;
  "botfleet.instance.id"?: string;
  "botfleet.room.id"?: string;
  "botfleet.room.name"?: string;
};

/** Identity attributes plus `gen_ai.agent.name`, for the span shapes that
 * have no driver kind to fall back on. */
export type IdentifiedAgentAttributes = TurnIdentityAttributes & {
  "gen_ai.agent.name"?: string;
};

/** What a failed turn is tagged with in Sentry. */
export type TurnFailureTags = TurnIdentityAttributes & {
  "botfleet.provider": string;
  "botfleet.thread.id": string;
  "gen_ai.provider.name": string;
  "gen_ai.request.model"?: string;
  /** The completion's stop reason, so an Issue can be filtered by it. */
  "botfleet.stop_reason"?: string;
  /** "true" when the failure followed a setup runtime.error. */
  "botfleet.setup"?: string;
};

function identityAttributes(identity: TurnIdentity | null): TurnIdentityAttributes {
  const out: TurnIdentityAttributes = {};
  if (!identity) return out;
  const put = (key: keyof TurnIdentityAttributes, value: string | undefined) => {
    const text = clean(value);
    if (text) out[key] = text;
  };
  put("botfleet.bot.id", identity.botId);
  put("botfleet.bot.name", identity.botName);
  put("botfleet.instance.id", identity.instanceId);
  put("botfleet.room.id", identity.roomId);
  put("botfleet.room.name", identity.roomName);
  return out;
}

function identityWithAgentName(identity: TurnIdentity | null): IdentifiedAgentAttributes {
  const out: IdentifiedAgentAttributes = identityAttributes(identity);
  const botName = clean(identity?.botName);
  if (botName) out["gen_ai.agent.name"] = botName;
  return out;
}

function agentName(identity: TurnIdentity | null, fallback: string): string {
  return clean(identity?.botName) ?? fallback;
}

function turnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "_"}`;
}

/** The SDK's own start-span options, derived rather than imported:
 *  @sentry/node is loaded lazily through a createRequire in sentry.ts
 *  precisely so vitest never pays the Node SDK tax, and a top-level type
 *  import of it here would undo that arrangement's tidiness for one field. */
type SentryStartSpanOptions = Parameters<
  NonNullable<ReturnType<typeof getSentry>>["startInactiveSpan"]
>[0];

/** Only the scope fields a capture actually set, so an absent context stays
 * `undefined` rather than an empty object the SDK would merge. */
function captureScope(context: SentryCaptureContext | undefined): SentryCaptureContext | undefined {
  if (!context?.tags && !context?.fingerprint) return undefined;
  const scope: SentryCaptureContext = {};
  if (context.tags) scope.tags = context.tags;
  if (context.fingerprint) scope.fingerprint = context.fingerprint;
  return scope;
}

function liveSink(): SentryAiSink | null {
  if (!isSentryActive()) return null;
  const Sentry = getSentry();
  if (!Sentry) return null;
  return {
    setConversationId: (id) => {
      try {
        if (typeof Sentry.setConversationId === "function") {
          Sentry.setConversationId(id);
        }
      } catch {
        // Conversation tagging must never take down a turn.
      }
    },
    setUser: (user) => {
      Sentry.setUser(user);
    },
    startInactiveSpan: (opts) => {
      const spanOptions: SentryStartSpanOptions = {
        op: opts.op,
        name: opts.name,
        attributes: opts.attributes,
      };
      if (opts.parentSpan) {
        // SAFETY: the only SpanLike this sink is ever handed as a parent is
        // one it produced itself from Sentry.startInactiveSpan below — the
        // turn span, read back out of the `turns` map this same sink filled.
        // A test that swaps in a fake sink swaps in BOTH ends together.
        spanOptions.parentSpan = opts.parentSpan as SentryStartSpanOptions["parentSpan"];
      }
      const span = Sentry.startInactiveSpan(spanOptions);
      // SAFETY: Sentry v10 inactive spans expose setAttribute/end; setStatus is optional.
      return span as SpanLike;
    },
    captureException: (error, context) => {
      Sentry.captureException(error, captureScope(context));
      observability.noteCapture();
    },
    captureMessage: (message, context) => {
      Sentry.captureMessage(message, { ...captureScope(context), level: context?.level ?? "warning" });
      observability.noteCapture();
    },
    addBreadcrumb: (crumb) => {
      Sentry.addBreadcrumb({
        category: crumb.category,
        message: crumb.message,
        level: crumb.level ?? "info",
        data: crumb.data,
      });
    },
  };
}

/** `conversationId` is the per-TASK id (one invocation chain — see
 *  `taskConversationId`); `threadId` is the persistent room/thread the task
 *  ran on, used only to resolve identity for the Conversations User column.
 *  Kept as two separate arguments so a caller can never accidentally feed
 *  the thread id into `setConversationId`, which is the exact bug this
 *  split fixes: gen_ai.conversation.id must change every task, threadId
 *  never does. */
function applyConversation(
  sink: SentryAiSink,
  conversationId: string,
  threadId: string,
  identity?: TurnIdentity | null,
): void {
  try {
    sink.setConversationId?.(conversationId);
    if (!sink.setUser) return;
    const resolved = identity === undefined ? identityFor(threadId) : identity;
    const id = clean(resolved?.botId) ?? clean(resolved?.roomId) ?? threadId;
    const username = clean(resolved?.botName) ?? clean(resolved?.roomName);
    sink.setUser({
      id,
      ...(username ? { username } : {}),
    });
  } catch {
    /* conversation tagging must never take down a turn */
  }
}

/** The per-task conversation id: one value per agent invocation chain (one
 *  driver-generated turnId), never per persistent room/thread.  Sentry's
 *  Conversations view groups by `gen_ai.conversation.id`, and a threadId
 *  that lives for the bot's whole lifetime made every turn look like the
 *  same conversation — see the 2026-09-24 telemetry evaluation, "How it's
 *  working now" → "Data-quality gaps".  Falls back to the thread id only
 *  for the handful of infra events with no turn in flight (e.g. a
 *  synthetic runtime.error from the event-log writer). */
function taskConversationId(event: RuntimeEvent): string {
  return event.turnId ?? event.threadId;
}

/** The still-open `gen_ai.invoke_agent` span for a thread, so a span opened
 *  later in the same turn can be nested under it.
 *
 *  The lookup is by THREAD, not by turn key: a driver calls withChatSpan
 *  from inside its own round loop, where it knows the thread id it was
 *  handed and never the turn id observeRuntimeEvent keyed the span under.
 *  That is the same prefix scan `session.exited` already does.  A thread
 *  runs at most one turn at a time — every driver rejects a second
 *  concurrent sendTurn on a busy thread — so this matches at most one
 *  entry; taking the LAST match means that if a leak ever did leave an
 *  older turn open, the round is still nested under the newest one, which
 *  is the turn it actually belongs to. */
function openTurnSpan(threadId: string): SpanLike | undefined {
  const prefix = `${threadId}:`;
  let found: SpanLike | undefined;
  for (const [key, turn] of turns) {
    if (key.startsWith(prefix)) found = turn.span;
  }
  return found;
}

// Sentry's gen_ai.provider.name vocabulary, keyed by lowercased driver kind.
// A substring test used to answer "openai" for `openai-compat`, which put
// every OpenRouter and Groq span in the OpenAI provider bucket.
const GEN_AI_PROVIDERS = new Map<string, string>([
  ["codex", "openai"],
  ["openai", "openai"],
  ["openai-compat", "openai-compat"],
  ["claude", "anthropic"],
  ["claudeagent", "anthropic"],
  ["anthropic", "anthropic"],
  ["grok", "x_ai"],
  ["grokagent", "x_ai"],
  ["xai", "x_ai"],
  ["antigravity", "gcp.gemini"],
  ["antigravityagent", "gcp.gemini"],
  ["gemini", "gcp.gemini"],
  ["deepseek", "deepseek"],
  ["deepseekagent", "deepseek"],
  ["dsh", "deepseek"],
  ["dshagent", "deepseek"],
  ["kimi", "moonshot"],
  ["kimiagent", "moonshot"],
  ["cursor", "cursor"],
  ["cursoragent", "cursor"],
  ["minimax", "minimax"],
  ["boxagent", "box"],
]);

/** Map a BotFleet driver kind onto Sentry's provider vocabulary.  An engine
 * Sentry has no name for keeps its own kind rather than being folded into a
 * neighbour it does not belong to. */
export function genAiProvider(driverKind: string): string {
  const kind = (driverKind || "").trim().toLowerCase();
  return GEN_AI_PROVIDERS.get(kind) ?? (driverKind || "custom");
}

function applyCost(span: SpanLike, cost: number | null | undefined, billingMode?: "actual" | "estimated"): void {
  if (billingMode === "estimated") return;
  if (cost == null || !Number.isFinite(cost) || cost < 0) return;
  span.setAttribute("gen_ai.usage.cost", cost);
}

/** Stop reasons that are never a crash on their own.  `host_control_policy`
 * is Antigravity refusing, fail-closed, to run a host-control turn under an
 * always-proceed tool policy — a verdict the person is shown, not a fault.
 * "timeout" is deliberately absent: see `modelTimeoutTurns`. */
const EXPECTED_TURN_STOPS = new Set(["auth_required", "cancelled", "interrupted", "host_control_policy"]);

/** Stop reasons a request-timeout turn can end with: the chat-completions
 * loop maps its `request_timeout` exit to "timeout", and "request_timeout"
 * is kept for a driver that reports the exit name itself. */
const MODEL_TIMEOUT_STOPS = new Set(["timeout", "request_timeout"]);

/** The leading words of `antigravityHostPolicyRefusal` in both of its
 * forms.  Matched as text rather than imported, so this module does not
 * pull the whole Antigravity driver in; sentry-ai.test.ts pins the match
 * against the function's real output. */
const ANTIGRAVITY_POLICY_REFUSAL = "Antigravity's tool execution policy";

/** A bounded failure class for a runtime.error, for the Issue fingerprint.
 * The retry classifier's reason when it recognizes the text, joined to the
 * message's shape with every variable part — numbers, ids, paths, quoted
 * values, URLs — folded to a placeholder, secrets redacted first.  Two
 * different failures keep two Issues; the same failure with a different
 * request id or duration stays one. */
export function classifyMessage(message: string): string {
  const { reason } = classifyError({ text: message });
  const template = scrubWebhookSecrets(redactSecretsInText(message))
    .toLowerCase()
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/g, "<url>")
    .replace(/(["`])(?:(?!\1).){0,200}\1/g, "<q>")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${reason}: ${template || "empty"}`;
}

function endTurn(
  key: string,
  ok: boolean,
  usage?: { input?: number; output?: number; cachedInput?: number; cost?: number | null },
  billingMode?: "actual" | "estimated",
  expectedStop = false,
): void {
  const turn = turns.get(key);
  reportedProviderErrors.delete(key);
  if (!turn) return;
  for (const tool of turn.tools.values()) tool.end();
  turn.tools.clear();
  if (usage?.input != null) turn.span.setAttribute("gen_ai.usage.input_tokens", usage.input);
  if (usage?.output != null) turn.span.setAttribute("gen_ai.usage.output_tokens", usage.output);
  if (usage?.cachedInput != null) turn.span.setAttribute("gen_ai.usage.input_tokens.cached", usage.cachedInput);
  applyCost(turn.span, usage?.cost, billingMode);
  if (!ok && !expectedStop) turn.span.setStatus?.({ code: 2, message: "internal_error" });
  turn.span.end();
  turns.delete(key);
}

function failureTags(
  event: RuntimeEvent,
  provider: string,
  turn: AgentTurn | undefined,
  outcome: { stopReason?: string; setup?: boolean } = {},
): TurnFailureTags {
  const identity = turn?.identity ?? identityFor(event.threadId);
  const tags: TurnFailureTags = {
    "botfleet.provider": event.provider,
    "botfleet.thread.id": event.threadId,
    "gen_ai.provider.name": provider,
    ...identityAttributes(identity),
  };
  const model = clean(turn?.model) ?? clean(identity?.model);
  if (model) tags["gen_ai.request.model"] = model;
  if (outcome.stopReason) tags["botfleet.stop_reason"] = outcome.stopReason;
  if (outcome.setup) tags["botfleet.setup"] = "true";
  return tags;
}

/** Map a harness runtime event onto gen_ai spans.  No-op without a sink. */
export function observeRuntimeEvent(event: RuntimeEvent, sink: SentryAiSink | null = liveSink()): void {
  if (!sink) return;
  const key = turnKey(event.threadId, event.turnId);
  const provider = genAiProvider(event.provider);
  // Resolve once per event so setUser and span attributes share the same snapshot.
  const eventIdentity = identityFor(event.threadId);
  const conversationId = taskConversationId(event);
  applyConversation(sink, conversationId, event.threadId, eventIdentity);

  switch (event.type) {
    case "turn.started": {
      reportedProviderErrors.delete(key);
      // A turn that never completed (a crashed driver) must not hand its
      // flags to the next turn on the same key.
      initTimeoutTurns.delete(key);
      modelTimeoutTurns.delete(key);
      setupErrorTurns.delete(key);
      const identity = eventIdentity;
      const named = agentName(identity, event.provider);
      const span = sink.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${named}`,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": named,
          "gen_ai.provider.name": provider,
          "gen_ai.conversation.id": conversationId,
          "botfleet.room_id": event.threadId,
          "gen_ai.system": provider,
          ...identityAttributes(identity),
        },
      });
      const model = clean(identity?.model);
      if (model) span.setAttribute("gen_ai.request.model", model);
      turns.set(key, { span, provider, identity, model, tools: new Map() });
      break;
    }
    case "session.started": {
      const turn = turns.get(key);
      if (turn && event.model) {
        turn.model = event.model;
        turn.span.setAttribute("gen_ai.request.model", event.model);
      }
      break;
    }
    case "session.exited": {
      // A session that dies mid-turn never sends turn.completed, so the
      // invoke_agent span would hang open until the process exits.
      const prefix = `${event.threadId}:`;
      for (const openKey of turns.keys()) {
        if (openKey.startsWith(prefix)) endTurn(openKey, false);
      }
      break;
    }
    case "item.started": {
      if (event.itemType !== "tool") break;
      const turn = turns.get(key);
      if (!turn) break;
      const toolName = (event.title ?? "tool").split(/\s/)[0] || "tool";
      const toolId = event.itemId ?? toolName;
      const toolSpan = sink.startInactiveSpan({
        op: "gen_ai.execute_tool",
        name: `execute_tool ${toolName}`,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.conversation.id": conversationId,
          "botfleet.room_id": event.threadId,
          "gen_ai.agent.name": agentName(turn.identity, event.provider),
          ...identityAttributes(turn.identity),
        },
      });
      turn.tools.set(toolId, toolSpan);
      break;
    }
    case "item.completed": {
      if (event.itemType !== "tool") break;
      const turn = turns.get(key);
      if (!turn || !event.itemId) break;
      const toolSpan = turn.tools.get(event.itemId);
      if (!toolSpan) break;
      if (!event.ok) {
        toolSpan.setStatus?.({ code: 2, message: "internal_error" });
        // A failure's one-line detail is the whole reason the row is worth
        // reading.  Arguments stay off the wire; only the result line goes —
        // and it is real provider output (stdout/stderr/error text a driver
        // read back from the tool call).
        //
        // Every production driver has already redacted this in
        // `describeResult()`, before the 240-character clip that would have
        // cut a secret away from the closing marker its pattern needs.  This
        // pass is the belt to that braces: it costs one regex sweep over 240
        // characters, and it covers a `detail` that reached us some other way
        // — a driver that builds the string itself, a replayed event, a test.
        const detail = clean(event.detail);
        if (detail) toolSpan.setAttribute("gen_ai.tool.result.detail", redactSecretsInText(detail).slice(0, 200));
      }
      toolSpan.end();
      turn.tools.delete(event.itemId);
      break;
    }
    case "request.opened": {
      const turn = turns.get(key);
      if (!turn) break;
      const toolName = event.tool || "tool";
      const toolId = event.requestId ?? toolName;
      if (turn.tools.has(toolId)) break;
      const toolSpan = sink.startInactiveSpan({
        op: "gen_ai.execute_tool",
        name: `execute_tool ${toolName}`,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.conversation.id": conversationId,
          "botfleet.room_id": event.threadId,
          "gen_ai.agent.name": agentName(turn.identity, event.provider),
          ...identityAttributes(turn.identity),
        },
      });
      turn.tools.set(toolId, toolSpan);
      break;
    }
    case "request.resolved": {
      const turn = turns.get(key);
      if (!turn || !event.requestId) break;
      const toolSpan = turn.tools.get(event.requestId);
      if (!toolSpan) break;
      toolSpan.setAttribute("botfleet.approval.behavior", event.behavior);
      toolSpan.setAttribute("botfleet.approval.source", event.source);
      toolSpan.end();
      turn.tools.delete(event.requestId);
      break;
    }
    case "turn.retrying": {
      sink.addBreadcrumb?.({
        category: "botfleet.turn",
        message: `turn retrying: ${clean(event.reason)?.slice(0, 200) ?? "unknown"}`,
        level: "warning",
        data: {
          attempt: event.attempt,
          delayMs: event.delayMs,
          provider: event.provider,
          threadId: event.threadId,
        },
      });
      break;
    }
    case "thread.token-usage.updated": {
      const turn = turns.get(key);
      if (!turn) break;
      turn.span.setAttribute("gen_ai.usage.input_tokens", event.input);
      // Optional: a driver that reports only a combined context-occupancy
      // figure (DSH's ACP `usage_update`) has no real output split to give —
      // see the `output?:` comment on RuntimeEvent's thread.token-usage.updated.
      if (event.output != null) turn.span.setAttribute("gen_ai.usage.output_tokens", event.output);
      if (event.cachedInput != null) {
        turn.span.setAttribute("gen_ai.usage.input_tokens.cached", event.cachedInput);
      }
      break;
    }
    case "runtime.error": {
      // setup:true is "run grok login", not an unexpected crash.  BOTFLEET-A
      // was this message paged as an Issue while the CLI was signed in.
      // Expected operational conditions (session expired/could not resume, permission timeout,
      // provider timeout waiting for response) are recorded as warnings/breadcrumbs, not exceptions.
      const isExpectedNonCrash =
        event.setup ||
        event.message.includes("The saved ACP session could not be resumed") ||
        event.message.includes("nobody answered this permission request in time") ||
        event.message.includes("timeout waiting for response") ||
        event.message.includes("initialize timed out") ||
        event.message.includes("the model did not answer within") ||
        event.message.startsWith(ANTIGRAVITY_POLICY_REFUSAL);

      if (isExpectedNonCrash) {
        sink.addBreadcrumb?.({
          category: "botfleet.turn",
          message: event.message.slice(0, 500),
          level: "warning",
        });
        if (event.message.includes("initialize timed out")) initTimeoutTurns.add(key);
        if (event.message.includes("the model did not answer within")) modelTimeoutTurns.add(key);
        if (event.setup) setupErrorTurns.set(key, redactSecretsInText(event.message).slice(0, 500));
        break;
      }
      const turn = turns.get(key);
      // EventBus reports canonical-log I/O separately from the provider
      // turn.  Capture that infrastructure failure, but do not let it consume
      // the provider turn's one-error boundary.
      const providerTurnFailure = event.raw?.source !== "botfleet.event-log";
      if (!providerTurnFailure || !reportedProviderErrors.has(key)) {
        sink.captureException(
          new Error(event.message.slice(0, 500)),
          {
            tags: failureTags(event, provider, turn),
            fingerprint: ["bot-runtime-error", event.provider, classifyMessage(event.message)],
          },
        );
        if (providerTurnFailure) reportedProviderErrors.add(key);
      }
      break;
    }
    case "turn.completed": {
      const runtimeErrorReported = reportedProviderErrors.has(key);
      const stopReason = clean(event.stopReason)?.slice(0, 200) ?? "unknown";
      const afterInitTimeout = initTimeoutTurns.delete(key);
      const afterModelTimeout = modelTimeoutTurns.delete(key);
      const setupMessage = setupErrorTurns.get(key);
      setupErrorTurns.delete(key);
      const expectedStop =
        !event.ok &&
        !runtimeErrorReported &&
        (EXPECTED_TURN_STOPS.has(stopReason) ||
          (afterInitTimeout && stopReason === "rpc_error") ||
          (afterModelTimeout && MODEL_TIMEOUT_STOPS.has(stopReason)));
      if (!event.ok) {
        // A failed turn is the thing an operator wants an Issue for.  Most
        // drivers report the failure only here — they never emit
        // runtime.error — so without this a broken engine was invisible.
        // OpenAI-compatible, Grok, BoxAgent, and chat-completions drivers
        // report a user-initiated stop as "interrupted" rather than
        // "cancelled" — both are the expected, benign shape of a stop.
        // A model-request timeout ("the model did not answer within …",
        // then stopReason "timeout") and an ACP init timeout (then
        // rpc_error) were already breadcrumbed as expected operational
        // conditions, so their completions must not page an Issue either.
        if (expectedStop) {
          sink.addBreadcrumb?.({
            category: "botfleet.turn",
            message: `bot turn failed: ${stopReason}`,
            level: "warning",
            data: { provider: event.provider, threadId: event.threadId },
          });
        } else if (!runtimeErrorReported && setupMessage) {
          // The engine could not start for a reason the operator fixes
          // (install the CLI, sign in).  Report that reason, at warning
          // level, as one Issue per engine — not a reasonless crash.
          const turn = turns.get(key);
          const context: SentryMessageContext = {
            level: "warning",
            tags: failureTags(event, provider, turn, { stopReason, setup: true }),
            fingerprint: ["bot-setup", event.provider],
          };
          if (sink.captureMessage) sink.captureMessage(setupMessage, context);
          else sink.captureException(new Error(setupMessage), context);
        } else if (!runtimeErrorReported) {
          const turn = turns.get(key);
          sink.captureException(new Error(`bot turn failed: ${stopReason}`), {
            tags: failureTags(event, provider, turn, { stopReason }),
            fingerprint: ["bot-turn-failure", event.provider, stopReason],
          });
        }
      }
      endTurn(key, event.ok, { ...event.usage, cost: event.cost }, event.billingMode, expectedStop);
      break;
    }
    default:
      break;
  }
}

export function resetSentryAiForTests(): void {
  for (const turn of turns.values()) {
    for (const tool of turn.tools.values()) tool.end();
    turn.span.end();
  }
  turns.clear();
  reportedProviderErrors.clear();
  initTimeoutTurns.clear();
  setupErrorTurns.clear();
  modelTimeoutTurns.clear();
  identityResolver = null;
}

/** Record tool names from an API-backed driver that does not emit
 *  item.started/item.completed for its tool calls.
 *
 *  Do NOT call this from a driver whose tool calls already flow through
 *  item.started/item.completed (any driver running server/drivers/
 *  chat-completions/loop.ts, or any CLI/ACP driver) — those already become
 *  execute_tool spans generically, via observeRuntimeEvent, with a REAL
 *  outcome and REAL start/end timing.  Calling both for the same tool call
 *  produces two execute_tool spans instead of one. */
export function recordExecutedTools(
  conversationId: string,
  toolNames: string[],
  sink: SentryAiSink | null = liveSink(),
  /** The per-task id, when the caller has one (a turnId).  Defaults to
   *  `conversationId` — the thread — for a caller that does not, so this
   *  stays per-room rather than reporting nothing. */
  taskId: string = conversationId,
): void {
  if (!sink || toolNames.length === 0) return;
  applyConversation(sink, taskId, conversationId);
  const identityAttrs = identityWithAgentName(identityFor(conversationId));
  for (const raw of toolNames) {
    const toolName = raw.trim() || "tool";
    const span = sink.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.conversation.id": taskId,
        "botfleet.room_id": conversationId,
        ...identityAttrs,
      },
    });
    span.end();
  }
}

export type ChatSpanUsage = {
  input?: number;
  output?: number;
  cachedInput?: number;
};

export interface ChatSpanContext {
  recordUsage: (usage: ChatSpanUsage) => void;
  span: SpanLike;
}

/** Wrap one OpenAI-compatible chat completion.  Never attach messages.
 *
 *  `conversationId` stays the THREAD id — `openTurnSpan` and `identityFor`
 *  both key off it, since that is what the harness's identity resolver and
 *  the `turns` map (keyed `threadId:turnId`) actually know about.  `taskId`
 *  is the per-task id (the driver's own turnId, when it has one in scope)
 *  and is what actually becomes `gen_ai.conversation.id`; a caller that
 *  omits it falls back to `conversationId`, so this stays per-room instead
 *  of reporting nothing. */
export async function withChatSpan<T extends { usage?: ChatSpanUsage | null }>(
  opts: { model: string; conversationId: string; taskId?: string; provider?: string },
  fn: (context: ChatSpanContext) => Promise<T>,
  sink: SentryAiSink | null = liveSink(),
): Promise<T> {
  const applyUsageToSpan = (spanTarget: SpanLike, u?: ChatSpanUsage | null) => {
    if (!u) return;
    if (u.input != null) spanTarget.setAttribute("gen_ai.usage.input_tokens", u.input);
    if (u.output != null) spanTarget.setAttribute("gen_ai.usage.output_tokens", u.output);
    if (u.cachedInput != null) spanTarget.setAttribute("gen_ai.usage.input_tokens.cached", u.cachedInput);
  };

  if (!sink) {
    const dummySpan: SpanLike = {
      setAttribute: () => {},
      end: () => {},
      setStatus: () => {},
    };
    return fn({ recordUsage: () => {}, span: dummySpan });
  }
  const provider = opts.provider ?? "openai";
  const taskId = opts.taskId ?? opts.conversationId;
  const identityAttrs = identityWithAgentName(identityFor(opts.conversationId));
  const span = sink.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${opts.model}`,
    // A real trace-tree child of the turn, not merely a sibling that shares
    // a gen_ai.conversation.id.  The turn's invoke_agent span is opened by
    // observeRuntimeEvent with startInactiveSpan and never entered as the
    // active span, so a span started here would otherwise attach to
    // whatever happened to be active — in a detached turn loop, nothing —
    // and Sentry's AI Agents view would show each round as its own root
    // rather than as a step inside the turn.  Undefined when this thread
    // has no open turn (generateText's title and summary rounds run
    // outside any turn at all), which leaves Sentry's own default parenting
    // in place instead of forcing a root.
    parentSpan: openTurnSpan(opts.conversationId),
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": opts.model,
      "gen_ai.provider.name": provider,
      "gen_ai.system": provider,
      "gen_ai.conversation.id": taskId,
      "botfleet.room_id": opts.conversationId,
      ...identityAttrs,
    },
  });
  try {
    const result = await fn({
      recordUsage: (u) => applyUsageToSpan(span, u),
      span,
    });
    if (result?.usage) {
      applyUsageToSpan(span, result.usage);
    }
    return result;
  } catch (error) {
    span.setStatus?.({ code: 2, message: "internal_error" });
    throw error;
  } finally {
    span.end();
  }
}
