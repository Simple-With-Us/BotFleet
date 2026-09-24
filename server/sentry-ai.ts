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
import { redactSecretsInText } from "./redact.ts";
import { getSentry, isSentryActive } from "./sentry.ts";

export type SpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  end(): void;
};

/** Scope a single capture without touching the global Sentry scope. */
export type SentryCaptureContext = {
  tags?: Record<string, string>;
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
      Sentry.captureException(error, context?.tags ? { tags: context.tags } : undefined);
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

function applyConversation(sink: SentryAiSink, threadId: string, identity?: TurnIdentity | null): void {
  try {
    sink.setConversationId?.(threadId);
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

const EXPECTED_TURN_STOPS = new Set(["auth_required", "cancelled", "interrupted"]);

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
  return tags;
}

/** Map a harness runtime event onto gen_ai spans.  No-op without a sink. */
export function observeRuntimeEvent(event: RuntimeEvent, sink: SentryAiSink | null = liveSink()): void {
  if (!sink) return;
  const key = turnKey(event.threadId, event.turnId);
  const provider = genAiProvider(event.provider);
  // Resolve once per event so setUser and span attributes share the same snapshot.
  const eventIdentity = identityFor(event.threadId);
  applyConversation(sink, event.threadId, eventIdentity);

  switch (event.type) {
    case "turn.started": {
      reportedProviderErrors.delete(key);
      const identity = eventIdentity;
      const named = agentName(identity, event.provider);
      const span = sink.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${named}`,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": named,
          "gen_ai.provider.name": provider,
          "gen_ai.conversation.id": event.threadId,
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
          "gen_ai.conversation.id": event.threadId,
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
          "gen_ai.conversation.id": event.threadId,
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
      turn.span.setAttribute("gen_ai.usage.output_tokens", event.output);
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
        event.message.includes("timeout waiting for response");

      if (isExpectedNonCrash) {
        sink.addBreadcrumb?.({
          category: "botfleet.turn",
          message: event.message.slice(0, 500),
          level: "warning",
        });
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
          { tags: failureTags(event, provider, turn) },
        );
        if (providerTurnFailure) reportedProviderErrors.add(key);
      }
      break;
    }
    case "turn.completed": {
      const runtimeErrorReported = reportedProviderErrors.has(key);
      const stopReason = clean(event.stopReason)?.slice(0, 200) ?? "unknown";
      const expectedStop = !event.ok && !runtimeErrorReported && EXPECTED_TURN_STOPS.has(stopReason);
      if (!event.ok) {
        // A failed turn is the thing an operator wants an Issue for.  Most
        // drivers report the failure only here — they never emit
        // runtime.error — so without this a broken engine was invisible.
        // OpenAI-compatible, Grok, BoxAgent, and chat-completions drivers
        // report a user-initiated stop as "interrupted" rather than
        // "cancelled" — both are the expected, benign shape of a stop.
        if (expectedStop) {
          sink.addBreadcrumb?.({
            category: "botfleet.turn",
            message: `bot turn failed: ${stopReason}`,
            level: "warning",
            data: { provider: event.provider, threadId: event.threadId },
          });
        } else if (!runtimeErrorReported) {
          const turn = turns.get(key);
          sink.captureException(new Error(`bot turn failed: ${stopReason}`), {
            tags: failureTags(event, provider, turn),
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
): void {
  if (!sink || toolNames.length === 0) return;
  applyConversation(sink, conversationId);
  const identityAttrs = identityWithAgentName(identityFor(conversationId));
  for (const raw of toolNames) {
    const toolName = raw.trim() || "tool";
    const span = sink.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.conversation.id": conversationId,
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

/** Wrap one OpenAI-compatible chat completion.  Never attach messages. */
export async function withChatSpan<T extends { usage?: ChatSpanUsage | null }>(
  opts: { model: string; conversationId: string; provider?: string },
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
      "gen_ai.conversation.id": opts.conversationId,
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
