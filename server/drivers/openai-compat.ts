// OpenAI-compatible driver — any endpoint that speaks the OpenAI
// chat-completions shape (OpenRouter, Groq, Together, a local llama.cpp,
// …). This is the "free models" entry point: point it at OpenRouter's
// free tier or Groq's open-model endpoints and a bot runs without a
// paid Claude/Codex/Grok subscription.
//
// Transcript-replay like grok.ts: the harness folds thread history and
// hands it back each turn (SendTurnInput.transcript); we emit true
// token-level content.delta events and supply generateText.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { splitChatPrompt } from "./prompt-split.ts";
import { withChatSpan } from "../sentry-ai.ts";
import { runTurnLoop, type ChatMessage, type TurnLoopDeps, type TurnUsage } from "./chat-completions/loop.ts";

import { httpErrorFor } from "./chat-completions/errors.ts";
import { toTurnUsage } from "./chat-completions/usage.ts";
import { capReplayedTranscript } from "./chat-completions/replay-cap.ts";

const DRIVER_KIND = "openai-compat";
// How long a request may go without a byte before it is abandoned.  This was
// the whole-request ceiling, which cut off a slow-but-live stream at 120s;
// it is now the turn loop's IDLE clock (see `requestIdleMs` in
// chat-completions/loop.ts), so a stream still delivering bytes runs to the
// loop's hard ceiling instead.  generateText, which has no loop around it,
// still uses it as a plain ceiling.
const REQUEST_TIMEOUT_MS = 120_000;

// Default catalog — overwritten by /models when the endpoint answers.
// Free-tier-friendly defaults so the picker is never empty.
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
  ],
};

export interface OpenAICompatConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
  /** Env var (instance environment or process.env) carrying the API key. */
  apiKeyEnv: string;
  /** Direct API key if configured */
  key?: string;
  /** Custom configured models list (IDs or objects) */
  models?: Array<string | { id: string; label?: string }>;
  /** Custom icon URL or data URL (SVG, PNG, etc.) */
  iconUrl?: string;
}

// Sentry's gen_ai.provider.name for whoever is actually answering.  Every
// endpoint here speaks the OpenAI wire shape, so the URL is the only thing
// that says whether a span belongs to OpenAI, OpenRouter, or Groq — calling
// them all "openai" put four vendors in one Sentry bucket.
export function sentryProviderForUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "openai-compat";
  }
  const hostMatches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (hostMatches("openrouter.ai")) return "openrouter";
  if (hostMatches("groq.com")) return "groq";
  if (hostMatches("api.openai.com")) return "openai";
  return "openai-compat";
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  const rawModels = Array.isArray(o.models) ? o.models : undefined;
  const models: Array<string | { id: string; label?: string }> = [];
  if (rawModels) {
    for (const m of rawModels) {
      if (typeof m === "string" && m.trim()) {
        models.push(m.trim());
      } else if (typeof m === "object" && m !== null && typeof (m as any).id === "string" && (m as any).id.trim()) {
        const id = String((m as any).id).trim();
        const label = typeof (m as any).label === "string" && (m as any).label.trim() ? String((m as any).label).trim() : undefined;
        models.push(label ? { id, label } : { id });
      }
      if (models.length >= 15) break;
    }
  }

  return {
    url:
      typeof o.url === "string" && o.url
        ? o.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    key: typeof o.key === "string" && o.key ? o.key : undefined,
    models: models && models.length > 0 ? models : undefined,
    iconUrl: typeof o.iconUrl === "string" && o.iconUrl.trim() ? o.iconUrl.trim() : undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No CLI to install — the "install" is getting a free API key.
  install: {
    docsUrl: "https://openrouter.ai/keys",
    apiKeyOnly: true,
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.botfleet/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.botfleet/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.botfleet/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.botfleet\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    // process.env is process-wide, not per-instance: syncCredentialEnv copies
    // the workspace's openaiCompat.key into process.env.OPENAI_COMPAT_API_KEY
    // (and config.apiKeyEnv usually resolves to that same var) the moment it
    // is saved, so every openai-compat instance's process.env lookup would
    // otherwise see it — including a custom instance pointed at an arbitrary
    // keyless endpoint. Only the single reserved `openaiCompat` instance may
    // fall back to process.env; a user-added custom instance gets a key only
    // via its own config.key or its isolated instance environment (matching
    // injectedEnvironment()'s instance-id gate in config.ts).
    const isCustomInstance = instanceId !== "openaiCompat";
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment["OPENAI_COMPAT_API_KEY"] ??
      (isCustomInstance
        ? undefined
        : (process.env[config.apiKeyEnv] ?? process.env["OPENAI_COMPAT_API_KEY"])) ??
      "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string; startedAt: number }>();
    let catalog = DEFAULT_MODELS;
    if (config.models && config.models.length > 0) {
      const options: ModelCatalog["options"] = config.models.map((m) => {
        const id = typeof m === "string" ? m : m.id;
        const label = typeof m === "object" && m.label ? m.label : id;
        return { id, label, custom: true };
      });
      catalog = { default: options[0].id, options };
    }

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<any>,
      model: string,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        tools?: any[];
        onChunk?: () => void;
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
        onUsage?: (usage: TurnUsage) => void;
      },
    ): Promise<{
      text: string;
      reasoning: string;
      tool_calls?: any[];
      usage: TurnUsage | null;
    }> => {
      const bodyPayload: any = { model, messages, stream: opts.stream, ...(opts.stream ? { stream_options: { include_usage: true } } : {}) };
      if (opts.tools && opts.tools.length > 0) {
        bodyPayload.tools = opts.tools;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }
      const signal = opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const request = () => fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal,
      });
      let res = await request();
      if (!res.ok && opts.stream && (res.status === 400 || res.status === 422)) {
        // Some compatible endpoints reject this optional OpenAI field.  Retry
        // only an explicit validation rejection, before any stream or tools
        // can run, and keep the original cancellation/deadline budget.
        const rejection = await res.text().catch(() => "");
        // Providers phrase the same 400 differently, so the wording check has to
        // cover active voice ("does not support") as well as the adjective and
        // passive forms ("unsupported", "not supported").  Matching only the
        // latter left a plain "This endpoint does not support stream_options"
        // rejection with no retry at all.
        if (/stream_options/i.test(rejection) &&
            /unsupported|not supported|does not support|doesn't support|do not support|cannot support|can't support|not permitted|unrecognized|unknown|unexpected|extra_forbidden/i.test(rejection)) {
          delete bodyPayload.stream_options;
          res = await request();
        }
      }
      if (!res.ok) {
        // Provider bodies can echo prompts or credentials.  Only the status
        // and its typed classification are safe to surface in diagnostics.
        throw httpErrorFor(res.status, "");
      }
      // headers are progress too: the socket answered
      opts.onChunk?.();
      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        const mainContent = typeof msg?.content === "string" ? msg.content : "";
        const reasoningContent = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
        return {
          text: mainContent,
          reasoning: reasoningContent,
          tool_calls: msg?.tool_calls,
          usage: json.usage ? toTurnUsage(json.usage) : null,
        };
      }
      let text = "";
      let reasoning = "";
      let usage: TurnUsage | null = null;
      let streamToolCalls: any[] = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const takeSseLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
        const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
        const toolCallsDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined;

        if (reasoningDelta) {
          reasoning += reasoningDelta;
          opts.onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          opts.onDelta?.(contentDelta, "assistant_text");
        }
        if (toolCallsDelta) {
          for (const tc of toolCallsDelta) {
            const tcIndex = tc.index ?? 0;
            if (!streamToolCalls[tcIndex]) {
              streamToolCalls[tcIndex] = { id: "", type: "function", function: { name: "", arguments: "" } };
            }
            // Only the arguments stream in fragments.  A provider that
            // repeats the id and the name on every chunk — several do — used
            // to accumulate `call_acall_acall_a` and `bashbashbash`, so the
            // settled call could never be matched to the step it opened.
            if (tc.id && !streamToolCalls[tcIndex].id) streamToolCalls[tcIndex].id = tc.id;
            if (tc.function?.name && !streamToolCalls[tcIndex].function.name) {
              streamToolCalls[tcIndex].function.name = tc.function.name;
            }
            if (tc.function?.arguments) streamToolCalls[tcIndex].function.arguments += tc.function.arguments;
          }
        }
        if (chunk.usage) {
          usage = toTurnUsage(chunk.usage);
          opts.onUsage?.(usage);
        }
        if (chunk.error) {
          const status = chunk.error.code ?? chunk.error.status;
          // Error frames may contain request material.  Keep the status,
          // never the upstream body, in the user-visible failure.
          if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
            throw httpErrorFor(status, "");
          }
          throw new Error("upstream reported a streaming error");
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buf += decoder.decode();
            if (buf.trim()) takeSseLine(buf.trim());
            break;
          }
          // Any bytes at all keep the round's idle clock alive, parsed
          // into a delta or not.
          opts.onChunk?.();
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            takeSseLine(line);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { text, reasoning, usage, tool_calls: streamToolCalls.length > 0 ? streamToolCalls : undefined };
    };

    const fetchModels = async (): Promise<void> => {
      if (config.models && config.models.length > 0) return;
      if (!apiKey && !isCustomInstance) return;
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const res = await fetch(`${config.url}/models`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const json: any = await res.json();
        const rows: Array<{ id?: unknown; name?: unknown }> = Array.isArray(json)
          ? json
          : Array.isArray(json?.data)
            ? json.data
            : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label =
            typeof row.name === "string" && row.name.trim()
              ? row.name
              : id;
          options.push({ id, label });
        }
        if (options.length) {
          catalog = { default: options[0].id, options };
        }
      } catch {
        // keep DEFAULT_MODELS — never fail the instance on a catalog miss
      }
    };
    if (apiKey || isCustomInstance) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      // Validation rejects sendTurn before the loop exists, so startTurn's
      // catch settles the dispatch exactly as it does
      // for a CLI driver — error chip, watchdog settled, bot idle, all three
      // queue drains.  A rejection here must never become a resolved turn
      // that nothing ever settles.
      if (!apiKey && !isCustomInstance) {
        throw new Error(
          `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        );
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId, startedAt: Date.now() });

      const openAiTools = turn.tools && turn.tools.length > 0
        ? turn.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
            },
          }))
        : undefined;

      const model = turn.model || catalog.default;
      // Round 1's prefix.  The loop owns this array from here and only ever
      // APPENDS to it, so rounds 2..N re-send a byte-identical prefix and the
      // endpoint's prompt cache stays reachable.  The transcript is byte- and
      // entry-count-capped first so a long thread cannot grow past the
      // model's prompt window or the provider's per-request size — see
      // chat-completions/replay-cap.ts.
      const cappedTranscript = capReplayedTranscript(turn.transcript);
      // Only the stable half of the prompt heads the request; the volatile
      // half rides the newest user message, every request, so the resent
      // prefix stays byte-identical across a memory write (see
      // prompt-split.ts splitChatPrompt).
      const chat = splitChatPrompt(turn);
      const messages: ChatMessage[] = [
        ...(chat.system ? [{ role: "system" as const, content: chat.system }] : []),
        ...cappedTranscript.flatMap((m): ChatMessage[] => {
          const res: ChatMessage[] = [];
          if (m.role === "assistant") {
            const assistantMsg: ChatMessage = { role: "assistant", content: m.text || "" };
            if (m.toolCalls && m.toolCalls.length > 0) {
              assistantMsg.tool_calls = m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              }));
            }
            res.push(assistantMsg);
          } else {
            if (m.toolResults && m.toolResults.length > 0) {
              for (const tr of m.toolResults) {
                res.push({ role: "tool", tool_call_id: tr.id, content: tr.result });
              }
            } else {
              res.push({ role: "user", content: m.text });
            }
          }
          return res;
        }),
        ...(chat.text ? [{ role: "user" as const, content: chat.text }] : []),
      ];

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model,
      });

      const runRound: TurnLoopDeps["runRound"] = async (roundMessages, opts) => {
        appendNative(threadId, {
          dir: "out",
          source: "openai-compat.chat.completions",
          // Native logs are diagnostic artifacts users commonly attach to
          // issues. Keep routing metadata, not prompts or transcript content.
          msg: { model, messageCount: roundMessages.length, round: opts.round },
        });
        const { text, reasoning, tool_calls, usage } = await withChatSpan(
          { model, conversationId: threadId, taskId: turnId, provider: sentryProviderForUrl(config.url) },
          ({ recordUsage }) =>
            complete(roundMessages, model, {
              stream: true,
              signal: opts.signal,
              tools: openAiTools,
              onChunk: opts.onChunk,
              // `onPublished` before the emit: from here this round can
              // never be retried, because a replay would show the person
              // text they already read.  It also feeds the idle clock.
              onDelta: (delta, streamKind = "assistant_text") => {
                opts.onPublished?.();
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind,
                  delta,
                });
              },
              // Forwarded straight to the loop's own live channel, so a
              // round that errors mid-stream after several chunks still gets
              // its usage folded into the terminal event instead of
              // reporting zero.
              onUsage: (u) => {
                recordUsage(u);
                opts.onUsage?.(u);
              },
            }),
        );
        appendNative(threadId, {
          dir: "in",
          source: "openai-compat.chat.completions",
          msg: { textLength: text.length, reasoningLength: reasoning.length, toolCallsLength: tool_calls?.length ?? 0, usage, round: opts.round },
        });
        // A reply that is entirely reasoning (no assistant text) still needs
        // to render as something — fall back to the reasoning text rather
        // than settling a silently empty turn.  The loop is what turns a
        // non-empty `text` into the `item.completed` event and into the next
        // round's assistant-message prefix, so folding the fallback in here
        // is what makes both of those honour it too.
        const replyText = text.trim() ? text : reasoning;
        return { text: replyText, usage, toolCalls: tool_calls };
      };

      // Detached, exactly as every CLI driver runs its turn: sendTurn
      // resolves at DISPATCH so markTaskDispatched and the rewind clear are
      // not deferred to the end of the loop.  runTurnLoop never rejects — it
      // emits one turn.completed on every exit and resolves with which one.
      void runTurnLoop({
        base: () => base(threadId, turnId),
        emit,
        runRound,
        messages,
        // Only `timeoutMs` is read from this; the provider payload is built
        // separately above from name/description/parameters.
        tools: turn.tools,
        toolHost: turn.toolHost,
        requestApproval: turn.toolHost?.requestApproval
          ? (ask) => turn.toolHost!.requestApproval!(ask)
          : undefined,
        signal: abort.signal,
        // 120s of SILENCE ends a request, as it always has for this driver;
        // a stream that keeps delivering bytes now runs to the loop's hard
        // ceiling instead of being cut off at 120s mid-answer.
        budget: { requestIdleMs: REQUEST_TIMEOUT_MS },
        onSettled: () => active.delete(threadId),
      });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey && !isCustomInstance) {
        return {
          state: "unavailable",
          reason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        };
      }
      return {
        state: "available",
        authenticated: Boolean(apiKey || isCustomInstance),
        version: null,
        ...(apiKey ? { billing: "metered" as const } : {}),
      };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      iconUrl: config.iconUrl,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // no MCP server is mounted in this file and respondToRequest answers
        // The driver owns both transcript replay and model-to-tool rounds.
        // localComputerMcp runs host computer tools through the toolLoop host.
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true, toolLoop: true, localComputerMcp: true, replaysTranscript: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        sweepStuckTurns: async (olderThanMs: number) => {
          const cutoff = Date.now() - olderThanMs;
          const stuck: string[] = [];
          for (const [threadId, entry] of active) {
            if (entry.startedAt > cutoff) continue;
            stuck.push(threadId);
            entry.abort.abort();
          }
          return stuck;
        },
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete(
          [{ role: "user", content: prompt }],
          catalog.default,
          { stream: false },
        );
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
